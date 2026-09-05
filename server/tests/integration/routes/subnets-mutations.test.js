/**
 * Regression tests for the remaining mutation-path fixes (R1 #2, R2 #2/#3,
 * R3 #2, R4 #1–#4).
 *
 *   - Forward-zone rename-in-place (records survive, the pre-R1 delete-and-
 *     recreate would cascade every record in the zone).
 *   - Forward-zone conflict 409 when another subnet owns the target name.
 *   - Detached-zone adoption when the target name points at an orphan (R4 #3).
 *   - Detach when domain_name is cleared.
 *   - Bidirectional domain_name ↔ zone.name sync on DNS zone POST/PUT/DELETE
 *     (R4 #1, #2, R3 #7).
 *   - PUT /:id CIDR change rejection (R2 #5).
 *   - Gateway-in-pool guards on subnets PUT and dhcp scopes PUT (R3 #2, R4 #4).
 *   - Range DELETE refuses when a DHCP scope is attached (R2 #2).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
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
const { default: dnsRouter }    = await import('../../../src/routes/dns.js');
const { default: dhcpRouter }   = await import('../../../src/routes/dhcp.js');
const { default: rangeRouter }  = await import('../../../src/routes/ranges.js');
const { default: folderRouter } = await import('../../../src/routes/folders.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/dns',     router: dnsRouter },
    { prefix: '/api/dhcp',    router: dhcpRouter },
    { prefix: '/api/folders', router: folderRouter },
    { prefix: '/api/subnets/:subnetId/ranges', router: rangeRouter },
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

async function findZone(name) {
  const res = await request(app).get('/api/dns/zones');
  return res.body.find(z => z.name === name);
}

// --- Rename / adopt / detach -----------------------------------------

// Post-decouple (migration 045): zones are subnet-agnostic. `domain_name` on a
// subnet is just a pointer to a forward zone by name. Multiple subnets may
// share one zone; changing a subnet's domain_name doesn't touch the zone.
describe('PUT /api/subnets/:id, domain_name pointer semantics', () => {
  it('changing domain_name auto-creates the target forward zone if missing', async () => {
    const s = await mkSubnet({ cidr: '10.30.0.0/24', name: 'ptr', status: 'allocated', gateway_address: '10.30.0.1' });
    await configure(s.id, { name: 'ptr', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'old.test' });

    const put = await request(app).put(`/api/subnets/${s.id}`).send({ domain_name: 'fresh.test' });
    expect(put.status).toBe(200);
    expect(put.body.domain_name).toBe('fresh.test');

    // The new zone exists...
    const fresh = await findZone('fresh.test');
    expect(fresh).toBeDefined();
    // ...and the old zone is untouched (no other subnet is pointing at it,
    // but the user can delete it explicitly from the DNS UI).
    const old = await findZone('old.test');
    expect(old).toBeDefined();
  });

  it('allows two subnets to share a forward zone via matching domain_name', async () => {
    const a = await mkSubnet({ cidr: '10.31.0.0/24', name: 'A', status: 'allocated', gateway_address: '10.31.0.1' });
    const b = await mkSubnet({ cidr: '10.31.1.0/24', name: 'B', status: 'allocated', gateway_address: '10.31.1.1' });
    await configure(a.id, { name: 'A', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'shared.test' });

    // B pointing at the same zone is allowed, no 409.
    const put = await request(app).put(`/api/subnets/${b.id}`).send({ domain_name: 'shared.test' });
    expect(put.status).toBe(200);
    expect(put.body.domain_name).toBe('shared.test');
  });

  it('clearing domain_name leaves the zone in place (other subnets may need it)', async () => {
    const s = await mkSubnet({ cidr: '10.33.0.0/24', name: 'clearer', status: 'allocated', gateway_address: '10.33.0.1' });
    await configure(s.id, { name: 'clearer', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'still-here.test' });

    const put = await request(app).put(`/api/subnets/${s.id}`).send({ domain_name: null });
    expect(put.status).toBe(200);
    expect(put.body.domain_name).toBeNull();

    // The zone is deliberately NOT deleted, zones are shared state.
    const zone = await findZone('still-here.test');
    expect(zone).toBeDefined();
  });
});

// Post-decouple: zones are subnet-agnostic. The only zone→subnet link is
// `subnets.domain_name` (a name pointer). PUT-rename propagates to every
// subnet pointing at the zone. DELETE clears all such pointers. POST sets
// no pointer (user's DNS UI is independent of the IPAM side).
describe('DNS zone CRUD ↔ subnets.domain_name sync', () => {
  it('PUT /api/dns/zones/:id rename updates every subnet whose domain_name matched', async () => {
    const a = await mkSubnet({ cidr: '10.35.0.0/24', name: 'zone-put-a', status: 'allocated', gateway_address: '10.35.0.1' });
    const b = await mkSubnet({ cidr: '10.35.1.0/24', name: 'zone-put-b', status: 'allocated', gateway_address: '10.35.1.1' });
    await configure(a.id, { name: 'zone-put-a', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'before.test' });
    // b shares the zone via domain_name pointer.
    await request(app).put(`/api/subnets/${b.id}`).send({ domain_name: 'before.test' });
    const zone = await findZone('before.test');

    const put = await request(app).put(`/api/dns/zones/${zone.id}`).send({ name: 'after.test' });
    expect(put.status).toBe(200);

    const getA = await request(app).get(`/api/subnets/${a.id}`);
    const getB = await request(app).get(`/api/subnets/${b.id}`);
    expect(getA.body.domain_name).toBe('after.test');
    expect(getB.body.domain_name).toBe('after.test');
  });

  it('DELETE /api/dns/zones/:id clears every subnet that pointed at it', async () => {
    const a = await mkSubnet({ cidr: '10.36.0.0/24', name: 'zone-del-a', status: 'allocated', gateway_address: '10.36.0.1' });
    const b = await mkSubnet({ cidr: '10.36.1.0/24', name: 'zone-del-b', status: 'allocated', gateway_address: '10.36.1.1' });
    await configure(a.id, { name: 'zone-del-a', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'gone.test' });
    await request(app).put(`/api/subnets/${b.id}`).send({ domain_name: 'gone.test' });
    const zone = await findZone('gone.test');

    const del = await request(app).delete(`/api/dns/zones/${zone.id}`);
    expect(del.status).toBe(200);

    const getA = await request(app).get(`/api/subnets/${a.id}`);
    const getB = await request(app).get(`/api/subnets/${b.id}`);
    expect(getA.body.domain_name).toBeNull();
    expect(getB.body.domain_name).toBeNull();
  });

  it('disabling, re-enabling, and deleting a zone updates IP allocation authority', async () => {
    const s = await mkSubnet({
      cidr: '10.37.0.0/24', name: 'zone-lifecycle', status: 'allocated', gateway_address: '10.37.0.1'
    });
    await configure(s.id, {
      name: 'zone-lifecycle', create_reverse_dns: false, create_dhcp_scope: false,
      domain_name: 'zone-lifecycle.test'
    });
    const zone = await findZone('zone-lifecycle.test');
    const created = await request(app).post(`/api/dns/zones/${zone.id}/records`).send({
      name: 'host', type: 'A', value: '10.37.0.50'
    });
    expect(created.status).toBe(201);

    const { getDb } = await import('../../../src/db/init.js');
    const db = getDb();
    expect(db.prepare(`
      SELECT allocation_state, allocation_source_type
      FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?
    `).get(s.id, '10.37.0.1')).toMatchObject({
      allocation_state: 'gateway',
      allocation_source_type: 'topology'
    });
    const allocation = () => db.prepare(`
      SELECT allocation_state, allocation_source_type, hostname
      FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?
    `).get(s.id, '10.37.0.50');
    expect(allocation()).toMatchObject({
      allocation_state: 'static_dns',
      allocation_source_type: 'dns',
      hostname: 'host.zone-lifecycle.test'
    });

    const disabled = await request(app).put(`/api/dns/zones/${zone.id}`).send({ enabled: false });
    expect(disabled.status).toBe(200);
    expect(allocation()).toMatchObject({
      allocation_state: 'unassigned',
      allocation_source_type: null,
      hostname: null
    });

    const enabled = await request(app).put(`/api/dns/zones/${zone.id}`).send({ enabled: true });
    expect(enabled.status).toBe(200);
    expect(allocation()).toMatchObject({
      allocation_state: 'static_dns',
      allocation_source_type: 'dns',
      hostname: 'host.zone-lifecycle.test'
    });

    const deleted = await request(app).delete(`/api/dns/zones/${zone.id}`);
    expect(deleted.status).toBe(200);
    expect(allocation()).toMatchObject({
      allocation_state: 'unassigned',
      allocation_source_type: null,
      hostname: null
    });
  });
});

// --- DNS record lifecycle keeps ip_addresses.hostname synchronized ------
describe('DNS address metadata sync', () => {
  it('normalizes A-record names against the target IP subnet domain', async () => {
    const s = await mkSubnet({
      cidr: '10.83.0.0/24', name: 'dns-normalize', status: 'allocated', gateway_address: '10.83.0.1'
    });
    await configure(s.id, {
      name: 'dns-normalize', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'dns-normalize.test'
    });
    const zone = await findZone('dns-normalize.test');

    const fqdn = await request(app).post(`/api/dns/zones/${zone.id}/records`).send({
      name: 'Host-One.DNS-NORMALIZE.TEST.', type: 'A', value: '10.83.0.50'
    });
    expect(fqdn.status).toBe(201);
    expect(fqdn.body.name).toBe('host-one');

    const external = await request(app).post(`/api/dns/zones/${zone.id}/records`).send({
      name: 'Host-Two.Google.COM.', type: 'A', value: '10.83.0.51'
    });
    expect(external.status).toBe(201);
    expect(external.body.name).toBe('host-two.google.com.');

    const records = await request(app).get(`/api/dns/zones/${zone.id}/records`);
    expect(records.status).toBe(200);
    expect(records.body.find(record => record.id === fqdn.body.id)?.record_fqdn)
      .toBe('host-one.dns-normalize.test');
    expect(records.body.find(record => record.id === external.body.id)?.record_fqdn)
      .toBe('host-two.google.com.');

    const ips = await request(app).get(`/api/subnets/${s.id}/ips?page=1&pageSize=256`);
    const one = ips.body.ips.find(r => r.ip_address === '10.83.0.50');
    const two = ips.body.ips.find(r => r.ip_address === '10.83.0.51');
    expect(one.hostname).toBe('host-one.dns-normalize.test');
    expect(two.hostname).toBe('host-two.google.com.');
  });

  it('renaming a DNS A record updates the ip_addresses row hostname', async () => {
    const s = await mkSubnet({
      cidr: '10.80.0.0/24', name: 'dns-rename', status: 'allocated', gateway_address: '10.80.0.1'
    });
    await configure(s.id, {
      name: 'dns-rename', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'dns-rename.test'
    });
    const zone = await findZone('dns-rename.test');

    // Create A record, then rename (same IP, new name). The ip_addresses row
    // for that IP should track the current FQDN, not the old one.
    const create = await request(app).post(`/api/dns/zones/${zone.id}/records`).send({
      name: 'host-v1', type: 'A', value: '10.80.0.50'
    });
    expect(create.status).toBe(201);

    const rename = await request(app).put(`/api/dns/zones/${zone.id}/records/${create.body.id}`).send({
      name: 'host-v2', type: 'A', value: '10.80.0.50'
    });
    expect(rename.status).toBe(200);

    const ips = await request(app).get(`/api/subnets/${s.id}/ips?page=1&pageSize=256`);
    const row = ips.body.ips.find(r => r.ip_address === '10.80.0.50');
    expect(row).toBeDefined();
    expect(row.hostname).toBe('host-v2.dns-rename.test');
  });

  it('rejects a second A hostname for the same IP and directs aliases to CNAME', async () => {
    const s = await mkSubnet({
      cidr: '10.84.0.0/24', name: 'dns-single-hostname', status: 'allocated', gateway_address: '10.84.0.1'
    });
    await configure(s.id, {
      name: 'dns-single-hostname', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'single-hostname.test'
    });
    const zone = await findZone('single-hostname.test');

    const create = await request(app).post(`/api/dns/zones/${zone.id}/records`).send({
      name: 'primary', type: 'A', value: '10.84.0.50'
    });
    expect(create.status).toBe(201);

    const duplicateName = await request(app).post(`/api/dns/zones/${zone.id}/records`).send({
      name: 'secondary', type: 'A', value: '10.84.0.50'
    });
    expect(duplicateName.status).toBe(409);
    expect(duplicateName.body.error).toMatch(/create a CNAME/i);

    const cname = await request(app).post(`/api/dns/zones/${zone.id}/records`).send({
      name: 'secondary', type: 'CNAME', value: 'primary.single-hostname.test'
    });
    expect(cname.status).toBe(201);
  });

  it('does not allow reservation-sourced DNS records to be edited or deleted manually', async () => {
    const s = await mkSubnet({
      cidr: '10.85.0.0/24', name: 'dns-derived-records', status: 'allocated', gateway_address: '10.85.0.1'
    });
    await configure(s.id, {
      name: 'dns-derived-records', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'derived-records.test'
    });
    const zone = await findZone('derived-records.test');
    const db = (await import('../../../src/db/init.js')).getDb();
    const recordId = db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'reserved-host', 'A', '10.85.0.50', 'reservation', 1)
    `).run(zone.id).lastInsertRowid;

    const edit = await request(app).put(`/api/dns/zones/${zone.id}/records/${recordId}`).send({
      name: 'manual-edit', type: 'A', value: '10.85.0.50'
    });
    expect(edit.status).toBe(403);

    const del = await request(app).delete(`/api/dns/zones/${zone.id}/records/${recordId}`);
    expect(del.status).toBe(403);
  });

});

// --- PUT /:id CIDR reject + gateway-in-pool guards --------------------

describe('PUT /api/subnets/:id, structural guards', () => {
  it('rejects DHCP scope bounds outside the subnet usable range', async () => {
    const s = await mkSubnet({ cidr: '10.90.0.0/22', name: 'bad-scope', status: 'unallocated' });

    const bad = await request(app).post(`/api/subnets/${s.id}/configure`).send({
      name: 'bad-scope',
      create_reverse_dns: false,
      create_dhcp_scope: true,
      dhcp_start_ip: '10.90.0.65',
      dhcp_end_ip: '10.90.4.255'
    });

    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/DHCP Scope End IP.*10\.90\.0\.1 - 10\.90\.3\.254/i);
  });

  it('rejects DHCP scope bounds in reverse order', async () => {
    const s = await mkSubnet({ cidr: '10.91.0.0/24', name: 'reversed-scope', status: 'unallocated' });

    const bad = await request(app).post(`/api/subnets/${s.id}/configure`).send({
      name: 'reversed-scope',
      create_reverse_dns: false,
      create_dhcp_scope: true,
      dhcp_start_ip: '10.91.0.200',
      dhcp_end_ip: '10.91.0.100'
    });

    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Start IP.*less than or equal/i);
  });

  it('rejects CIDR change in the body when the value differs (R2 #5)', async () => {
    const s = await mkSubnet({ cidr: '10.40.0.0/24', name: 'cidr-fixed', status: 'allocated', gateway_address: '10.40.0.1' });

    // Changing CIDR via PUT is still rejected.
    const bad = await request(app).put(`/api/subnets/${s.id}`).send({ cidr: '10.40.1.0/24' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/CIDR cannot be changed/i);

    // But echoing the existing CIDR back in the body is a harmless no-op,     // the edit dialog always sends the current value along with the other
    // fields, so we must accept it.
    const ok = await request(app).put(`/api/subnets/${s.id}`).send({ cidr: s.cidr, name: 'renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe('renamed');
  });

  it('refuses a gateway change that lands inside an existing DHCP pool (R3 #2)', async () => {
    const s = await mkSubnet({ cidr: '10.41.0.0/24', name: 'gw-pool', status: 'allocated', gateway_address: '10.41.0.1' });
    await configure(s.id, {
      name: 'gw-pool', create_reverse_dns: false, create_dhcp_scope: true,
      dhcp_start_ip: '10.41.0.100', dhcp_end_ip: '10.41.0.200'
    });

    // Inside the pool → 409.
    const bad = await request(app).put(`/api/subnets/${s.id}`).send({ gateway_address: '10.41.0.150' });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toMatch(/DHCP pool/i);

    // Outside the pool → 200.
    const ok = await request(app).put(`/api/subnets/${s.id}`).send({ gateway_address: '10.41.0.2' });
    expect(ok.status).toBe(200);
  });
});

describe('PUT /api/dhcp/scopes/:id, pool resize guard (R4 #4)', () => {
  it('refuses a pool resize that would include the subnet gateway', async () => {
    const s = await mkSubnet({ cidr: '10.42.0.0/24', name: 'scope-resize', status: 'allocated', gateway_address: '10.42.0.1' });
    await configure(s.id, {
      name: 'scope-resize', create_reverse_dns: false, create_dhcp_scope: true,
      dhcp_start_ip: '10.42.0.100', dhcp_end_ip: '10.42.0.200'
    });

    const scopes = await request(app).get('/api/dhcp/scopes');
    const scope = scopes.body.find(sc => sc.subnet_id === s.id);
    expect(scope).toBeDefined();

    // Try to widen the pool to include .1 (the gateway), 409.
    const bad = await request(app).put(`/api/dhcp/scopes/${scope.id}`).send({ start_ip: '10.42.0.1', end_ip: '10.42.0.200' });
    expect(bad.status).toBe(409);

    // A valid resize still works.
    const ok = await request(app).put(`/api/dhcp/scopes/${scope.id}`).send({ start_ip: '10.42.0.50', end_ip: '10.42.0.200' });
    expect(ok.status).toBe(200);
  });
});

// The gateway-in-pool invariant used to be enforced on two of the four routes
// that can write a scope's pool. dnsmasq builds dhcp-range= straight from the
// ranges row (utils/dhcp.js), so an unguarded route hands the router's own
// address out as a dynamic lease. One test per write path, so a future route
// that skips the shared helper fails here.
describe('gateway-in-pool invariant holds on every route that writes a pool', () => {
  it('POST /api/subnets/:id/configure refuses an explicit pool containing the gateway', async () => {
    const s = await mkSubnet({ cidr: '10.111.0.0/24', name: 'cfg-gw', status: 'allocated', gateway_address: '10.111.0.1' });
    const bad = await request(app).post(`/api/subnets/${s.id}/configure`).send({
      name: 'cfg-gw', create_reverse_dns: false, create_dhcp_scope: true,
      dhcp_start_ip: '10.111.0.1', dhcp_end_ip: '10.111.0.200'
    });
    expect(bad.status).toBe(409);

    const ok = await request(app).post(`/api/subnets/${s.id}/configure`).send({
      name: 'cfg-gw', create_reverse_dns: false, create_dhcp_scope: true,
      dhcp_start_ip: '10.111.0.100', dhcp_end_ip: '10.111.0.200'
    });
    expect(ok.status).toBe(200);
  });

  // The old check compared the gateway against the pool boundaries only, so a
  // gateway sitting strictly inside the pool went straight through.
  // Note /configure takes the gateway from the request (falling back to
  // default_gateway_position) and writes it, so the gateway under test has to
  // be in the same call, not just on the subnet.
  it('POST /api/subnets/:id/configure refuses a gateway strictly inside the pool', async () => {
    const s = await mkSubnet({ cidr: '10.114.0.0/24', name: 'cfg-gw-mid', status: 'allocated', gateway_address: '10.114.0.150' });
    const bad = await request(app).post(`/api/subnets/${s.id}/configure`).send({
      name: 'cfg-gw-mid', create_reverse_dns: false, create_dhcp_scope: true,
      gateway_address: '10.114.0.150',
      dhcp_start_ip: '10.114.0.100', dhcp_end_ip: '10.114.0.200'
    });
    expect(bad.status).toBe(409);
  });

  it('POST /api/subnets/:subnetId/ranges refuses a DHCP Scope range containing the gateway', async () => {
    const s = await mkSubnet({ cidr: '10.112.0.0/24', name: 'rng-post-gw', status: 'allocated', gateway_address: '10.112.0.1' });
    await configure(s.id, { name: 'rng-post-gw', create_reverse_dns: false, create_dhcp_scope: false });

    // The range-types router is not mounted in this app, read the seeded row.
    const { getDb } = await import('../../../src/db/init.js');
    const dhcpType = getDb().prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get();
    expect(dhcpType).toBeDefined();

    const bad = await request(app).post(`/api/subnets/${s.id}/ranges`).send({
      range_type_id: dhcpType.id, start_ip: '10.112.0.1', end_ip: '10.112.0.100', force: true
    });
    expect(bad.status).toBe(409);

    const ok = await request(app).post(`/api/subnets/${s.id}/ranges`).send({
      range_type_id: dhcpType.id, start_ip: '10.112.0.50', end_ip: '10.112.0.100', force: true
    });
    expect(ok.status).toBe(201);
  });

  it('PUT /api/subnets/:subnetId/ranges/:id refuses editing a live pool onto the gateway', async () => {
    const s = await mkSubnet({ cidr: '10.113.0.0/24', name: 'rng-put-gw', status: 'allocated', gateway_address: '10.113.0.1' });
    await configure(s.id, {
      name: 'rng-put-gw', create_reverse_dns: false, create_dhcp_scope: true,
      dhcp_start_ip: '10.113.0.100', dhcp_end_ip: '10.113.0.200'
    });

    // The range the scope points at is the row dnsmasq actually serves.
    const scopes = await request(app).get('/api/dhcp/scopes');
    const scope = scopes.body.find(sc => sc.subnet_id === s.id);
    expect(scope).toBeDefined();

    const bad = await request(app)
      .put(`/api/subnets/${s.id}/ranges/${scope.range_id}`)
      .send({ start_ip: '10.113.0.1', end_ip: '10.113.0.200', force: true });
    expect(bad.status).toBe(409);

    const ok = await request(app)
      .put(`/api/subnets/${s.id}/ranges/${scope.range_id}`)
      .send({ start_ip: '10.113.0.50', end_ip: '10.113.0.200', force: true });
    expect(ok.status).toBe(200);
  });
});

// folder_id is validated by one rule on all three routes that accept it. They
// used to disagree on both type and existence, so the same body got 201, 200
// and 400 depending on which route you sent it to.
// See REVIEW.md, duplicate-logic audit #22.
describe('folder_id is validated identically on every route that accepts it', () => {
  async function realFolder() {
    const res = await request(app).post('/api/folders').send({ name: `F${Date.now()}${Math.floor(process.hrtime()[1] % 1000)}` });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it('rejects a numeric string on all three routes', async () => {
    const s = await mkSubnet({ cidr: '10.121.0.0/24', name: 'fid-str', status: 'allocated', gateway_address: '10.121.0.1' });
    const create = await request(app).post('/api/subnets')
      .send({ cidr: '10.122.0.0/24', name: 'fid-str2', status: 'allocated', folder_id: '3' });
    expect(create.status).toBe(400);

    const put = await request(app).put(`/api/subnets/${s.id}`).send({ folder_id: '3' });
    expect(put.status).toBe(400);

    const cfg = await request(app).post(`/api/subnets/${s.id}/configure`)
      .send({ name: 'fid-str', create_reverse_dns: false, create_dhcp_scope: false, folder_id: '3' });
    expect(cfg.status).toBe(400);
  });

  it('rejects a folder that does not exist on all three routes', async () => {
    const s = await mkSubnet({ cidr: '10.123.0.0/24', name: 'fid-missing', status: 'allocated', gateway_address: '10.123.0.1' });
    const create = await request(app).post('/api/subnets')
      .send({ cidr: '10.124.0.0/24', name: 'fid-missing2', status: 'allocated', folder_id: 999999 });
    expect(create.status).toBe(400);

    const put = await request(app).put(`/api/subnets/${s.id}`).send({ folder_id: 999999 });
    expect(put.status).toBe(400);

    const cfg = await request(app).post(`/api/subnets/${s.id}/configure`)
      .send({ name: 'fid-missing', create_reverse_dns: false, create_dhcp_scope: false, folder_id: 999999 });
    expect(cfg.status).toBe(400);
  });

  it('accepts a real folder id, so the rule is not simply rejecting everything', async () => {
    const folderId = await realFolder();
    const s = await mkSubnet({ cidr: '10.125.0.0/24', name: 'fid-ok', status: 'allocated', gateway_address: '10.125.0.1' });
    const put = await request(app).put(`/api/subnets/${s.id}`).send({ folder_id: folderId });
    expect(put.status).toBe(200);
    expect(put.body.folder_id).toBe(folderId);
  });

  it('still accepts null, which clears the assignment', async () => {
    const s = await mkSubnet({ cidr: '10.126.0.0/24', name: 'fid-null', status: 'allocated', gateway_address: '10.126.0.1' });
    const put = await request(app).put(`/api/subnets/${s.id}`).send({ folder_id: null });
    expect(put.status).toBe(200);
  });
});

describe('GET /api/dhcp/scopes/:id/addresses, lifecycle state', () => {
  it('includes ip_addresses lifecycle state for unassigned addresses in the scope', async () => {
    const s = await mkSubnet({ cidr: '10.44.0.0/24', name: 'scope-lifecycle', status: 'allocated', gateway_address: '10.44.0.1' });
    await configure(s.id, {
      name: 'scope-lifecycle', create_reverse_dns: false, create_dhcp_scope: true,
      dhcp_start_ip: '10.44.0.100', dhcp_end_ip: '10.44.0.110'
    });

    const scopes = await request(app).get('/api/dhcp/scopes');
    const scope = scopes.body.find(sc => sc.subnet_id === s.id);
    expect(scope).toBeDefined();

    const { getDb } = await import('../../../src/db/init.js');
    const db = getDb();
    db.prepare(`
      UPDATE ip_addresses
         SET hostname = 'restored-prod-lease',
             mac_address = 'aa:bb:cc:dd:ee:ff',
             last_seen_mac = 'aa:bb:cc:dd:ee:ff',
             allocation_state = 'unassigned',
             is_online = 1,
             detection_source = 'dhcp_lease',
             last_seen_at = datetime('now'),
             last_scanned_at = datetime('now')
       WHERE subnet_id = ? AND ip_address = '10.44.0.104'
    `).run(s.id);

    const res = await request(app).get(`/api/dhcp/scopes/${scope.id}/addresses`);
    expect(res.status).toBe(200);

    const row = res.body.find(addr => addr.ip_address === '10.44.0.104');
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('type');
    expect(row).not.toHaveProperty('status');
    expect(row.dhcp_assignment_type).toBeNull();
    expect(row.lease_status).toBe('unavailable');
    expect(row.allocation_state).toBe('unassigned');
    expect(row.ip_display_status).toBe('in use');
    expect(row.address_type).toBe('rogue');
    expect(row.is_online).toBe(true);
    expect(row.hostname).toBe('restored-prod-lease');
    expect(row.mac_address).toBe('aa:bb:cc:dd:ee:ff');
    expect(row.has_dhcp_reservation).toBe(0);
    expect(row.dhcp_expires_at).toBeNull();
  });

  it('shows retained lease history as expired without occupying a scope address', async () => {
    const s = await mkSubnet({
      cidr: '10.45.0.0/24', name: 'scope-expired', status: 'allocated',
      gateway_address: '10.45.0.1'
    });
    await configure(s.id, {
      name: 'scope-expired', create_reverse_dns: false, create_dhcp_scope: true,
      dhcp_start_ip: '10.45.0.100', dhcp_end_ip: '10.45.0.110'
    });
    const scopes = await request(app).get('/api/dhcp/scopes');
    const scope = scopes.body.find(sc => sc.subnet_id === s.id);
    const { getDb } = await import('../../../src/db/init.js');
    getDb().prepare(`
      INSERT INTO dhcp_leases
        (subnet_id, ip_address, mac_address, hostname, expires_at)
      VALUES (?, '10.45.0.104', 'aa:bb:cc:dd:ee:45', 'expired-host', datetime('now', '-1 second'))
    `).run(s.id);

    const leases = await request(app).get('/api/dhcp/leases');
    const history = leases.body.find(row => row.subnet_id === s.id && row.ip_address === '10.45.0.104');
    expect(history).toMatchObject({
      dhcp_assignment_type: 'dynamic',
      lease_status: 'expired',
      hostname: 'expired-host'
    });

    const addresses = await request(app).get(`/api/dhcp/scopes/${scope.id}/addresses`);
    expect(addresses.body.find(row => row.ip_address === '10.45.0.104')).toMatchObject({
      dhcp_assignment_type: null,
      lease_status: 'available'
    });
  });
});

describe('canonical IP allocation endpoints', () => {
  it('reserves and releases one address through allocation_state', async () => {
    const s = await mkSubnet({
      cidr: '10.46.0.0/24', name: 'canonical-allocation', status: 'allocated',
      gateway_address: '10.46.0.1'
    });
    await configure(s.id, {
      name: 'canonical-allocation', create_reverse_dns: false,
      create_dhcp_scope: false, gateway_address: '10.46.0.1'
    });

    const { regenerateDhcpConfigs } = await import('../../../src/utils/dhcp.js');
    regenerateDhcpConfigs.mockClear();

    const reserve = await request(app)
      .put(`/api/subnets/${s.id}/ips/10.46.0.50/allocation`)
      .send({ allocation_state: 'reserved', note: 'printer hold' });
    expect(reserve.status).toBe(200);
    expect(reserve.body).toMatchObject({
      ip_address: '10.46.0.50',
      allocation_state: 'reserved',
      reservation_note: 'printer hold'
    });
    await vi.waitFor(() => expect(regenerateDhcpConfigs).toHaveBeenCalledTimes(1));

    const { getDb } = await import('../../../src/db/init.js');
    expect(getDb().prepare(`
      SELECT allocation_state, allocation_source_type, reservation_note
      FROM ip_addresses WHERE subnet_id = ? AND ip_address = '10.46.0.50'
    `).get(s.id)).toEqual({
      allocation_state: 'reserved',
      allocation_source_type: 'admin_reservation',
      reservation_note: 'printer hold'
    });

    const ips = await request(app).get(`/api/subnets/${s.id}/ips?search=10.46.0.50`);
    expect(ips.body.ips[0]).toMatchObject({
      allocation_state: 'reserved',
      ip_display_status: 'in use',
      address_type: 'IP Reservation'
    });
    expect(ips.body.ips[0]).not.toHaveProperty('status');

    const release = await request(app)
      .put(`/api/subnets/${s.id}/ips/10.46.0.50/allocation`)
      .send({ allocation_state: 'unassigned' });
    expect(release.status).toBe(200);
    await vi.waitFor(() => expect(regenerateDhcpConfigs).toHaveBeenCalledTimes(2));
    expect(getDb().prepare(`
      SELECT allocation_state, allocation_source_type, reservation_note
      FROM ip_addresses WHERE subnet_id = ? AND ip_address = '10.46.0.50'
    `).get(s.id)).toEqual({
      allocation_state: 'unassigned',
      allocation_source_type: null,
      reservation_note: null
    });

    const legacy = await request(app)
      .put(`/api/subnets/${s.id}/ips/10.46.0.50/status`)
      .send({ status: 'locked' });
    expect(legacy.status).toBe(404);
  });

  it('bulk allocation skips protected topology addresses', async () => {
    const s = await mkSubnet({
      cidr: '10.47.0.0/24', name: 'canonical-bulk-allocation', status: 'allocated',
      gateway_address: '10.47.0.1'
    });
    await configure(s.id, {
      name: 'canonical-bulk-allocation', create_reverse_dns: false,
      create_dhcp_scope: false, gateway_address: '10.47.0.1'
    });

    const { regenerateDhcpConfigs } = await import('../../../src/utils/dhcp.js');
    regenerateDhcpConfigs.mockClear();

    const reserve = await request(app)
      .put(`/api/subnets/${s.id}/ips/bulk-allocation`)
      .send({
        start_ip: '10.47.0.0',
        end_ip: '10.47.0.3',
        allocation_state: 'reserved'
      });
    expect(reserve.status).toBe(200);
    expect(reserve.body).toMatchObject({ count: 2, skipped: 2, allocation_state: 'reserved' });
    await vi.waitFor(() => expect(regenerateDhcpConfigs).toHaveBeenCalledTimes(1));

    const { getDb } = await import('../../../src/db/init.js');
    expect(getDb().prepare(`
      SELECT ip_address FROM ip_addresses
      WHERE subnet_id = ? AND allocation_state = 'reserved'
      ORDER BY ip_address
    `).all(s.id).map(row => row.ip_address)).toEqual(['10.47.0.2', '10.47.0.3']);
  });
});

// --- Child-folder assignment ------------------------------------------

describe('Folder assignment on child subnets', () => {
  it('allows moving a child subnet to its own folder (promoted in the tree)', async () => {
    // Two folders.
    const fA = (await request(app).post('/api/folders').send({ name: 'FolderA' })).body;
    const fB = (await request(app).post('/api/folders').send({ name: 'FolderB' })).body;

    // Parent /23 in folder A.
    const parent = await mkSubnet({
      cidr: '10.50.0.0/23', name: 'Parent', status: 'allocated', gateway_address: '10.50.0.1', folder_id: fA.id
    });
    // Divide into two /24 children.
    const div = await request(app).post(`/api/subnets/${parent.id}/divide`).send({ new_prefix: 24, force: true });
    expect(div.status).toBe(200);

    // Grab a child via the tree.
    const tree1 = await request(app).get('/api/subnets');
    const fAGroup = tree1.body.folders.find(f => f.id === fA.id);
    const p = fAGroup.subnets.find(s => s.id === parent.id);
    const child = p.children[0];

    // Move the child to folder B.
    const put = await request(app).put(`/api/subnets/${child.id}`).send({ folder_id: fB.id });
    expect(put.status).toBe(200);

    // The child now appears as a root-level entry under folder B.
    const tree2 = await request(app).get('/api/subnets');
    const fBGroup = tree2.body.folders.find(f => f.id === fB.id);
    expect(fBGroup).toBeDefined();
    const promoted = fBGroup.subnets.find(s => s.id === child.id);
    expect(promoted).toBeDefined();
    expect(promoted.folder_id).toBe(fB.id);

    // And it no longer nests under the parent in folder A.
    const fAGroupAfter = tree2.body.folders.find(f => f.id === fA.id);
    const parentAfter = fAGroupAfter.subnets.find(s => s.id === parent.id);
    expect(parentAfter.children.some(c => c.id === child.id)).toBe(false);
  });

  it('clears folder_id on a child (inherits parent folder again)', async () => {
    const fA = (await request(app).post('/api/folders').send({ name: 'FolderA2' })).body;
    const fC = (await request(app).post('/api/folders').send({ name: 'FolderC' })).body;

    const parent = await mkSubnet({
      cidr: '10.51.0.0/23', name: 'Parent2', status: 'allocated', gateway_address: '10.51.0.1', folder_id: fA.id
    });
    await request(app).post(`/api/subnets/${parent.id}/divide`).send({ new_prefix: 24, force: true });

    const tree1 = await request(app).get('/api/subnets');
    const fAGroup = tree1.body.folders.find(f => f.id === fA.id);
    const child = fAGroup.subnets.find(s => s.id === parent.id).children[0];

    // Promote to fC, then clear.
    await request(app).put(`/api/subnets/${child.id}`).send({ folder_id: fC.id });
    const clr = await request(app).put(`/api/subnets/${child.id}`).send({ folder_id: null });
    expect(clr.status).toBe(200);

    // Child is back under the parent in fA, and fC no longer references it.
    const tree2 = await request(app).get('/api/subnets');
    const fCGroup = tree2.body.folders.find(f => f.id === fC.id);
    expect(fCGroup.subnets.some(s => s.id === child.id)).toBe(false);
    const fAGroup2 = tree2.body.folders.find(f => f.id === fA.id);
    const parentAfter = fAGroup2.subnets.find(s => s.id === parent.id);
    expect(parentAfter.children.some(c => c.id === child.id)).toBe(true);
  });
});

// --- VLAN collision warning -------------------------------------------

describe('VLAN collision warning', () => {
  it('returns vlan_warning when POST creates a subnet with a VLAN already in use', async () => {
    await mkSubnet({ cidr: '10.70.0.0/24', name: 'vlan-a', vlan_id: 42, status: 'unallocated' });
    const res = await request(app).post('/api/subnets').send({
      cidr: '10.70.1.0/24', name: 'vlan-b', vlan_id: 42
    });
    expect(res.status).toBe(201);
    expect(res.body.vlan_warning).toBeDefined();
    expect(res.body.vlan_warning.vlan_id).toBe(42);
    expect(res.body.vlan_warning.peers.some(p => p.cidr === '10.70.0.0/24')).toBe(true);
  });

  it('does NOT return vlan_warning when VLAN is unique', async () => {
    const res = await request(app).post('/api/subnets').send({
      cidr: '10.71.0.0/24', name: 'vlan-unique', vlan_id: 99
    });
    expect(res.status).toBe(201);
    expect(res.body.vlan_warning).toBeUndefined();
  });

  it('returns vlan_warning when PUT sets a conflicting VLAN', async () => {
    await mkSubnet({ cidr: '10.72.0.0/24', name: 'vlan-existing', vlan_id: 55, status: 'unallocated' });
    const target = await mkSubnet({ cidr: '10.72.1.0/24', name: 'vlan-target', status: 'unallocated' });
    const res = await request(app).put(`/api/subnets/${target.id}`).send({ vlan_id: 55 });
    expect(res.status).toBe(200);
    expect(res.body.vlan_warning).toBeDefined();
    expect(res.body.vlan_warning.vlan_id).toBe(55);
  });
});

// --- Reservation leaf-only guard (R-audit MEDIUM) ---------------------

describe('POST /api/dhcp/reservations, subnet target must be an allocated leaf', () => {
  it('rejects a reservation on a subnet that has children (not a leaf)', async () => {
    const fA = (await request(app).post('/api/folders').send({ name: 'ResvLeafA' })).body;
    void fA;
    const parent = await mkSubnet({
      cidr: '10.60.0.0/23', name: 'resv-leaf', status: 'allocated', gateway_address: '10.60.0.1'
    });
    // Divide so the parent becomes a non-leaf container.
    const div = await request(app).post(`/api/subnets/${parent.id}/divide`).send({ new_prefix: 24, force: true });
    expect(div.status).toBe(200);

    // Parent is now a non-leaf. Reservation targeting it must 400.
    const resv = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: parent.id, ip_address: '10.60.0.50',
      mac_address: 'aa:bb:cc:00:ee:01', hostname: 'nolock'
    });
    expect(resv.status).toBe(400);
    expect(resv.body.error).toMatch(/leaf|child subnets/i);
  });

  it('rejects a reservation on an unallocated subnet', async () => {
    const s = await mkSubnet({
      cidr: '10.61.0.0/24', name: 'resv-unalloc', status: 'unallocated'
    });
    const resv = await request(app).post('/api/dhcp/reservations').send({
      subnet_id: s.id, ip_address: '10.61.0.50',
      mac_address: 'aa:bb:cc:00:ee:02', hostname: 'nolock'
    });
    expect(resv.status).toBe(400);
    expect(resv.body.error).toMatch(/allocated/i);
  });
});

// --- Range DELETE guard (R2 #2) ---------------------------------------

describe('DELETE /api/subnets/:subnetId/ranges/:id, scope guard', () => {
  it('refuses to update a range to a nonexistent range type', async () => {
    const s = await mkSubnet({ cidr: '10.92.0.0/24', name: 'range-type-guard', status: 'allocated', gateway_address: '10.92.0.1' });
    const { getDb } = await import('../../../src/db/init.js');
    const db = getDb();
    const staticType = db.prepare("SELECT id FROM range_types WHERE name = 'Static'").get();

    const created = await request(app).post(`/api/subnets/${s.id}/ranges`).send({
      range_type_id: staticType.id,
      start_ip: '10.92.0.50',
      end_ip: '10.92.0.50',
      description: 'valid'
    });
    expect(created.status).toBe(201);

    const bad = await request(app).put(`/api/subnets/${s.id}/ranges/${created.body.id}`).send({
      range_type_id: 999999
    });
    expect(bad.status).toBe(404);
    expect(bad.body.error).toMatch(/Range type/i);
  });

  it('refuses to delete a range that has a DHCP scope attached', async () => {
    const s = await mkSubnet({ cidr: '10.43.0.0/24', name: 'range-del', status: 'allocated', gateway_address: '10.43.0.1' });
    await configure(s.id, {
      name: 'range-del', create_reverse_dns: false, create_dhcp_scope: true,
      dhcp_start_ip: '10.43.0.100', dhcp_end_ip: '10.43.0.200'
    });

    const scopes = await request(app).get('/api/dhcp/scopes');
    const scope = scopes.body.find(sc => sc.subnet_id === s.id);
    const rangeId = scope.range_id;

    const del = await request(app).delete(`/api/subnets/${s.id}/ranges/${rangeId}`);
    expect(del.status).toBe(409);
    expect(del.body.dhcp_scope_id).toBe(scope.id);
  });
});
