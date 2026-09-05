import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import {
  clearDnsFromIp,
  syncDhcpReservationToIp,
  syncDnsToIp,
  syncLeasesToIps
} from '../../../src/utils/ip-sync.js';
import * as IpAddress from '../../../src/models/ip-address.js';

let db;
let tmpDir;
let subnetId;
let otherSubnetId;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;

  db.prepare(`
    INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length, total_addresses, status)
    VALUES ('10.0.1.0/24', 'Test', '10.0.1.0', '10.0.1.255', 24, 256, 'allocated')
  `).run();
  subnetId = db.prepare("SELECT id FROM subnets WHERE cidr = '10.0.1.0/24'").get().id;

  db.prepare(`
    INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length, total_addresses, status)
    VALUES ('10.0.2.0/24', 'Other', '10.0.2.0', '10.0.2.255', 24, 256, 'allocated')
  `).run();
  otherSubnetId = db.prepare("SELECT id FROM subnets WHERE cidr = '10.0.2.0/24'").get().id;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  db.prepare('DELETE FROM ip_events').run();
  db.prepare('DELETE FROM ip_addresses').run();
  db.prepare('DELETE FROM dhcp_leases').run();
  db.prepare('DELETE FROM dhcp_reservations').run();
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dns_zones').run();
  db.prepare('UPDATE subnets SET domain_name = NULL').run();
});

describe('syncLeasesToIps', () => {
  it('keeps one ip_addresses row for a DHCP MAC when the lease moves', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.10', {
      hostname: 'old-host',
      mac_address: 'aa:bb:cc:dd:ee:ff',
      allocation_state: 'dynamic_dhcp',
      is_online: 0,
      detection_source: 'dhcp_lease'
    });

    syncLeasesToIps(db, [{
      subnetId,
      ip: '10.0.1.20',
      mac: 'aa:bb:cc:dd:ee:ff',
      hostname: 'new-host'
    }]);

    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.10')).toBeUndefined();
    const current = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.20');
    expect(current).toBeTruthy();
    expect(current.mac_address).toBe('aa:bb:cc:dd:ee:ff');
    expect(current.hostname).toBe('new-host');
    expect(current.allocation_state).toBe('unassigned');
    // Lease sync owns assignment, not liveness. It must not claim the host is up.
    expect(current.is_online).toBe(0);
  });

  it('preserves observed rows matched only by last_seen_mac', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.30', {
      last_seen_mac: 'aa:bb:cc:dd:ee:01',
      is_online: 1,
      is_rogue: 1,
      detection_source: 'scanner'
    });
    const observed = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.30');
    IpAddress.emitEvent(db, subnetId, '10.0.1.30', 'rogue_detected', { source: 'scanner' });

    syncLeasesToIps(db, [{
      subnetId,
      ip: '10.0.1.31',
      mac: 'aa:bb:cc:dd:ee:01',
      hostname: null
    }]);

    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.30')).toMatchObject({
      is_online: 1,
      is_rogue: 1,
      detection_source: 'scanner'
    });
    expect(IpAddress.getEvents(db, observed.id)).toHaveLength(1);
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.31')).toBeTruthy();
  });

  it('removes stale rows for the same MAC across subnets', () => {
    IpAddress.upsert(db, otherSubnetId, '10.0.2.50', {
      mac_address: 'aa:bb:cc:dd:ee:02',
      allocation_state: 'dynamic_dhcp',
      is_online: 0,
      detection_source: 'dhcp_lease'
    });

    syncLeasesToIps(db, [{
      subnetId,
      ip: '10.0.1.50',
      mac: 'aa:bb:cc:dd:ee:02',
      hostname: 'moved-host'
    }]);

    expect(IpAddress.findBySubnetAndIp(db, otherSubnetId, '10.0.2.50')).toBeUndefined();
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.50')).toBeTruthy();
  });

  it('does not overwrite a reservation hostname with a dynamic lease hostname', () => {
    db.prepare(`
      INSERT INTO dhcp_reservations (subnet_id, ip_address, mac_address, hostname, enabled)
      VALUES (?, '10.0.1.80', 'aa:bb:cc:dd:ee:80', 'reserved-name', 1)
    `).run(subnetId);

    syncDhcpReservationToIp(db, subnetId, '10.0.1.80', {
      hostname: 'reserved-name',
      mac_address: 'aa:bb:cc:dd:ee:80'
    });
    IpAddress.upsert(db, subnetId, '10.0.1.80', { allocation_state: 'static_dhcp' });

    syncLeasesToIps(db, [{
      subnetId,
      ip: '10.0.1.80',
      mac: 'aa:bb:cc:dd:ee:80',
      hostname: 'lease-name'
    }]);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.80');
    expect(row.hostname).toBe('reserved-name');
    expect(row.allocation_state).toBe('static_dhcp');
    expect(row.is_online).toBe(0);
  });

  it('does not mark a host online, even on an infinite lease', () => {
    // The reported bug. A reservation reaches dnsmasq's lease file with
    // expires_at='infinite', so it never expires. Asserting liveness here made
    // those hosts permanently "online" and re-asserted it over the scanner's
    // verdict on every lease-file rewrite.
    syncLeasesToIps(db, [{
      subnetId,
      ip: '10.0.1.90',
      mac: 'aa:bb:cc:dd:ee:90',
      hostname: 'static-host',
      expiresAt: 'infinite'
    }]);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.90');
    expect(row.is_online).toBe(0);
    expect(row.last_seen_at).toBeNull();
  });

  it('marks a dynamic host online when lease acquisition or renewal is observed', () => {
    syncLeasesToIps(db, [{
      subnetId,
      ip: '10.0.1.92',
      mac: 'aa:bb:cc:dd:ee:92',
      hostname: 'renewed-host',
      expiresAt: '2030-01-01T00:00:00.000Z',
      observedActivity: true
    }]);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.92');
    expect(row.is_online).toBe(1);
    expect(row.last_seen_at).toBeTruthy();
  });

  it('does not overwrite a scanner no-response verdict', () => {
    // End-to-end shape of the bug: the scanner proves the host is gone, then
    // any other device renewing its lease rewrites the file and re-syncs.
    IpAddress.upsert(db, subnetId, '10.0.1.91', {
      mac_address: 'aa:bb:cc:dd:ee:91',
      allocation_state: 'dynamic_dhcp',
      is_online: 1,
      detection_source: 'dhcp_lease'
    });
    IpAddress.updateFromScan(db, subnetId, '10.0.1.91', {
      responded: 0, mac: null, isConflict: 0, conflictReason: null
    });
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.91').is_online).toBe(0);

    const before = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.91').last_seen_at;

    syncLeasesToIps(db, [{
      subnetId,
      ip: '10.0.1.91',
      mac: 'aa:bb:cc:dd:ee:91',
      hostname: 'gone-host',
      expiresAt: 'infinite'
    }]);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.91');
    expect(row.is_online).toBe(0);
    expect(row.last_seen_at).toBe(before);
  });
});

