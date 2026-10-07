/**
 * Golden output of the dnsmasq backend.
 *
 * Seeds one estate with something of everything dnsmasq is told about (v4 and
 * v6 scopes in every mode, v4 and DUID reservations, every record type, a
 * disabled zone, the resolver and listen settings), drives each apply path,
 * and snapshots every file under DATA_DIR/dnsmasq plus the commands run
 * (validate, reload, restart). The snapshots were taken before the backend
 * facade existed; refactors of the apply paths must leave them byte for byte.
 *
 * Steps run in order and each builds on the last, so a step's snapshot shows
 * what that one change wrote and which commands it cost.
 */
import { DATA_DIR } from '../../helpers/isolated-data-dir.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const commands = [];
vi.mock('child_process', () => ({
  execFileSync: vi.fn((cmd, args = []) => {
    if (cmd === 'dnsmasq' && args[0] === '--version') {
      return 'Compile time options: IPv6 DHCP DHCPv6 DNSSEC inotify';
    }
    commands.push([cmd, ...args].join(' '));
    return '';
  }),
  execSync: vi.fn((cmd) => {
    commands.push(cmd);
    return '';
  }),
  execFile: vi.fn(),
}));

const DNSMASQ_DIR = path.join(DATA_DIR, 'dnsmasq');
const REPO_DEFAULT_CONF = path.resolve(__dirname, '../../../../dnsmasq/dnsmasq.conf.default');
const DISTRO_TRUST_ANCHORS = '/usr/share/dnsmasq/trust-anchors.conf';

const { setupTestDb, cleanupTestDb, enableIpv6 } = await import('../../helpers/test-db.js');
const { setSetting } = await import('../../../src/db/init.js');
const { queueRegen } = await import('../../../src/utils/after-commit.js');
const { applyAtBoot, applyListenNow } = await import('../../../src/services/backend-apply.js');
const { syncLeasesNow } = await import('../../../src/services/dhcp-lease-sync.js');
const { getDnsBackend } = await import('../../../src/backends/index.js');
const { ESTATE_INTERFACES, seedBackendEstate } = await import('../../helpers/backend-estate.js');

let db;
let tmpDir;

// The apply paths outside the after-commit hooks, as index.js and the DNS
// proxy run them.
const applyPaths = {
  boot: () => applyAtBoot(db),
  bypass(on) {
    if (on) setSetting('dns_proxy_bypass', 'true');
    else db.prepare("DELETE FROM settings WHERE key = 'dns_proxy_bypass'").run();
    applyListenNow(db);
  },
  syncLeases: () => syncLeasesNow(db, { settleMs: 0 }),
};

const hooksSettle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function hook(name) {
  queueRegen(name);
  await hooksSettle();
}

function dumpDir() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name !== 'dnsmasq.leases') {
        out.push(`=== ${path.relative(DNSMASQ_DIR, full)} ===`, fs.readFileSync(full, 'utf-8'));
      }
    }
  };
  walk(DNSMASQ_DIR);
  return out.join('\n');
}

function snapshot() {
  const text = ['##### files', dumpDir(), '##### commands', ...commands.splice(0), '']
    .join('\n')
    .replaceAll(DATA_DIR, '<DATA_DIR>');
  return text;
}

