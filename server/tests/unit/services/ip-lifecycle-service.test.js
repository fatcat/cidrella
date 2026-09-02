import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import {
  allocateStaticDns,
  allocateStaticDhcp,
  deallocateStaticDhcp,
  observeDhcpLeases,
  observeNeighbor,
  observeRouterAdvertisement,
  observeSlaac,
  setManualReservation
} from '../../../src/services/ip-lifecycle-service.js';

let db;
let tmpDir;
let subnetId;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  subnetId = db.prepare(`
    INSERT INTO subnets
      (cidr, name, network_address, broadcast_address, prefix_length,
       total_addresses, status, domain_name)
    VALUES ('10.99.0.0/24', 'Lifecycle service', '10.99.0.0', '10.99.0.255',
            24, 256, 'allocated', 'service.test')
  `).run().lastInsertRowid;
});

beforeEach(() => {
  db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_reservations WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dns_zones').run();
});

afterAll(() => cleanupTestDb(tmpDir));

function address(ip) {
  return db.prepare('SELECT * FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?')
    .get(subnetId, ip);
}

describe('IP lifecycle service allocation boundary', () => {
  it('owns administrative reserve and release transitions', () => {
    db.prepare(`
      INSERT INTO ip_addresses
        (subnet_id, ip_address, status, is_rogue, rogue_reason, allocation_state)
      VALUES (?, '10.99.0.20', 'available', 1, 'observed conflict', 'unassigned')
    `).run(subnetId);
    setManualReservation(db, subnetId, '10.99.0.20', true, 'printer hold');
    expect(address('10.99.0.20')).toMatchObject({
      allocation_state: 'reserved',
      allocation_source_type: 'admin_reservation',
      status: 'locked',
      reservation_note: 'printer hold',
      is_rogue: 0,
      rogue_reason: null
    });

    setManualReservation(db, subnetId, '10.99.0.20', false);
    expect(address('10.99.0.20')).toMatchObject({
      allocation_state: 'unassigned',
      allocation_source_type: null,
      status: 'available'
    });
  });

  it('owns static DNS allocation state', () => {
    const zoneId = db.prepare(
      "INSERT INTO dns_zones (name, type, enabled) VALUES ('service.test', 'forward', 1)"
    ).run().lastInsertRowid;
    const recordId = db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'nas', 'A', '10.99.0.21', 'manual', 1)
    `).run(zoneId).lastInsertRowid;

    allocateStaticDns(db, 'nas', '10.99.0.21', 'service.test', recordId);
    expect(address('10.99.0.21')).toMatchObject({
      allocation_state: 'static_dns',
      allocation_source_type: 'dns',
      allocation_source_id: recordId,
      hostname: 'nas.service.test'
    });
  });

  it('owns static DHCP allocation and release', () => {
    const reservationId = db.prepare(`
      INSERT INTO dhcp_reservations
        (subnet_id, mac_address, ip_address, hostname, enabled)
      VALUES (?, 'aa:bb:cc:dd:ee:22', '10.99.0.22', 'printer', 1)
    `).run(subnetId).lastInsertRowid;

    allocateStaticDhcp(db, subnetId, '10.99.0.22', {
      hostname: 'printer',
      mac_address: 'aa:bb:cc:dd:ee:22'
    }, reservationId);
    expect(address('10.99.0.22')).toMatchObject({
      allocation_state: 'static_dhcp',
      allocation_source_type: 'dhcp_reservation',
      allocation_source_id: reservationId,
      dhcp_version: 4
    });

    db.prepare('DELETE FROM dhcp_reservations WHERE id = ?').run(reservationId);
    deallocateStaticDhcp(db, subnetId, '10.99.0.22', 'aa:bb:cc:dd:ee:22');
    expect(address('10.99.0.22')).toBeUndefined();
  });

  it('releases dynamic allocation authority when a lease disappears', () => {
    const lease = {
      ip: '10.99.0.23',
      mac: 'aa:bb:cc:dd:ee:23',
      hostname: 'dynamic-host',
      clientId: null,
      expiresAt: 'infinite',
      subnetId
    };
    db.prepare(`
      INSERT INTO dhcp_leases
        (subnet_id, ip_address, mac_address, hostname, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(subnetId, lease.ip, lease.mac, lease.hostname, lease.expiresAt);
    observeDhcpLeases(db, [lease]);
    expect(address(lease.ip)).toMatchObject({
      allocation_state: 'dynamic_dhcp',
      allocation_source_type: 'dhcp_lease'
    });

    db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ? AND ip_address = ?')
      .run(subnetId, lease.ip);
    observeDhcpLeases(db, []);
    expect(address(lease.ip)).toMatchObject({
      allocation_state: 'unassigned',
      allocation_source_type: null,
      allocation_source_id: null
    });
  });
});

describe('future IPv6 lifecycle adapters', () => {
  it('records SLAAC lifetimes and interface context', () => {
    observeSlaac(db, subnetId, '2001:0DB8::99', {
      interfaceId: 'eth0',
      preferredUntil: '2029-12-31T23:00:00.000Z',
      validUntil: '2030-01-01T00:00:00.000Z',
      temporary: true
    });
    expect(address('2001:db8::99')).toMatchObject({
      allocation_state: 'slaac',
      allocation_source_type: 'slaac',
      interface_id: 'eth0',
      detection_source: 'slaac_privacy'
    });
  });

  it('records Neighbor Discovery as liveness without changing allocation', () => {
    observeNeighbor(db, subnetId, 'fe80::99%eth0', { mac: 'aa:bb:cc:dd:ee:99' });
    expect(address('fe80::99')).toMatchObject({
      allocation_state: 'unassigned',
      interface_id: 'eth0',
      is_online: 1,
      is_rogue: 1,
      detection_source: 'neighbor_discovery'
    });

    setManualReservation(db, subnetId, 'fe80::98%eth0', true, 'IPv6 hold');
    observeNeighbor(db, subnetId, 'fe80::98%eth0', { mac: 'aa:bb:cc:dd:ee:98' });
    expect(address('fe80::98')).toMatchObject({
      allocation_state: 'reserved',
      is_online: 1,
      is_rogue: 0,
      rogue_reason: null
    });
  });

  it('accepts only trusted Router Advertisement gateway authority', () => {
    expect(() => observeRouterAdvertisement(db, subnetId, 'fe80::1%eth0'))
      .toThrow(/Untrusted Router Advertisement/);
    observeRouterAdvertisement(db, subnetId, 'fe80::1%eth0', { trusted: true });
    expect(address('fe80::1')).toMatchObject({
      allocation_state: 'gateway',
      allocation_source_type: 'topology',
      interface_id: 'eth0'
    });
  });
});
