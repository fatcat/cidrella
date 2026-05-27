/**
 * Regression tests for the remaining mutation-path fixes (R1 #2, R2 #2/#3,
 * R3 #2, R4 #1–#4).
 *
 *   - Forward-zone rename-in-place (records survive — the pre-R1 delete-and-
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
describe('PUT /api/subnets/:id — domain_name pointer semantics', () => {
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

    // B pointing at the same zone is allowed — no 409.
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

    // The zone is deliberately NOT deleted — zones are shared state.
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
});

// --- DNS record rename clears stale ip_addresses.hostname --------------
//
// Prior to the bug fix, PUT /api/dns/zones/:zoneId/records/:id only called
// clearDnsFromIp when the record's VALUE changed. A name-only rename on the
// same IP would leave the old FQDN on ip_addresses.hostname (still sort of
// OK because syncDnsToIp then overwrites). The more dangerous path was
// DELETE paths that skipped clearDnsFromIp (pre-refactor test data, SQL
// edits), leaving orphan rows that later flagged as lossy on divide.
// reconcileDnsOrphans on startup is the safety net.
describe('ip-sync orphan cleanup', () => {
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

  it('reconcileDnsOrphans clears hostname on ip_addresses rows without a backing DNS record', async () => {
    const { reconcileDnsOrphans } = await import('../../../src/utils/ip-sync.js');
    const { getDb } = await import('../../../src/db/init.js');
    const db = getDb();

    const s = await mkSubnet({
      cidr: '10.81.0.0/24', name: 'orphan-src', status: 'allocated', gateway_address: '10.81.0.1'
    });
    await configure(s.id, {
      name: 'orphan-src', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'orphan-src.test'
    });

    // Plant a phantom DNS-sourced row: hostname points at a zone-qualified
    // FQDN that has no backing dns_records row. This simulates the pre-
    // refactor orphan state.
    db.prepare(`
      INSERT OR REPLACE INTO ip_addresses
        (subnet_id, ip_address, hostname, status, detection_source, updated_at)
      VALUES (?, ?, ?, 'available', 'dns', datetime('now'))
    `).run(s.id, '10.81.0.77', 'ghost.orphan-src.test');

    const before = db.prepare('SELECT hostname, detection_source FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?')
      .get(s.id, '10.81.0.77');
    expect(before.hostname).toBe('ghost.orphan-src.test');

    const cleared = reconcileDnsOrphans(db);
    expect(cleared).toBeGreaterThanOrEqual(1);

    const after = db.prepare('SELECT hostname, detection_source FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?')
      .get(s.id, '10.81.0.77');
    expect(after.hostname).toBeNull();
    expect(after.detection_source).toBeNull();
  });

  it('reconcileDnsOrphans does NOT touch rows with a real backing A record', async () => {
    const { reconcileDnsOrphans } = await import('../../../src/utils/ip-sync.js');
    const { getDb } = await import('../../../src/db/init.js');
    const db = getDb();

    const s = await mkSubnet({
      cidr: '10.82.0.0/24', name: 'orphan-keep', status: 'allocated', gateway_address: '10.82.0.1'
    });
    await configure(s.id, {
      name: 'orphan-keep', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'orphan-keep.test'
    });
    const zone = await findZone('orphan-keep.test');
    await request(app).post(`/api/dns/zones/${zone.id}/records`).send({
      name: 'keeper', type: 'A', value: '10.82.0.42'
    });

    // A-record create already wrote hostname='keeper.orphan-keep.test' with
    // detection_source='dns' — that's a REAL mapping. Reconcile must leave it.
    reconcileDnsOrphans(db);

    const row = db.prepare(
      'SELECT hostname, detection_source FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
    ).get(s.id, '10.82.0.42');
    expect(row.hostname).toBe('keeper.orphan-keep.test');
    expect(row.detection_source).toBe('dns');
  });
});

// --- PUT /:id CIDR reject + gateway-in-pool guards --------------------

describe('PUT /api/subnets/:id — structural guards', () => {
  it('rejects CIDR change in the body when the value differs (R2 #5)', async () => {
    const s = await mkSubnet({ cidr: '10.40.0.0/24', name: 'cidr-fixed', status: 'allocated', gateway_address: '10.40.0.1' });

    // Changing CIDR via PUT is still rejected.
    const bad = await request(app).put(`/api/subnets/${s.id}`).send({ cidr: '10.40.1.0/24' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/CIDR cannot be changed/i);

    // But echoing the existing CIDR back in the body is a harmless no-op —
    // the edit dialog always sends the current value along with the other
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

describe('PUT /api/dhcp/scopes/:id — pool resize guard (R4 #4)', () => {
  it('refuses a pool resize that would include the subnet gateway', async () => {
    const s = await mkSubnet({ cidr: '10.42.0.0/24', name: 'scope-resize', status: 'allocated', gateway_address: '10.42.0.1' });
    await configure(s.id, {
      name: 'scope-resize', create_reverse_dns: false, create_dhcp_scope: true,
      dhcp_start_ip: '10.42.0.100', dhcp_end_ip: '10.42.0.200'
    });

    const scopes = await request(app).get('/api/dhcp/scopes');
    const scope = scopes.body.find(sc => sc.subnet_id === s.id);
    expect(scope).toBeDefined();

    // Try to widen the pool to include .1 (the gateway) — 409.
    const bad = await request(app).put(`/api/dhcp/scopes/${scope.id}`).send({ start_ip: '10.42.0.1', end_ip: '10.42.0.200' });
    expect(bad.status).toBe(409);

    // A valid resize still works.
    const ok = await request(app).put(`/api/dhcp/scopes/${scope.id}`).send({ start_ip: '10.42.0.50', end_ip: '10.42.0.200' });
    expect(ok.status).toBe(200);
  });
});

describe('GET /api/dhcp/scopes/:id/addresses — lifecycle state', () => {
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
             status = 'available',
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
    expect(row.ip_lifecycle_status).toBe('available');
    expect(row.address_type).toBe('rogue');
    expect(row.is_online).toBe(true);
    expect(row.hostname).toBe('restored-prod-lease');
    expect(row.mac_address).toBe('aa:bb:cc:dd:ee:ff');
    expect(row.has_dhcp_reservation).toBe(0);
    expect(row.has_static_dns).toBe(0);
    expect(row.dhcp_expires_at).toBeNull();
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

describe('POST /api/dhcp/reservations — subnet target must be an allocated leaf', () => {
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

describe('DELETE /api/subnets/:subnetId/ranges/:id — scope guard', () => {
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
