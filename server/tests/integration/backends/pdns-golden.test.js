/**
 * Golden output of the PowerDNS backend, on the estate the dnsmasq and Kea
 * goldens use (tests/helpers/backend-estate.js).
 *
 * Each step snapshots what it sent Authoritative's API (method, path and
 * body), the files under DATA_DIR/pdns, and the commands run (Recursor's
 * config check, rec_control). Steps build on each other, so a snapshot shows
 * what that one change cost.
 */
import { DATA_DIR } from '../../helpers/isolated-data-dir.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Every command the adapter runs, systemctl included, is recorded, never run.
const commands = [];
// Commands and API requests in the order they happened, for the start order.
const timeline = [];
vi.mock('child_process', () => ({
  execFileSync: vi.fn((cmd, args = []) => {
    commands.push([cmd, ...args].join(' '));
    timeline.push([cmd, ...args].join(' '));
    return '';
  }),
}));
// rec_control and systemctl run through runCommand: recorded by the same mock.
vi.mock('../../../src/utils/run-command.js', async () =>
  (await import('../../helpers/fake-run-command.js')).fakeRunCommandModule(
    (await import('child_process')).execFileSync,
  ),
);

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../../helpers/test-db.js');
const { setSetting } = await import('../../../src/db/init.js');
const { ESTATE_INTERFACES, seedBackendEstate } = await import('../../helpers/backend-estate.js');
const { startFakePdns } = await import('../../helpers/fake-pdns.js');
const { ensureSecret } = await import('../../../src/backends/shared/secret.js');
const { PDNS_DIR, SECRET_DIR, API_KEY_FILE } = await import('../../../src/backends/pdns/paths.js');

let db;
let tmpDir;
let pdns;
let backend;
let apiKey;
let ntp = { available: true, synchronized: false };

function dumpDir() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // The secret and the sqlite database are not text worth comparing.
      else if (!full.startsWith(SECRET_DIR) && !entry.name.startsWith('pdns.sqlite3')) {
        out.push(`=== ${path.relative(PDNS_DIR, full)} ===`, fs.readFileSync(full, 'utf-8'));
      }
    }
  };
  walk(PDNS_DIR);
  return out.join('\n');
}

function snapshot() {
  const requests = pdns.requests
    .splice(0)
    .map(({ method, url, body }) =>
      [`${method} ${url}`, body === undefined ? null : JSON.stringify(body, null, 2)]
        .filter(Boolean)
        .join('\n'),
    );
  return (
    [
      '##### api',
      ...requests,
      '##### files',
      dumpDir(),
      '##### commands',
      ...commands.splice(0),
      '',
    ]
      .join('\n')
      .replaceAll(DATA_DIR, '<DATA_DIR>')
      .replaceAll(apiKey, '<API_KEY>')
      .replaceAll(`port=${pdns.port}`, 'port=<API_PORT>')
      // The digests cover the socket path, which is under the random DATA_DIR.
      .replace(/^# (fixed|zones): \w+$/gm, '# $1: <digest>')
  );
}

const golden = (step) => `./__golden__/pdns-${step}.txt`;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  enableIpv6(db);
  seedBackendEstate(db);
  apiKey = ensureSecret(SECRET_DIR, API_KEY_FILE);
  pdns = await startFakePdns({ apiKey });
  process.env.PDNS_API_PORT = String(pdns.port);
  const schema = path.join(tmpDir, 'schema.sqlite3.sql');
  fs.writeFileSync(schema, 'CREATE TABLE domains (id INTEGER PRIMARY KEY, name TEXT);\n');
  process.env.PDNS_SQLITE_SCHEMA = schema;
  const { createPdnsBackend } = await import('../../../src/backends/pdns/index.js');
  backend = createPdnsBackend({
    sysIfaces: () => ESTATE_INTERFACES,
    ntpStatus: () => ntp,
    getDb: () => db,
  });
});

