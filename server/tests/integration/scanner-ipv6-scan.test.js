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
vi.mock('../../src/utils/nd-cache.js', () => ({
  readNdCache: () => neighbors,
  lookupNdEntry: (ip) => neighbors.get(ip) || null,
}));

const { startScan } = await import('../../src/utils/scanner.js');
const { parseNetwork } = await import('../../src/utils/cidr.js');
const { insertSubnet, configureSubnet } = await import('../../src/services/subnet-topology.js');
const ScanRun = await import('../../src/models/scan-run.js');
const { invalidateSubnetCache } = await import('../../src/utils/ip-sync.js');
const { recordDnsQueryLiveness } = await import('../../src/utils/ip-liveness.js');

let db;
let tmpDir;
const nets = {};

function network(cidr, mode) {
  const id = insertSubnet(db, { cidr, name: cidr, status: 'unallocated', depth: 0 }).lastInsertRowid;
  const parsed = parseNetwork(cidr);
  configureSubnet(
    db,
    db.prepare('SELECT * FROM subnets WHERE id = ?').get(id),
    parsed,
    {
      name: cidr,
      gateway: parsed.firstUsable,
      gateway_policy: 'first',
      create_dhcp_scope: Boolean(mode),
      dhcpV6: mode ? { mode, pool: null } : null,
    },
  );
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
    // The prefix was never swept: the discovered global host and the one
    // allocated address (the gateway) got an echo, nothing else.
    const pinged = execFile.mock.calls.filter((c) => c[0] === 'ping').map((c) => c[1].at(-1));
    expect(pinged.filter((t) => !t.startsWith('ff02')).sort()).toEqual(['fd00:5::1', 'fd00:5::a1']);
  });

  it('flags an unclaimed host as rogue on a stateful network', async () => {
    neighbors = new Map([['fd00:6::b1', { mac: 'aa:bb:cc:dd:ee:b1', interface: 'eth0', state: 'REACHABLE' }]]);
    responders.clear();
    responders.add('fd00:6::b1');
    const run = await scan(nets.stateful);
    expect(run.conflicts_found).toBe(1);
    expect(row('fd00:6::b1')).toMatchObject({ allocation_state: 'unassigned', is_rogue: 1, is_online: 1 });
  });

  it('records liveness only when the network has no scope', async () => {
    neighbors = new Map([['fd00:7::c1', { mac: null, interface: 'eth0', state: 'STALE' }]]);
    responders.clear();
    responders.add('fd00:7::c1');
    const run = await scan(nets.bare);
    expect(run.conflicts_found).toBe(0);
    expect(row('fd00:7::c1')).toMatchObject({ allocation_state: 'unassigned', is_rogue: 0, is_online: 1 });
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

describe('passive IPv6 source under each mode', () => {
  it('claims SLAAC on a SLAAC network and rogue on a stateful one', () => {
    neighbors = new Map([
      ['fd00:5::d1', { mac: 'aa:bb:cc:dd:ee:d1', interface: 'eth0', state: 'REACHABLE' }],
      ['fd00:6::d2', { mac: 'aa:bb:cc:dd:ee:d2', interface: 'eth0', state: 'REACHABLE' }],
    ]);
    recordDnsQueryLiveness(db, 'fd00:5::d1', { createRogue: true });
    recordDnsQueryLiveness(db, 'fd00:6::d2', { createRogue: true });
    expect(row('fd00:5::d1')).toMatchObject({ allocation_state: 'slaac', is_rogue: 0, detection_source: 'passive' });
    expect(row('fd00:6::d2')).toMatchObject({ allocation_state: 'unassigned', is_rogue: 1 });
  });
});
