/**
 * An enabled manual A record allocates its address as static DNS no matter
 * which came first, the record or the network (docs/ARCHITECTURE.md,
 * Canonical IP Model). Configuring a network materializes its address rows,
 * so it must adopt the manual records that already name them, or the
 * Addresses table shows a blank row and address search cannot find the host.
 *
 * The same facts reached in either order, and through startup
 * reconciliation, converge on one allocation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';
import { invalidateSubnetCache } from '../../../src/utils/ip-sync.js';

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
const { default: dnsRouter } = await import('../../../src/routes/dns.js');
const { default: dhcpRouter } = await import('../../../src/routes/dhcp.js');
const { default: workspaceRouter } = await import('../../../src/routes/workspace.js');
const { reconcileStaticDnsAllocations, setManualReservation } =
  await import('../../../src/services/ip-lifecycle-service.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;
let db;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/dns', router: dnsRouter },
    { prefix: '/api/dhcp', router: dhcpRouter },
    { prefix: '/api/workspace', router: workspaceRouter },
  ]);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  invalidateSubnetCache();
  for (const table of [
    'dns_records',
    'dns_zones',
    'dhcp_scope_options',
    'dhcp_leases',
    'dhcp_reservations',
    'dhcp_scope_pools',
    'dhcp_scopes',
    'ranges',
    'ip_events',
    'ip_addresses',
    'subnets',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

const DOMAIN = 'lab.test';
const CIDR = '10.130.0.0/24';
const IP = '10.130.0.10';

async function createZone(name = DOMAIN) {
  const res = await request(app).post('/api/dns/zones').send({ name, type: 'forward' });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function postRecord(zoneId, name, ip, enabled = true) {
  const res = await request(app)
    .post(`/api/dns/zones/${zoneId}/records`)
    .send({ name, type: 'A', value: ip, enabled });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function allocateNetwork(body = {}) {
  const created = await request(app)
    .post('/api/subnets')
    .send({ cidr: CIDR, name: 'lab', status: 'allocated' });
  expect(created.status).toBe(201);
  invalidateSubnetCache();
  const configured = await request(app)
    .post(`/api/subnets/${created.body.id}/configure`)
    .send({
      name: 'lab',
      gateway_address: '10.130.0.1',
      domain_name: DOMAIN,
      create_reverse_dns: false,
      ...body,
    });
  expect(configured.status).toBe(200);
  invalidateSubnetCache();
  return created.body.id;
}

function addressRow(ip = IP) {
  return db
    .prepare(
      `SELECT allocation_state, allocation_source_type, allocation_source_id, hostname
         FROM ip_addresses WHERE ip_address = ?`,
    )
    .get(ip);
}

function staticDns(recordId, hostname = `pve-01.${DOMAIN}`) {
  return {
    allocation_state: 'static_dns',
    allocation_source_type: 'dns',
    allocation_source_id: recordId,
    hostname,
  };
}

async function searchAddresses(subnetId, search) {
  const res = await request(app).get(`/api/subnets/${subnetId}/ips`).query({ search });
  expect(res.status).toBe(200);
  return res.body.ips.map((row) => row.ip_address);
}

async function searchNetworks(q) {
  const res = await request(app).get('/api/workspace/networks').query({ q });
  expect(res.status).toBe(200);
  return res.body.items.map((row) => row.cidr);
}

describe('a manual A record that predates its network', () => {
  it('is adopted as static DNS when the network is configured, and is searchable', async () => {
    const zoneId = await createZone();
    const recordId = await postRecord(zoneId, 'pve-01', IP);
    const subnetId = await allocateNetwork();

    expect(addressRow()).toMatchObject(staticDns(recordId));
    const [row] = (await request(app).get(`/api/subnets/${subnetId}/ips`).query({ search: IP }))
      .body.ips;
    expect(row).toMatchObject({ address_type: 'static DNS', ip_display_status: 'in use' });
    expect(await searchAddresses(subnetId, 'pve-01')).toEqual([IP]);
    expect(await searchNetworks('pve-01')).toEqual([CIDR]);
  });

  it('matches the record-after-network order', async () => {
    await createZone();
    const subnetId = await allocateNetwork();
    const zoneId = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(DOMAIN).id;
    const recordId = await postRecord(zoneId, 'pve-01', IP);

    expect(addressRow()).toMatchObject(staticDns(recordId));
    expect(await searchAddresses(subnetId, 'pve-01')).toEqual([IP]);
  });

  it('is adopted again after the network is deleted and configured anew', async () => {
    await createZone();
    const first = await allocateNetwork();
    const zoneId = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(DOMAIN).id;
    const recordId = await postRecord(zoneId, 'pve-01', IP);
    expect((await request(app).delete(`/api/subnets/${first}`)).status).toBe(200);
    invalidateSubnetCache();
    // Deleting a network keeps manual records.
    expect(db.prepare('SELECT id FROM dns_records WHERE id = ?').get(recordId)).toBeTruthy();

    const reconfigured = await request(app)
      .post(`/api/subnets/${first}/configure`)
      .send({ name: 'lab', gateway_address: '10.130.0.1', domain_name: DOMAIN });
    expect(reconfigured.status).toBe(200);
    invalidateSubnetCache();

    expect(addressRow()).toMatchObject(staticDns(recordId));
    expect(await searchAddresses(first, 'pve-01')).toEqual([IP]);
  });

  it('names the gateway without taking it from topology', async () => {
    const zoneId = await createZone();
    await postRecord(zoneId, 'router', '10.130.0.1');
    await allocateNetwork();

    expect(addressRow('10.130.0.1')).toMatchObject({
      allocation_state: 'gateway',
      allocation_source_type: 'topology',
      hostname: `router.${DOMAIN}`,
    });
  });

  it('holds a disabled record as disabled DNS on configure (ADR 004)', async () => {
    const zoneId = await createZone();
    const recordId = await postRecord(zoneId, 'pve-01', IP, false);
    await allocateNetwork();

    expect(addressRow()).toMatchObject({
      allocation_state: 'reserved',
      allocation_source_type: 'dns',
      allocation_source_id: recordId,
    });
  });

  it('refuses a new DHCP pool over a record that predates the network', async () => {
    const zoneId = await createZone();
    await postRecord(zoneId, 'pooled', '10.130.0.150');
    const created = await request(app)
      .post('/api/subnets')
      .send({ cidr: CIDR, name: 'lab', status: 'allocated' });
    const configured = await request(app).post(`/api/subnets/${created.body.id}/configure`).send({
      name: 'lab',
      gateway_address: '10.130.0.1',
      domain_name: DOMAIN,
      create_dhcp_scope: true,
      dhcp_start_ip: '10.130.0.100',
      dhcp_end_ip: '10.130.0.200',
    });
    expect(configured.status).toBe(409);
    expect(configured.body).toMatchObject({
      conflict_type: 'static_dns',
      ip_address: '10.130.0.150',
    });
  });
});

describe('startup reconciliation of enabled manual records', () => {
  it('re-claims an address whose row drifted to unassigned, and is idempotent', async () => {
    const zoneId = await createZone();
    const subnetId = await allocateNetwork();
    const recordId = await postRecord(zoneId, 'pve-01', IP);
    // The drift observed in the field: a served record, a blank address row.
    db.prepare(
      `UPDATE ip_addresses
          SET allocation_state = 'unassigned', allocation_source_type = NULL,
              allocation_source_id = NULL, hostname = NULL, detection_source = NULL
        WHERE ip_address = ?`,
    ).run(IP);
    expect(await searchAddresses(subnetId, 'pve-01')).toEqual([]);

    expect(reconcileStaticDnsAllocations(db)).toMatchObject({ changed: 1 });
    expect(addressRow()).toMatchObject(staticDns(recordId));
    expect(await searchAddresses(subnetId, 'pve-01')).toEqual([IP]);

    expect(reconcileStaticDnsAllocations(db)).toMatchObject({ changed: 0 });
  });

  it('leaves a record inside an enabled DHCP pool to the pool, and reports it', async () => {
    const zoneId = await createZone();
    await allocateNetwork({
      create_dhcp_scope: true,
      dhcp_start_ip: '10.130.0.100',
      dhcp_end_ip: '10.130.0.200',
    });
    // Written around the lifecycle, as an old import or a hand-edited
    // database might have: the pool owns the address, not the record.
    const recordId = db
      .prepare(
        `INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
         VALUES (?, 'pooled', 'A', '10.130.0.150', 'manual', 1)`,
      )
      .run(zoneId).lastInsertRowid;

    expect(reconcileStaticDnsAllocations(db)).toMatchObject({
      changed: 0,
      conflicts: [
        expect.objectContaining({
          ip: '10.130.0.150',
          record_id: recordId,
          reason: expect.stringMatching(/DHCP scope/),
        }),
      ],
    });
    expect(addressRow('10.130.0.150').allocation_state).toBe('unassigned');
  });

  it('leaves an address another owner holds alone', async () => {
    const zoneId = await createZone();
    const subnetId = await allocateNetwork();
    setManualReservation(db, subnetId, IP, true, 'held');
    db.prepare(
      `INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
       VALUES (?, 'late', 'A', ?, 'manual', 1)`,
    ).run(zoneId, IP);

    expect(reconcileStaticDnsAllocations(db)).toMatchObject({ changed: 0 });
    expect(addressRow()).toMatchObject({
      allocation_state: 'reserved',
      allocation_source_type: 'admin_reservation',
    });
  });
});