afterAll(async () => {
  await pdns?.close();
  delete process.env.PDNS_API_PORT;
  delete process.env.PDNS_SQLITE_SCHEMA;
  cleanupTestDb(tmpDir);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('PowerDNS backend golden output', () => {
  it('01 prepares the daemons: directories, database, pdns.conf', async () => {
    backend.prepare();
    const authDb = path.join(PDNS_DIR, 'auth', 'pdns.sqlite3');
    // Owner only: the database holds every local zone.
    expect(fs.statSync(authDb).mode & 0o777).toBe(0o600);
    await expect(snapshot()).toMatchFileSnapshot(golden('01-prepare'));
  });

  it('02 applies DNS zones', async () => {
    const result = await backend.dns.applyZones(db);
    expect(result).toMatchObject({ changed: true, activated: true });
    await expect(snapshot()).toMatchFileSnapshot(golden('02-dns-zones'));
  });

  it('03 applies the resolver: encrypted forwarding and DNSSEC before the clock is set', async () => {
    setSetting('forwarder_encryption', 'tls');
    setSetting('dnssec_enabled', 'true');
    expect((await backend.dns.applyResolver(db)).activation).toBe('restart');
    await expect(snapshot()).toMatchFileSnapshot(golden('03-resolver'));
  });

  it('04 validates once the clock is synchronized', async () => {
    ntp = { available: true, synchronized: true };
    await backend.dns.onClockSynchronized();
    await expect(snapshot()).toMatchFileSnapshot(golden('04-clock'));
  });

  it('05 listens on the LAN in bypass mode, and back', async () => {
    setSetting(
      'interface_config',
      JSON.stringify({ eth0: { dns: true, dhcp: true }, eth1: { dns: false, dhcp: true } }),
    );
    setSetting('dns_proxy_bypass', 'true');
    await backend.dns.applyListen(db);
    const on = snapshot();
    db.prepare("DELETE FROM settings WHERE key = 'dns_proxy_bypass'").run();
    await backend.dns.applyListen(db);
    await expect(`${on}\n${snapshot()}`).toMatchFileSnapshot(golden('05-bypass'));
  });

  it('06 stops recursion', async () => {
    setSetting('dns_no_recursion', 'true');
    await backend.dns.applyResolver(db);
    await expect(snapshot()).toMatchFileSnapshot(golden('06-no-recursion'));
  });

  it('07 changes one record, and only the SOA serial of another zone', async () => {
    db.prepare(
      "UPDATE dns_records SET value = '10.60.0.20' WHERE name = 'web' AND type = 'A'",
    ).run();
    db.prepare(
      "UPDATE dns_zones SET soa_serial = soa_serial + 1 WHERE name LIKE '%in-addr.arpa'",
    ).run();
    expect((await backend.dns.applyZones(db)).activation).toBe('reload');
    await expect(snapshot()).toMatchFileSnapshot(golden('07-record-edit'));
  });

  it('08 sends nothing when nothing changed', async () => {
    expect((await backend.dns.applyZones(db)).changed).toBe(false);
    expect((await backend.dns.applyResolver(db)).changed).toBe(false);
    expect((await backend.dns.applyListen(db)).changed).toBe(false);
    await expect(snapshot()).toMatchFileSnapshot(golden('08-idempotent'));
  });

  it('09 removes a disabled zone', async () => {
    db.prepare("UPDATE dns_zones SET enabled = 0 WHERE name LIKE '%ip6.arpa'").run();
    await backend.dns.applyZones(db);
    await expect(snapshot()).toMatchFileSnapshot(golden('09-zone-removed'));
  });

  // Recursor caches a negative answer for a zone Authoritative does not hold
  // yet, so it starts only once the zones are in.
  it('10 starts Authoritative, syncs the zones, then starts Recursor', async () => {
    db.prepare("UPDATE dns_zones SET enabled = 1 WHERE name LIKE '%ip6.arpa'").run();
    snapshot();
    timeline.length = 0;
    const recorded = pdns.requests.length;
    const realPush = pdns.requests.push.bind(pdns.requests);
    pdns.requests.push = (...items) => {
      for (const item of items) timeline.push(`${item.method} ${item.url}`);
      return realPush(...items);
    };
    await backend.restart();
    pdns.requests.push = realPush;
    expect(pdns.requests.length).toBeGreaterThan(recorded);
    const at = (pattern) => timeline.findIndex((entry) => pattern.test(entry));
    const authStart = at(/^systemctl restart cidrella-pdns-auth/);
    const zoneWrite = at(/^(POST|PATCH) .*\/zones/);
    const recursorStart = at(/^systemctl restart cidrella-pdns-recursor/);
    expect(authStart).toBeGreaterThanOrEqual(0);
    expect(zoneWrite).toBeGreaterThan(authStart);
    expect(recursorStart).toBeGreaterThan(zoneWrite);
  });
});
