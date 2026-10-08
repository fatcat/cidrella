/**
 * What a full scan makes of a probe's answer.
 *
 * A host the scanner last saw online is not called offline on one missed
 * probe: it gets OFFLINE_CONFIRM_PINGS echoes first. WiFi clients drop
 * broadcast ARP and now and then a lone echo, so a host that is up can miss
 * both. A host that was already offline gets no retry.
 *
 * A MAC that differs from the stored one is a conflict only where DHCP sets
 * the MAC; anywhere else it replaces the stored one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../helpers/test-db.js';

// Hosts that answer only when several echoes are sent (the WiFi case), and
// hosts that answer ARP (a wired host). Everything else is silent.
const answersRetry = new Set();
const answersArp = new Set();
const arpMac = new Map();
const pings = [];
const execFile = vi.fn((cmd, args, opts, cb) => {
  const target = args[args.length - 1].split('%')[0];
  if (cmd === 'ping') {
    const count = Number(args[args.indexOf('-c') + 1]);
    pings.push([target, count]);
    const ok = target.startsWith('ff02::1') || (count > 1 && answersRetry.has(target));
    return cb(ok ? null : new Error('no reply'), '');
  }
  const ok = answersArp.has(target);
  return cb(
    ok ? null : new Error('no reply'),
    ok ? `60 bytes from ${arpMac.get(target) || '52:54:00:00:00:04'} (${target})` : '',
  );
});
vi.mock('child_process', () => ({ execFile: (...a) => execFile(...a), execFileSync: vi.fn() }));
vi.mock('../../src/utils/nd-cache.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readNdCache: () => new Map(),
  lookupNdEntry: () => null,
}));
vi.mock('../../src/utils/arp-cache.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readArpCache: () => new Map(),
}));

const { startScan } = await import('../../src/utils/scanner.js');
const { parseNetwork } = await import('../../src/utils/cidr.js');
const { insertSubnet, configureSubnet } = await import('../../src/services/subnet-topology.js');
const ScanRun = await import('../../src/models/scan-run.js');
const IpAddress = await import('../../src/models/ip-address.js');
const { invalidateSubnetCache } = await import('../../src/utils/ip-sync.js');
const { OFFLINE_CONFIRM_PINGS } = await import('../../src/config/defaults.js');

let db;
let tmpDir;

function network(cidr) {
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
    create_dhcp_scope: false,
  });
  invalidateSubnetCache();
  return Number(id);
}

const online = (ip) =>
  db.prepare('SELECT is_online FROM ip_addresses WHERE ip_address = ?').get(ip)?.is_online;
const retried = (ip) => pings.some(([target, count]) => target === ip && count > 1);

async function scan(subnetId) {
  const scanId = ScanRun.createPending(db, subnetId);
  await startScan(db, scanId, subnetId);
}

beforeAll(async () => {
  const setup = await setupTestDb();
  enableIpv6(setup.db);
  db = setup.db;
  tmpDir = setup.tmpDir;
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    eth0: [
      { family: 'IPv4', address: '10.71.0.6', internal: false },
      { family: 'IPv6', address: 'fd00:71::2', internal: false },
    ],
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

describe('confirming a missed probe before going offline', () => {
  it('keeps an IPv4 WiFi host online and retries nothing that answered or was offline', async () => {
    const subnetId = network('10.71.0.0/29');
    // .2 is a WiFi host that was online, .3 one that was already offline,
    // .4 a wired host that answers ARP.
    for (const [ip, isOnline] of [
      ['10.71.0.2', 1],
      ['10.71.0.3', 0],
      ['10.71.0.4', 1],
    ]) {
      IpAddress.upsert(db, subnetId, ip, { is_online: isOnline, detection_source: 'passive' });
    }
    answersRetry.add('10.71.0.2').add('10.71.0.3');
    answersArp.add('10.71.0.4');
    pings.length = 0;

    await scan(subnetId);

    expect(online('10.71.0.2')).toBe(1);
    expect(pings).toContainEqual(['10.71.0.2', OFFLINE_CONFIRM_PINGS]);
    expect(online('10.71.0.3')).toBe(0);
    expect(retried('10.71.0.3')).toBe(false);
    expect(online('10.71.0.4')).toBe(1);
    expect(retried('10.71.0.4')).toBe(false);

    // Once it stops answering even the retry, it goes offline.
    answersRetry.delete('10.71.0.2');
    await scan(subnetId);
    expect(online('10.71.0.2')).toBe(0);
  });

  it('keeps an IPv6 host online on a confirmed echo', async () => {
    const subnetId = network('fd00:71::/64');
    IpAddress.upsert(db, subnetId, 'fd00:71::20', { is_online: 1, detection_source: 'passive' });
    IpAddress.upsert(db, subnetId, 'fd00:71::21', { is_online: 1, detection_source: 'passive' });
    answersRetry.add('fd00:71::20');
    pings.length = 0;

    await scan(subnetId);

    expect(online('fd00:71::20')).toBe(1);
    expect(pings).toContainEqual(['fd00:71::20', OFFLINE_CONFIRM_PINGS]);
    expect(online('fd00:71::21')).toBe(0);
  });
});

describe('a different MAC answering', () => {
  it('replaces the stored MAC of a DNS-only address and flags a DHCP reservation', async () => {
    const subnetId = network('10.72.0.0/29');
    const setRow = (ip, state, mac) => {
      IpAddress.upsert(db, subnetId, ip, { is_online: 1, mac_address: mac });
      db.prepare(
        'UPDATE ip_addresses SET allocation_state = ? WHERE subnet_id = ? AND ip_address = ?',
      ).run(state, subnetId, ip);
    };
    // A VM recreated with a new NIC behind a DNS record, and one behind a
    // DHCP Reservation that still names the old NIC.
    setRow('10.72.0.2', 'static_dns', 'bc:24:11:00:00:01');
    setRow('10.72.0.3', 'static_dhcp', 'bc:24:11:00:00:03');
    for (const [ip, mac] of [
      ['10.72.0.2', 'bc:24:11:00:00:02'],
      ['10.72.0.3', 'bc:24:11:00:00:04'],
    ]) {
      answersArp.add(ip);
      arpMac.set(ip, mac);
    }
    const conflicts = () =>
      db
        .prepare(
          `SELECT ip_address, conflict_reason FROM scan_results
           WHERE is_conflict = 1 AND scan_id = (SELECT MAX(id) FROM network_scans WHERE subnet_id = ?)`,
        )
        .all(subnetId);
    const mac = (ip) =>
      db.prepare('SELECT mac_address FROM ip_addresses WHERE ip_address = ?').get(ip).mac_address;

    await scan(subnetId);
    expect(conflicts()).toEqual([
      {
        ip_address: '10.72.0.3',
        conflict_reason: 'MAC mismatch (expected bc:24:11:00:00:03, got bc:24:11:00:00:04)',
      },
    ]);
    expect(mac('10.72.0.2')).toBe('bc:24:11:00:00:02');
    expect(mac('10.72.0.3')).toBe('bc:24:11:00:00:03');

    // The next scan has nothing new to say about the DNS-only address.
    await scan(subnetId);
    expect(conflicts().map((row) => row.ip_address)).toEqual(['10.72.0.3']);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM ip_events WHERE ip_address = '10.72.0.2' AND event_type = 'mac_changed' AND source = 'scanner'",
        )
        .get().n,
    ).toBe(1);
  });
});
