import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';
import { setManualReservation } from '../../../src/services/ip-lifecycle-service.js';
import { invalidateSubnetCache } from '../../../src/utils/ip-sync.js';

vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateConfigs: vi.fn(),
    regenerateDnsmasqConf: vi.fn(),
    restartDnsmasq: vi.fn(),
    signalDnsmasq: vi.fn()
  };
});
vi.mock('../../../src/utils/dhcp.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, regenerateDhcpConfigs: vi.fn() };
});

const { default: dnsRouter } = await import('../../../src/routes/dns.js');
const { default: dhcpRouter } = await import('../../../src/routes/dhcp.js');
const { default: request } = await import('supertest');

let app;
let db;
let tmpDir;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  app = createMultiRouterApp([
    { prefix: '/api/dns', router: dnsRouter },
    { prefix: '/api/dhcp', router: dhcpRouter }
  ]);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  invalidateSubnetCache();
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dns_zones').run();
  db.prepare('DELETE FROM dhcp_scope_options').run();
  db.prepare('DELETE FROM dhcp_leases').run();
  db.prepare('DELETE FROM dhcp_reservations').run();
  db.prepare('DELETE FROM dhcp_scopes').run();
  db.prepare('DELETE FROM ranges').run();
  db.prepare('DELETE FROM ip_events').run();
  db.prepare('DELETE FROM ip_addresses').run();
  db.prepare('DELETE FROM subnets').run();
});

function createSubnet(cidr = '10.120.0.0/24', gateway = '10.120.0.1') {
  return db.prepare(`
    INSERT INTO subnets
      (cidr, name, network_address, broadcast_address, prefix_length,
       total_addresses, gateway_address, status, domain_name)
    VALUES (?, 'Lifecycle enforcement', '10.120.0.0', '10.120.0.255', 24,
            256, ?, 'allocated', 'lifecycle.test')
  `).run(cidr, gateway).lastInsertRowid;
}

function createZone() {
  return db.prepare(`
    INSERT INTO dns_zones (name, type, enabled)
    VALUES ('lifecycle.test', 'forward', 1)
  `).run().lastInsertRowid;
}

function createRange(subnetId, start = '10.120.0.20', end = '10.120.0.100') {
  const typeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  return db.prepare(`
    INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
    VALUES (?, ?, ?, ?)
  `).run(subnetId, typeId, start, end).lastInsertRowid;
}

function createScope(subnetId, rangeId, enabled = 1) {
  return db.prepare(`
    INSERT INTO dhcp_scopes (subnet_id, range_id, lease_time, enabled)
    VALUES (?, ?, '24h', ?)
  `).run(subnetId, rangeId, enabled).lastInsertRowid;
}

function postA(zoneId, name, ip) {
  return request(app).post(`/api/dns/zones/${zoneId}/records`).send({ name, type: 'A', value: ip });
}

function postReservation(subnetId, ip, mac = 'aa:bb:cc:dd:ee:50') {
  return request(app).post('/api/dhcp/reservations').send({
    subnet_id: subnetId,
    mac_address: mac,
    ip_address: ip
  });
}

describe('mutually exclusive DNS and DHCP allocation', () => {
  it('rejects DNS inside an enabled dynamic pool without creating a record', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();
    createScope(subnetId, createRange(subnetId));

    const response = await postA(zoneId, 'pooled', '10.120.0.50');

    expect(response.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS count FROM dns_records').get().count).toBe(0);
    expect(db.prepare("SELECT * FROM ip_addresses WHERE ip_address = '10.120.0.50'").get())
      .toBeUndefined();
  });

  it('rejects DNS over a hostname-less DHCP Reservation', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();
    expect((await postReservation(subnetId, '10.120.0.50')).status).toBe(201);

    const response = await postA(zoneId, 'collision', '10.120.0.50');

    expect(response.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS count FROM dns_records').get().count).toBe(0);
    expect(db.prepare("SELECT allocation_state FROM ip_addresses WHERE ip_address = '10.120.0.50'").get())
      .toEqual({ allocation_state: 'static_dhcp' });
  });

  it('rejects static DHCP over DNS without creating a reservation', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();
    expect((await postA(zoneId, 'dns-first', '10.120.0.51')).status).toBe(201);

    const response = await postReservation(subnetId, '10.120.0.51');

    expect(response.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS count FROM dhcp_reservations').get().count).toBe(0);
    expect(db.prepare("SELECT allocation_state FROM ip_addresses WHERE ip_address = '10.120.0.51'").get())
      .toEqual({ allocation_state: 'static_dns' });
  });

  it('activates a reserved address through DNS or static DHCP', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();
    setManualReservation(db, subnetId, '10.120.0.52', true, 'DNS hold');
    setManualReservation(db, subnetId, '10.120.0.53', true, 'DHCP hold');

    expect((await postA(zoneId, 'activated', '10.120.0.52')).status).toBe(201);
    expect((await postReservation(subnetId, '10.120.0.53', 'aa:bb:cc:dd:ee:53')).status)
      .toBe(201);

    expect(db.prepare("SELECT allocation_state FROM ip_addresses WHERE ip_address = '10.120.0.52'").get())
      .toEqual({ allocation_state: 'static_dns' });
    expect(db.prepare("SELECT allocation_state FROM ip_addresses WHERE ip_address = '10.120.0.53'").get())
      .toEqual({ allocation_state: 'static_dhcp' });
  });

  it('allows only one of concurrent DNS and static DHCP claims to commit', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();

    const [dnsResponse, dhcpResponse] = await Promise.all([
      postA(zoneId, 'race', '10.120.0.54'),
      postReservation(subnetId, '10.120.0.54', 'aa:bb:cc:dd:ee:54')
    ]);

    expect([dnsResponse.status, dhcpResponse.status].filter(status => status < 300)).toHaveLength(1);
    const dnsCount = db.prepare('SELECT COUNT(*) AS count FROM dns_records').get().count;
    const dhcpCount = db.prepare('SELECT COUNT(*) AS count FROM dhcp_reservations').get().count;
    expect(dnsCount + dhcpCount).toBe(1);
    expect(db.prepare("SELECT allocation_state FROM ip_addresses WHERE ip_address = '10.120.0.54'").get()
      .allocation_state).toMatch(/^(static_dns|static_dhcp)$/);
  });
});

