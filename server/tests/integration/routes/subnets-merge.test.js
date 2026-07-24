/**
 * Regression tests for the subnet merge path. Guards the R1/R3 fixes:
 *   - transferPerIpArtifactsToParent moves reservations + ip_addresses
 *     (with UNIQUE-constraint dedup from R3 #5).
 *   - migrateChildZonesToParent moves DNS zones.
 *   - migrateChildScopesToParent preserves the configSource's DHCP scope
 *     (R3 #1, the scope previously cascaded to nothing).
 *   - detectForwardZoneConflict blocks 409 when siblings own different
 *     forward-zone domain names.
 *
 * Pre-R1 behaviour: a merge deleted all children and their dns_zones,
 * dhcp_reservations, ip_addresses rows. Post-R3, the configSource's DHCP
 * scope also survives.
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
  ]);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

async function createSubnet(body) {
  const res = await request(app).post('/api/subnets').send(body);
  expect(res.status).toBe(201);
  return res.body;
}

async function configure(id, body) {
  const res = await request(app).post(`/api/subnets/${id}/configure`).send(body);
  expect(res.status).toBe(200);
  return res.body;
}

async function getChildren(parentId) {
  const tree = await request(app).get('/api/subnets');
  const flat = [];
  const walk = (xs) => { for (const s of xs) { flat.push(s); walk(s.children || []); } };
  for (const f of tree.body.folders) walk(f.subnets || []);
  const p = flat.find(s => s.id === parentId);
  return p?.children || [];
}

describe('POST /api/subnets/merge — data preservation', () => {
  it('preserves reservations on merged children', async () => {
    const parent = await createSubnet({ cidr: '10.20.0.0/23', name: 'M-resv', status: 'allocated', gateway_address: '10.20.0.1' });
    await configure(parent.id, { name: 'M-resv', create_reverse_dns: false, create_dhcp_scope: false });

    const div = await request(app).post(`/api/subnets/${parent.id}/divide`).send({ new_prefix: 24, force: true });
    expect(div.status).toBe(200);
    const children = await getChildren(parent.id);
    const [c0, c1] = children.sort((a, b) => a.cidr.localeCompare(b.cidr));

    // Reservation on the upper child, should survive the merge.
    await request(app).post('/api/dhcp/reservations').send({
      subnet_id: c1.id, ip_address: '10.20.1.50', mac_address: 'aa:bb:cc:10:00:01', hostname: 'keepme'
    });

    const merge = await request(app).post('/api/subnets/merge').send({ subnet_ids: [c0.id, c1.id] });
    expect(merge.status).toBe(200);

    // After merge, the reservation should be attached to the merged subnet
    // (which is the reconstituted parent at the /23).
    const resvs = await request(app).get('/api/dhcp/reservations');
    const keepme = resvs.body.find(r => r.hostname === 'keepme');
    expect(keepme).toBeDefined();
    expect(keepme.subnet_id).toBe(parent.id);
  });

  it('preserves the configSource DHCP scope (R3 #1)', async () => {
    const parent = await createSubnet({ cidr: '10.21.0.0/23', name: 'M-scope', status: 'allocated', gateway_address: '10.21.0.1' });
    await configure(parent.id, {
      name: 'M-scope', create_reverse_dns: false, create_dhcp_scope: true,
      dhcp_start_ip: '10.21.0.100', dhcp_end_ip: '10.21.0.200'
    });

    const div = await request(app).post(`/api/subnets/${parent.id}/divide`).send({ new_prefix: 24, force: true });
    expect(div.status).toBe(200);
    const children = await getChildren(parent.id);
    const [c0, c1] = children.sort((a, b) => a.cidr.localeCompare(b.cidr));

    // Sanity: before the merge, c0 carries the inherited scope.
    const before = await request(app).get('/api/dhcp/scopes');
    expect(before.body.some(s => s.subnet_id === c0.id)).toBe(true);

    const merge = await request(app).post('/api/subnets/merge').send({ subnet_ids: [c0.id, c1.id] });
    expect(merge.status).toBe(200);

    // After merge the scope lives on the merged (parent) subnet.
    const after = await request(app).get('/api/dhcp/scopes');
    const mergedScopes = after.body.filter(s => s.subnet_id === parent.id);
    expect(mergedScopes.length).toBe(1);
    expect(mergedScopes[0].start_ip).toBe('10.21.0.100');
    expect(mergedScopes[0].end_ip).toBe('10.21.0.200');
  });

  it('preserves forward DNS zone across the merge', async () => {
    const parent = await createSubnet({ cidr: '10.22.0.0/23', name: 'M-dns', status: 'allocated', gateway_address: '10.22.0.1' });
    await configure(parent.id, {
      name: 'M-dns', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'merge-dns.test'
    });

    const div = await request(app).post(`/api/subnets/${parent.id}/divide`).send({ new_prefix: 24, force: true });
    expect(div.status).toBe(200);
    const children = await getChildren(parent.id);
    const [c0, c1] = children.sort((a, b) => a.cidr.localeCompare(b.cidr));

    const zonesBefore = await request(app).get('/api/dns/zones');
    const fwd = zonesBefore.body.find(z => z.name === 'merge-dns.test');
    expect(fwd).toBeDefined();

    const merge = await request(app).post('/api/subnets/merge').send({ subnet_ids: [c0.id, c1.id] });
    expect(merge.status).toBe(200);

    // Post-decouple: the zone still exists, unmodified. Any subnet may
    // reference it via domain_name, the merged parent continues to point
    // at it.
    const zonesAfter = await request(app).get('/api/dns/zones');
    const survived = zonesAfter.body.find(z => z.id === fwd.id);
    expect(survived).toBeDefined();
    const mergedParent = await request(app).get(`/api/subnets/${parent.id}`);
    expect(mergedParent.body.domain_name).toBe('merge-dns.test');
  });
});

describe('POST /api/subnets/merge — conflict detection', () => {
  it('blocks with 409 when siblings own forward zones with different names', async () => {
    const parent = await createSubnet({ cidr: '10.23.0.0/23', name: 'M-conflict', status: 'allocated', gateway_address: '10.23.0.1' });
    await configure(parent.id, {
      name: 'M-conflict', create_reverse_dns: false, create_dhcp_scope: false, domain_name: 'shared.test'
    });

    const div = await request(app).post(`/api/subnets/${parent.id}/divide`).send({ new_prefix: 24, force: true });
    expect(div.status).toBe(200);
    const children = await getChildren(parent.id);
    const [c0, c1] = children.sort((a, b) => a.cidr.localeCompare(b.cidr));

    // Give each child a distinct forward-zone domain.
    await request(app).put(`/api/subnets/${c0.id}`).send({ domain_name: 'alpha.test' });
    await request(app).put(`/api/subnets/${c1.id}`).send({ domain_name: 'beta.test' });

    // Preview surfaces the conflict...
    const prev = await request(app).post('/api/subnets/merge/preview').send({ subnet_ids: [c0.id, c1.id] });
    expect(prev.status).toBe(200);
    expect(prev.body.forward_zone_conflict).toBe(true);

    // ...and execute refuses with 409.
    const merge = await request(app).post('/api/subnets/merge').send({ subnet_ids: [c0.id, c1.id] });
    expect(merge.status).toBe(409);
    expect(merge.body.error).toMatch(/forward zone/i);
  });
});
