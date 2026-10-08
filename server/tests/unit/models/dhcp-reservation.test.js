import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import * as DhcpReservation from '../../../src/models/dhcp-reservation.js';
import { allocateStaticDns } from '../../../src/services/ip-lifecycle-service.js';
import { invalidateSubnetCache, syncPtrForIp } from '../../../src/utils/ip-sync.js';

let db;
let tmpDir;

function createSubnet() {
  return db
    .prepare(
      `
    INSERT INTO subnets (
      cidr, name, network_address, broadcast_address, prefix_length,
      total_addresses, gateway_address, status, domain_name
    )
    VALUES ('10.60.0.0/24', 'reservation-test', '10.60.0.0', '10.60.0.255', 24, 256, '10.60.0.1', 'allocated', 'reservation.test')
  `,
    )
    .run().lastInsertRowid;
}

function createReverseZone() {
  return db
    .prepare(
      "INSERT INTO dns_zones (name, type, enabled) VALUES ('0.60.10.in-addr.arpa', 'reverse', 1)",
    )
    .run().lastInsertRowid;
}

function createForwardZone() {
  return db
    .prepare(
      "INSERT INTO dns_zones (name, type, enabled) VALUES ('reservation.test', 'forward', 1)",
    )
    .run().lastInsertRowid;
}

function disabledReservation(subnet, mac, ip, hostname) {
  const created = DhcpReservation.createReservation(db, subnet, {
    mac_address: mac,
    ip_address: ip,
    hostname,
  });
  return DhcpReservation.updateReservation(db, created, subnet, {
    mac_address: created.mac_address,
    ip_address: created.ip_address,
    enabled: false,
  });
}

// What the DNS record route does for an enabled A record: allocate through
// DNS, then write the managed PTR. The leaf-subnet cache is per process, so
// it is dropped after this file's beforeEach recreated the subnet.
function claimThroughDns(subnetId, name, ip) {
  invalidateSubnetCache();
  allocateStaticDns(db, name, ip, 'reservation.test');
  syncPtrForIp(db, subnetId, ip, `${name}.reservation.test`, { source: 'dns' });
}

function ptrValue(zoneId, name) {
  return db
    .prepare("SELECT value FROM dns_records WHERE zone_id = ? AND type = 'PTR' AND name = ?")
    .get(zoneId, name)?.value;
}

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dns_zones').run();
  db.prepare('DELETE FROM ip_events').run();
  db.prepare('DELETE FROM ip_addresses').run();
  db.prepare('DELETE FROM dhcp_reservations').run();
  db.prepare('DELETE FROM subnets').run();
});

describe('DHCP Reservation ownership', () => {
  it('creates reservation rows and syncs IP/PTR state', () => {
    const subnetId = createSubnet();
    const ptrZoneId = createReverseZone();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);

    const reservation = DhcpReservation.createReservation(db, subnet, {
      mac_address: 'aa:bb:cc:dd:ee:01',
      ip_address: '10.60.0.25',
      hostname: 'host-one',
      description: 'test',
    });

    const ip = db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get('10.60.0.25');
    expect(reservation.hostname).toBe('host-one');
    expect(ip.hostname).toBe('host-one');
    expect(ip.mac_address).toBe('aa:bb:cc:dd:ee:01');
    expect(ptrValue(ptrZoneId, '25')).toBe('host-one.reservation.test');
  });

  it('updates reservation IP and clears old IP/PTR state', () => {
    const subnetId = createSubnet();
    const ptrZoneId = createReverseZone();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const reservation = DhcpReservation.createReservation(db, subnet, {
      mac_address: 'aa:bb:cc:dd:ee:01',
      ip_address: '10.60.0.25',
      hostname: 'host-one',
    });

    const updated = DhcpReservation.updateReservation(db, reservation, subnet, {
      mac_address: 'aa:bb:cc:dd:ee:02',
      ip_address: '10.60.0.26',
      hostname: 'host-two',
      description: undefined,
      enabled: true,
    });

    const oldIp = db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get('10.60.0.25');
    const newIp = db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get('10.60.0.26');
    expect(updated.ip_address).toBe('10.60.0.26');
    expect(oldIp).toBeUndefined();
    expect(newIp.hostname).toBe('host-two');
    expect(newIp.mac_address).toBe('aa:bb:cc:dd:ee:02');
    expect(ptrValue(ptrZoneId, '25')).toBe('10.60.0.25');
    expect(ptrValue(ptrZoneId, '26')).toBe('host-two.reservation.test');
  });

  it('deletes reservation rows and clears IP/PTR state', () => {
    const subnetId = createSubnet();
    const ptrZoneId = createReverseZone();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const reservation = DhcpReservation.createReservation(db, subnet, {
      mac_address: 'aa:bb:cc:dd:ee:01',
      ip_address: '10.60.0.25',
      hostname: 'host-one',
    });

    DhcpReservation.deleteReservation(db, reservation);

    const deleted = db.prepare('SELECT * FROM dhcp_reservations WHERE id = ?').get(reservation.id);
    const ip = db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get('10.60.0.25');
    expect(deleted).toBeUndefined();
    expect(ip).toBeUndefined();
    expect(ptrValue(ptrZoneId, '25')).toBe('10.60.0.25');
  });

  it('removes and restores allocation authority when disabled and re-enabled', () => {
    const subnetId = createSubnet();
    const ptrZoneId = createReverseZone();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const reservation = DhcpReservation.createReservation(db, subnet, {
      mac_address: 'aa:bb:cc:dd:ee:03',
      ip_address: '10.60.0.27',
      hostname: 'toggle-host',
    });

    const disabled = DhcpReservation.updateReservation(db, reservation, subnet, {
      mac_address: reservation.mac_address,
      ip_address: reservation.ip_address,
      enabled: false,
    });
    expect(disabled.enabled).toBe(0);
    expect(
      db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get('10.60.0.27'),
    ).toBeUndefined();
    expect(ptrValue(ptrZoneId, '27')).toBe('10.60.0.27');

    const enabled = DhcpReservation.updateReservation(db, disabled, subnet, {
      mac_address: disabled.mac_address,
      ip_address: disabled.ip_address,
      enabled: true,
    });
    const ip = db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get('10.60.0.27');
    expect(enabled.enabled).toBe(1);
    expect(ip).toMatchObject({
      allocation_state: 'static_dhcp',
      allocation_source_type: 'dhcp_reservation',
      allocation_source_id: reservation.id,
    });
    expect(ptrValue(ptrZoneId, '27')).toBe('toggle-host.reservation.test');
  });
});

