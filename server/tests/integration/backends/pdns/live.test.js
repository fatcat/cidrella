/**
 * The PowerDNS adapter against real PowerDNS: Authoritative 5.0 and Recursor
 * 5.3 from PowerDNS's repository, started on what CIDRella renders, with
 * CIDRella's own forwarder upstream. Skipped unless PDNS_LIVE=1, so it runs
 * only where PowerDNS is installed (scripts/lib/pdns-install.sh, or the
 * pdns-server, pdns-backend-sqlite3 and pdns-recursor packages):
 *
 *   PDNS_LIVE=1 npx vitest run tests/integration/backends/pdns/live.test.js
 *
 * It needs ports 5300, 5353, 5356 and 8053 free on loopback, and network
 * access for the forwarder (plain DNS to PDNS_LIVE_UPSTREAM, 9.9.9.9 by
 * default). Run it as root or as the account the units run as.
 *
 * Through Recursor it checks every record type in both families, NXDOMAIN
 * inside a local zone, an edit answering at once, a second apply sending
 * nothing (what CIDRella renders is what the API hands back), and DNSSEC:
 * a signed public name validates and dnssec-failed.org fails.
 */
import { DATA_DIR } from '../../../helpers/isolated-data-dir.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import dns from 'dns';
import fs from 'fs';

const LIVE = process.env.PDNS_LIVE === '1';
const UPSTREAM = process.env.PDNS_LIVE_UPSTREAM || '9.9.9.9';

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../../../helpers/test-db.js');
const { setSetting, getSetting } = await import('../../../../src/db/init.js');
const { seedBackendEstate } = await import('../../../helpers/backend-estate.js');
const { createPdnsBackend } = await import('../../../../src/backends/pdns/index.js');
const { AUTH_DIR, RECURSOR_DIR, binary } = await import('../../../../src/backends/pdns/paths.js');
// The forwarder runs here, in the test, reading the test database's settings.
const { configureForwarder, applyEncryptedForwarder, stopEncryptedForwarder } =
  await import('../../../../src/dns-proxy/forwarder.js');
configureForwarder({ setting: getSetting });

const PORT = 5353;
let db;
let tmpDir;
let backend;
const daemons = [];

const resolver = new dns.promises.Resolver({ timeout: 6000, tries: 1 });
resolver.setServers([`127.0.0.1:${PORT}`]);

// dig, for what Node's resolver does not show: the status and the AD flag.
// Never execFileSync: the forwarder runs in this process and must keep answering.
async function dig(name, type = 'A') {
  const { stdout } = await promisify(execFile)(
    'dig',
    ['+dnssec', '+time=6', '+tries=1', '-p', String(PORT), '@127.0.0.1', name, type],
    { encoding: 'utf8' },
  );
  return stdout;
}
const statusOf = (out) => /status: (\w+)/.exec(out)?.[1];

