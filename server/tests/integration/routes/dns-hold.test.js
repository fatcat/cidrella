import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';
import {
  reconcileDnsHolds,
  setManualReservation,
} from '../../../src/services/ip-lifecycle-service.js';
import { findRetirementCandidates } from '../../../src/models/ip-address.js';
import { computeIpView } from '../../../src/models/ip-view.js';
import { invalidateSubnetCache } from '../../../src/utils/ip-sync.js';

vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateConfigs: vi.fn(),
    regenerateDnsmasqConf: vi.fn(),
    restartDnsmasq: vi.fn(),
    signalDnsmasq: vi.fn(),
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
    { prefix: '/api/dhcp', router: dhcpRouter },
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
  return db
    .prepare(
      `
    INSERT INTO subnets
      (cidr, name, network_address, broadcast_address, prefix_length,
       total_addresses, gateway_address, status, domain_name)
    VALUES (?, 'Lifecycle enforcement', '10.120.0.0', '10.120.0.255', 24,
            256, ?, 'allocated', 'lifecycle.test')
  `,
    )
    .run(cidr, gateway).lastInsertRowid;
}

function createZone() {
  return db
    .prepare(
      `
    INSERT INTO dns_zones (name, type, enabled)
    VALUES ('lifecycle.test', 'forward', 1)
  `,
    )
    .run().lastInsertRowid;
}

function createRange(subnetId, start = '10.120.0.20', end = '10.120.0.100') {
  const typeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'").get().id;
  return db
    .prepare(
      `
    INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
    VALUES (?, ?, ?, ?)
  `,
    )
    .run(subnetId, typeId, start, end).lastInsertRowid;
}

function createScope(subnetId, rangeId, enabled = 1) {
  const scopeId = db
    .prepare(
      `
    INSERT INTO dhcp_scopes (subnet_id, range_id, lease_time, enabled)
    VALUES (?, ?, '24h', ?)
  `,
    )
    .run(subnetId, rangeId, enabled).lastInsertRowid;
  const range = db.prepare('SELECT start_ip, end_ip FROM ranges WHERE id = ?').get(rangeId);
  db.prepare(
    `
    INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
    VALUES (?, ?, ?, ?)
  `,
  ).run(scopeId, rangeId, range.start_ip, range.end_ip);
  return scopeId;
}

function postReservation(subnetId, ip, mac = 'aa:bb:cc:dd:ee:50') {
  return request(app).post('/api/dhcp/reservations').send({
    subnet_id: subnetId,
    mac_address: mac,
    ip_address: ip,
  });
}

// ADR 004: a manual address record that exists but is not served holds its
// address as `reserved` owned by dns.

const IP = '10.120.0.60';

function allocation(ip = IP) {
  return (
    db
      .prepare(
        `SELECT allocation_state, allocation_source_type, allocation_source_id
           FROM ip_addresses WHERE ip_address = ?`,
      )
      .get(ip) || { allocation_state: 'unassigned', allocation_source_type: null }
  );
}

function held(recordId) {
  return {
    allocation_state: 'reserved',
    allocation_source_type: 'dns',
    allocation_source_id: recordId,
  };
}

async function postRecord(zoneId, name, ip, enabled = true) {
  const res = await request(app)
    .post(`/api/dns/zones/${zoneId}/records`)
    .send({ name, type: 'A', value: ip, enabled });
  expect(res.status).toBe(201);
  return res.body.id;
}

function putRecord(zoneId, id, body) {
  return request(app).put(`/api/dns/zones/${zoneId}/records/${id}`).send(body);
}

