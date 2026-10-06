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
const { parseNetwork } = await import('../../../src/utils/cidr.js');
const { insertSubnet, configureSubnet } = await import('../../../src/services/subnet-topology.js');
const { invalidateSubnetCache } = await import('../../../src/utils/ip-sync.js');
const { queueRegen } = await import('../../../src/utils/after-commit.js');
const {
  applyInterfaceConfig,
  regenerateDnsmasqConf,
  restartDnsmasq,
  withValidatedDnsmasqUpdate,
  dnsmasqRestartPending,
  isCidrellaDnsmasqRunning,
} = await import('../../../src/utils/dnsmasq.js');
const { syncSettledLeases } = await import('../../../src/utils/dhcp.js');

let db;
let tmpDir;

// The apply paths outside the after-commit hooks. Each mirrors its caller
// line for line; the facade phases point these at the facade instead.
const applyPaths = {
  // index.js boot block
  boot() {
    let ifaceChanged = false;
    let confChanged = false;
    try {
      ({ ifaceChanged, confChanged } = withValidatedDnsmasqUpdate(() => {
        const ifaceChanged = applyInterfaceConfig(db);
        const confChanged = regenerateDnsmasqConf(db);
        return { ifaceChanged, confChanged, changed: ifaceChanged || confChanged };
      }));
    } catch (err) {
      commands.push(`boot generation failed: ${err.message}`);
    }
    if (ifaceChanged || confChanged || dnsmasqRestartPending() || !isCidrellaDnsmasqRunning()) {
      restartDnsmasq();
    } else {
      commands.push('boot: unchanged, restart skipped');
    }
  },
  // dns-proxy.js activateBypass / deactivateBypass
  bypass(on) {
    if (on) setSetting('dns_proxy_bypass', 'true');
    else db.prepare("DELETE FROM settings WHERE key = 'dns_proxy_bypass'").run();
    withValidatedDnsmasqUpdate(() => applyInterfaceConfig(db));
    restartDnsmasq();
  },
  syncLeases: () => syncSettledLeases(db, { settleMs: 0 }),
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

function network(cidr, fields) {
  const id = insertSubnet(db, {
    cidr,
    name: cidr,
    status: 'unallocated',
    depth: 0,
  }).lastInsertRowid;
  const parsed = parseNetwork(cidr);
  configureSubnet(db, db.prepare('SELECT * FROM subnets WHERE id = ?').get(id), parsed, {
    name: cidr,
    gateway: parsed.firstUsable,
    gateway_policy: 'first',
    ...fields,
  });
  invalidateSubnetCache();
  return Number(id);
}

function record(zoneId, name, type, value, extra = {}) {
  db.prepare(
    `INSERT INTO dns_records (zone_id, name, type, value, priority, weight, port, ttl, enabled, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
  ).run(
    zoneId,
    name,
    type,
    value,
    extra.priority ?? null,
    extra.weight ?? null,
    extra.port ?? null,
    extra.ttl ?? null,
    extra.enabled ?? 1,
  );
}

const zoneId = (name) => db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(name).id;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  enableIpv6(db);
  fs.copyFileSync(REPO_DEFAULT_CONF, path.join(DNSMASQ_DIR, 'dnsmasq.conf'));

  // The distro trust-anchor file differs between hosts; pin it absent.
  const realExists = fs.existsSync;
  vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
    p === DISTRO_TRUST_ANCHORS ? false : realExists(p),
  );
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    lo: [
      { family: 'IPv4', address: '127.0.0.1', internal: true },
      { family: 'IPv6', address: '::1', internal: true },
    ],
    eth0: [
      { family: 'IPv4', address: '10.60.0.2', internal: false },
      { family: 'IPv6', address: 'fd00:60::2', internal: false },
      { family: 'IPv6', address: 'fe80::2', internal: false },
    ],
    eth1: [{ family: 'IPv4', address: '10.61.0.2', internal: false }],
  });

  // IPv4 network with a pool, a domain and reverse DNS.
  const v4 = network('10.60.0.0/24', {
    domain_name: 'golden.test',
    create_reverse_dns: true,
    create_dhcp_scope: true,
    dhcpPool: {
      startLong: Number(parseNetwork('10.60.0.100/32').networkLong),
      endLong: Number(parseNetwork('10.60.0.199/32').networkLong),
    },
  });
  const v4Scope = db.prepare('SELECT id FROM dhcp_scopes WHERE subnet_id = ?').get(v4).id;
  db.prepare(
    "INSERT OR REPLACE INTO dhcp_scope_options (scope_id, option_code, value, address_family) VALUES (?, 66, 'tftp.golden.test', 4)",
  ).run(v4Scope);
  db.prepare(
    "INSERT INTO dhcp_reservations (subnet_id, mac_address, ip_address, hostname, address_family) VALUES (?, 'aa:bb:cc:00:00:01', '10.60.0.50', 'printer', 4)",
  ).run(v4);
  db.prepare(
    "INSERT INTO dhcp_reservations (subnet_id, mac_address, ip_address, address_family) VALUES (?, 'aa:bb:cc:00:00:02', '10.60.0.51', 4)",
  ).run(v4);

  // IPv6 in every mode, one with reverse DNS.
  network('fd00:61::/64', { create_dhcp_scope: true, dhcpV6: { mode: 'slaac', pool: null } });
  network('fd00:62::/64', { create_dhcp_scope: true, dhcpV6: { mode: 'stateless', pool: null } });
  const v6 = network('fd00:63::/64', {
    domain_name: 'golden.test',
    create_reverse_dns: true,
    create_dhcp_scope: true,
    dhcpV6: { mode: 'stateful', pool: null },
  });
  db.prepare(
    "INSERT INTO dhcp_reservations (subnet_id, duid, iaid, ip_address, hostname, address_family) VALUES (?, '00:01:00:01:2a:2b:2c:2d:aa:bb:cc:00:00:03', 7, 'fd00:63::50', 'nas', 6)",
  ).run(v6);

  // Every record type, served and unserved PTRs, both families.
  const fwd = zoneId('golden.test');
  record(fwd, 'web', 'A', '10.60.0.10');
  record(fwd, 'web', 'AAAA', 'fd00:63::10');
  record(fwd, 'www', 'CNAME', 'web.golden.test', { ttl: 300 });
  record(fwd, '@', 'MX', 'mail.golden.test', { priority: 5 });
  record(fwd, '@', 'TXT', 'v=spf1 "quoted" -all');
  record(fwd, '_sip._tcp', 'SRV', 'sip.golden.test', { port: 5060, priority: 1, weight: 2 });
  record(fwd, 'off', 'A', '10.60.0.11', { enabled: 0 });
  const rev4 = db
    .prepare("SELECT id FROM dns_zones WHERE type = 'reverse' AND name LIKE '%in-addr.arpa'")
    .get().id;
  record(rev4, '10', 'PTR', 'web.golden.test');
  record(rev4, '12', 'PTR', 'elsewhere.example.net');
  const rev6 = db
    .prepare("SELECT id FROM dns_zones WHERE type = 'reverse' AND name LIKE '%ip6.arpa'")
    .get().id;
  record(rev6, '0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0', 'PTR', 'web.golden.test');

  // A disabled zone writes nothing.
  db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('off.test', 'forward', 0)").run();
  record(zoneId('off.test'), 'gone', 'CNAME', 'web.golden.test');
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
