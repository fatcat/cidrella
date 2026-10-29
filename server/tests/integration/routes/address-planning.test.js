/**
 * Phase 2 of docs/IPV6-HANDLING.md, in both families.
 *
 * Rule 2, GET /api/subnets/:id/suggest-address: one free address, never a
 * stored one, a pool address, a topology address, the gateway or an EUI-64
 * interface ID. Advisory: the write that uses it still goes through the
 * lifecycle service.
 *
 * Rule 3: pool use (`pool_size`, `pool_in_use`) on the tree and the summary,
 * and the summary's `by_state`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';
import { sortKey, isEui64InterfaceId } from '../../../src/utils/address.js';
import { addressToBig } from '../../../src/utils/cidr.js';

vi.mock('../../../src/services/backend-apply.js', async (importOriginal) =>
  (await import('../../helpers/fake-backends.js')).stubBackendApply(await importOriginal(), [
    'applyDns',
    'applyDhcp',
    'applyResolver',
  ]),
);
vi.mock('../../../src/backends/index.js', async () =>
  (await import('../../helpers/fake-backends.js')).fakeBackendsModule(),
);

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

// An allocated network through the real configure path, so its gateway,
// topology rows and DHCP pool are what an operator would have.
async function allocate(cidr, fields) {
  const created = await request(app).post('/api/subnets').send({ cidr });
  expect(created.status).toBe(201);
  const configured = await request(app)
    .post(`/api/subnets/${created.body.id}/configure`)
    .send({ name: `net ${cidr}`, ...fields });
  expect(configured.status).toBe(200);
  return created.body.id;
}

// An IPv4 network stores a row for every address once configured, so this
// claims the row there and adds one on IPv6.
function store(subnetId, ips, state = 'reserved') {
  const claim = db.prepare(
    'UPDATE ip_addresses SET allocation_state = ? WHERE subnet_id = ? AND ip_address = ?',
  );
  const insert = db.prepare(`
    INSERT INTO ip_addresses
      (subnet_id, ip_address, allocation_state, detection_source, address_family, address_sort_key)
    VALUES (?, ?, ?, 'manual', ?, ?)
  `);
  for (const ip of ips) {
    if (claim.run(state, subnetId, ip).changes) continue;
    insert.run(subnetId, ip, state, ip.includes(':') ? 6 : 4, sortKey(ip));
  }
}

const suggest = (id, query = '') => request(app).get(`/api/subnets/${id}/suggest-address${query}`);

const inPool = (ip, pool) => {
  const value = addressToBig(ip).value;
  return value >= addressToBig(pool.start_ip).value && value <= addressToBig(pool.end_ip).value;
};

function poolOf(subnetId) {
  return db
    .prepare(
      `SELECT r.start_ip, r.end_ip FROM ranges r JOIN range_types rt ON rt.id = r.range_type_id
        WHERE r.subnet_id = ? AND rt.name = 'DHCP Scope'`,
    )
    .get(subnetId);
}

describe('sequential suggestions', () => {
  it('IPv4: the first free address after the gateway and a stored run, jumping the pool', async () => {
    const id = await allocate('10.60.0.0/24', {
      gateway_policy: 'first',
      create_dhcp_scope: true,
      dhcp_start_ip: '10.60.0.10',
      dhcp_end_ip: '10.60.0.99',
    });
    store(id, ['10.60.0.2', '10.60.0.3', '10.60.0.4']);
    const first = await suggest(id);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      ip_address: '10.60.0.5',
      strategy: 'sequential',
      bounds: '10.60.0.0/24',
    });
    store(id, ['10.60.0.5', '10.60.0.6', '10.60.0.7', '10.60.0.8', '10.60.0.9']);
    // The pool is 10-99: the next free address is past it.
    expect((await suggest(id)).body.ip_address).toBe('10.60.0.100');
    expect((await suggest(id, '?from=10.60.0.200')).body.ip_address).toBe('10.60.0.200');
    // The broadcast address is never offered.
    store(
      id,
      Array.from({ length: 54 }, (_, index) => `10.60.0.${201 + index}`),
    );
    expect((await suggest(id, '?from=10.60.0.250')).status).toBe(404);
  });

  it('IPv6: starts at ::10, skips stored rows, the pool and EUI-64 interface IDs', async () => {
    const id = await allocate('fd00:60::/64', {
      gateway_policy: 'first',
      create_dhcp_scope: true,
      dhcp_v6_mode: 'stateful',
    });
    const pool = poolOf(id);
    expect(pool).toBeTruthy();
    const first = await suggest(id);
    expect(first.body.ip_address).toBe('fd00:60::10');
    store(id, ['fd00:60::10', 'fd00:60::11']);
    expect((await suggest(id)).body.ip_address).toBe('fd00:60::12');
    // From inside the pool, the answer is past it.
    const pastPool = (await suggest(id, `?from=${pool.start_ip}`)).body.ip_address;
    expect(inPool(pastPool, pool)).toBe(false);
    expect(addressToBig(pastPool).value).toBe(addressToBig(pool.end_ip).value + 1n);
    // An EUI-64 block is jumped as a whole.
    const eui = (await suggest(id, '?from=fd00:60::21a:2bff:fe00:0')).body.ip_address;
    expect(isEui64InterfaceId(eui)).toBe(false);
    expect(eui).toBe('fd00:60::21a:2bff:ff00:0');
  });

  it('never offers the network address, the gateway or a small prefix past its end', async () => {
    const v6 = await allocate('fd00:61::/125', { gateway_policy: 'first' });
    // ::10 is outside a /125, so the search starts at its first usable address.
    expect((await suggest(v6)).body.ip_address).toBe('fd00:61::2');
    const v4 = await allocate('10.61.0.0/30', { gateway_policy: 'first' });
    expect((await suggest(v4)).body.ip_address).toBe('10.61.0.2');
    store(v4, ['10.61.0.2']);
    const full = await suggest(v4);
    expect(full.status).toBe(404);
    expect(full.body.error).toBe('No free address in 10.61.0.0/30');
  });
});

describe('random suggestions', () => {
  it('stay inside the network and its bounds, in both families', async () => {
    const v6 = await allocate('fd00:62::/64', {
      gateway_policy: 'first',
      create_dhcp_scope: true,
      dhcp_v6_mode: 'stateful',
    });
    const pool = poolOf(v6);
    for (let index = 0; index < 20; index += 1) {
      const res = await suggest(v6, '?strategy=random');
      expect(res.body.strategy).toBe('random');
      const ip = res.body.ip_address;
      expect(ip.startsWith('fd00:62::')).toBe(true);
      expect(inPool(ip, pool)).toBe(false);
      expect(isEui64InterfaceId(ip)).toBe(false);
    }
    const inside = await suggest(v6, '?strategy=random&within=fd00:62::ab00/120');
    expect(addressToBig(inside.body.ip_address).value >> 8n).toBe(
      addressToBig('fd00:62::ab00').value >> 8n,
    );
  });

  it('falls back to the free address left in a crowded IPv4 network, and 404s on a full one', async () => {
    const id = await allocate('10.62.0.0/28', { gateway_policy: 'first' });
    // .1 is the gateway; store every host but .9.
    store(
      id,
      ['2', '3', '4', '5', '6', '7', '8', '10', '11', '12', '13', '14'].map((n) => `10.62.0.${n}`),
    );
    for (let index = 0; index < 5; index += 1) {
      expect((await suggest(id, '?strategy=random')).body.ip_address).toBe('10.62.0.9');
    }
    store(id, ['10.62.0.9']);
    expect((await suggest(id, '?strategy=random')).status).toBe(404);
  });
});

describe('bounds and refusals', () => {
  it('narrows to a CIDR or a range of the network, and refuses one outside it', async () => {
    const id = await allocate('10.63.0.0/24', { gateway_policy: 'first' });
    expect((await suggest(id, '?within=10.63.0.128/25')).body.ip_address).toBe('10.63.0.128');
    const range = await request(app)
      .post(`/api/subnets/${id}/ranges`)
      .send({ range_type_id: customRangeTypeId(), start_ip: '10.63.0.40', end_ip: '10.63.0.49' });
    expect(range.status).toBe(201);
    expect((await suggest(id, `?within=${range.body.id}`)).body.ip_address).toBe('10.63.0.40');
    expect((await suggest(id, '?within=10.64.0.0/24')).status).toBe(400);
    expect((await suggest(id, '?within=999999')).status).toBe(400);
    expect((await suggest(id, '?within=nonsense')).status).toBe(400);
    expect((await suggest(id, '?from=10.99.0.1')).status).toBe(400);
    expect((await suggest(id, '?strategy=sparse')).status).toBe(400);
    expect((await request(app).get('/api/subnets/999999/suggest-address')).status).toBe(404);
  });

  it('reserves nothing: the write that uses it still refuses a claim made in between', async () => {
    const id = await allocate('fd00:64::/64', { gateway_policy: 'first' });
    const { ip_address: ip } = (await suggest(id)).body;
    expect((await suggest(id)).body.ip_address).toBe(ip);
    const reserved = await request(app)
      .put(`/api/subnets/${id}/ips/${ip}/allocation`)
      .send({ allocation_state: 'reserved' });
    expect(reserved.status).toBe(200);
    expect((await suggest(id)).body.ip_address).not.toBe(ip);
    const gateway = db.prepare('SELECT gateway_address FROM subnets WHERE id = ?').get(id);
    const onGateway = await request(app)
      .put(`/api/subnets/${id}/ips/${gateway.gateway_address}/allocation`)
      .send({ allocation_state: 'reserved' });
    expect(onGateway.status).toBe(400);
  });
});

function customRangeTypeId() {
  const existing = db.prepare('SELECT id FROM range_types WHERE is_system = 0 LIMIT 1').get();
  if (existing) return existing.id;
  return Number(
    db
      .prepare("INSERT INTO range_types (name, color, is_system) VALUES ('Servers', '#888888', 0)")
      .run().lastInsertRowid,
  );
}

function lease(subnetId, ip, expires = "datetime('now', '+1 hour')") {
  db.prepare(
    `INSERT INTO dhcp_leases (subnet_id, ip_address, mac_address, expires_at, dhcp_version)
     VALUES (?, ?, '02:00:00:00:00:01', ${expires}, ?)`,
  ).run(subnetId, ip, ip.includes(':') ? 6 : 4);
}

const treeNode = async (id) => {
  const res = await request(app).get('/api/subnets');
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = walk(node.children || []);
      if (found) return found;
    }
    return null;
  };
  return walk(res.body.folders.flatMap((folder) => folder.subnets));
};

describe('pool use', () => {
  it('IPv4: the pool size and the active leases inside it, on the tree and the summary', async () => {
    const id = await allocate('10.70.0.0/24', {
      gateway_policy: 'first',
      create_dhcp_scope: true,
      dhcp_start_ip: '10.70.0.100',
      dhcp_end_ip: '10.70.0.199',
    });
    lease(id, '10.70.0.100');
    lease(id, '10.70.0.101');
    lease(id, '10.70.0.102', "datetime('now', '-1 hour')");
    lease(id, '10.70.0.20');
    const summary = (await request(app).get(`/api/subnets/${id}/summary`)).body;
    expect(summary).toMatchObject({ pool_size: '100', pool_in_use: 2 });
    expect(await treeNode(id)).toMatchObject({ pool_size: '100', pool_in_use: 2 });
  });

  it('IPv6: a stateful pool too big for a Number reads as a decimal string', async () => {
    const id = await allocate('fd00:70::/64', {
      gateway_policy: 'first',
      create_dhcp_scope: true,
      dhcp_v6_mode: 'stateful',
      dhcp_start_ip: 'fd00:70::1:0',
      dhcp_end_ip: 'fd00:70::ffff:ffff:ffff:ffff',
    });
    lease(id, 'fd00:70::1:5');
    lease(id, 'fd00:70::2');
    const size = (0xffffffffffffffffn - 0x10000n + 1n).toString();
    const summary = (await request(app).get(`/api/subnets/${id}/summary`)).body;
    expect(summary).toMatchObject({ pool_size: size, pool_in_use: 1 });
    expect(await treeNode(id)).toMatchObject({ pool_size: size, pool_in_use: 1 });
  });

  it('is null without an address pool: no scope, or a SLAAC one', async () => {
    const none = await allocate('10.71.0.0/24', { gateway_policy: 'first' });
    const slaac = await allocate('fd00:71::/64', {
      gateway_policy: 'first',
      create_dhcp_scope: true,
      dhcp_v6_mode: 'slaac',
    });
    for (const id of [none, slaac]) {
      expect((await request(app).get(`/api/subnets/${id}/summary`)).body).toMatchObject({
        pool_size: null,
        pool_in_use: null,
      });
      expect(await treeNode(id)).toMatchObject({ pool_size: null, pool_in_use: null });
    }
  });
});

describe('summary by_state', () => {
  it('counts each address under the states it holds, plus the seen ones, in both families', async () => {
    for (const [cidr, host] of [
      ['10.72.0.0/24', (n) => `10.72.0.${n}`],
      ['fd00:72::/64', (n) => `fd00:72::${n}`],
    ]) {
      const id = await allocate(cidr, { gateway_policy: 'first' });
      store(id, [host(20), host(21)]);
      store(id, [host(30)], 'static_dhcp');
      if (cidr.includes(':')) {
        store(id, [host(40)], 'unassigned');
      }
      db.prepare(
        'UPDATE ip_addresses SET is_online = 1 WHERE subnet_id = ? AND ip_address = ?',
      ).run(id, host(40));
      const { by_state: byState } = (await request(app).get(`/api/subnets/${id}/summary`)).body;
      expect(byState).toMatchObject({ reserved: 2, static_dhcp: 1, gateway: 1, seen: 1 });
    }
  });
});

describe('calculate paging', () => {
  const calc = (body) => request(app).post('/api/subnets/calculate').send(body);

  it('IPv6: a /48 into /64s comes a page at a time, with count, first and last', async () => {
    const res = await calc({ cidr: 'fd00:90::/48', new_prefix: 64 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      count: '65536',
      first: 'fd00:90::/64',
      last: 'fd00:90:0:ffff::/64',
      page: 1,
      page_size: 256,
    });
    expect(res.body.subnets).toHaveLength(256);
    expect(res.body.subnets[255].cidr).toBe('fd00:90:0:ff::/64');
    const middle = await calc({ cidr: 'fd00:90::/48', new_prefix: 64, page: 65, page_size: 512 });
    expect(middle.body.subnets[0].cidr).toBe('fd00:90:0:8000::/64');
    const lastPage = await calc({
      cidr: 'fd00:90::/48',
      new_prefix: 64,
      page: 16,
      page_size: 4096,
    });
    expect(lastPage.body.subnets.at(-1).cidr).toBe('fd00:90:0:ffff::/64');
    const past = await calc({ cidr: 'fd00:90::/48', new_prefix: 64, page: 999 });
    expect(past.body.subnets).toEqual([]);
  });

  it('IPv4: the pages together are the whole split', async () => {
    const pages = [];
    for (let page = 1; page <= 4; page += 1) {
      pages.push(
        ...(await calc({ cidr: '10.90.0.0/22', new_prefix: 28, page, page_size: 16 })).body.subnets,
      );
    }
    const whole = (await calc({ cidr: '10.90.0.0/22', new_prefix: 28, page_size: 4096 })).body;
    expect(whole.count).toBe('64');
    expect(pages.map((child) => child.cidr)).toEqual(whole.subnets.map((child) => child.cidr));
  });

  it('refuses a bad page or page size', async () => {
    for (const bad of [
      { page: 0 },
      { page: 1.5 },
      { page_size: 0 },
      { page_size: 4097 },
      { page_size: '9' },
    ]) {
      expect((await calc({ cidr: '10.90.0.0/24', new_prefix: 26, ...bad })).status).toBe(400);
    }
  });
});
