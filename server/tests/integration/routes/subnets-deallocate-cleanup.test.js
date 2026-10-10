/**
 * Deallocating an allocated network takes its generated DNS with it and
 * refuses while DHCP reservations exist.
 *
 *   - PTRs the app wrote (placeholder, lease, reservation) in the block's
 *     reverse zones go; manual A records and their PTRs stay.
 *   - A/AAAA records written from leases go; manual ones stay.
 *   - Reverse zones no other allocated network covers are disabled, and
 *     re-enabled when the block is configured again with reverse DNS.
 *   - Reservations anywhere in the subtree block the delete with a 409.
 *   - GET /deallocation-preview reports the same numbers the delete removes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

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
const { default: dnsRouter } = await import('../../../src/routes/dns.js');
const { default: dhcpRouter } = await import('../../../src/routes/dhcp.js');
const { default: request } = await import('supertest');
const { ipToLong } = await import('../../../src/utils/ip.js');

let tmpDir;
let app;
let db;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/dns', router: dnsRouter },
    { prefix: '/api/dhcp', router: dhcpRouter },
  ]);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

async function mkSubnet(body) {
  const res = await request(app).post('/api/subnets').send(body);
  expect(res.status).toBe(201);
  return res.body;
}

async function configure(id, body) {
  const res = await request(app).post(`/api/subnets/${id}/configure`).send(body);
  expect(res.status).toBe(200);
  return res.body;
}

const zone = (name) => db.prepare('SELECT * FROM dns_zones WHERE name = ?').get(name);
const zoneId = (name) => {
  const row = db.prepare("SELECT id FROM dns_zones WHERE name = ? AND type = 'forward'").get(name);
  return row.id;
};
const ptrCount = (zoneName, source) =>
  db
    .prepare(
      `SELECT COUNT(*) AS c FROM dns_records r JOIN dns_zones z ON z.id = r.zone_id
       WHERE z.name = ? AND r.type = 'PTR' AND r.source = ?`,
    )
    .get(zoneName, source).c;
const addressRecords = (zoneName) =>
  db
    .prepare(
      `SELECT r.name, r.value, r.source FROM dns_records r JOIN dns_zones z ON z.id = r.zone_id
       WHERE z.name = ? AND r.type IN ('A', 'AAAA') ORDER BY r.name`,
    )
    .all(zoneName);

// A /23 with reverse DNS and a DHCP scope, a manual A record, a lease-written
// A record, and the PTR each of them produced.
async function seedNetwork(cidr, { domain, gateway, manualHost, leaseHost, leaseIp, manualIp }) {
  const s = await mkSubnet({ cidr, name: `net ${cidr}`, status: 'allocated' });
  await configure(s.id, {
    name: `net ${cidr}`,
    gateway_address: gateway,
    create_reverse_dns: true,
    create_dhcp_scope: true,
    domain_name: domain,
  });
  const manual = await request(app)
    .post(`/api/dns/zones/${zoneId(domain)}/records`)
    .send({ name: manualHost, type: 'A', value: manualIp });
  expect(manual.status).toBe(201);
  db.prepare(
    `INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
     VALUES (?, ?, 'A', ?, 'dhcp', 1)`,
  ).run(zoneId(domain), leaseHost, leaseIp);
  db.prepare(
    `INSERT INTO dhcp_leases (subnet_id, ip_address, mac_address, hostname, expires_at)
     VALUES (?, ?, 'aa:bb:cc:00:00:01', ?, datetime('now', '+1 day'))`,
  ).run(s.id, leaseIp, leaseHost);
  db.prepare(
    `INSERT INTO dhcp_leases (subnet_id, ip_address, mac_address, hostname, expires_at)
     VALUES (?, ?, 'aa:bb:cc:00:00:02', 'other', datetime('now', '+1 day'))`,
  ).run(s.id, manualIp.replace(/\.\d+$/, '.77'));
  return s;
}

describe('DELETE /api/subnets/:id on an allocated network', () => {
  it('removes generated DNS, keeps manual records, disables the reverse zones', async () => {
    const s = await seedNetwork('10.40.0.0/23', {
      domain: 'dealloc.test',
      gateway: '10.40.0.1',
      manualHost: 'kept',
      manualIp: '10.40.1.20',
      leaseHost: 'laptop',
      leaseIp: '10.40.0.30',
    });
    // Configure filled both /24 zones with placeholders and mirrored the manual
    // A record's PTR with source 'dns'.
    expect(zone('0.40.10.in-addr.arpa').enabled).toBe(1);
    expect(zone('1.40.10.in-addr.arpa').enabled).toBe(1);
    expect(ptrCount('0.40.10.in-addr.arpa', 'placeholder')).toBeGreaterThan(200);
    expect(ptrCount('1.40.10.in-addr.arpa', 'dns')).toBe(1);

    const preview = await request(app).get(`/api/subnets/${s.id}/deallocation-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      reservations: 0,
      scopes: 1,
      leases: 2,
      generated_address_records: 1,
      forward_zones: ['dealloc.test'],
      children: 0,
    });
    expect(preview.body.reverse_zones).toEqual([
      { name: '0.40.10.in-addr.arpa', enabled: true, will_disable: true },
      { name: '1.40.10.in-addr.arpa', enabled: true, will_disable: true },
    ]);
    const generatedPtrBefore =
      ptrCount('0.40.10.in-addr.arpa', 'placeholder') +
      ptrCount('1.40.10.in-addr.arpa', 'placeholder');
    expect(preview.body.generated_ptr).toBe(generatedPtrBefore);

    const del = await request(app).delete(`/api/subnets/${s.id}`);
    expect(del.status).toBe(200);
    expect(del.body.action).toBe('deallocated');
    expect(del.body.dns).toEqual({
      ptr_removed: generatedPtrBefore,
      address_records_removed: 1,
      zones_disabled: ['0.40.10.in-addr.arpa', '1.40.10.in-addr.arpa'],
    });

    expect(ptrCount('0.40.10.in-addr.arpa', 'placeholder')).toBe(0);
    expect(ptrCount('1.40.10.in-addr.arpa', 'placeholder')).toBe(0);
    expect(ptrCount('1.40.10.in-addr.arpa', 'dns')).toBe(1);
    expect(zone('0.40.10.in-addr.arpa').enabled).toBe(0);
    expect(zone('1.40.10.in-addr.arpa').enabled).toBe(0);
    expect(zone('dealloc.test').enabled).toBe(1);
    expect(addressRecords('dealloc.test')).toEqual([
      { name: 'kept', value: '10.40.1.20', source: 'manual' },
    ]);
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM dhcp_scopes WHERE subnet_id = ?').get(s.id).c,
    ).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM dhcp_leases WHERE subnet_id = ?').get(s.id).c,
    ).toBe(0);
    expect(
      db.prepare('SELECT status, has_reverse_dns FROM subnets WHERE id = ?').get(s.id),
    ).toEqual({ status: 'unallocated', has_reverse_dns: 0 });

    const audit = db
      .prepare("SELECT details FROM audit_log WHERE action = 'subnet_deleted' ORDER BY id DESC")
      .get();
    expect(JSON.parse(audit.details)).toMatchObject({
      action: 'deallocated',
      address_records_removed: 1,
      zones_disabled: ['0.40.10.in-addr.arpa', '1.40.10.in-addr.arpa'],
    });
  });

  it('re-enables the reverse zones when the block is configured again', async () => {
    const s = db.prepare("SELECT id FROM subnets WHERE cidr = '10.40.0.0/23'").get();
    await configure(s.id, {
      name: 'again',
      gateway_address: '10.40.0.1',
      create_reverse_dns: true,
      create_dhcp_scope: false,
      domain_name: 'dealloc.test',
    });
    expect(zone('0.40.10.in-addr.arpa').enabled).toBe(1);
    expect(zone('1.40.10.in-addr.arpa').enabled).toBe(1);
    expect(ptrCount('0.40.10.in-addr.arpa', 'placeholder')).toBeGreaterThan(200);
    // The manual A record's PTR was never removed, so it is still the one 'dns' row.
    expect(ptrCount('1.40.10.in-addr.arpa', 'dns')).toBe(1);
    expect((await request(app).delete(`/api/subnets/${s.id}`)).status).toBe(200);
  });

  it('keeps a reverse zone another allocated network still covers', async () => {
    // Two /25s share 0.50.10.in-addr.arpa; only the second's zone is exclusive.
    const a = await mkSubnet({ cidr: '10.50.0.0/25', name: 'a', status: 'allocated' });
    await configure(a.id, {
      name: 'a',
      gateway_address: '10.50.0.1',
      create_reverse_dns: true,
      create_dhcp_scope: false,
    });
    const b = await mkSubnet({ cidr: '10.50.0.128/25', name: 'b', status: 'allocated' });
    await configure(b.id, {
      name: 'b',
      gateway_address: '10.50.0.129',
      create_reverse_dns: true,
      create_dhcp_scope: false,
    });
    const placeholdersBefore = ptrCount('0.50.10.in-addr.arpa', 'placeholder');

    const preview = await request(app).get(`/api/subnets/${a.id}/deallocation-preview`);
    expect(preview.body.reverse_zones).toEqual([
      { name: '0.50.10.in-addr.arpa', enabled: true, will_disable: false },
    ]);

    const del = await request(app).delete(`/api/subnets/${a.id}`);
    expect(del.status).toBe(200);
    expect(del.body.dns.zones_disabled).toEqual([]);
    expect(zone('0.50.10.in-addr.arpa').enabled).toBe(1);
    // Only a's half of the zone was cleared.
    const after = ptrCount('0.50.10.in-addr.arpa', 'placeholder');
    expect(after).toBeGreaterThan(100);
    expect(after).toBeLessThan(placeholdersBefore);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM dns_records r JOIN dns_zones z ON z.id = r.zone_id
           WHERE z.name = '0.50.10.in-addr.arpa' AND r.type = 'PTR' AND r.value LIKE '10.50.0.1%'
             AND CAST(substr(r.value, 9) AS INTEGER) < 128`,
        )
        .get().c,
    ).toBe(0);
  });

  it('refuses while the network or a child holds a DHCP reservation', async () => {
    const s = await mkSubnet({ cidr: '10.60.0.0/24', name: 'res', status: 'allocated' });
    await configure(s.id, {
      name: 'res',
      gateway_address: '10.60.0.1',
      create_reverse_dns: true,
      create_dhcp_scope: true,
    });
    const reservation = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: s.id,
      ip_address: '10.60.0.50',
      mac_address: 'aa:bb:cc:dd:ee:50',
      hostname: 'printer',
    });
    expect(reservation.status).toBe(201);

    const preview = await request(app).get(`/api/subnets/${s.id}/deallocation-preview`);
    expect(preview.body.reservations).toBe(1);

    const rows = () => ({
      ptr: db.prepare("SELECT COUNT(*) AS c FROM dns_records WHERE type = 'PTR'").get().c,
      zones: db.prepare('SELECT COUNT(*) AS c FROM dns_zones WHERE enabled = 1').get().c,
      scopes: db.prepare('SELECT COUNT(*) AS c FROM dhcp_scopes').get().c,
      status: db.prepare('SELECT status FROM subnets WHERE id = ?').get(s.id).status,
    });
    const before = rows();
    const del = await request(app).delete(`/api/subnets/${s.id}`);
    expect(del.status).toBe(409);
    expect(del.body).toEqual({
      error: 'Remove the 1 DHCP reservation in this network first.',
      reason_code: 'reservations_present',
      reservation_count: 1,
    });
    expect(rows()).toEqual(before);

    // The same reservation seen from an allocated parent blocks the parent too.
    db.prepare("UPDATE subnets SET status = 'allocated' WHERE id = ?").run(s.id);
    const parent = await mkSubnet({ cidr: '10.61.0.0/23', name: 'parent', status: 'allocated' });
    await configure(parent.id, {
      name: 'parent',
      gateway_address: '10.61.0.1',
      create_reverse_dns: false,
      create_dhcp_scope: false,
    });
    db.prepare('UPDATE subnets SET parent_id = ?, depth = 1 WHERE id = ?').run(parent.id, s.id);
    const blocked = await request(app).delete(`/api/subnets/${parent.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.reservation_count).toBe(1);
  });

  it('deleting an unallocated leaf touches no DNS rows', async () => {
    const s = await mkSubnet({ cidr: '10.70.0.0/24', name: '10.70.0.0/24', status: 'unallocated' });
    const before = db.prepare('SELECT COUNT(*) AS c FROM dns_records').get().c;
    const del = await request(app).delete(`/api/subnets/${s.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({
      action: 'deleted',
      dns: { ptr_removed: 0, address_records_removed: 0, zones_disabled: [] },
    });
    expect(db.prepare('SELECT COUNT(*) AS c FROM dns_records').get().c).toBe(before);
  });
});

describe('a deallocated network keeps only its address space', () => {
  it.each([
    ['IPv4', '10.71.0.0/24', '10.71.0.1'],
    ['IPv6', 'fd71::/64', 'fd71::1'],
  ])('%s: clears every attribute, its folder included', async (_family, cidr, gateway) => {
    enableIpv6(db);
    const folderId = db.prepare("INSERT INTO folders (name) VALUES ('Lab')").run().lastInsertRowid;
    const s = await mkSubnet({ cidr, name: cidr, status: 'unallocated' });
    await configure(s.id, {
      name: 'Lab net',
      description: 'bench',
      vlan_id: 71,
      folder_id: folderId,
      domain_name: 'lab.test',
      gateway_address: gateway,
      scan_enabled: false,
      create_reverse_dns: false,
      create_dhcp_scope: false,
    });
    const allocated = db.prepare('SELECT * FROM subnets WHERE id = ?').get(s.id);
    expect(allocated).toMatchObject({ folder_id: folderId, scan_enabled: 0, vlan_id: 71 });

    const del = await request(app).delete(`/api/subnets/${s.id}`);
    expect(del.body.action).toBe('deallocated');
    expect(db.prepare('SELECT * FROM subnets WHERE id = ?').get(s.id)).toMatchObject({
      status: 'unallocated',
      name: cidr,
      description: null,
      vlan_id: null,
      folder_id: null,
      domain_name: null,
      gateway_address: null,
      gateway_policy: 'none',
      has_reverse_dns: 0,
      scan_enabled: null,
      scan_interval: null,
    });
  });
});

// Merging is an operation the operator asks for (Merge), never a side effect.
// Deallocating or deleting one network must not fold its unallocated
// siblings back into their parent.
describe('siblings are never merged as a side effect', () => {
  async function divideInto(cidr, newPrefix) {
    const parent = await mkSubnet({ cidr, name: cidr });
    const preview = await request(app)
      .post(`/api/subnets/${parent.id}/divide/preview`)
      .send({ new_prefix: newPrefix });
    expect(preview.status).toBe(200);
    const divided = await request(app)
      .post(`/api/subnets/${parent.id}/divide`)
      .send({ new_prefix: newPrefix, plan_token: preview.body.plan.dependency_token });
    expect(divided.status).toBe(200);
    return { parent, children: childRows(parent.id) };
  }
  // In address order; network_address is text, so ORDER BY puts .64 after .192.
  const childRows = (parentId) =>
    db
      .prepare('SELECT * FROM subnets WHERE parent_id = ?')
      .all(parentId)
      .sort((a, b) => ipToLong(a.network_address) - ipToLong(b.network_address));
  const childCidrs = (parentId) =>
    childRows(parentId).map(({ cidr, status }) => ({ cidr, status }));

  it('keeps both halves after deallocating each of them', async () => {
    const { parent, children } = await divideInto('10.90.0.0/24', 25);
    expect(children.map((child) => child.cidr)).toEqual(['10.90.0.0/25', '10.90.0.128/25']);
    for (const child of children) {
      await configure(child.id, { name: `net ${child.cidr}`, gateway_address: null });
    }
    for (const child of children) {
      expect((await request(app).delete(`/api/subnets/${child.id}`)).status).toBe(200);
    }

    expect(db.prepare('SELECT id FROM subnets WHERE id = ?').get(parent.id)).toBeTruthy();
    expect(childCidrs(parent.id)).toEqual([
      { cidr: '10.90.0.0/25', status: 'unallocated' },
      { cidr: '10.90.0.128/25', status: 'unallocated' },
    ]);
  });

  it('leaves the other unallocated siblings alone when one is deleted', async () => {
    const { parent, children } = await divideInto('10.91.0.0/24', 26);
    expect(children).toHaveLength(4);
    expect((await request(app).delete(`/api/subnets/${children[3].id}`)).status).toBe(200);

    expect(children[3].cidr).toBe('10.91.0.192/26');
    expect(childCidrs(parent.id).map((child) => child.cidr)).toEqual([
      '10.91.0.0/26',
      '10.91.0.64/26',
      '10.91.0.128/26',
    ]);
  });
});
