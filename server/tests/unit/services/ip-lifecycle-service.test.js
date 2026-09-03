import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDb, setupTestDb } from '../../helpers/test-db.js';
import {
  allocateStaticDns,
  allocateStaticDhcp,
  deallocateStaticDhcp,
  dhcpLeaseRejectionReason,
  observeDhcpLeases,
  observeDhcpv6Lease,
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
  db.prepare('DELETE FROM dhcp_scope_options').run();
  db.prepare('DELETE FROM dhcp_scopes WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(subnetId);
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

function createDynamicScope(start = '10.99.0.20', end = '10.99.0.30') {
  const rangeTypeId = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope'")
    .get().id;
  const rangeId = db.prepare(`
    INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip)
    VALUES (?, ?, ?, ?)
  `).run(subnetId, rangeTypeId, start, end).lastInsertRowid;
  db.prepare(`
    INSERT INTO dhcp_scopes (subnet_id, range_id, lease_time, enabled)
    VALUES (?, ?, '24h', 1)
  `).run(subnetId, rangeId);
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
    createDynamicScope();
    const lease = {
      ip: '10.99.0.23',
      mac: 'aa:bb:cc:dd:ee:23',
      hostname: 'dynamic-host',
      clientId: null,
      expiresAt: 'infinite',
      subnetId,
      observedActivity: true
    };
    db.prepare(`
      INSERT INTO dhcp_leases
        (subnet_id, ip_address, mac_address, hostname, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(subnetId, lease.ip, lease.mac, lease.hostname, lease.expiresAt);
    observeDhcpLeases(db, [lease]);
    expect(address(lease.ip)).toMatchObject({
      allocation_state: 'dynamic_dhcp',
      allocation_source_type: 'dhcp_lease',
      is_online: 1
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

  it('rejects dynamic leases outside pools and on reserved addresses', () => {
    createDynamicScope();
    expect(dhcpLeaseRejectionReason(db, {
      subnetId, ip: '10.99.0.40', mac: 'aa:bb:cc:dd:ee:40'
    })).toMatch(/outside an enabled DHCP scope/);

    setManualReservation(db, subnetId, '10.99.0.24', true, 'hold');
    expect(dhcpLeaseRejectionReason(db, {
      subnetId, ip: '10.99.0.24', mac: 'aa:bb:cc:dd:ee:24'
    })).toMatch(/reserved to dynamic_dhcp/);
  });
});

describe('future IPv6 lifecycle adapters', () => {
  it('records DHCPv6 allocation without deriving gateway authority', () => {
    observeDhcpv6Lease(db, subnetId, '2001:db8::97', {
      duid: '00:04:11:22:33:44:55:66',
      iaid: '7',
      preferredUntil: '2029-12-31T23:00:00.000Z',
      validUntil: '2030-01-01T00:00:00.000Z',
      poolValidated: true,
      routerAddress: '2001:db8::1'
    });
    expect(address('2001:db8::97')).toMatchObject({
      allocation_state: 'dynamic_dhcp',
      allocation_source_type: 'dhcp_lease',
      dhcp_version: 6,
      is_online: 1
    });
    expect(() => observeDhcpv6Lease(db, subnetId, '2001:db8::96', {
      duid: '00:04:11:22:33:44:55:66',
      iaid: '8',
      validUntil: '2030-01-01T00:00:00.000Z'
    })).toThrow(/validated enabled-pool membership/);
  });

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
