/**
 * Regression tests for the subnet divide path. These guard the R1–R3 data-loss
 * fixes: per-IP artifact transfer, DNS zone migration, DHCP scope inheritance,
 * lossy-IP detection (network/broadcast + DNS A records + outside_selection),
 * and exact conflict-resolution gates.
 *
 * The original bug (before R1): dividing an allocated /22 silently wiped all
 * reservations, ip_addresses rows, DNS zones, and DHCP scope config under the
 * parent, declared "disastrous for a production system" by the user.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

// Mock the filesystem-writing regen utilities so dnsmasq configs aren't touched.
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
const { default: dnsRouter }    = await import('../../../src/routes/dns.js');
const { default: dhcpRouter }   = await import('../../../src/routes/dhcp.js');
const { default: rangeRouter }  = await import('../../../src/routes/ranges.js');
const { default: request } = await import('supertest');
const { getDb } = await import('../../../src/db/init.js');
const { ipToLong } = await import('../../../src/utils/ip.js');

let tmpDir;
let app;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/dns',     router: dnsRouter },
    { prefix: '/api/dhcp',    router: dhcpRouter },
    // ranges router is nested under /api/subnets/:subnetId/ranges in prod
    { prefix: '/api/subnets/:subnetId/ranges', router: rangeRouter },
  ]);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

// Helpers --------------------------------------------------------------

async function createSubnet(body) {
  const res = await request(app).post('/api/subnets').send(body);
  expect(res.status).toBe(201);
  return res.body;
}

async function configure(subnetId, body) {
  const res = await request(app).post(`/api/subnets/${subnetId}/configure`).send(body);
  expect(res.status).toBe(200);
  return res.body;
}

async function divide(subnetId, body) {
  return await request(app).post(`/api/subnets/${subnetId}/divide`).send(body);
}

async function dividePreview(subnetId, body) {
  return await request(app).post(`/api/subnets/${subnetId}/divide/preview`).send(body);
}

// Tests ----------------------------------------------------------------

describe('POST /api/subnets/:id/divide, data preservation', () => {
  it('requires and applies explicit gateway policies for custom-gateway children', async () => {
    const parent = await createSubnet({ cidr: '192.0.3.0/24', name: 'Custom gateway split' });
    await configure(parent.id, {
      name: 'Custom gateway split', gateway_policy: 'custom', gateway_address: '192.0.3.100',
      create_reverse_dns: false, create_dhcp_scope: false
    });
    const preview = await dividePreview(parent.id, { new_prefix: 25 });
    expect(preview.status).toBe(200);
    expect(preview.body.plan.conflicts).toContainEqual({ code: 'custom_gateway_policy_required' });

    const target_gateways = [
      { cidr: '192.0.3.0/25', policy: 'custom', address: '192.0.3.100' },
      { cidr: '192.0.3.128/25', policy: 'last' }
    ];
    const accepted = await dividePreview(parent.id, { new_prefix: 25, target_gateways });
    expect(accepted.body.plan.conflicts).toEqual([]);
    const result = await divide(parent.id, {
      new_prefix: 25, force: true, target_gateways,
      plan_token: accepted.body.plan.dependency_token
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.children.map(child => [child.cidr, child.gateway_policy, child.gateway_address]))
      .toEqual([
        ['192.0.3.0/25', 'custom', '192.0.3.100'],
        ['192.0.3.128/25', 'last', '192.0.3.254']
      ]);
  });

  it('rejects execution when a preview dependency changed', async () => {
    const parent = await createSubnet({ cidr: '192.0.4.0/24', name: 'Stale plan' });
    const preview = await dividePreview(parent.id, { new_prefix: 25 });
    expect(preview.status).toBe(200);
    const edit = await request(app).put(`/api/subnets/${parent.id}`).send({ name: 'Changed after preview' });
    expect(edit.status).toBe(200);
    const result = await divide(parent.id, {
      new_prefix: 25, plan_token: preview.body.plan.dependency_token
    });
    expect(result.status).toBe(409);
    expect(result.body.stale_plan).toBe(true);
  });

  it('previews an active lease occupying a future child gateway', async () => {
    const parent = await createSubnet({ cidr: '192.0.5.0/24', name: 'Gateway lease conflict' });
    await configure(parent.id, {
      name: 'Gateway lease conflict', gateway_policy: 'last',
      create_reverse_dns: false, create_dhcp_scope: false
    });
    const leaseId = getDb().prepare(`
      INSERT INTO dhcp_leases (subnet_id, ip_address, mac_address, hostname, expires_at)
      VALUES (?, '192.0.5.126', '02:00:00:05:01:26', 'future-gateway', datetime('now', '+1 hour'))
    `).run(parent.id).lastInsertRowid;

    const preview = await dividePreview(parent.id, { new_prefix: 25 });
    expect(preview.status).toBe(200);
    expect(preview.body.plan.conflicts).toContainEqual(expect.objectContaining({
      code: 'gateway_active_lease_conflict',
      target_cidr: '192.0.5.0/25',
      ip_address: '192.0.5.126',
      record_id: leaseId
    }));
    const execute = await divide(parent.id, { new_prefix: 25, force: true });
    expect(execute.status).toBe(409);
    expect(getDb().prepare('SELECT id FROM dhcp_leases WHERE id = ?').get(leaseId)).toBeDefined();
  });

  it('canonically projects last gateways, boundaries, scopes, and leases across a two-way split', async () => {
    const db = getDb();
    db.prepare("UPDATE settings SET value = 'last' WHERE key = 'default_gateway_position'").run();
    const parent = await createSubnet({ cidr: '192.0.2.0/24', name: 'Canonical split' });
    await configure(parent.id, {
      name: 'Canonical split', create_reverse_dns: false, create_dhcp_scope: true,
      dhcp_start_ip: '192.0.2.20', dhcp_end_ip: '192.0.2.240'
    });
    db.prepare(`
      INSERT INTO dhcp_leases (subnet_id, ip_address, mac_address, hostname, expires_at)
      VALUES (?, '192.0.2.40', '02:00:00:00:00:40', 'split-client', datetime('now', '+1 hour'))
    `).run(parent.id);

    const response = await divide(parent.id, { new_prefix: 25, force: true });
    db.prepare("UPDATE settings SET value = 'first' WHERE key = 'default_gateway_position'").run();
    expect(response.status).toBe(200);
    const children = response.body.children;
    expect(children.map(child => [child.cidr, child.gateway_policy, child.gateway_address])).toEqual([
      ['192.0.2.0/25', 'last', '192.0.2.126'],
      ['192.0.2.128/25', 'last', '192.0.2.254']
    ]);

    const states = db.prepare(`
      SELECT ip_address, allocation_state FROM ip_addresses
      WHERE subnet_id IN (?, ?) AND ip_address IN ('192.0.2.0', '192.0.2.126', '192.0.2.127', '192.0.2.128', '192.0.2.254', '192.0.2.255')
      ORDER BY ip_address
    `).all(children[0].id, children[1].id);
    expect(Object.fromEntries(states.map(row => [row.ip_address, row.allocation_state]))).toEqual({
      '192.0.2.0': 'system', '192.0.2.126': 'gateway', '192.0.2.127': 'system',
      '192.0.2.128': 'system', '192.0.2.254': 'gateway', '192.0.2.255': 'system'
    });

    const scopes = db.prepare(`
      SELECT scope.subnet_id, range.start_ip, range.end_ip,
        (SELECT value FROM dhcp_scope_options WHERE scope_id = scope.id AND option_code = 3) AS router
      FROM dhcp_scopes scope JOIN ranges range ON range.id = scope.range_id
      WHERE scope.subnet_id IN (?, ?) ORDER BY range.start_ip
    `).all(children[0].id, children[1].id);
    expect(scopes.sort((a, b) => ipToLong(a.start_ip) - ipToLong(b.start_ip))
      .map(scope => [scope.start_ip, scope.end_ip, scope.router])).toEqual([
      ['192.0.2.20', '192.0.2.125', '192.0.2.126'],
      ['192.0.2.129', '192.0.2.240', '192.0.2.254']
    ]);
    expect(db.prepare("SELECT subnet_id FROM dhcp_leases WHERE hostname = 'split-client'").get().subnet_id)
      .toBe(children[0].id);

    const merged = await request(app).post('/api/subnets/merge')
      .send({ subnet_ids: children.map(child => child.id).reverse() });
    expect(merged.status).toBe(200);
    const restored = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parent.id);
    expect([restored.gateway_policy, restored.gateway_address]).toEqual(['last', '192.0.2.254']);
    expect(db.prepare("SELECT allocation_state FROM ip_addresses WHERE subnet_id = ? AND ip_address = '192.0.2.254'").get(parent.id).allocation_state)
      .toBe('gateway');
    expect(db.prepare("SELECT allocation_state FROM ip_addresses WHERE subnet_id = ? AND ip_address = '192.0.2.126'").get(parent.id).allocation_state)
      .toBe('unassigned');
    expect(db.prepare('SELECT COUNT(*) AS count FROM dhcp_scopes WHERE subnet_id = ?').get(parent.id).count)
      .toBe(2);
    expect(db.prepare("SELECT subnet_id FROM dhcp_leases WHERE hostname = 'split-client'").get().subnet_id)
      .toBe(parent.id);
  });
  it('transfers DHCP Reservations into the child that contains the IP', async () => {
    const parent = await createSubnet({ cidr: '10.10.0.0/23', name: 'Divide-res', status: 'allocated', gateway_address: '10.10.0.1' });
    await configure(parent.id, { name: 'Divide-res', create_reverse_dns: false, create_dhcp_scope: false });

    // Create reservation at 10.10.1.50, lands in the upper /24 after divide.
    const resvCreate = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: parent.id, ip_address: '10.10.1.50', mac_address: 'aa:bb:cc:00:00:10', hostname: 'carrier'
    });
    expect(resvCreate.status).toBe(201);

    const divRes = await divide(parent.id, { new_prefix: 24, force: true });
    expect(divRes.status).toBe(200);

    // The parent's children should now hold the reservation (in the child whose range contains 10.10.1.50).
    const listed = await request(app).get(`/api/dhcp/reservations?subnet_id=${parent.id}`);
    // Reservation is no longer on the parent (parent is now a container).
    expect(listed.body.find(r => r.ip_address === '10.10.1.50')).toBeUndefined();

    // Find it under the children instead.
    const tree = await request(app).get('/api/subnets');
    const flat = [];
    const walk = (xs) => { for (const s of xs) { flat.push(s); walk(s.children || []); } };
    for (const f of tree.body.folders) walk(f.subnets || []);
    const p = flat.find(s => s.id === parent.id);
    const upper = (p.children || []).find(c => c.cidr === '10.10.1.0/24');
    expect(upper).toBeDefined();

    const upperResv = await request(app).get(`/api/dhcp/reservations?subnet_id=${upper.id}`);
    expect(upperResv.body.find(r => r.ip_address === '10.10.1.50' && r.hostname === 'carrier')).toBeDefined();
  });

  it('forward DNS zone and its records survive the divide (post-decouple: zone is subnet-agnostic)', async () => {
    const parent = await createSubnet({ cidr: '10.11.0.0/23', name: 'Divide-dns', status: 'allocated', gateway_address: '10.11.0.1' });
    await configure(parent.id, {
      name: 'Divide-dns', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'divide-dns.test'
    });

    // Grab the forward zone and add a manual record that must survive.
    const zonesBefore = await request(app).get('/api/dns/zones');
    const fwd = zonesBefore.body.find(z => z.name === 'divide-dns.test');
    expect(fwd).toBeDefined();
    await request(app).post(`/api/dns/zones/${fwd.id}/records`).send({ name: 'survivor', type: 'A', value: '10.11.0.50' });

    const divRes = await divide(parent.id, { new_prefix: 24, force: true });
    expect(divRes.status).toBe(200);

    // Post-decouple: zones are subnet-agnostic. The zone and its records
    // survive the divide unchanged; nothing to "reassign" because no FK
    // back to any subnet exists. The parent subnet's domain_name pointer
    // is unchanged too (children inherit it via parent.domain_name copy).
    const zonesAfter = await request(app).get('/api/dns/zones');
    const stillThere = zonesAfter.body.find(z => z.id === fwd.id);
    expect(stillThere).toBeDefined();

    const records = await request(app).get(`/api/dns/zones/${fwd.id}/records`);
    expect(records.body.find(r => r.name === 'survivor' && r.value === '10.11.0.50')).toBeDefined();
  });
});

describe('POST /api/subnets/:id/divide, lossy gate', () => {
  it('preview returns lossy list when a reservation would land on a new broadcast IP', async () => {
    const parent = await createSubnet({ cidr: '10.12.0.0/22', name: 'Lossy-preview', status: 'allocated', gateway_address: '10.12.0.1' });
    await configure(parent.id, { name: 'Lossy-preview', create_reverse_dns: false, create_dhcp_scope: true });

    // 10.12.1.255 would be the broadcast of 10.12.0.0/23 after divide.
    const mkRes = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: parent.id, ip_address: '10.12.1.255', mac_address: 'aa:bb:cc:00:00:20', hostname: 'doomed'
    });
    expect(mkRes.status).toBe(201);

    const prev = await dividePreview(parent.id, { new_prefix: 23 });
    expect(prev.status).toBe(200);
    expect(Array.isArray(prev.body.lossy)).toBe(true);
    const hit = prev.body.lossy.find(
      l => l.ip === '10.12.1.255' && l.reason === 'broadcast' && l.carries === 'dhcp_reservation'
    );
    expect(hit).toBeDefined();
  });

  it('requires exact conflict resolutions when lossy rows exist', async () => {
    const parent = await createSubnet({ cidr: '10.13.0.0/22', name: 'Lossy-gate', status: 'allocated', gateway_address: '10.13.0.1' });
    await configure(parent.id, { name: 'Lossy-gate', create_reverse_dns: false, create_dhcp_scope: true });

    await request(app).post('/api/dhcp/reservations').send({
      subnet_id: parent.id, ip_address: '10.13.1.255', mac_address: 'aa:bb:cc:00:00:21', hostname: 'doomed'
    });

    const res = await divide(parent.id, { new_prefix: 23, force: true });
    expect(res.status).toBe(409);
    expect(res.body.requires_conflict_resolutions).toBe(true);
    expect(Array.isArray(res.body.lossy)).toBe(true);
    expect(res.body.lossy.length).toBeGreaterThan(0);
  });

  it('executes after every current conflict is accepted by record identity', async () => {
    const parent = await createSubnet({ cidr: '10.14.0.0/22', name: 'Lossy-force', status: 'allocated', gateway_address: '10.14.0.1' });
    await configure(parent.id, { name: 'Lossy-force', create_reverse_dns: false, create_dhcp_scope: true });

    await request(app).post('/api/dhcp/reservations').send({
      subnet_id: parent.id, ip_address: '10.14.1.255', mac_address: 'aa:bb:cc:00:00:22', hostname: 'doomed'
    });

    const blocked = await divide(parent.id, { new_prefix: 23, force: true });
    const conflict_resolutions = blocked.body.lossy.map(row => ({
      carries: row.carries, record_id: row.record_id, action: 'delete'
    }));
    const res = await divide(parent.id, { new_prefix: 23, force: true, conflict_resolutions });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('rejects partial or unrelated conflict acknowledgements without deleting anything', async () => {
    const parent = await createSubnet({ cidr: '10.24.0.0/22', name: 'Exact-conflicts' });
    await configure(parent.id, {
      name: 'Exact-conflicts', create_reverse_dns: false, create_dhcp_scope: false,
      domain_name: 'exact-conflicts.test'
    });
    const reservation = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: parent.id, ip_address: '10.24.1.255',
      mac_address: 'aa:bb:cc:00:24:01', hostname: 'boundary-client'
    });
    expect(reservation.status).toBe(201);
    const blocked = await divide(parent.id, { new_prefix: 23, force: true });
    expect(blocked.body.lossy.length).toBeGreaterThan(1);

    const one = blocked.body.lossy[0];
    const partial = await divide(parent.id, {
      new_prefix: 23, force: true,
      conflict_resolutions: [{ carries: one.carries, record_id: one.record_id, action: 'delete' }]
    });
    expect(partial.status).toBe(409);
    expect(getDb().prepare('SELECT id FROM dhcp_reservations WHERE id = ?').get(reservation.body.id))
      .toBeDefined();

    const unrelated = await divide(parent.id, {
      new_prefix: 23, force: true,
      conflict_resolutions: [{ carries: 'dhcp_reservation', record_id: 999999, action: 'delete' }]
    });
    expect(unrelated.status).toBe(400);
    expect(getDb().prepare('SELECT id FROM dhcp_reservations WHERE id = ?').get(reservation.body.id))
      .toBeDefined();
  });

  it('flags DNS A records landing on a boundary IP', async () => {
    const parent = await createSubnet({ cidr: '10.15.0.0/23', name: 'Lossy-dns', status: 'allocated', gateway_address: '10.15.0.1' });
    await configure(parent.id, {
      name: 'Lossy-dns', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'lossy-dns.test'
    });

    const zones = await request(app).get('/api/dns/zones');
    const fwd = zones.body.find(z => z.name === 'lossy-dns.test');
    // 10.15.0.255 becomes broadcast of 10.15.0.0/24 after divide.
    await request(app).post(`/api/dns/zones/${fwd.id}/records`).send({ name: 'edge', type: 'A', value: '10.15.0.255' });

    const prev = await dividePreview(parent.id, { new_prefix: 24 });
    expect(prev.status).toBe(200);
    const hit = prev.body.lossy.find(l => l.carries === 'dns_record' && l.ip === '10.15.0.255');
    expect(hit).toBeDefined();
    expect(hit.reason).toBe('broadcast');
  });

  it('finds boundary records in other manual zones without including shared-zone outsiders', async () => {
    const parent = await createSubnet({ cidr: '10.25.0.0/23', name: 'Shared-zone-source' });
    await configure(parent.id, {
      name: 'Shared-zone-source', create_reverse_dns: false, create_dhcp_scope: false
    });
    const zone = await request(app).post('/api/dns/zones').send({
      name: 'shared-boundaries.test', type: 'forward'
    });
    expect(zone.status).toBe(201);
    expect((await request(app).post(`/api/dns/zones/${zone.body.id}/records`).send({
      name: 'inside', type: 'A', value: '10.25.0.255'
    })).status).toBe(201);
    expect((await request(app).post(`/api/dns/zones/${zone.body.id}/records`).send({
      name: 'outside', type: 'A', value: '10.99.0.255'
    })).status).toBe(201);

    const preview = await dividePreview(parent.id, { new_prefix: 24 });
    expect(preview.body.lossy).toEqual(expect.arrayContaining([
      expect.objectContaining({ carries: 'dns_record', ip: '10.25.0.255' })
    ]));
    expect(preview.body.lossy.some(item => item.ip === '10.99.0.255')).toBe(false);
  });

  it('preserves rows in explicit remainder children when partially selecting a divide', async () => {
    const parent = await createSubnet({ cidr: '10.16.0.0/22', name: 'Lossy-partial', status: 'allocated', gateway_address: '10.16.0.1' });
    await configure(parent.id, { name: 'Lossy-partial', create_reverse_dns: false, create_dhcp_scope: true });

    // Reservation in the upper half, which the user is NOT selecting.
    await request(app).post('/api/dhcp/reservations').send({
      subnet_id: parent.id, ip_address: '10.16.3.50', mac_address: 'aa:bb:cc:00:00:30', hostname: 'stranded'
    });

    const prev = await dividePreview(parent.id, { new_prefix: 23 });
    expect(prev.status).toBe(200);
    // Selection no longer abandons the rest of the source CIDR. Every result
    // remains an explicit child so facts outside the selected target survive.
    const res = await divide(parent.id, {
      new_prefix: 23, force: true, selected_cidrs: ['10.16.0.0/23']
    });
    expect(res.status).toBe(200);
    const remainder = res.body.children.find(child => child.cidr === '10.16.2.0/23');
    expect(remainder).toBeDefined();
    expect(getDb().prepare(
      "SELECT subnet_id FROM ip_addresses WHERE ip_address = '10.16.3.50'"
    ).get().subnet_id).toBe(remainder.id);
  });

  it('returns empty lossy when no host data sits on a boundary', async () => {
    const parent = await createSubnet({ cidr: '10.17.0.0/22', name: 'Clean', status: 'allocated', gateway_address: '10.17.0.1' });
    await configure(parent.id, { name: 'Clean', create_reverse_dns: false, create_dhcp_scope: true });

    const prev = await dividePreview(parent.id, { new_prefix: 23 });
    expect(prev.status).toBe(200);
    expect(prev.body.lossy).toEqual([]);
  });
});

describe('POST /api/subnets/:id/divide, reviewed conflict cleanup', () => {
  it('deletes DHCP Reservations, DNS A records, and reports counts', async () => {
    const parent = await createSubnet({
      cidr: '10.19.0.0/22', name: 'LossyCleanup', status: 'allocated', gateway_address: '10.19.0.1'
    });
    await configure(parent.id, {
      name: 'LossyCleanup', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'lossy-cleanup.test'
    });

    // Reservation at 10.19.1.255, becomes broadcast of 10.19.0.0/23.
    const resvRes = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: parent.id, ip_address: '10.19.1.255', mac_address: 'aa:bb:cc:00:77:01', hostname: 'doomed'
    });
    expect(resvRes.status).toBe(201);

    // A separate DNS allocation at 10.19.2.0 becomes the network address of
    // the second /23. DNS and static DHCP can no longer claim the same IP, so
    // use the two distinct boundary addresses to exercise both cleanup paths.
    const zones = await request(app).get('/api/dns/zones');
    const fwd = zones.body.find(z => z.name === 'lossy-cleanup.test');
    const dnsRes = await request(app).post(`/api/dns/zones/${fwd.id}/records`).send({
      name: 'doomed-dns', type: 'A', value: '10.19.2.0'
    });
    expect(dnsRes.status).toBe(201);

    const blocked = await divide(parent.id, { new_prefix: 23, force: true });
    const conflict_resolutions = blocked.body.lossy.map(row => ({
      carries: row.carries, record_id: row.record_id, action: 'delete'
    }));
    const divRes = await divide(parent.id, { new_prefix: 23, force: true, conflict_resolutions });
    expect(divRes.status, JSON.stringify(divRes.body)).toBe(200);

    // Cleanup summary is echoed back.
    expect(divRes.body.lossy_cleanup).toBeDefined();
    expect(divRes.body.lossy_cleanup.ips).toContain('10.19.1.255');
    expect(divRes.body.lossy_cleanup.ips).toContain('10.19.2.0');
    expect(divRes.body.lossy_cleanup.removed.reservations).toBeGreaterThanOrEqual(1);
    expect(divRes.body.lossy_cleanup.removed.dns_records).toBeGreaterThanOrEqual(1);

    // The reservation is actually gone.
    const resvListing = await request(app).get('/api/dhcp/reservations');
    expect(resvListing.body.find(r => r.ip_address === '10.19.1.255')).toBeUndefined();

    // The A record is actually gone.
    const recs = await request(app).get(`/api/dns/zones/${fwd.id}/records`);
    expect(recs.body.find(r => r.value === '10.19.2.0')).toBeUndefined();
  });
});

describe('POST /api/subnets/:id/divide, gateway/pool conflict handling', () => {
  it('shrinks the pool to exclude the child gateway and reports the adjustment', async () => {
    // Parent /22 with gateway at .0.1 and a pool covering everything after it.
    // The parent's own gateway is deliberately OUTSIDE the pool, because
    // /configure now refuses to create that state. The conflict this test
    // exercises appears at divide time instead: splitting into /23s gives the
    // second child a clipped slice starting at 10.18.2.1, which is that
    // child's own gateway. The server should shrink the child's pool to
    // exclude it and echo the adjustment back.
    const parent = await createSubnet({
      cidr: '10.18.0.0/22', name: 'GwInPool', status: 'allocated', gateway_address: '10.18.0.1'
    });
    await configure(parent.id, {
      name: 'GwInPool', create_reverse_dns: false, create_dhcp_scope: true,
      // Bleeds across the /23 boundary so the second child inherits a slice
      // containing its own firstUsable.
      dhcp_start_ip: '10.18.0.2', dhcp_end_ip: '10.18.3.254'
    });

    const divRes = await divide(parent.id, { new_prefix: 23, force: true });
    expect(divRes.status).toBe(200);
    expect(Array.isArray(divRes.body.pool_adjustments)).toBe(true);
    expect(divRes.body.pool_adjustments.length).toBeGreaterThan(0);

    // Each adjustment identifies the child cidr, the conflicting gateway,
    // and the pool before/after so the client can toast it.
    for (const a of divRes.body.pool_adjustments) {
      expect(typeof a.child_cidr).toBe('string');
      expect(typeof a.gateway).toBe('string');
      expect(a.pool_was).toBeDefined();
      // After adjustment, the gateway must not be in [start, end].
      if (a.pool_now) {
        const parts = a.gateway.split('.').map(Number);
        const gwLong = (parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | parts[3]) >>> 0;
        const sp = a.pool_now.start_ip.split('.').map(Number);
        const ep = a.pool_now.end_ip.split('.').map(Number);
        const s = (sp[0] << 24 | sp[1] << 16 | sp[2] << 8 | sp[3]) >>> 0;
        const e = (ep[0] << 24 | ep[1] << 16 | ep[2] << 8 | ep[3]) >>> 0;
        expect(gwLong >= s && gwLong <= e).toBe(false);
      }
    }
  });
});
