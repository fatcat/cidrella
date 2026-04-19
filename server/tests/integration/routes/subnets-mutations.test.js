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

describe('PUT /api/subnets/:id — forward-zone rename', () => {
  it('renames the zone in place, preserving records', async () => {
    const s = await mkSubnet({ cidr: '10.30.0.0/24', name: 'rename', status: 'allocated', gateway_address: '10.30.0.1' });
    await configure(s.id, { name: 'rename', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'old.test' });
    const zoneBefore = await findZone('old.test');
    await request(app).post(`/api/dns/zones/${zoneBefore.id}/records`).send({ name: 'survivor', type: 'A', value: '10.30.0.50' });

    const put = await request(app).put(`/api/subnets/${s.id}`).send({ domain_name: 'new.test' });
    expect(put.status).toBe(200);

    const zoneAfter = await findZone('new.test');
    expect(zoneAfter.id).toBe(zoneBefore.id);  // same row, renamed
    const records = await request(app).get(`/api/dns/zones/${zoneAfter.id}/records`);
    expect(records.body.find(r => r.name === 'survivor')).toBeDefined();
  });

  it('rejects with 409 when the target name is owned by another subnet', async () => {
    const a = await mkSubnet({ cidr: '10.31.0.0/24', name: 'A', status: 'allocated', gateway_address: '10.31.0.1' });
    const b = await mkSubnet({ cidr: '10.31.1.0/24', name: 'B', status: 'allocated', gateway_address: '10.31.1.1' });
    await configure(a.id, { name: 'A', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'owned.test' });
    await configure(b.id, { name: 'B', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'other.test' });

    const put = await request(app).put(`/api/subnets/${b.id}`).send({ domain_name: 'owned.test' });
    expect(put.status).toBe(409);
  });

  it('adopts a detached (subnet_id NULL) same-name zone instead of 409 (R4 #3)', async () => {
    const s = await mkSubnet({ cidr: '10.32.0.0/24', name: 'adopter', status: 'allocated', gateway_address: '10.32.0.1' });

    // Create a forward zone with no subnet_id — e.g. left over from a prior detach.
    const zoneRes = await request(app).post('/api/dns/zones').send({ name: 'orphan.test', type: 'forward' });
    expect(zoneRes.status).toBe(201);
    expect(zoneRes.body.subnet_id).toBeNull();

    const put = await request(app).put(`/api/subnets/${s.id}`).send({ domain_name: 'orphan.test' });
    expect(put.status).toBe(200);

    const adopted = await findZone('orphan.test');
    expect(adopted.id).toBe(zoneRes.body.id);
    expect(adopted.subnet_id).toBe(s.id);
  });

  it('detaches the zone (subnet_id NULL) when domain_name is cleared', async () => {
    const s = await mkSubnet({ cidr: '10.33.0.0/24', name: 'detacher', status: 'allocated', gateway_address: '10.33.0.1' });
    await configure(s.id, { name: 'detacher', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'attached.test' });
    const zoneBefore = await findZone('attached.test');
    expect(zoneBefore.subnet_id).toBe(s.id);

    const put = await request(app).put(`/api/subnets/${s.id}`).send({ domain_name: null });
    expect(put.status).toBe(200);

    const zoneAfter = await findZone('attached.test');
    expect(zoneAfter).toBeDefined();
    expect(zoneAfter.subnet_id).toBeNull();
  });
});

// --- Bidirectional zone ↔ subnet.domain_name sync (R4) -----------------

describe('DNS zone CRUD ↔ subnets.domain_name sync', () => {
  it('POST /api/dns/zones sets subnets.domain_name when attaching to an empty-domain subnet (R4 #2)', async () => {
    const s = await mkSubnet({ cidr: '10.34.0.0/24', name: 'zone-post', status: 'allocated', gateway_address: '10.34.0.1' });

    const zoneRes = await request(app).post('/api/dns/zones').send({
      name: 'post-synced.test', type: 'forward', subnet_id: s.id
    });
    expect(zoneRes.status).toBe(201);

    const get = await request(app).get(`/api/subnets/${s.id}`);
    expect(get.body.domain_name).toBe('post-synced.test');
  });

  it('PUT /api/dns/zones/:id rename syncs subnets.domain_name (R4 #1)', async () => {
    const s = await mkSubnet({ cidr: '10.35.0.0/24', name: 'zone-put', status: 'allocated', gateway_address: '10.35.0.1' });
    await configure(s.id, { name: 'zone-put', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'before.test' });
    const zone = await findZone('before.test');

    const put = await request(app).put(`/api/dns/zones/${zone.id}`).send({ name: 'after.test' });
    expect(put.status).toBe(200);

    const get = await request(app).get(`/api/subnets/${s.id}`);
    expect(get.body.domain_name).toBe('after.test');
  });

  it('DELETE /api/dns/zones/:id clears subnets.domain_name when it backed the subnet (R3 #7)', async () => {
    const s = await mkSubnet({ cidr: '10.36.0.0/24', name: 'zone-del', status: 'allocated', gateway_address: '10.36.0.1' });
    await configure(s.id, { name: 'zone-del', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'gone.test' });
    const zone = await findZone('gone.test');

    const del = await request(app).delete(`/api/dns/zones/${zone.id}`);
    expect(del.status).toBe(200);

    const get = await request(app).get(`/api/subnets/${s.id}`);
    expect(get.body.domain_name).toBeNull();
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
