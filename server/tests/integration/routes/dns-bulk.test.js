import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';
import { invalidateSubnetCache } from '../../../src/utils/ip-sync.js';

vi.mock('../../../src/services/backend-apply.js', async (importOriginal) =>
  (await import('../../helpers/fake-backends.js')).stubBackendApply(await importOriginal(), [
    'applyDns',
    'applyDhcp',
    'applyResolver',
  ]),
);
vi.mock('../../../src/backends/dnsmasq/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateDnsmasqConf: vi.fn(),
    restartDnsmasq: vi.fn(),
    signalDnsmasq: vi.fn(),
  };
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

// POST /api/dns/records/bulk runs each record through the single-record
// workflows, so the address each one names ends up exactly where the
// single-record route would leave it.

function allocation(ip) {
  return (
    db
      .prepare(
        `SELECT allocation_state, allocation_source_type, allocation_source_id
           FROM ip_addresses WHERE ip_address = ?`,
      )
      .get(ip) || { allocation_state: 'unassigned', allocation_source_type: null }
  );
}

async function postRecord(zoneId, name, ip, enabled = true) {
  const res = await request(app)
    .post(`/api/dns/zones/${zoneId}/records`)
    .send({ name, type: 'A', value: ip, enabled });
  expect(res.status).toBe(201);
  return res.body.id;
}

const bulk = (action, ids) => request(app).post('/api/dns/records/bulk').send({ action, ids });
const recordEnabled = (id) =>
  db.prepare('SELECT enabled FROM dns_records WHERE id = ?').get(id)?.enabled;

describe('POST /api/dns/records/bulk', () => {
  it('disables and enables records, moving their addresses between held and static DNS', async () => {
    createSubnet();
    const zoneId = createZone();
    const a = await postRecord(zoneId, 'alpha', '10.120.0.60');
    const b = await postRecord(zoneId, 'beta', '10.120.0.61');

    const off = await bulk('disable', [a, b]);
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ action: 'disable', applied: [a, b], skipped: [] });
    expect([recordEnabled(a), recordEnabled(b)]).toEqual([0, 0]);
    expect(allocation('10.120.0.60')).toMatchObject({
      allocation_state: 'reserved',
      allocation_source_type: 'dns',
      allocation_source_id: a,
    });

    const on = await bulk('enable', [a, b]);
    expect(on.body.applied).toEqual([a, b]);
    expect(allocation('10.120.0.61')).toMatchObject({
      allocation_state: 'static_dns',
      allocation_source_id: b,
    });
  });

  it('deletes records and frees their addresses', async () => {
    createSubnet();
    const zoneId = createZone();
    const a = await postRecord(zoneId, 'alpha', '10.120.0.60');
    const b = await postRecord(zoneId, 'beta', '10.120.0.61', false);

    const res = await bulk('delete', [a, b]);
    expect(res.body).toEqual({ action: 'delete', applied: [a, b], skipped: [] });
    expect(db.prepare('SELECT COUNT(*) AS c FROM dns_records WHERE id IN (?, ?)').get(a, b).c).toBe(
      0,
    );
    expect(allocation('10.120.0.60').allocation_state).toBe('unassigned');
    expect(allocation('10.120.0.61').allocation_state).toBe('unassigned');
  });

  it('skips what it cannot change and applies the rest', async () => {
    const subnetId = createSubnet();
    const zoneId = createZone();
    const live = await postRecord(zoneId, 'live', '10.120.0.60');
    const parked = await postRecord(zoneId, 'parked', '10.120.0.110', false);
    const generated = db
      .prepare(
        `INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
         VALUES (?, 'laptop', 'A', '10.120.0.62', 'dhcp', 1)`,
      )
      .run(zoneId).lastInsertRowid;
    // A disabled record whose address a DHCP pool (.20-.100) now owns:
    // enabling it is refused by the lifecycle, and only it is rolled back.
    const pooled = await postRecord(zoneId, 'pooled', '10.120.0.50', false);
    createScope(subnetId, createRange(subnetId));
    const pooledBefore = allocation('10.120.0.50');

    const res = await bulk('enable', [live, parked, generated, pooled, 999999]);
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual([parked]);
    expect(res.body.skipped).toEqual([
      { id: live, reason: 'Already enabled' },
      { id: generated, reason: 'Generated records follow their DNS or DHCP source' },
      { id: pooled, reason: expect.stringMatching(/DHCP scope/) },
      { id: 999999, reason: 'Record not found' },
    ]);
    expect(recordEnabled(parked)).toBe(1);
    expect(recordEnabled(pooled)).toBe(0);
    // The refused record's savepoint rolled back: its address is untouched.
    expect(allocation('10.120.0.50')).toEqual(pooledBefore);
    expect(allocation('10.120.0.110').allocation_state).toBe('static_dns');
  });

  it('refuses a bad action or id list', async () => {
    expect((await bulk('toggle', [1])).status).toBe(400);
    expect((await bulk('enable', [])).status).toBe(400);
    expect((await bulk('enable', ['1'])).status).toBe(400);
    expect(
      (
        await bulk(
          'delete',
          Array.from({ length: 1001 }, (_, i) => i + 1),
        )
      ).status,
    ).toBe(400);
  });
});