// T-20 orders: a reservation disabled and then superseded by a DNS owner on
// the same address. Disabled configuration is non-authoritative, so its later
// edits and deletion must leave the DNS allocation and PTR alone instead of
// being refused by the lifecycle service.
describe('DHCP Reservation without a live allocation', () => {
  it('deletes a disabled reservation whose address DNS has since claimed', () => {
    const subnetId = createSubnet();
    const ptrZoneId = createReverseZone();
    createForwardZone();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const disabled = disabledReservation(subnet, 'aa:bb:cc:dd:ee:10', '10.60.0.40', 'old-host');
    claimThroughDns(subnetId, 'dns-host', '10.60.0.40');
    expect(ptrValue(ptrZoneId, '40')).toBe('dns-host.reservation.test');

    DhcpReservation.deleteReservation(db, disabled);

    expect(db.prepare('SELECT * FROM dhcp_reservations WHERE id = ?').get(disabled.id)).toBe(
      undefined,
    );
    expect(
      db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get('10.60.0.40'),
    ).toMatchObject({ allocation_state: 'static_dns', hostname: 'dns-host.reservation.test' });
    expect(ptrValue(ptrZoneId, '40')).toBe('dns-host.reservation.test');
  });

  it('edits a disabled reservation without touching the address it no longer holds', () => {
    const subnetId = createSubnet();
    const ptrZoneId = createReverseZone();
    createForwardZone();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const disabled = disabledReservation(subnet, 'aa:bb:cc:dd:ee:11', '10.60.0.41', 'old-host');
    claimThroughDns(subnetId, 'dns-host', '10.60.0.41');

    const renamed = DhcpReservation.updateReservation(db, disabled, subnet, {
      mac_address: disabled.mac_address,
      ip_address: disabled.ip_address,
      hostname: 'renamed-host',
      enabled: false,
    });
    expect(renamed.hostname).toBe('renamed-host');
    expect(
      db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get('10.60.0.41'),
    ).toMatchObject({ allocation_state: 'static_dns', hostname: 'dns-host.reservation.test' });
    expect(ptrValue(ptrZoneId, '41')).toBe('dns-host.reservation.test');
  });

  it('moves a disabled reservation to another address without releasing either', () => {
    const subnetId = createSubnet();
    const ptrZoneId = createReverseZone();
    createForwardZone();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const disabled = disabledReservation(subnet, 'aa:bb:cc:dd:ee:12', '10.60.0.42', 'old-host');
    claimThroughDns(subnetId, 'dns-a', '10.60.0.42');
    claimThroughDns(subnetId, 'dns-b', '10.60.0.43');

    const moved = DhcpReservation.updateReservation(db, disabled, subnet, {
      mac_address: disabled.mac_address,
      ip_address: '10.60.0.43',
      enabled: false,
    });
    expect(moved.ip_address).toBe('10.60.0.43');
    expect(
      db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get('10.60.0.42'),
    ).toMatchObject({ allocation_state: 'static_dns' });
    expect(
      db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get('10.60.0.43'),
    ).toMatchObject({ allocation_state: 'static_dns' });
    expect(ptrValue(ptrZoneId, '42')).toBe('dns-a.reservation.test');
    expect(ptrValue(ptrZoneId, '43')).toBe('dns-b.reservation.test');
  });

  it('still releases the address when an enabled reservation is deleted', () => {
    const subnetId = createSubnet();
    const ptrZoneId = createReverseZone();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
    const reservation = DhcpReservation.createReservation(db, subnet, {
      mac_address: 'aa:bb:cc:dd:ee:13',
      ip_address: '10.60.0.44',
      hostname: 'live-host',
    });
    // The route hands the model the stored row, enabled as 1.
    DhcpReservation.deleteReservation(db, {
      ...db.prepare('SELECT * FROM dhcp_reservations WHERE id = ?').get(reservation.id),
    });
    expect(
      db.prepare('SELECT * FROM ip_addresses WHERE ip_address = ?').get('10.60.0.44'),
    ).toBeUndefined();
    expect(ptrValue(ptrZoneId, '44')).toBe('10.60.0.44');
  });
});