describe('a disabled record holds its address', () => {
  it('holds from creation, and the read model calls it disabled DNS, not rogue', async () => {
    createSubnet();
    const zoneId = createZone();
    const id = await postRecord(zoneId, 'parked', IP, false);

    expect(allocation()).toMatchObject(held(id));
    db.prepare('UPDATE ip_addresses SET is_online = 1 WHERE ip_address = ?').run(IP);
    const row = db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get(IP);
    expect(computeIpView(row)).toMatchObject({
      address_type: 'disabled DNS',
      ip_display_status: 'in use',
    });
  });

  it('moves between static DNS and held as the record is disabled and enabled, and frees on delete', async () => {
    createSubnet();
    const zoneId = createZone();
    const id = await postRecord(zoneId, 'toggled', IP);
    expect(allocation().allocation_state).toBe('static_dns');

    expect((await putRecord(zoneId, id, { enabled: false })).status).toBe(200);
    expect(allocation()).toMatchObject(held(id));

    expect((await putRecord(zoneId, id, { enabled: true })).status).toBe(200);
    expect(allocation()).toMatchObject({
      allocation_state: 'static_dns',
      allocation_source_id: id,
    });

    expect((await putRecord(zoneId, id, { enabled: false })).status).toBe(200);
    expect((await request(app).delete(`/api/dns/zones/${zoneId}/records/${id}`)).status).toBe(200);
    expect(allocation().allocation_state).toBe('unassigned');
  });

  it('moves the hold to the next disabled record when one is deleted', async () => {
    createSubnet();
    const zoneId = createZone();
    const first = await postRecord(zoneId, 'one', IP, false);
    const second = await postRecord(zoneId, 'two', IP, false);
    expect(allocation()).toMatchObject(held(first));

    await request(app).delete(`/api/dns/zones/${zoneId}/records/${first}`);
    expect(allocation()).toMatchObject(held(second));
  });

  it('holds when the zone is disabled, claims again when it is enabled, frees when it is deleted', async () => {
    createSubnet();
    const zoneId = createZone();
    const live = await postRecord(zoneId, 'live', IP);
    const parked = await postRecord(zoneId, 'parked', '10.120.0.61', false);

    expect(
      (await request(app).put(`/api/dns/zones/${zoneId}`).send({ enabled: false })).status,
    ).toBe(200);
    expect(allocation()).toMatchObject(held(live));
    expect(allocation('10.120.0.61')).toMatchObject(held(parked));

    expect(
      (await request(app).put(`/api/dns/zones/${zoneId}`).send({ enabled: true })).status,
    ).toBe(200);
    expect(allocation().allocation_state).toBe('static_dns');
    expect(allocation('10.120.0.61')).toMatchObject(held(parked));

    expect((await request(app).delete(`/api/dns/zones/${zoneId}`)).status).toBe(200);
    expect(allocation().allocation_state).toBe('unassigned');
    expect(allocation('10.120.0.61').allocation_state).toBe('unassigned');
  });

  it('does not hold inside an enabled DHCP scope, which the pool owns', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();
    createScope(subnetId, createRange(subnetId));
    await postRecord(zoneId, 'pooled', '10.120.0.50', false);
    expect(allocation('10.120.0.50').allocation_state).toBe('unassigned');
  });
});

describe('a hold and an IP Reservation, in both orders', () => {
  it('leaves an existing IP Reservation alone, and keeps it when the record goes', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();
    setManualReservation(db, subnetId, IP, true, 'printer');
    const id = await postRecord(zoneId, 'late', IP, false);
    expect(allocation()).toMatchObject({
      allocation_state: 'reserved',
      allocation_source_type: 'admin_reservation',
    });

    await request(app).delete(`/api/dns/zones/${zoneId}/records/${id}`);
    expect(allocation().allocation_source_type).toBe('admin_reservation');
  });

  it('refuses to replace or release a hold as an IP Reservation', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();
    const id = await postRecord(zoneId, 'first', IP, false);

    expect(() => setManualReservation(db, subnetId, IP, true, 'nope')).toThrow(
      /disabled DNS record/,
    );
    expect(() => setManualReservation(db, subnetId, IP, false)).toThrow(/disabled DNS record/);
    expect(allocation()).toMatchObject(held(id));
  });

  it('hands the hold back when a DHCP Reservation over it is removed', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();
    const id = await postRecord(zoneId, 'held', IP, false);
    const created = await postReservation(subnetId, IP, 'aa:bb:cc:dd:ee:60');
    expect(created.status).toBe(201);
    expect(allocation().allocation_state).toBe('static_dhcp');

    expect((await request(app).delete(`/api/dhcp/reservations/${created.body.id}`)).status).toBe(
      200,
    );
    expect(allocation()).toMatchObject(held(id));
  });
});

describe('protections a hold carries', () => {
  it('is not a retirement candidate while offline', async () => {
    createSubnet();
    const zoneId = createZone();
    await postRecord(zoneId, 'offline', IP, false);
    db.prepare(
      "UPDATE ip_addresses SET is_online = 0, offline_since_at = datetime('now', '-2 days') WHERE ip_address = ?",
    ).run(IP);
    const candidates = findRetirementCandidates(
      db,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    expect(candidates.map((row) => row.ip_address)).not.toContain(IP);
  });
});

describe('startup reconciliation', () => {
  it('reaches the same state as the routes, is idempotent, and releases an orphaned hold', async () => {
    createSubnet();
    const zoneId = createZone();
    // A disabled record written before ADR 004: no hold yet.
    const id = db
      .prepare(
        "INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, 'legacy', 'A', ?, 0)",
      )
      .run(zoneId, IP).lastInsertRowid;
    expect(allocation().allocation_state).toBe('unassigned');

    expect(reconcileDnsHolds(db).changed).toBe(1);
    expect(allocation()).toMatchObject(held(Number(id)));
    expect(reconcileDnsHolds(db).changed).toBe(0);

    db.prepare('DELETE FROM dns_records WHERE id = ?').run(id);
    expect(reconcileDnsHolds(db).changed).toBe(1);
    expect(allocation().allocation_state).toBe('unassigned');
  });
});
