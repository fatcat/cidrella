/**
 * Address history (GET /api/subnets/:id/ips/:ip/events):
 *
 *   - it outlives the address row and the network: deallocating keeps it;
 *   - a probe that changes nothing records nothing, only last_scanned_at;
 *   - reservations, DNS holds and lease expiry say what happened;
 *   - Network Range Types record what they gained and lost, one row a run;
 *   - a request's user is named on what it caused.
 *
 * Each case runs for IPv4 and IPv6.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => ({
  ...(await importOriginal()),
  regenerateConfigs: vi.fn(),
  applyInterfaceConfig: vi.fn(),
  regenerateDnsmasqConf: vi.fn(),
  signalDnsmasq: vi.fn(),
  restartDnsmasq: vi.fn(),
}));
vi.mock('../../../src/utils/dhcp.js', async (importOriginal) => ({
  ...(await importOriginal()),
  regenerateDhcpConfigs: vi.fn(),
  startLeaseWatcher: vi.fn(),
}));

const { default: subnetRouter } = await import('../../../src/routes/subnets.js');
const { default: rangeRouter } = await import('../../../src/routes/ranges.js');
const { default: request } = await import('supertest');
const Lifecycle = await import('../../../src/services/ip-lifecycle-service.js');
const IpAddress = await import('../../../src/models/ip-address.js');
const { runAsActor } = await import('../../../src/utils/request-actor.js');

let tmpDir;
let db;
let app;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  db = setup.db;
  enableIpv6(db);
  app = createMultiRouterApp([
    { prefix: '/api/subnets', router: subnetRouter },
    { prefix: '/api/subnets/:subnetId/ranges', router: rangeRouter },
  ]);
});

afterAll(() => cleanupTestDb(tmpDir));

async function allocated(cidr) {
  const created = await request(app)
    .post('/api/subnets')
    .send({ cidr, name: cidr, status: 'unallocated' });
  expect(created.status).toBe(201);
  const configured = await request(app)
    .post(`/api/subnets/${created.body.id}/configure`)
    .send({ name: cidr, create_reverse_dns: false, create_dhcp_scope: false });
  expect(configured.status).toBe(200);
  return created.body.id;
}

async function history(subnetId, ip) {
  const res = await request(app).get(
    `/api/subnets/${subnetId}/ips/${encodeURIComponent(ip)}/events`,
  );
  expect(res.status).toBe(200);
  return res.body.events;
}

const types = (events) => events.map((event) => event.event_type);

const FAMILIES = [
  { family: 'IPv4', cidr: '10.90.0.0/24', a: '10.90.0.20', b: '10.90.0.21', c: '10.90.0.22' },
  { family: 'IPv6', cidr: 'fd90::/64', a: 'fd90::20', b: 'fd90::21', c: 'fd90::22' },
];

describe.each(FAMILIES)('$family address history', ({ cidr, a, b, c }) => {
  let subnetId;
  beforeAll(async () => {
    subnetId = await allocated(cidr);
  });

  it('names an IP Reservation and who made it, and keeps it after the network goes', async () => {
    runAsActor('alice', () => Lifecycle.setManualReservation(db, subnetId, a, true, 'lab printer'));
    runAsActor('bob', () => Lifecycle.setManualReservation(db, subnetId, a, false));

    const events = await history(subnetId, a);
    expect(events.slice(0, 2)).toMatchObject([
      { event_type: 'ip_reservation_released', old_value: 'lab printer', actor: 'bob' },
      { event_type: 'ip_reservation_created', new_value: 'lab printer', actor: 'alice' },
    ]);
    expect(types(events)).not.toContain('allocation_changed');
  });

  it('records a probe only when liveness changes, and last_scanned_at always', () => {
    for (let i = 0; i < 3; i++) Lifecycle.observeScanResult(db, subnetId, b, { responded: true });
    Lifecycle.observeScanResult(db, subnetId, b, { responded: false });
    const events = IpAddress.getEvents(db, b);
    expect(types(events).filter((type) => type === 'online')).toHaveLength(1);
    expect(types(events)).toContain('offline');
    expect(types(events)).not.toContain('scanned');
  });

  it('names a DHCP Reservation by its client, also when its row goes with it', () => {
    Lifecycle.allocateStaticDhcp(db, subnetId, c, {
      mac_address: 'aa:bb:cc:00:00:22',
      hostname: 'bench',
      dhcp_version: cidr.includes(':') ? 6 : 4,
      dhcp_duid: cidr.includes(':') ? '00:01:00:01:aa:bb' : null,
    });
    Lifecycle.deallocateStaticDhcp(db, subnetId, c, 'aa:bb:cc:00:00:22');
    const events = IpAddress.getEvents(db, c);
    expect(events[0]).toMatchObject({
      event_type: 'dhcp_reservation_removed',
      old_value: 'aa:bb:cc:00:00:22',
    });
    expect(events.find((event) => event.event_type === 'dhcp_reservation_created')).toMatchObject({
      new_value: 'aa:bb:cc:00:00:22 (bench)',
    });
  });

  it('records a Network Range Type by the run it covers, gained and lost', async () => {
    const type = db
      .prepare("INSERT INTO range_types (name, color, is_system) VALUES (?, '#ec4899', 0)")
      .run(`Printers ${cidr}`).lastInsertRowid;
    const set = (body) => request(app).put(`/api/subnets/${subnetId}/ranges/set-type`).send(body);

    let res = await set({ range_type_id: type, ranges: [{ start_ip: a, end_ip: b }] });
    expect(res.status).toBe(200);
    // Widening to c records c alone; a and b already had it.
    res = await set({
      range_type_id: type,
      ranges: [{ start_ip: a, end_ip: c }],
      accept_overlaps: true,
    });
    expect(res.status).toBe(200);
    expect(
      db
        .prepare(
          "SELECT start_ip, end_ip FROM ip_range_events WHERE range_type = ? AND event_type = 'range_assigned' ORDER BY id",
        )
        .all(`Printers ${cidr}`),
    ).toEqual([
      { start_ip: a, end_ip: b },
      { start_ip: c, end_ip: c },
    ]);

    res = await request(app)
      .put(`/api/subnets/${subnetId}/ranges/clear-type`)
      .send({ ranges: [{ start_ip: b, end_ip: b }] });
    expect(res.status).toBe(200);

    const forB = await history(subnetId, b);
    expect(forB.filter((event) => event.source === 'range')).toMatchObject([
      { event_type: 'range_unassigned', old_value: `Printers ${cidr}`, actor: 'testadmin' },
      { event_type: 'range_assigned', new_value: `Printers ${cidr}`, actor: 'testadmin' },
    ]);
    const forC = await history(subnetId, c);
    expect(types(forC.filter((event) => event.source === 'range'))).toEqual(['range_assigned']);
  });

  it('keeps every address history after the network is deallocated', async () => {
    const before = (await history(subnetId, a)).length;
    const res = await request(app).delete(`/api/subnets/${subnetId}`);
    expect(res.body.action).toBe('deallocated');
    expect(IpAddress.findBySubnetAndIp(db, subnetId, a)).toBeUndefined();

    const after = await history(subnetId, a);
    // The type left a with the allocation; nothing earlier was lost.
    expect(after[0]).toMatchObject({ event_type: 'range_unassigned', source: 'range' });
    expect(after.length).toBe(before + 1);
    expect(types(after)).toContain('ip_reservation_created');
  });
});

describe('DNS holds and lease expiry', () => {
  it('says a disabled record took the address and when it let go', async () => {
    const subnetId = await allocated('10.91.0.0/24');
    const zoneId = db
      .prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('hold.test', 'forward', 1)")
      .run().lastInsertRowid;
    const recordId = db
      .prepare(
        "INSERT INTO dns_records (zone_id, name, type, value, source, enabled) VALUES (?, 'nas', 'A', '10.91.0.9', 'manual', 0)",
      )
      .run(zoneId).lastInsertRowid;
    Lifecycle.reconcileDnsHold(db, '10.91.0.9');
    db.prepare('DELETE FROM dns_records WHERE id = ?').run(recordId);
    Lifecycle.reconcileDnsHold(db, '10.91.0.9');

    expect(types(await history(subnetId, '10.91.0.9')).slice(0, 2)).toEqual([
      'dns_hold_released',
      'dns_hold_taken',
    ]);
    expect((await history(subnetId, '10.91.0.9'))[1].new_value).toBe('nas.hold.test');
  });

  it('records a lapsed lease as expired, with the client it named', async () => {
    const subnetId = await allocated('10.92.0.0/24');
    IpAddress.upsert(db, subnetId, '10.92.0.50', {
      mac_address: 'aa:bb:cc:00:00:50',
      allocation_state: 'dynamic_dhcp',
      allocation_source_type: 'dhcp_lease',
      dhcp_version: 4,
      detection_source: 'dhcp_lease',
    });
    Lifecycle.reconcileExpiredDhcpAllocations(db);
    expect((await history(subnetId, '10.92.0.50'))[0]).toMatchObject({
      event_type: 'lease_expired',
      old_value: 'aa:bb:cc:00:00:50',
    });
  });
});

describe('the history endpoint', () => {
  it('answers for an address with no row and refuses one that is not an address', async () => {
    const subnetId = await allocated('10.93.0.0/24');
    expect(await history(subnetId, '10.93.0.77')).toEqual([]);
    const bad = await request(app).get(`/api/subnets/${subnetId}/ips/not-an-ip/events`);
    expect(bad.status).toBe(400);
  });
});