describe('allocation-owned hostname sync', () => {
  it('does not use a raw lease as hostname precedence over a DNS write', () => {
    db.prepare(`
      INSERT INTO dhcp_leases (ip_address, mac_address, hostname, client_id, expires_at, subnet_id)
      VALUES ('10.0.1.90', 'aa:bb:cc:dd:ee:90', 'lease-name', NULL, datetime('now', '+1 hour'), ?)
    `).run(subnetId);
    syncLeasesToIps(db, [{
      subnetId,
      ip: '10.0.1.90',
      mac: 'aa:bb:cc:dd:ee:90',
      hostname: 'lease-name'
    }]);

    db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)").run();
    syncDnsToIp(db, 'static-name', '10.0.1.90', 'example.test');

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.90');
    expect(row.hostname).toBe('static-name.example.test');
  });

  it('does not fall back to an incompatible DNS claim when a reservation hostname is cleared', () => {
    const zone = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)").run();
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'static-name', 'A', '10.0.1.91', 'manual', 1)
    `).run(zone.lastInsertRowid);

    db.prepare(`
      INSERT INTO dhcp_reservations (subnet_id, ip_address, mac_address, hostname, enabled)
      VALUES (?, '10.0.1.91', 'aa:bb:cc:dd:ee:91', 'reserved-name', 1)
    `).run(subnetId);
    syncDhcpReservationToIp(db, subnetId, '10.0.1.91', {
      hostname: 'reserved-name',
      mac_address: 'aa:bb:cc:dd:ee:91'
    });
    IpAddress.upsert(db, subnetId, '10.0.1.91', { allocation_state: 'static_dhcp' });

    db.prepare("UPDATE dhcp_reservations SET hostname = NULL WHERE subnet_id = ? AND ip_address = '10.0.1.91'")
      .run(subnetId);
    syncDhcpReservationToIp(db, subnetId, '10.0.1.91', {
      hostname: null,
      mac_address: 'aa:bb:cc:dd:ee:91'
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.91');
    expect(row.hostname).toBeNull();
    expect(row.allocation_state).toBe('static_dhcp');
  });

  it('clears the DNS-owned hostname when its record is removed', () => {
    const zone = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)").run();
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'static-name', 'A', '10.0.1.92', 'manual', 1)
    `).run(zone.lastInsertRowid);
    syncDnsToIp(db, 'static-name', '10.0.1.92', 'example.test');

    db.prepare("DELETE FROM dns_records WHERE zone_id = ? AND name = 'static-name'").run(zone.lastInsertRowid);
    clearDnsFromIp(db, 'static-name', '10.0.1.92', 'example.test');

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.92');
    expect(row.hostname).toBeNull();
  });

  it('resets the PTR even when cached IP hostname metadata is stale', () => {
    const zone = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)").run();
    const reverseZone = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('1.0.10.in-addr.arpa', 'reverse', 1)").run();
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'static-name', 'A', '10.0.1.93', 'manual', 1)
    `).run(zone.lastInsertRowid);
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, '93', 'PTR', 'static-name.example.test', 'dns', 1)
    `).run(reverseZone.lastInsertRowid);
    IpAddress.upsert(db, subnetId, '10.0.1.93', {
      allocation_state: 'static_dns',
      hostname: 'stale.example.test',
      detection_source: 'dns'
    });

    db.prepare("DELETE FROM dns_records WHERE zone_id = ? AND name = 'static-name'")
      .run(zone.lastInsertRowid);
    clearDnsFromIp(db, 'static-name', '10.0.1.93', 'example.test');

    expect(db.prepare(`
      SELECT value, source FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND name = '93'
    `).get(reverseZone.lastInsertRowid)).toEqual({
      value: '10.0.1.93',
      source: 'placeholder'
    });
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.93').hostname).toBeNull();
  });
});