function start(daemon, configDir) {
  const child = spawn(
    binary(daemon),
    [`--config-dir=${configDir}`, '--daemon=no', '--disable-syslog'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  child.log = () => log;
  daemons.push(child);
  return child;
}

describe.skipIf(!LIVE)('PowerDNS live', () => {
  beforeAll(async () => {
    ({ db, tmpDir } = await setupTestDb());
    enableIpv6(db);
    seedBackendEstate(db);
    db.prepare(
      `INSERT INTO dns_records (zone_id, name, type, value, enabled, source)
       SELECT id, 'intl', 'TXT', 'café, "quoted" and \\ backslash', 1, 'manual'
       FROM dns_zones WHERE name = 'golden.test'`,
    ).run();
    setSetting('dns_upstream_servers', JSON.stringify([UPSTREAM]));
    setSetting('dnssec_enabled', 'true');
    applyEncryptedForwarder();

    backend = createPdnsBackend({ getDb: () => db });
    expect(backend.installed()).toEqual({ ok: true });
    backend.prepare();
    expect(backend.dns.applyResolver(db, { activate: false }).changed).toBe(true);
    start('auth', AUTH_DIR);
    start('recursor', RECURSOR_DIR);
    await backend.awaitRunning({ timeoutMs: 20000, intervalMs: 500 }).catch((err) => {
      throw new Error(`${err.message}\n${daemons.map((d) => d.log()).join('\n')}`);
    });
    const applied = await backend.dns.applyZones(db);
    expect(applied.changed).toBe(true);
  }, 60000);

  afterAll(() => {
    for (const child of daemons) child.kill('SIGTERM');
    stopEncryptedForwarder();
    if (tmpDir) cleanupTestDb(tmpDir);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('answers every record type in both families', async () => {
    expect(await resolver.resolve4('web.golden.test')).toEqual(['10.60.0.10']);
    expect(await resolver.resolve6('web.golden.test')).toEqual(['fd00:63::10']);
    expect(await resolver.resolveCname('www.golden.test')).toEqual(['web.golden.test']);
    expect(await resolver.resolveMx('golden.test')).toEqual([
      { exchange: 'mail.golden.test', priority: 5 },
    ]);
    expect(await resolver.resolveSrv('_sip._tcp.golden.test')).toEqual([
      { name: 'sip.golden.test', port: 5060, priority: 1, weight: 2 },
    ]);
    const txt = (await resolver.resolveTxt('golden.test')).map((parts) => parts.join(''));
    expect(txt).toEqual(['v=spf1 "quoted" -all']);
    // Node reads TXT bytes as Latin-1; the record is UTF-8.
    const intl = (await resolver.resolveTxt('intl.golden.test')).map((parts) =>
      Buffer.from(parts.join(''), 'latin1').toString('utf8'),
    );
    expect(intl).toEqual(['café, "quoted" and \\ backslash']);
    expect(await resolver.reverse('10.60.0.10')).toEqual(['web.golden.test']);
    expect(await resolver.reverse('fd00:63::10')).toEqual(['web.golden.test']);
    expect(statusOf(await dig('nothing.golden.test'))).toBe('NXDOMAIN');
    expect(statusOf(await dig('golden.test', 'SOA'))).toBe('NOERROR');
  });

  it('sends nothing on a second apply: what it renders is what the API keeps', async () => {
    expect((await backend.dns.applyZones(db)).changed).toBe(false);
  });

  it('answers an edit at once, in both families', async () => {
    // Cache the old answers first, so the test shows the wipe.
    expect(await resolver.resolve4('web.golden.test')).toEqual(['10.60.0.10']);
    expect(await resolver.resolve6('web.golden.test')).toEqual(['fd00:63::10']);
    db.prepare(
      "UPDATE dns_records SET value = '10.60.0.20' WHERE name = 'web' AND type = 'A'",
    ).run();
    db.prepare(
      "UPDATE dns_records SET value = 'fd00:63::20' WHERE name = 'web' AND type = 'AAAA'",
    ).run();
    expect((await backend.dns.applyZones(db)).activation).toBe('reload');
    expect(await resolver.resolve4('web.golden.test')).toEqual(['10.60.0.20']);
    expect(await resolver.resolve6('web.golden.test')).toEqual(['fd00:63::20']);
  });

  it('serves a new zone at once, and drops a removed one', async () => {
    db.prepare(
      "INSERT INTO dns_zones (name, type, enabled) VALUES ('fresh.test', 'forward', 1)",
    ).run();
    db.prepare(
      `INSERT INTO dns_records (zone_id, name, type, value, enabled, source)
       SELECT id, 'h', 'A', '10.70.0.1', 1, 'manual' FROM dns_zones WHERE name = 'fresh.test'`,
    ).run();
    expect(statusOf(await dig('h.fresh.test'))).not.toBe('NOERROR');
    await backend.dns.applyZones(db);
    expect(await resolver.resolve4('h.fresh.test')).toEqual(['10.70.0.1']);
    db.prepare("UPDATE dns_zones SET enabled = 0 WHERE name = 'fresh.test'").run();
    await backend.dns.applyZones(db);
    expect(statusOf(await dig('h.fresh.test'))).not.toBe('NOERROR');
  });

  it('validates DNSSEC through the forwarder', async () => {
    const signed = await dig('isc.org');
    expect(statusOf(signed)).toBe('NOERROR');
    expect(signed).toMatch(/flags:[^;]* ad/);
    expect(statusOf(await dig('dnssec-failed.org'))).toBe('SERVFAIL');
  });
});
