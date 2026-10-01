/**
 * A full IPv6 scan against the database: discovery through the neighbor
 * table, the per-network meaning of an unclaimed address, and echoes to the
 * addresses CIDRella already allocated.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../helpers/test-db.js';

const responders = new Set();
const execFile = vi.fn((cmd, args, opts, cb) => {
  const target = args[args.length - 1];
  const ok = cmd === 'ping' && (target.startsWith('ff02::1') || responders.has(target));
  cb(ok ? null : new Error('no reply'), '');
});
vi.mock('child_process', () => ({ execFile: (...a) => execFile(...a), execFileSync: vi.fn() }));

let neighbors = new Map();
vi.mock('../../src/utils/nd-cache.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readNdCache: () => neighbors,
  lookupNdEntry: (ip) => neighbors.get(ip) || null,
}));

const { startScan, confirmByNeighborDiscovery } = await import('../../src/utils/scanner.js');
const { parseNetwork } = await import('../../src/utils/cidr.js');
const { insertSubnet, configureSubnet } = await import('../../src/services/subnet-topology.js');
const ScanRun = await import('../../src/models/scan-run.js');
const { invalidateSubnetCache } = await import('../../src/utils/ip-sync.js');
const { recordDnsQueryLiveness } = await import('../../src/utils/ip-liveness.js');

let db;
let tmpDir;
const nets = {};

function network(cidr, mode) {
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
    create_dhcp_scope: Boolean(mode),
    dhcpV6: mode ? { mode, pool: null } : null,
  });
  invalidateSubnetCache();
  return Number(id);
}

function row(ip) {
  return db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get(ip);
}

beforeAll(async () => {
  const setup = await setupTestDb();
  enableIpv6(setup.db);
  db = setup.db;
  tmpDir = setup.tmpDir;
  nets.slaac = network('fd00:5::/64', 'slaac');
  nets.stateful = network('fd00:6::/64', 'stateful');
  nets.bare = network('fd00:7::/64', null);
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    eth0: [
      { family: 'IPv6', address: 'fd00:5::2', internal: false },
      { family: 'IPv6', address: 'fd00:6::2', internal: false },
      { family: 'IPv6', address: 'fd00:7::2', internal: false },
    ],
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

async function scan(subnetId) {
  const scanId = ScanRun.createPending(db, subnetId);
  await startScan(db, scanId, subnetId);
  return db.prepare('SELECT * FROM network_scans WHERE id = ?').get(scanId);
}

describe('IPv6 scan', () => {
  it('turns a discovered host into a SLAAC claim on a SLAAC network, never a rogue', async () => {
    neighbors = new Map([
      ['fd00:5::a1', { mac: 'aa:bb:cc:dd:ee:a1', interface: 'eth0', state: 'REACHABLE' }],
      ['fe80::a1', { mac: 'aa:bb:cc:dd:ee:a1', interface: 'eth0', state: 'STALE' }],
    ]);
    responders.clear();
    responders.add('fd00:5::a1');
    responders.add('fe80::a1%eth0');
    const run = await scan(nets.slaac);
    expect(run.status).toBe('completed');
    expect(run.conflicts_found).toBe(0);
    expect(row('fd00:5::a1')).toMatchObject({
      allocation_state: 'slaac',
      is_rogue: 0,
      is_online: 1,
      last_seen_mac: 'aa:bb:cc:dd:ee:a1',
    });
    expect(row('fd00:5::a1').valid_until).toBeTruthy();
    // Link-local is liveness with interface context and no claim.
    expect(row('fe80::a1')).toMatchObject({
      allocation_state: 'unassigned',
      is_rogue: 0,
      is_online: 1,
      interface_id: 'eth0',
    });
    // The prefix was never swept: the discovered hosts and the one allocated
    // address (the gateway) got an echo, nothing else; the link-local one on
    // its interface.
    const pinged = execFile.mock.calls.filter((c) => c[0] === 'ping').map((c) => c[1].at(-1));
    expect(pinged.filter((t) => !t.startsWith('ff02')).sort()).toEqual([
      'fd00:5::1',
      'fd00:5::a1',
      'fe80::a1%eth0',
    ]);
  });

  it('flags an unclaimed host as rogue on a stateful network', async () => {
    neighbors = new Map([
      ['fd00:6::b1', { mac: 'aa:bb:cc:dd:ee:b1', interface: 'eth0', state: 'REACHABLE' }],
    ]);
    responders.clear();
    responders.add('fd00:6::b1');
    const run = await scan(nets.stateful);
    expect(run.status).toBe('completed');
    expect(run.conflicts_found).toBe(1);
    expect(row('fd00:6::b1')).toMatchObject({
      allocation_state: 'unassigned',
      is_rogue: 1,
      is_online: 1,
    });
  });

  it('records liveness only when the network has no scope', async () => {
    neighbors = new Map([['fd00:7::c1', { mac: null, interface: 'eth0', state: 'STALE' }]]);
    responders.clear();
    responders.add('fd00:7::c1');
    const run = await scan(nets.bare);
    expect(run.status).toBe('completed');
    expect(run.conflicts_found).toBe(0);
    expect(row('fd00:7::c1')).toMatchObject({
      allocation_state: 'unassigned',
      is_rogue: 0,
      is_online: 1,
    });
  });

  it('probes an unassigned address on a SLAAC network without failing', async () => {
    neighbors = new Map();
    responders.clear();
    responders.add('fd00:5::d1');
    const scanId = ScanRun.createPending(db, nets.slaac);
    await startScan(db, scanId, nets.slaac, { targetIps: ['fd00:5::d1'] });
    const run = db.prepare('SELECT * FROM network_scans WHERE id = ?').get(scanId);
    expect(run.status).toBe('completed');
    expect(ScanRun.getResultForIp(db, scanId, 'fd00:5::d1')).toMatchObject({
      responded: 1,
      is_conflict: 0,
    });
  });

  it('probes an allocated address typed in another spelling as that address', async () => {
    db.prepare(
      `INSERT INTO ip_addresses (subnet_id, ip_address, allocation_state, address_family, address_sort_key)
       VALUES (?, 'fd00:6::77', 'static_dns', 6, 'x')`,
    ).run(nets.stateful);
    neighbors = new Map();
    responders.clear();
    responders.add('fd00:6::77');
    const scanId = ScanRun.createPending(db, nets.stateful);
    await startScan(db, scanId, nets.stateful, { targetIps: ['FD00:6::77', 'fd00:6:0:0::77'] });
    expect(db.prepare('SELECT * FROM network_scans WHERE id = ?').get(scanId)).toMatchObject({
      status: 'completed',
      conflicts_found: 0,
    });
    expect(ScanRun.getResultForIp(db, scanId, 'fd00:6::77')).toMatchObject({ is_conflict: 0 });
    expect(row('fd00:6::77')).toMatchObject({ allocation_state: 'static_dns', is_rogue: 0 });
  });

  it('echoes every persisted allocated address so a quiet static host goes offline', async () => {
    db.prepare(
      `INSERT INTO ip_addresses (subnet_id, ip_address, allocation_state, address_family, address_sort_key, is_online)
       VALUES (?, 'fd00:5::5000', 'static_dns', 6, 'x', 1)`,
    ).run(nets.slaac);
    neighbors = new Map();
    responders.clear();
    execFile.mockClear();
    await scan(nets.slaac);
    const pinged = execFile.mock.calls.filter((c) => c[0] === 'ping').map((c) => c[1].at(-1));
    expect(pinged).toContain('fd00:5::5000');
    // The anycast address is never probed.
    expect(pinged).not.toContain('fd00:5::');
    expect(row('fd00:5::5000')).toMatchObject({ is_online: 0, allocation_state: 'static_dns' });
    expect(row('fd00:5::5000').offline_since_at).toBeTruthy();
  });
});

describe('a scan answers for every address it reports (IPV6-32, 33, 34)', () => {
  const insert = (subnetId, ip, fields = {}) => {
    const columns = { allocation_state: 'unassigned', is_online: 0, is_rogue: 0, ...fields };
    const names = Object.keys(columns);
    db.prepare(
      `INSERT INTO ip_addresses (subnet_id, ip_address, address_family, address_sort_key, ${names.join(', ')})
       VALUES (?, ?, 6, 'x', ${names.map(() => '?').join(', ')})`,
    ).run(subnetId, ip, ...Object.values(columns));
  };
  let stateful;
  beforeAll(() => {
    stateful = network('fd00:8::/64', 'stateful');
  });

  it('counts a REACHABLE neighbor as an answer when the host drops echo', async () => {
    insert(stateful, 'fd00:8::50', { allocation_state: 'static_dns', is_online: 1 });
    insert(stateful, 'fd00:8::51', { allocation_state: 'static_dns', is_online: 1 });
    neighbors = new Map([
      ['fd00:8::50', { mac: 'aa:bb:cc:dd:ee:50', interface: 'eth0', state: 'REACHABLE' }],
      // STALE is what the kernel remembers of a host, not an answer.
      ['fd00:8::51', { mac: 'aa:bb:cc:dd:ee:51', interface: 'eth0', state: 'STALE' }],
    ]);
    responders.clear();
    const run = await scan(stateful);
    expect(run.status).toBe('completed');
    expect(row('fd00:8::50')).toMatchObject({ is_online: 1, last_seen_mac: 'aa:bb:cc:dd:ee:50' });
    expect(row('fd00:8::51')).toMatchObject({ is_online: 0 });
  });

  it('echoes an online host nobody allocated, so one that left goes offline', async () => {
    neighbors = new Map([
      ['fd00:8::c2', { mac: 'aa:bb:cc:dd:ee:c2', interface: 'eth0', state: 'REACHABLE' }],
      ['fe80::c2', { mac: 'aa:bb:cc:dd:ee:c2', interface: 'eth0', state: 'REACHABLE' }],
    ]);
    responders.clear();
    responders.add('fd00:8::c2');
    await scan(stateful);
    expect(row('fd00:8::c2')).toMatchObject({ is_online: 1, is_rogue: 1 });

    // The host leaves: nothing in the neighbor table, no echo reply.
    neighbors = new Map();
    responders.clear();
    execFile.mockClear();
    const run = await scan(stateful);
    expect(run.status).toBe('completed');
    const pinged = execFile.mock.calls.filter((c) => c[0] === 'ping').map((c) => c[1].at(-1));
    expect(pinged).toContain('fd00:8::c2');
    expect(row('fd00:8::c2')).toMatchObject({ is_online: 0, is_rogue: 0 });
  });

  it('keeps a rogue flag the scan did not re-check, and records the ones it clears', async () => {
    insert(stateful, 'fd00:8::e1', { is_rogue: 1, rogue_reason: 'Rogue device (IP not assigned)' });
    neighbors = new Map();
    responders.clear();
    const run = await scan(stateful);
    expect(run.status).toBe('completed');
    // Offline, so not echoed, so still a rogue.
    expect(row('fd00:8::e1')).toMatchObject({ is_rogue: 1 });
    const cleared = db
      .prepare(
        "SELECT ip_address FROM ip_events WHERE event_type = 'rogue_cleared' AND ip_address = ?",
      )
      .all('fd00:8::c2');
    expect(cleared.length).toBeGreaterThan(0);
  });

  it('leaves only the rows the scan never echoes to the stale sweep', async () => {
    const { markStalePassiveAddresses } =
      await import('../../src/services/ip-lifecycle-service.js');
    db.prepare("UPDATE subnets SET scan_interval = '1h', scan_enabled = 1 WHERE id = ?").run(
      stateful,
    );
    db.prepare(
      "UPDATE ip_addresses SET is_online = 1, last_seen_at = datetime('now', '-3 hours') WHERE subnet_id = ? AND ip_address = 'fd00:8::'",
    ).run(stateful);
    insert(stateful, 'fd00:8::d2', { allocation_state: 'static_dns', is_online: 1 });
    db.prepare(
      "UPDATE ip_addresses SET last_seen_at = datetime('now', '-3 hours') WHERE ip_address = 'fd00:8::d2'",
    ).run();
    markStalePassiveAddresses(db, 60);
    // Nothing echoes the anycast address, so the sweep ages it out; the scan
    // echoes fd00:8::d2, so the sweep leaves it to the scan.
    expect(row('fd00:8::')).toMatchObject({ is_online: 0 });
    expect(row('fd00:8::d2')).toMatchObject({ is_online: 1 });
  });
});

describe('confirmByNeighborDiscovery', () => {
  it('waits for a settling entry and refuses a stale or failed one', async () => {
    const reads = [
      new Map([
        ['fd00::1', { ip: 'fd00::1', mac: 'aa:00:00:00:00:01', interface: 'eth0', state: 'DELAY' }],
        ['fd00::2', { ip: 'fd00::2', mac: 'aa:00:00:00:00:02', interface: 'eth0', state: 'STALE' }],
        ['fd00::3', { ip: 'fd00::3', mac: 'aa:00:00:00:00:03', interface: 'eth0', state: 'PROBE' }],
        [
          'fe80::4%eth1',
          { ip: 'fe80::4', mac: 'aa:00:00:00:00:04', interface: 'eth1', state: 'REACHABLE' },
        ],
      ]),
      new Map([
        [
          'fd00::1',
          { ip: 'fd00::1', mac: 'aa:00:00:00:00:01', interface: 'eth0', state: 'REACHABLE' },
        ],
        // fd00::3's probes failed, so the kernel dropped it from what we read.
      ]),
    ];
    const wait = vi.fn(async () => {});
    const results = [
      { ip: 'fd00::1', iface: null, responded: false, mac: null, method: 'icmpv6' },
      { ip: 'fd00::2', iface: null, responded: false, mac: null, method: 'icmpv6' },
      { ip: 'fd00::3', iface: null, responded: false, mac: null, method: 'icmpv6' },
      { ip: 'fe80::4', iface: 'eth1', responded: false, mac: null, method: 'icmpv6' },
      { ip: 'fd00::5', iface: null, responded: true, mac: null, method: 'icmpv6' },
    ];
    await confirmByNeighborDiscovery(results, { read: () => reads.shift() ?? new Map(), wait });
    expect(results.map((r) => [r.ip, r.responded, r.method])).toEqual([
      ['fd00::1', true, 'ndp'],
      ['fd00::2', false, 'icmpv6'],
      ['fd00::3', false, 'icmpv6'],
      ['fe80::4', true, 'ndp'],
      ['fd00::5', true, 'icmpv6'],
    ]);
    expect(results[0].mac).toBe('aa:00:00:00:00:01');
    expect(wait).toHaveBeenCalledTimes(1);
  });
});

describe('passive IPv6 source under each mode', () => {
  it('claims SLAAC on a SLAAC network and rogue on a stateful one', () => {
    neighbors = new Map([
      ['fd00:5::d1', { mac: 'aa:bb:cc:dd:ee:d1', interface: 'eth0', state: 'REACHABLE' }],
      ['fd00:6::d2', { mac: 'aa:bb:cc:dd:ee:d2', interface: 'eth0', state: 'REACHABLE' }],
    ]);
    recordDnsQueryLiveness(db, 'fd00:5::d1', { createRogue: true });
    recordDnsQueryLiveness(db, 'fd00:6::d2', { createRogue: true });
    expect(row('fd00:5::d1')).toMatchObject({
      allocation_state: 'slaac',
      is_rogue: 0,
      detection_source: 'passive',
    });
    expect(row('fd00:6::d2')).toMatchObject({ allocation_state: 'unassigned', is_rogue: 1 });
  });
});
