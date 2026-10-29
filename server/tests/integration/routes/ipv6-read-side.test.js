/**
 * The IPv6 read side (docs/IPV6-HANDLING.md, rules 1, 6 and 7): an IPv6
 * network is an inventory, so Show available is ignored there; search knows
 * expanded spellings and CIDR queries in both families; the plain address
 * list, the summary and the network search read SQL instead of every row.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';
import { sortKey } from '../../../src/utils/address.js';
import { addressToBig, bigToAddress } from '../../../src/utils/cidr.js';

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
const { default: workspaceRouter } = await import('../../../src/routes/workspace.js');
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
    { prefix: '/api/workspace', router: workspaceRouter },
  ]);
});

afterAll(() => cleanupTestDb(tmpDir));

// An allocated leaf with a gateway. The read side only reads these columns,
// so the fixture sets them rather than walking the allocation flow.
async function createNetwork(cidr, name, gateway) {
  const res = await request(app).post('/api/subnets').send({ cidr, name });
  expect(res.status).toBe(201);
  db.prepare("UPDATE subnets SET status = 'allocated', gateway_address = ? WHERE id = ?").run(
    gateway,
    res.body.id,
  );
  return res.body.id;
}

function storeAddresses(subnetId, rows) {
  const insert = db.prepare(`
    INSERT INTO ip_addresses
      (subnet_id, ip_address, hostname, allocation_state, is_online, is_rogue,
       detection_source, address_family, address_sort_key)
    VALUES (@subnet_id, @ip, @hostname, @state, @online, @rogue, 'scanner', @family, @key)
  `);
  db.transaction(() => {
    for (const row of rows) {
      insert.run({
        subnet_id: subnetId,
        hostname: null,
        state: 'unassigned',
        online: 0,
        rogue: 0,
        ...row,
        family: row.ip.includes(':') ? 6 : 4,
        key: sortKey(row.ip),
      });
    }
  })();
}

const addresses = (res) => res.body.ips.map((row) => row.ip_address);

describe('SQL paging of an IPv6 network', () => {
  const NET = 'fd00:77::/64';
  const GATEWAY = 'fd00:77::8000';
  let netId;

  beforeAll(async () => {
    netId = await createNetwork(NET, 'paged6', GATEWAY);
    // Nothing stored for the network address or the gateway: both are
    // placed into the page they sort into.
    db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(netId);
    const base = addressToBig('fd00:77::').value;
    const rows = [];
    for (let index = 1; index <= 10000; index += 1) {
      rows.push({ ip: bigToAddress(base + BigInt(index * 7), 6) });
    }
    storeAddresses(netId, rows);
  });

  it('pages the plain view exactly as the in-memory listing does', async () => {
    const pageSize = 997;
    // A column sort takes the in-memory path; by address it is the same order.
    const plain = (page) =>
      request(app).get(`/api/subnets/${netId}/ips?page=${page}&pageSize=${pageSize}`);
    const inMemory = (page) =>
      request(app).get(
        `/api/subnets/${netId}/ips?page=${page}&pageSize=${pageSize}&sort_column=ip_address`,
      );
    const first = await plain(1);
    expect(first.status).toBe(200);
    expect(first.body.filteredTotal).toBe(10002);
    expect(first.body.totalPages).toBe(Math.ceil(10002 / pageSize));
    expect(first.body.ips[0]).toMatchObject({
      ip_address: 'fd00:77::',
      allocation_state: 'system',
    });
    const seen = [];
    for (let page = 1; page <= first.body.totalPages; page += 1) {
      const [fast, slow] = await Promise.all([plain(page), inMemory(page)]);
      expect(addresses(fast)).toEqual(addresses(slow));
      expect(fast.body).toMatchObject({
        filteredTotal: slow.body.filteredTotal,
        totalPages: slow.body.totalPages,
        page,
      });
      seen.push(...addresses(fast));
    }
    expect(seen).toHaveLength(10002);
    expect(new Set(seen).size).toBe(10002);
    // The gateway sorts between ::7fff (7 x 4681) and ::8006 (7 x 4682).
    const gateway = seen.indexOf(GATEWAY);
    expect(seen.slice(gateway - 1, gateway + 2)).toEqual([
      'fd00:77::7fff',
      GATEWAY,
      'fd00:77::8006',
    ]);
  });

  it('clamps a page past the end to the last page', async () => {
    const res = await request(app).get(`/api/subnets/${netId}/ips?page=999&pageSize=4096`);
    expect(res.body.page).toBe(3);
    expect(res.body.ips).toHaveLength(10002 - 2 * 4096);
    expect(res.body.ips.at(-1).ip_address).toBe('fd00:77::1:1170');
  });
});

describe('Show available', () => {
  it('is ignored on an IPv6 network', async () => {
    const netId = await createNetwork('fd00:78::/64', 'avail6', 'fd00:78::1');
    const searched = await request(app).get(
      `/api/subnets/${netId}/ips?showAvailable=false&search=fd00:78::abcd`,
    );
    expect(addresses(searched)).toEqual(['fd00:78::abcd']);
    expect(searched.body.ips[0].ip_display_status).toBe('available');
    const plain = await request(app).get(`/api/subnets/${netId}/ips?showAvailable=false`);
    expect(addresses(plain)).toContain('fd00:78::');
  });

  it('still hides available addresses on an IPv4 network', async () => {
    const netId = await createNetwork('10.78.0.0/29', 'avail4', '10.78.0.1');
    const res = await request(app).get(`/api/subnets/${netId}/ips?showAvailable=false`);
    expect(res.body.ips.every((row) => row.ip_display_status !== 'available')).toBe(true);
    const all = await request(app).get(`/api/subnets/${netId}/ips`);
    expect(all.body.ips.some((row) => row.ip_display_status === 'available')).toBe(true);
  });
});

describe('address search', () => {
  let v6Id;
  let v4Id;

  beforeAll(async () => {
    v6Id = await createNetwork('2001:db8:5::/64', 'doc6', '2001:db8:5::fffe');
    storeAddresses(v6Id, [{ ip: '2001:db8:5::1' }, { ip: '2001:db8:5::2:1' }]);
    v4Id = await createNetwork('10.79.0.0/24', 'search4', '10.79.0.1');
    storeAddresses(v4Id, [{ ip: '10.79.0.5' }, { ip: '10.79.0.200' }]);
  });

  const search = (id, query, param = 'table_search') =>
    request(app).get(`/api/subnets/${id}/ips?${param}=${encodeURIComponent(query)}`);

  it('matches an IPv6 address by its expanded spelling and by a compressed fragment', async () => {
    expect(addresses(await search(v6Id, '2001:0db8:0005'))).toEqual(
      expect.arrayContaining(['2001:db8:5::1', '2001:db8:5::2:1']),
    );
    expect(addresses(await search(v6Id, '0000:0002:0001'))).toEqual(['2001:db8:5::2:1']);
    expect(addresses(await search(v6Id, 'db8:5::2'))).toEqual(['2001:db8:5::2:1']);
  });

  it('matches the addresses inside a CIDR, in either search box', async () => {
    for (const param of ['search', 'table_search']) {
      const inside = addresses(await search(v6Id, '2001:db8:5::/112', param));
      expect(inside).toContain('2001:db8:5::1');
      expect(inside).not.toContain('2001:db8:5::2:1');
    }
    expect(addresses(await search(v6Id, '2001:db8::/32'))).toEqual(
      expect.arrayContaining(['2001:db8:5::1', '2001:db8:5::2:1', '2001:db8:5::fffe']),
    );
    expect(addresses(await search(v6Id, '10.0.0.0/8'))).toEqual([]);
  });

  it('matches the stored IPv4 addresses inside a CIDR', async () => {
    const inside = addresses(await search(v4Id, '10.79.0.0/25'));
    expect(inside).toContain('10.79.0.5');
    expect(inside).not.toContain('10.79.0.200');
    expect(addresses(await search(v4Id, 'fd00::/8'))).toEqual([]);
  });
});

describe('summary', () => {
  it('counts an IPv6 network in SQL, each address once', async () => {
    const netId = await createNetwork('fd00:7a::/64', 'summary6', 'fd00:7a::1');
    storeAddresses(netId, [
      { ip: 'fd00:7a::10', state: 'reserved', online: 1 },
      { ip: 'fd00:7a::11', online: 1 },
      { ip: 'fd00:7a::12', rogue: 1 },
      { ip: 'fd00:7a::13' },
    ]);
    const res = await request(app).get(`/api/subnets/${netId}/summary`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      subnet_id: netId,
      total_addresses: null,
      // The four stored rows, the network address and the gateway.
      known_count: 6,
      assigned_count: 3,
      unassigned_count: null,
      online_count: 2,
      rogue_count: 2,
      // ::11 is online and ::12 rogue, neither claimed: both seen.
      by_state: { reserved: 1, gateway: 1, system: 1, seen: 2 },
      pool_size: null,
      pool_in_use: null,
    });
  });
});

describe('network search', () => {
  let v6Id;
  let v4Id;

  beforeAll(async () => {
    v6Id = await createNetwork('2001:db8:9:1::/64', 'netsearch6', '2001:db8:9:1::1');
    storeAddresses(v6Id, [{ ip: '2001:db8:9:1::abc', hostname: 'camera-6' }]);
    v4Id = await createNetwork('10.81.4.0/24', 'netsearch4', '10.81.4.1');
    storeAddresses(v4Id, [{ ip: '10.81.4.77', hostname: 'camera-4' }]);
  });

  const found = async (query) => {
    const res = await request(app).get(`/api/workspace/networks?q=${encodeURIComponent(query)}`);
    expect(res.status).toBe(200);
    return res.body.items.map((network) => network.id);
  };

  it('finds the networks inside a CIDR and the one containing it, never the other family', async () => {
    expect(await found('2001:db8:9::/48')).toContain(v6Id);
    expect(await found('2001:db8:9:1::/96')).toContain(v6Id);
    expect(await found('2001:db8:9:2::/64')).not.toContain(v6Id);
    expect(await found('10.81.0.0/16')).toContain(v4Id);
    expect(await found('10.81.4.128/25')).toContain(v4Id);
    const v4Only = await found('10.0.0.0/8');
    expect(v4Only).not.toContain(v6Id);
  });

  it('finds a network by an address in its expanded spelling', async () => {
    expect(await found('0009:0001:0000:0000:0000:0abc')).toEqual([v6Id]);
    expect(await found('2001:db8:9:1:0:0:0:abc')).toEqual([v6Id]);
  });

  it('still finds a network by a stored hostname, MAC or address fragment', async () => {
    expect(await found('camera-6')).toEqual([v6Id]);
    expect(await found('CAMERA-4')).toEqual([v4Id]);
    expect(await found('81.4.77')).toEqual([v4Id]);
  });
});
