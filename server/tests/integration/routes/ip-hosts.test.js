/**
 * GET /api/subnets/:id/hosts (docs/IPV6-HANDLING.md rule 5), both families:
 * a network's addresses grouped into devices, paged by host, with the other
 * family's addresses of a dual stack host. A projection: nothing is written.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';
import { sortKey } from '../../../src/utils/address.js';

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
const { default: request } = await import('supertest');

let tmpDir;
let app;
let db;
let v4;
let v6;

const PHONE_MAC = 'aa:bb:cc:00:00:01';
const DHCP6_DUID = '00:02:00:00:ab:11:01:02:03:04';
const LAPTOP_MAC = '00:1a:2b:3c:4d:5e';

async function allocate(cidr) {
  const created = await request(app).post('/api/subnets').send({ cidr });
  expect(created.status).toBe(201);
  const configured = await request(app)
    .post(`/api/subnets/${created.body.id}/configure`)
    .send({ name: `net ${cidr}` });
  expect(configured.status).toBe(200);
  return created.body.id;
}

// Claims the IPv4 placeholder row, or adds the IPv6 row.
function store(subnetId, ip, fields) {
  const family = ip.includes(':') ? 6 : 4;
  const existing = db
    .prepare('SELECT id FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?')
    .get(subnetId, ip);
  const columns = { allocation_state: 'unassigned', detection_source: 'scanner', ...fields };
  if (existing) {
    const sets = Object.keys(columns).map((k) => `${k} = ?`);
    db.prepare(`UPDATE ip_addresses SET ${sets.join(', ')} WHERE id = ?`).run(
      ...Object.values(columns),
      existing.id,
    );
    return;
  }
  const all = { ...columns, subnet_id: subnetId, ip_address: ip, address_family: family };
  all.address_sort_key = sortKey(ip);
  const names = Object.keys(all);
  db.prepare(
    `INSERT INTO ip_addresses (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  ).run(...Object.values(all));
}

const hosts = (id, query = '') => request(app).get(`/api/subnets/${id}/hosts${query}`);

beforeAll(async () => {
  const setup = await setupTestDb();
  enableIpv6(setup.db);
  tmpDir = setup.tmpDir;
  db = setup.db;
  app = createMultiRouterApp([{ prefix: '/api/subnets', router: subnetRouter }]);

  v4 = await allocate('10.70.0.0/24');
  v6 = await allocate('fd00:70::/64');

  // A dual stack laptop: EUI-64 and a SLAAC address on IPv6, a DHCPv4 lease.
  store(v6, 'fd00:70::21a:2bff:fe3c:4d5e', { allocation_state: 'slaac' });
  store(v6, 'fd00:70::7f2e:91c4:aa01:3b6d', {
    allocation_state: 'slaac',
    last_seen_mac: LAPTOP_MAC,
    hostname: 'laptop',
  });
  db.prepare(
    `INSERT INTO dhcp_leases (ip_address, mac_address, expires_at, subnet_id, dhcp_version)
     VALUES ('10.70.0.150', ?, 'infinite', ?, 4)`,
  ).run(LAPTOP_MAC, v4);
  // A DUID-only DHCPv6 client, and a phone seen by the neighbor table.
  store(v6, 'fd00:70::100', {
    allocation_state: 'dynamic_dhcp',
    dhcp_duid: DHCP6_DUID,
    dhcp_version: 6,
    detection_source: 'dhcpv6_lease',
  });
  store(v6, 'fd00:70::aaaa', { allocation_state: 'slaac', last_seen_mac: PHONE_MAC });
  store(v6, 'fd00:70::bbbb', { allocation_state: 'slaac', last_seen_mac: PHONE_MAC });
  // IPv4: the phone again, and a reserved address with no MAC.
  store(v4, '10.70.0.20', { allocation_state: 'reserved', mac_address: PHONE_MAC });
  store(v4, '10.70.0.30', { allocation_state: 'reserved', hostname: 'printer' });
});

afterAll(() => cleanupTestDb(tmpDir));

describe('GET /api/subnets/:id/hosts', () => {
  it('groups an IPv6 network into devices', async () => {
    const res = await hosts(v6);
    expect(res.status).toBe(200);
    // The gateway is a device too: a host of one until something names its MAC.
    expect(res.body).toMatchObject({ total: 4, page: 1, page_size: 50, total_pages: 1 });
    expect(res.body.hosts.map((h) => h.key)).toEqual([
      'address:fd00:70::1',
      `duid:${DHCP6_DUID}`,
      `mac:${PHONE_MAC}`,
      `mac:${LAPTOP_MAC}`,
    ]);
    const byKey = Object.fromEntries(res.body.hosts.map((h) => [h.key, h]));
    expect(byKey[`mac:${LAPTOP_MAC}`]).toMatchObject({ name: 'laptop', stable_count: 1 });
    expect(byKey[`mac:${PHONE_MAC}`].addresses.map((a) => a.ip_address)).toEqual([
      'fd00:70::aaaa',
      'fd00:70::bbbb',
    ]);
  });

  it('lists a dual stack host’s IPv4 addresses, from rows and leases', async () => {
    const res = await hosts(v6);
    const byKey = Object.fromEntries(res.body.hosts.map((h) => [h.key, h]));
    expect(byKey[`mac:${LAPTOP_MAC}`].other_family).toEqual([
      expect.objectContaining({ ip_address: '10.70.0.150', subnet_id: v4, source: 'lease' }),
    ]);
    expect(byKey[`mac:${PHONE_MAC}`].other_family).toEqual([
      expect.objectContaining({ ip_address: '10.70.0.20', cidr: '10.70.0.0/24' }),
    ]);
    expect(byKey[`duid:${DHCP6_DUID}`].other_family).toEqual([]);
  });

  it('groups IPv4 the same way and skips the empty placeholder rows', async () => {
    const res = await hosts(v4);
    expect(res.status).toBe(200);
    const keys = res.body.hosts.map((h) => h.key);
    expect(keys).toContain(`mac:${PHONE_MAC}`);
    expect(keys).toContain('address:10.70.0.30');
    // A /24 stores 256 rows; only the ones with facts are hosts.
    expect(res.body.total).toBeLessThan(10);
    const phone = res.body.hosts.find((h) => h.key === `mac:${PHONE_MAC}`);
    expect(phone.other_family.map((a) => a.ip_address)).toEqual(['fd00:70::aaaa', 'fd00:70::bbbb']);
  });

  it('pages by host and searches by MAC, name and address', async () => {
    const first = await hosts(v6, '?page=1&page_size=2');
    const second = await hosts(v6, '?page=2&page_size=2');
    expect(first.body).toMatchObject({ total: 4, total_pages: 2 });
    expect(first.body.hosts).toHaveLength(2);
    expect(second.body.hosts).toHaveLength(2);
    expect([...first.body.hosts, ...second.body.hosts].map((h) => h.key)).toEqual(
      (await hosts(v6)).body.hosts.map((h) => h.key),
    );
    expect((await hosts(v6, `?q=${PHONE_MAC}`)).body.hosts.map((h) => h.key)).toEqual([
      `mac:${PHONE_MAC}`,
    ]);
    expect((await hosts(v6, '?q=laptop')).body.total).toBe(1);
    expect((await hosts(v6, '?search=fd00:70::/64&q=laptop')).body.total).toBe(1);
    expect((await hosts(v6, '?search=10.0.0.0/8&q=laptop')).body.total).toBe(0);
    expect((await hosts(v4, '?q=printer')).body.hosts[0].key).toBe('address:10.70.0.30');
  });

  it('returns the one host holding an address, in either family', async () => {
    const v6Host = await hosts(v6, '?address=fd00:0070::bbbb');
    expect(v6Host.body.hosts.map((h) => h.key)).toEqual([`mac:${PHONE_MAC}`]);
    const v4Host = await hosts(v4, '?address=10.70.0.20');
    expect(v4Host.body.hosts.map((h) => h.key)).toEqual([`mac:${PHONE_MAC}`]);
    expect((await hosts(v4, '?address=10.70.0.99')).body.hosts).toEqual([]);
  });

  it('refuses bad input', async () => {
    expect((await hosts(99999)).status).toBe(404);
    expect((await hosts(v6, '?page=0')).status).toBe(400);
    expect((await hosts(v6, '?page_size=513')).status).toBe(400);
    expect((await hosts(v6, '?page=abc')).status).toBe(400);
    expect((await hosts(v6, '?q=a&q=b')).status).toBe(400);
    expect((await hosts(v6, '?search=a&search=b')).status).toBe(400);
    expect((await hosts(v4, '?address=10.71.0.1')).status).toBe(400);
    expect((await hosts(v6, '?address=10.70.0.20')).status).toBe(400);
  });

  it('refuses an IPv6 network while IPv6 is switched off, and still serves IPv4', async () => {
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'ipv6_enabled'").run();
    try {
      expect((await hosts(v6)).status).toBe(400);
      expect((await hosts(v4)).status).toBe(200);
    } finally {
      enableIpv6(db);
    }
  });

  it('writes nothing', async () => {
    const snapshot = () =>
      JSON.stringify(db.prepare('SELECT * FROM ip_addresses ORDER BY id').all());
    const before = snapshot();
    await hosts(v6);
    await hosts(v4, '?address=10.70.0.20');
    expect(snapshot()).toBe(before);
  });
});
