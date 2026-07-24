/**
 * Regression tests for the subnet divide path. These guard the R1–R3 data-loss
 * fixes: per-IP artifact transfer, DNS zone migration, DHCP scope inheritance,
 * lossy-IP detection (network/broadcast + DNS A records + outside_selection),
 * and the force/force_lossy gates.
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

describe('POST /api/subnets/:id/divide — data preservation', () => {
  it('transfers DHCP reservations into the child that contains the IP', async () => {
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

describe('POST /api/subnets/:id/divide — lossy gate', () => {
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

  it('execute without force_lossy 409s when lossy rows exist', async () => {
    const parent = await createSubnet({ cidr: '10.13.0.0/22', name: 'Lossy-gate', status: 'allocated', gateway_address: '10.13.0.1' });
    await configure(parent.id, { name: 'Lossy-gate', create_reverse_dns: false, create_dhcp_scope: true });

    await request(app).post('/api/dhcp/reservations').send({
      subnet_id: parent.id, ip_address: '10.13.1.255', mac_address: 'aa:bb:cc:00:00:21', hostname: 'doomed'
    });

    // `force` (allocated gate) is set; force_lossy is NOT. The lossy gate must still block.
    const res = await divide(parent.id, { new_prefix: 23, force: true });
    expect(res.status).toBe(409);
    expect(res.body.can_force_lossy).toBe(true);
    expect(Array.isArray(res.body.lossy)).toBe(true);
    expect(res.body.lossy.length).toBeGreaterThan(0);
  });

  it('execute with force + force_lossy succeeds', async () => {
    const parent = await createSubnet({ cidr: '10.14.0.0/22', name: 'Lossy-force', status: 'allocated', gateway_address: '10.14.0.1' });
    await configure(parent.id, { name: 'Lossy-force', create_reverse_dns: false, create_dhcp_scope: true });

    await request(app).post('/api/dhcp/reservations').send({
      subnet_id: parent.id, ip_address: '10.14.1.255', mac_address: 'aa:bb:cc:00:00:22', hostname: 'doomed'
    });

    const res = await divide(parent.id, { new_prefix: 23, force: true, force_lossy: true });
    expect(res.status).toBe(200);
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

  it('flags rows outside selected_cidrs when partially dividing', async () => {
    const parent = await createSubnet({ cidr: '10.16.0.0/22', name: 'Lossy-partial', status: 'allocated', gateway_address: '10.16.0.1' });
    await configure(parent.id, { name: 'Lossy-partial', create_reverse_dns: false, create_dhcp_scope: true });

    // Reservation in the upper half, which the user is NOT selecting.
    await request(app).post('/api/dhcp/reservations').send({
      subnet_id: parent.id, ip_address: '10.16.3.50', mac_address: 'aa:bb:cc:00:00:30', hostname: 'stranded'
    });

    const prev = await dividePreview(parent.id, { new_prefix: 23 });
    expect(prev.status).toBe(200);
    // Preview returns the full expansion; execute is where selected_cidrs kicks in.
    // For the lossy gate, we need to call execute with a subset.
    const res = await divide(parent.id, {
      new_prefix: 23, force: true, selected_cidrs: ['10.16.0.0/23']
    });
    expect(res.status).toBe(409);
    const stranded = res.body.lossy.find(l => l.ip === '10.16.3.50' && l.reason === 'outside_selection');
    expect(stranded).toBeDefined();
  });

  it('returns empty lossy when no host data sits on a boundary', async () => {
    const parent = await createSubnet({ cidr: '10.17.0.0/22', name: 'Clean', status: 'allocated', gateway_address: '10.17.0.1' });
    await configure(parent.id, { name: 'Clean', create_reverse_dns: false, create_dhcp_scope: true });

    const prev = await dividePreview(parent.id, { new_prefix: 23 });
    expect(prev.status).toBe(200);
    expect(prev.body.lossy).toEqual([]);
  });
});

describe('POST /api/subnets/:id/divide — lossy-artifact cleanup with force_lossy', () => {
  it('deletes DHCP reservations, DNS A records, and reports counts', async () => {
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

    // DNS A record pointing at the same IP.
    const zones = await request(app).get('/api/dns/zones');
    const fwd = zones.body.find(z => z.name === 'lossy-cleanup.test');
    await request(app).post(`/api/dns/zones/${fwd.id}/records`).send({
      name: 'doomed', type: 'A', value: '10.19.1.255'
    });

    // Execute with both force flags.
    const divRes = await divide(parent.id, { new_prefix: 23, force: true, force_lossy: true });
    expect(divRes.status).toBe(200);

    // Cleanup summary is echoed back.
    expect(divRes.body.lossy_cleanup).toBeDefined();
    expect(divRes.body.lossy_cleanup.ips).toContain('10.19.1.255');
    expect(divRes.body.lossy_cleanup.removed.reservations).toBeGreaterThanOrEqual(1);
    expect(divRes.body.lossy_cleanup.removed.dns_records).toBeGreaterThanOrEqual(1);

    // The reservation is actually gone.
    const resvListing = await request(app).get('/api/dhcp/reservations');
    expect(resvListing.body.find(r => r.ip_address === '10.19.1.255')).toBeUndefined();

    // The A record is actually gone.
    const recs = await request(app).get(`/api/dns/zones/${fwd.id}/records`);
    expect(recs.body.find(r => r.value === '10.19.1.255')).toBeUndefined();
  });
});

describe('POST /api/subnets/:id/divide — gateway/pool conflict handling', () => {
  it('shrinks the pool to exclude the child gateway and reports the adjustment', async () => {
    // Parent /22 with gateway at .1 (firstUsable) and a pool spanning the
    // FULL usable range of the parent. After divide into /23s, each child
    // inherits a clipped slice of the pool that still contains the child's
    // own gateway (.0.1 and .2.1). The server should shrink each child's
    // pool to exclude its gateway and echo the adjustment back.
    const parent = await createSubnet({
      cidr: '10.18.0.0/22', name: 'GwInPool', status: 'allocated', gateway_address: '10.18.0.1'
    });
    await configure(parent.id, {
      name: 'GwInPool', create_reverse_dns: false, create_dhcp_scope: true,
      // Explicit wide pool that bleeds across the /23 boundary and covers
      // each child's firstUsable.
      dhcp_start_ip: '10.18.0.1', dhcp_end_ip: '10.18.3.254'
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