describe('scope conflicts in both operation orders', () => {
  it('rejects creating a scope over static DNS', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();
    expect((await postA(zoneId, 'claimed', '10.120.0.60')).status).toBe(201);
    const rangeId = createRange(subnetId);

    const response = await request(app).post('/api/dhcp/scopes').send({
      range_id: rangeId,
      subnet_id: subnetId
    });

    expect(response.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS count FROM dhcp_scopes').get().count).toBe(0);
  });

  it('allows DNS in a disabled scope but rejects enabling it', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();
    const rangeId = createRange(subnetId);
    const scopeId = createScope(subnetId, rangeId, 0);
    expect((await postA(zoneId, 'disabled-pool', '10.120.0.61')).status).toBe(201);

    const response = await request(app).put(`/api/dhcp/scopes/${scopeId}`).send({ enabled: true });

    expect(response.status).toBe(409);
    expect(db.prepare('SELECT enabled FROM dhcp_scopes WHERE id = ?').get(scopeId).enabled).toBe(0);
  });

  it('rejects resizing an enabled scope over DNS and preserves old bounds', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();
    const rangeId = createRange(subnetId, '10.120.0.20', '10.120.0.40');
    const scopeId = createScope(subnetId, rangeId);
    expect((await postA(zoneId, 'outside', '10.120.0.60')).status).toBe(201);

    const response = await request(app).put(`/api/dhcp/scopes/${scopeId}`)
      .send({ end_ip: '10.120.0.70' });

    expect(response.status).toBe(409);
    expect(db.prepare('SELECT start_ip, end_ip FROM ranges WHERE id = ?').get(rangeId))
      .toEqual({ start_ip: '10.120.0.20', end_ip: '10.120.0.40' });
  });
});

describe('protected topology addresses', () => {
  it('allows a DNS name for the gateway without transferring allocation ownership', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();

    const created = await postA(zoneId, 'gateway', '10.120.0.1');
    expect(created.status).toBe(201);
    expect(db.prepare(`
      SELECT allocation_state, allocation_source_type, hostname, detection_source
      FROM ip_addresses WHERE ip_address = '10.120.0.1'
    `).get()).toEqual({
      allocation_state: 'gateway',
      allocation_source_type: 'topology',
      hostname: 'gateway.lifecycle.test',
      detection_source: 'topology'
    });

    expect((await postReservation(subnetId, '10.120.0.1')).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS count FROM dns_records').get().count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM dhcp_reservations').get().count).toBe(0);

    const removed = await request(app)
      .delete(`/api/dns/zones/${zoneId}/records/${created.body.id}`);
    expect(removed.status).toBe(200);
    expect(db.prepare(`
      SELECT allocation_state, allocation_source_type, hostname, detection_source
      FROM ip_addresses WHERE ip_address = '10.120.0.1'
    `).get()).toEqual({
      allocation_state: 'gateway',
      allocation_source_type: 'topology',
      hostname: null,
      detection_source: 'topology'
    });
  });

  it.each([
    ['network', '10.120.0.0', 'aa:bb:cc:dd:ee:10'],
    ['broadcast', '10.120.0.255', 'aa:bb:cc:dd:ee:11']
  ])('rejects DNS and static DHCP claims for the %s address', async (label, ip, mac) => {
    const subnetId = createSubnet();
    const zoneId = createZone();

    expect((await postA(zoneId, label, ip)).status).toBe(409);
    expect((await postReservation(subnetId, ip, mac)).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS count FROM dns_records').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM dhcp_reservations').get().count).toBe(0);
  });
});
