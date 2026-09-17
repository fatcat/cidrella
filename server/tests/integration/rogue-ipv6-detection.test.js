/**
 * The two IPv6 rogue detectors against a real database.
 *
 * The DHCPv6 probe talks to a fake server on loopback: a udp6 socket that
 * answers our SOLICIT with an ADVERTISE, so the full path from packet build
 * to persisted event runs for real, on unprivileged ports. The Router
 * Advertisement check takes the kernel's route table and neighbor table as
 * parsed input, since a test cannot make the kernel hear an RA.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import dgram from 'dgram';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../helpers/test-db.js';

let tmpDir;
let db;
let runProbe6;
let checkRouterAdvertisements;
let parseRaRoutes;
let getRaState;
let RogueDhcp;
let parseIp;

const SERVER_DUID = '00:01:00:01:2a:2b:2c:2d:de:ad:be:ef:00:01';

function addressBytes(ip) {
  const { value } = parseIp(ip);
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64BE(value >> 64n, 0);
  buf.writeBigUInt64BE(value & 0xffffffffffffffffn, 8);
  return buf;
}

function option(code, data) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(code, 0);
  head.writeUInt16BE(data.length, 2);
  return Buffer.concat([head, data]);
}

function advertiseFor(solicit) {
  const head = Buffer.from([2, solicit[1], solicit[2], solicit[3]]);
  const iaAddr = Buffer.alloc(24);
  addressBytes('fd00:1234::1500').copy(iaAddr, 0);
  iaAddr.writeUInt32BE(3600, 16);
  iaAddr.writeUInt32BE(7200, 20);
  const iaNa = Buffer.concat([Buffer.alloc(12), option(5, iaAddr)]);
  return Buffer.concat([
    head,
    option(2, Buffer.from(SERVER_DUID.split(':').map((h) => parseInt(h, 16)))),
    option(3, iaNa),
    option(23, addressBytes('fd00:1234::bad')),
  ]);
}

// A fake DHCPv6 server on loopback. Resolves to { port, close }.
function startFakeServer() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp6');
    sock.on('error', reject);
    sock.on('message', (msg, rinfo) => {
      if (msg[0] !== 1) return; // SOLICIT only
      sock.send(advertiseFor(msg), rinfo.port, rinfo.address);
    });
    sock.bind(0, '::1', () => {
      resolve({ port: sock.address().port, close: () => sock.close() });
    });
  });
}

const LO = [{ ifName: 'lo', address: '::1', mac: '02:00:00:00:00:01', scopeid: 1 }];

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  ({ runProbe6 } = await import('../../src/utils/dhcpv6-probe.js'));
  ({ checkRouterAdvertisements, parseRaRoutes, getRaState } =
    await import('../../src/utils/ra-monitor.js'));
  RogueDhcp = await import('../../src/models/rogue-dhcp.js');
  ({ parseIp } = await import('../../src/utils/address.js'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  db.exec('DELETE FROM rogue_dhcp_events; DELETE FROM dhcp_authorized_servers;');
});

describe('DHCPv6 SOLICIT probe', () => {
  let server;
  beforeAll(async () => {
    server = await startFakeServer();
  });
  afterAll(() => server.close());

  const probe = (extra = {}) =>
    runProbe6(db, {
      windowMs: 300,
      destination: '::1',
      serverPort: server.port,
      clientPort: 0,
      interfaces: LO,
      leaseFile: path.join(tmpDir, 'dnsmasq', 'dnsmasq.leases'),
      ...extra,
    });

  it('records an unknown server that advertises, with its DUID, address and DNS', async () => {
    const result = await probe();
    expect(result.supported).toBe(true);
    expect(result.advertisements).toBe(1);
    expect(result.rogues).toHaveLength(1);
    const events = RogueDhcp.listEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'dhcpv6',
      address_family: 6,
      server_ip: '::1',
      server_duid: SERVER_DUID,
      server_identifier: SERVER_DUID,
      offered_ip: 'fd00:1234::1500',
      offered_dns: 'fd00:1234::bad',
      iface: 'lo',
      times_seen: 1,
    });
  });

  it('dedups a repeat detection into the same row', async () => {
    await probe();
    await probe();
    const events = RogueDhcp.listEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].times_seen).toBe(2);
  });

  it('trusts a server authorized by DUID', async () => {
    RogueDhcp.addAuthorized(db, { server_duid: SERVER_DUID });
    const result = await probe();
    expect(result.advertisements).toBe(1);
    expect(result.rogues).toEqual([]);
    expect(RogueDhcp.listEvents(db)).toEqual([]);
  });

  it("trusts dnsmasq's own DUID from the lease file header", async () => {
    const leaseFile = path.join(tmpDir, 'dnsmasq', 'dnsmasq.leases');
    fs.writeFileSync(leaseFile, `duid ${SERVER_DUID.toUpperCase()}\n`);
    try {
      const result = await probe();
      expect(result.advertisements).toBe(1);
      expect(result.rogues).toEqual([]);
    } finally {
      fs.rmSync(leaseFile, { force: true });
    }
  });

  it('reports no interfaces without opening a socket', async () => {
    const result = await probe({ interfaces: [] });
    expect(result).toEqual({ supported: true, interfaces: 0, advertisements: 0, rogues: [] });
  });
});

describe('Router Advertisement check', () => {
  const ROUTE_TABLE = `
default via fe80::1 dev eth0 proto ra metric 1024 expires 1755sec hoplimit 64 pref medium
default via fe80::bad dev eth0 proto ra metric 1024 expires 1790sec hoplimit 64 pref high
fd00:1234::/64 dev eth0 proto ra metric 1024 expires 86391sec pref medium
2001:db8:bad::/64 dev eth0 proto ra metric 1024 expires 1790sec pref medium
default via fe80::5 dev eth9 proto ra metric 1024 expires 1700sec hoplimit 64 pref medium
`;
  const NEIGHBORS = new Map([
    ['fe80::1', { mac: 'cc:cc:cc:cc:cc:cc', interface: 'eth0', state: 'REACHABLE' }],
    ['fe80::bad', { mac: 'de:ad:be:ef:00:02', interface: 'eth0', state: 'STALE' }],
  ]);
  const check = (extra = {}) =>
    checkRouterAdvertisements(db, {
      routes: parseRaRoutes(ROUTE_TABLE),
      interfaces: ['eth0'],
      neighbors: NEIGHBORS,
      supported: () => true,
      ...extra,
    });

  it('flags every learned router nobody vouches for, on watched interfaces only', () => {
    const result = check();
    expect(result.supported).toBe(true);
    expect(result.routers).toBe(2); // eth9 is not a probe interface
    expect(result.rogues.map((r) => r.server_ip).sort()).toEqual(['fe80::1', 'fe80::bad']);
    const events = RogueDhcp.listEvents(db);
    expect(events).toHaveLength(2);
    const bad = events.find((e) => e.server_ip === 'fe80::bad');
    expect(bad).toMatchObject({
      kind: 'ra',
      address_family: 6,
      server_mac: 'de:ad:be:ef:00:02',
      offered_gateway: 'fe80::bad',
      advertised_prefixes: 'fd00:1234::/64,2001:db8:bad::/64',
      iface: 'eth0',
    });
    expect(getRaState()).toMatchObject({ lastOutcome: 'ok', supported: true });
  });

  it('trusts the router whose MAC belongs to a configured gateway', () => {
    const subnet = db
      .prepare(
        `INSERT INTO subnets (cidr, name, network_address, last_address, prefix_length,
          address_family, status, depth, gateway_address, gateway_policy)
         VALUES ('fd00:1234::/64', 'lab6', 'fd00:1234::', 'fd00:1234:0:0:ffff:ffff:ffff:ffff',
          64, 6, 'allocated', 0, 'fd00:1234::1', 'first')`,
      )
      .run().lastInsertRowid;
    db.prepare(
      `INSERT INTO ip_addresses (subnet_id, ip_address, allocation_state, address_family,
        address_sort_key, mac_address) VALUES (?, 'fd00:1234::1', 'gateway', 6, ?, 'CC:CC:CC:CC:CC:CC')`,
    ).run(subnet, '6' + 'fd001234'.padEnd(32, '0'));
    try {
      const result = check();
      expect(result.rogues.map((r) => r.server_ip)).toEqual(['fe80::bad']);
    } finally {
      db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(subnet);
      db.prepare('DELETE FROM subnets WHERE id = ?').run(subnet);
    }
  });

  it('trusts an allowlisted router by link-local or MAC', () => {
    RogueDhcp.addAuthorized(db, { server_ip: 'fe80::1' });
    RogueDhcp.addAuthorized(db, { server_mac: 'de:ad:be:ef:00:02' });
    expect(check().rogues).toEqual([]);
    expect(RogueDhcp.listEvents(db)).toEqual([]);
  });

  it('says so when no interface accepts Router Advertisements', () => {
    const result = check({ supported: () => false });
    expect(result).toEqual({ supported: false, interfaces: 1, routers: 0, rogues: [] });
    expect(getRaState()).toMatchObject({
      lastOutcome: 'unsupported',
      supported: false,
      unsupportedInterfaces: ['eth0'],
    });
    expect(getRaState().lastError).toContain('accept_ra');
  });

  it('reads only interfaces where RAs are accepted', () => {
    const result = check({
      interfaces: ['eth0', 'eth9'],
      supported: (name) => name === 'eth9',
    });
    expect(result.routers).toBe(1);
    expect(result.rogues.map((r) => r.server_ip)).toEqual(['fe80::5']);
    expect(getRaState()).toMatchObject({
      supportedInterfaces: ['eth9'],
      unsupportedInterfaces: ['eth0'],
    });
  });
});
