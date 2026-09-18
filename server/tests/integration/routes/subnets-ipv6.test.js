/**
 * IPv6 networks through the subnet routes. IPv6 has no broadcast address, the
 * subnet-router anycast (network) address is the only system row, nothing is
 * materialized per address, and the listing is sparse.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateConfigs: vi.fn(),
    applyInterfaceConfig: vi.fn(),
    regenerateDnsmasqConf: vi.fn(),
    signalDnsmasq: vi.fn(),
    restartDnsmasq: vi.fn(),
  };
});

vi.mock('../../../src/utils/dhcp.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateDhcpConfigs: vi.fn(),
    startLeaseWatcher: vi.fn(),
  };
});

const { default: subnetRouter } = await import('../../../src/routes/subnets.js');
const { default: rangeRouter } = await import('../../../src/routes/ranges.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;
let db;

beforeAll(async () => {
  const setup = await setupTestDb();
  enableIpv6(setup.db);
  tmpDir = setup.tmpDir;
  db = setup.db;
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/subnets/:subnetId/ranges', router: rangeRouter },
  ]);
});

afterAll(() => cleanupTestDb(tmpDir));

const LAB = 'fd00:1234::/48';
const NET = 'fd00:1234:0:1::/64';

describe('IPv6 networks', () => {
  let labId;
  let netId;

  it('creates an IPv6 supernet with the IPv6 shape', async () => {
    const res = await request(app)
      .post('/api/subnets')
      .send({ cidr: 'FD00:1234:0000::/48', name: 'lab6' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      cidr: LAB,
      address_family: 6,
      network_address: 'fd00:1234::',
      broadcast_address: null,
      last_address: 'fd00:1234:0:ffff:ffff:ffff:ffff:ffff',
      prefix_length: 48,
      total_addresses: null,
      status: 'unallocated',
    });
    labId = res.body.id;
  });

  it('refuses a prefix that straddles a reserved block, and an overlapping root', async () => {
    // Inside a reserved block is fine (10.0.0.0/8 is the IPv4 precedent);
    // reaching past its edge is not.
    const straddles = await request(app).post('/api/subnets').send({ cidr: 'fc00::/6' });
    expect(straddles.status).toBe(400);
    expect(straddles.body.error).toContain('fc00::/7');
    const overlap = await request(app).post('/api/subnets').send({ cidr: 'fd00:1234:0:5::/64' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error).toContain(LAB);
  });

  it('previews configuration with IPv6 gateway semantics and the stateful default pool', async () => {
    const res = await request(app)
      .post('/api/subnets/configuration-preview')
      .send({ cidr: NET, gateway_policy: 'last' });
    expect(res.status).toBe(200);
    expect(res.body.gateway_address).toBe('fd00:1234:0:1:ffff:ffff:ffff:ffff');
    expect(res.body.address_family).toBe(6);
    expect(res.body.default_dhcp_pool).toEqual({
      start_ip: 'fd00:1234:0:1::1000',
      end_ip: 'fd00:1234:0:1::1fff',
    });
    expect(res.body.dhcp_v6_modes).toEqual(['slaac', 'stateless', 'stateful']);
    const bad = await request(app)
      .post('/api/subnets/configuration-preview')
      .send({ cidr: NET, gateway_address: '10.0.0.1' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('IPv6');
  });

  it('divides the /48 into /64 children with the family prefix bound', async () => {
    const tooLong = await request(app)
      .post(`/api/subnets/${labId}/divide/preview`)
      .send({ new_prefix: 129 });
    expect(tooLong.status).toBe(400);

    const preview = await request(app)
      .post(`/api/subnets/${labId}/divide/preview`)
      .send({ new_prefix: 52 });
    expect(preview.status).toBe(200);
    expect(preview.body.count).toBe(16);
    expect(preview.body.subnets[1]).toBe('fd00:1234:0:1000::/52');

    const carve = await request(app)
      .post(`/api/subnets/${labId}/divide`)
      .send({ cidr: NET });
    expect(carve.status).toBe(200);
    const cidrs = carve.body.children.map((child) => child.cidr);
    expect(cidrs).toContain(NET);
    expect(cidrs).toContain('fd00:1234::/64');
    expect(cidrs).toContain('fd00:1234:0:8000::/49');
    netId = carve.body.children.find((child) => child.cidr === NET).id;
    for (const child of carve.body.children) {
      expect(child.address_family).toBe(6);
      expect(child.broadcast_address).toBeNull();
    }
  });

  it('allocates a /64 with only the anycast and gateway rows', async () => {
    const res = await request(app)
      .post(`/api/subnets/${netId}/configure`)
      .send({ name: 'lab6-net1', gateway_policy: 'first', create_reverse_dns: false });
    expect(res.status).toBe(200);
    expect(res.body.gateway_address).toBe('fd00:1234:0:1::1');
    expect(res.body.status).toBe('allocated');

    const rows = db
      .prepare('SELECT ip_address, allocation_state FROM ip_addresses WHERE subnet_id = ? ORDER BY ip_address')
      .all(netId);
    expect(rows).toEqual([
      { ip_address: 'fd00:1234:0:1::', allocation_state: 'system' },
      { ip_address: 'fd00:1234:0:1::1', allocation_state: 'gateway' },
    ]);
    const ranges = db
      .prepare(
        `SELECT rt.name FROM ranges r JOIN range_types rt ON rt.id = r.range_type_id
         WHERE r.subnet_id = ? ORDER BY rt.name`,
      )
      .all(netId)
      .map((row) => row.name);
    expect(ranges).toEqual(['Gateway', 'Network']);
  });

  it('lists the network sparsely and summarizes without a total', async () => {
    const list = await request(app).get(`/api/subnets/${netId}/ips`);
    expect(list.status).toBe(200);
    expect(list.body.sparse).toBe(true);
    expect(list.body.totalIps).toBeNull();
    expect(list.body.filteredTotal).toBe(2);
    expect(list.body.ips.map((row) => [row.ip_address, row.allocation_state])).toEqual([
      ['fd00:1234:0:1::', 'system'],
      ['fd00:1234:0:1::1', 'gateway'],
    ]);

    const filtered = await request(app)
      .get(`/api/subnets/${netId}/ips`)
      .query({ address_type: 'gateway' });
    expect(filtered.body.ips).toHaveLength(1);
    expect(filtered.body.ips[0].ip_address).toBe('fd00:1234:0:1::1');

    const summary = await request(app).get(`/api/subnets/${netId}/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      total_addresses: null,
      assigned_count: 2,
      unassigned_count: null,
    });
  });

  it('reserves an address, refuses the protected ones, and reads a virtual row', async () => {
    const reserve = await request(app)
      .put(`/api/subnets/${netId}/ips/FD00:1234:0:1::10/allocation`)
      .send({ allocation_state: 'reserved', note: 'printer' });
    expect(reserve.status).toBe(200);
    expect(reserve.body.ip_address).toBe('fd00:1234:0:1::10');

    const anycast = await request(app)
      .put(`/api/subnets/${netId}/ips/fd00:1234:0:1::/allocation`)
      .send({ allocation_state: 'reserved' });
    expect(anycast.status).toBe(400);
    expect(anycast.body.error).toContain('network address');

    const gateway = await request(app)
      .put(`/api/subnets/${netId}/ips/fd00:1234:0:1::1/allocation`)
      .send({ allocation_state: 'reserved' });
    expect(gateway.status).toBe(400);

    const outside = await request(app)
      .put(`/api/subnets/${netId}/ips/fd00:1234:0:2::10/allocation`)
      .send({ allocation_state: 'reserved' });
    expect(outside.status).toBe(400);

    const v4 = await request(app)
      .put(`/api/subnets/${netId}/ips/10.0.0.1/allocation`)
      .send({ allocation_state: 'reserved' });
    expect(v4.status).toBe(400);

    const virtual = await request(app).get(`/api/subnets/${netId}/ips/fd00:1234:0:1::abcd`);
    expect(virtual.status).toBe(200);
    expect(virtual.body.ip).toMatchObject({
      ip_address: 'fd00:1234:0:1::abcd',
      allocation_state: 'unassigned',
    });

    const bulk = await request(app)
      .put(`/api/subnets/${netId}/ips/bulk-allocation`)
      .send({ start_ip: 'fd00:1234:0:1::100', end_ip: 'fd00:1234:0:1::103', allocation_state: 'reserved' });
    expect(bulk.status).toBe(200);
    expect(bulk.body.count).toBe(4);

    const tooBig = await request(app)
      .put(`/api/subnets/${netId}/ips/bulk-allocation`)
      .send({ start_ip: 'fd00:1234:0:1::', end_ip: 'fd00:1234:0:1::ffff', allocation_state: 'reserved' });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toContain('1024');

    // Search is a substring match, so the bulk block's ::100 to ::103 match too.
    const list = await request(app).get(`/api/subnets/${netId}/ips`).query({ search: 'fd00:1234:0:1::10' });
    expect(list.body.ips.map((row) => row.ip_address)).toEqual([
      'fd00:1234:0:1::10',
      'fd00:1234:0:1::100',
      'fd00:1234:0:1::101',
      'fd00:1234:0:1::102',
      'fd00:1234:0:1::103',
    ]);
  });

  it('holds a custom range on an IPv6 network', async () => {
    const type = db
      .prepare("INSERT INTO range_types (name, color, is_system) VALUES ('Printers6', '#123456', 0)")
      .run().lastInsertRowid;
    const res = await request(app)
      .post(`/api/subnets/${netId}/ranges`)
      .send({ range_type_id: Number(type), start_ip: 'fd00:1234:0:1::200', end_ip: 'fd00:1234:0:1::2ff' });
    expect(res.status).toBe(201);
    const wrongFamily = await request(app)
      .post(`/api/subnets/${netId}/ranges`)
      .send({ range_type_id: Number(type), start_ip: '10.0.0.1', end_ip: '10.0.0.5' });
    expect(wrongFamily.status).toBe(400);
  });

  it('calculates IPv6 splits and refuses oversized ones', async () => {
    const res = await request(app)
      .post('/api/subnets/calculate')
      .send({ cidr: '2001:db8::/32', new_prefix: 36 });
    expect(res.status).toBe(200);
    expect(res.body.subnets).toHaveLength(16);
    expect(res.body.subnets[15].cidr).toBe('2001:db8:f000::/36');
    expect(res.body.parent.size).toBeNull();

    const huge = await request(app)
      .post('/api/subnets/calculate')
      .send({ cidr: '2001:db8::/32', new_prefix: 64 });
    expect(huge.status).toBe(400);
    expect(huge.body.error).toContain('maximum');

    const v4Bound = await request(app)
      .post('/api/subnets/calculate')
      .send({ cidr: '10.0.0.0/8', new_prefix: 40 });
    expect(v4Bound.status).toBe(400);
  });

  it('merges unallocated IPv6 buddies back together', async () => {
    const spare = db.prepare("SELECT id FROM subnets WHERE cidr = 'fd00:1234::/64'").get().id;
    const divide = await request(app).post(`/api/subnets/${spare}/divide`).send({ new_prefix: 66 });
    expect(divide.status).toBe(200);
    const quarters = divide.body.children.map((child) => child.cidr);
    // RFC 5952 compresses the longest zero run, which is the trailing one here.
    expect(quarters).toEqual([
      'fd00:1234::/66',
      'fd00:1234:0:0:4000::/66',
      'fd00:1234:0:0:8000::/66',
      'fd00:1234:0:0:c000::/66',
    ]);
    const ids = divide.body.children.slice(0, 2).map((child) => child.id);

    const odd = await request(app)
      .post('/api/subnets/merge/preview')
      .send({ subnet_ids: divide.body.children.slice(1, 3).map((child) => child.id) });
    expect(odd.status).toBe(400);
    expect(odd.body.error).toContain('boundary');

    const preview = await request(app).post('/api/subnets/merge/preview').send({ subnet_ids: ids });
    expect(preview.status).toBe(200);
    expect(preview.body.merged_cidr).toBe('fd00:1234::/65');

    const merge = await request(app).post('/api/subnets/merge').send({ subnet_ids: ids });
    expect(merge.status).toBe(200);
    const merged = merge.body.children.find((child) => child.cidr === 'fd00:1234::/65');
    expect(merged).toMatchObject({ address_family: 6, broadcast_address: null, status: 'unallocated' });
    // Only the requested pair merges; the other quarters stay as they are.
    // The server orders children numerically, not by text.
    expect(merge.body.children.map((child) => child.cidr)).toEqual([
      'fd00:1234::/65',
      'fd00:1234:0:0:8000::/66',
      'fd00:1234:0:0:c000::/66',
    ]);
  });
});