const golden = (step) => `./__golden__/${step}.txt`;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  enableIpv6(db);
  fs.copyFileSync(REPO_DEFAULT_CONF, path.join(DNSMASQ_DIR, 'dnsmasq.conf'));

  // The distro trust-anchor file differs between hosts; pin it absent.
  const realExists = fs.existsSync;
  vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
    p === DISTRO_TRUST_ANCHORS ? false : realExists(p),
  );
  vi.spyOn(os, 'networkInterfaces').mockReturnValue(ESTATE_INTERFACES);
  seedBackendEstate(db);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('dnsmasq backend golden output', () => {
  it('01 applies DNS zones', async () => {
    commands.length = 0;
    await hook('regenerate_dns');
    await expect(snapshot()).toMatchFileSnapshot(golden('01-dns-zones'));
  });

  it('02 applies DHCP scopes and reservations', async () => {
    await hook('regenerate_dhcp');
    await expect(snapshot()).toMatchFileSnapshot(golden('02-dhcp'));
  });

  it('03 applies the resolver: encrypted forwarding and DNSSEC', async () => {
    setSetting('forwarder_encryption', 'tls');
    setSetting('dnssec_enabled', 'true');
    await hook('regenerate_dnsmasq_conf');
    await expect(snapshot()).toMatchFileSnapshot(golden('03-resolver'));
  });

  it('04 boots with an explicit interface config', async () => {
    setSetting(
      'interface_config',
      JSON.stringify({ eth0: { dns: true, dhcp: true }, eth1: { dns: true, dhcp: false } }),
    );
    applyPaths.boot();
    await expect(snapshot()).toMatchFileSnapshot(golden('04-boot'));
  });

  it('05 reboots with nothing changed', async () => {
    applyPaths.boot();
    await expect(snapshot()).toMatchFileSnapshot(golden('05-boot-unchanged'));
  });

  // DNSMASQ-03: with DNSSEC on, the listen and resolver writers used to move
  // each other's block, so an Interfaces save with nothing changed reported
  // a change and restarted dnsmasq. Not a snapshot: it must leave no trace.
  it('05b saves the Interfaces page with nothing changed', () => {
    const before = snapshot();
    expect(getDnsBackend().applyListen(db, { activate: false }).changed).toBe(false);
    expect(getDnsBackend().applyResolver(db, { activate: false }).changed).toBe(false);
    expect(snapshot()).toBe(before.replace(/##### commands\n[\s\S]*$/, '##### commands\n'));
  });

  it('06 enters and leaves proxy bypass', async () => {
    applyPaths.bypass(true);
    const on = snapshot();
    applyPaths.bypass(false);
    await expect(`${on}\n%%%%% bypass off\n${snapshot()}`).toMatchFileSnapshot(golden('06-bypass'));
  });

  it('07 turns recursion off and DNSSEC off', async () => {
    setSetting('dns_no_recursion', 'true');
    setSetting('dnssec_enabled', 'false');
    await hook('regenerate_dnsmasq_conf');
    await expect(snapshot()).toMatchFileSnapshot(golden('07-no-recursion'));
  });

  it('08 ingests leases from the lease file', async () => {
    const expiry = 4102444800; // 2100-01-01, never expired during a test run
    fs.writeFileSync(
      path.join(DNSMASQ_DIR, 'dnsmasq.leases'),
      [
        `${expiry} aa:bb:cc:00:00:10 10.60.0.120 laptop 01:aa:bb:cc:00:00:10`,
        `${expiry} aa:bb:cc:00:00:11 10.60.0.121 * *`,
        'duid 00:01:00:01:11:22:33:44:52:54:00:00:00:01',
        `${expiry} 12345 fd00:63::1020 phone 00:01:00:01:2a:2b:2c:2d:aa:bb:cc:00:00:12`,
        '',
      ].join('\n'),
    );
    await applyPaths.syncLeases();
    await hooksSettle();
    const leases = db
      .prepare(
        'SELECT ip_address, mac_address, hostname, duid, iaid, expires_at FROM dhcp_leases ORDER BY ip_address',
      )
      .all();
    const names = db
      .prepare(
        "SELECT name, type, value, source FROM dns_records WHERE source NOT IN ('manual', 'placeholder') ORDER BY type, name, value",
      )
      .all();
    await expect(
      `${snapshot()}\n##### leases\n${JSON.stringify(leases, null, 2)}\n##### records\n${JSON.stringify(names, null, 2)}\n`,
    ).toMatchFileSnapshot(golden('08-leases'));
  });

  it('09 re-applies everything with nothing changed', async () => {
    await hook('regenerate_dns');
    await hook('regenerate_dhcp');
    await hook('regenerate_dnsmasq_conf');
    await expect(snapshot()).toMatchFileSnapshot(golden('09-idempotent'));
  });

  it('10 boots on a fresh install with no interface config', async () => {
    db.prepare("DELETE FROM settings WHERE key = 'interface_config'").run();
    applyPaths.boot();
    await expect(snapshot()).toMatchFileSnapshot(golden('10-boot-fresh'));
  });
});
