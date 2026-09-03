import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import {
  clearDnsFromIp,
  pruneStaleDhcpHostRows,
  reconcileDnsOrphans,
  reconcileDuplicateDhcpMacRows,
  reconcileUnbackedDhcpLeaseRows,
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
      status: 'dhcp',
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
    expect(current.status).toBe('dhcp');
    // Lease sync owns assignment, not liveness. It must not claim the host is up.
    expect(current.is_online).toBe(0);
  });

  it('removes stale rows matched only by last_seen_mac', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.30', {
      last_seen_mac: 'aa:bb:cc:dd:ee:01',
      is_online: 0,
      detection_source: 'scanner'
    });

    syncLeasesToIps(db, [{
      subnetId,
      ip: '10.0.1.31',
      mac: 'aa:bb:cc:dd:ee:01',
      hostname: null
    }]);

    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.30')).toBeUndefined();
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.31')).toBeTruthy();
  });

  it('removes stale rows for the same MAC across subnets', () => {
    IpAddress.upsert(db, otherSubnetId, '10.0.2.50', {
      mac_address: 'aa:bb:cc:dd:ee:02',
      status: 'dhcp',
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

    syncLeasesToIps(db, [{
      subnetId,
      ip: '10.0.1.80',
      mac: 'aa:bb:cc:dd:ee:80',
      hostname: 'lease-name'
    }]);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.80');
    expect(row.hostname).toBe('reserved-name');
    expect(row.status).toBe('dhcp');
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
      status: 'dhcp',
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

describe('canonical hostname sync', () => {
  it('does not let a static DNS A record overwrite an active DHCP lease hostname', () => {
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
    expect(row.hostname).toBe('lease-name');
  });

  it('falls back to the static DNS hostname when a reservation hostname is cleared', () => {
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

    db.prepare("UPDATE dhcp_reservations SET hostname = NULL WHERE subnet_id = ? AND ip_address = '10.0.1.91'")
      .run(subnetId);
    syncDhcpReservationToIp(db, subnetId, '10.0.1.91', {
      hostname: null,
      mac_address: 'aa:bb:cc:dd:ee:91'
    });

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.91');
    expect(row.hostname).toBe('static-name.example.test');
    expect(row.status).toBe('dhcp');
  });

  it('falls back to another canonical source when a DNS hostname is removed', () => {
    const zone = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)").run();
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'static-name', 'A', '10.0.1.92', 'manual', 1)
    `).run(zone.lastInsertRowid);
    syncDnsToIp(db, 'static-name', '10.0.1.92', 'example.test');

    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'next-name', 'A', '10.0.1.92', 'manual', 1)
    `).run(zone.lastInsertRowid);
    db.prepare("DELETE FROM dns_records WHERE zone_id = ? AND name = 'static-name'").run(zone.lastInsertRowid);
    clearDnsFromIp(db, 'static-name', '10.0.1.92', 'example.test');

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.92');
    expect(row.hostname).toBe('next-name.example.test');
  });
});

describe('reconcileDuplicateDhcpMacRows', () => {
  it('removes older offline DHCP rows for the same MAC', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.10', {
      hostname: 'old',
      mac_address: 'aa:bb:cc:dd:ee:10',
      last_seen_mac: 'aa:bb:cc:dd:ee:10',
      status: 'dhcp',
      is_online: 0,
      detection_source: 'scanner'
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-30 days'), updated_at = datetime('now', '-30 days') WHERE subnet_id = ? AND ip_address = '10.0.1.10'")
      .run(subnetId);

    IpAddress.upsert(db, subnetId, '10.0.1.20', {
      hostname: 'new',
      mac_address: 'aa:bb:cc:dd:ee:10',
      last_seen_mac: 'aa:bb:cc:dd:ee:10',
      status: 'dhcp',
      is_online: 0,
      detection_source: 'scanner'
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-1 day') WHERE subnet_id = ? AND ip_address = '10.0.1.20'")
      .run(subnetId);

    expect(reconcileDuplicateDhcpMacRows(db)).toBe(1);
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.10')).toBeUndefined();
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.20')).toBeTruthy();
  });

  it('keeps the active lease row over a newer stale row for the same MAC', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.30', {
      mac_address: 'aa:bb:cc:dd:ee:30',
      status: 'dhcp',
      is_online: 0
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-10 days') WHERE subnet_id = ? AND ip_address = '10.0.1.30'")
      .run(subnetId);
    db.prepare(`
      INSERT INTO dhcp_leases (ip_address, mac_address, hostname, client_id, expires_at, subnet_id)
      VALUES ('10.0.1.30', 'aa:bb:cc:dd:ee:30', 'active', NULL, datetime('now', '+1 hour'), ?)
    `).run(subnetId);

    IpAddress.upsert(db, subnetId, '10.0.1.31', {
      mac_address: 'aa:bb:cc:dd:ee:30',
      status: 'dhcp',
      is_online: 0
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now') WHERE subnet_id = ? AND ip_address = '10.0.1.31'")
      .run(subnetId);

    expect(reconcileDuplicateDhcpMacRows(db)).toBe(1);
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.30')).toBeTruthy();
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.31')).toBeUndefined();
  });
});

describe('pruneStaleDhcpHostRows', () => {
  it('removes offline DHCP rows older than 24 hours with no active lease or reservation', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.70', {
      hostname: 'old-watch',
      mac_address: '00:24:e4:ee:96:16',
      status: 'dhcp',
      is_online: 0,
      detection_source: 'dhcp_lease'
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-25 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.70'")
      .run(subnetId);

    expect(pruneStaleDhcpHostRows(db)).toBe(1);
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.70')).toBeUndefined();
  });

  it('spares a row a manual A record points at', () => {
    // Deleting the row takes the MAC with it, and vendor and device with that.
    // A static DNS entry is an admin declaration, so it keeps what was learned.
    const zoneId = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('prune.test', 'forward', 1)")
      .run().lastInsertRowid;
    db.prepare("INSERT INTO dns_records (zone_id, name, type, value, source, enabled) VALUES (?, 'nas', 'A', '10.0.1.72', 'manual', 1)")
      .run(zoneId);

    IpAddress.upsert(db, subnetId, '10.0.1.72', {
      hostname: 'nas',
      mac_address: '00:24:e4:ee:96:18',
      status: 'dhcp',
      is_online: 0,
      detection_source: 'dhcp_lease'
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-25 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.72'")
      .run(subnetId);

    expect(pruneStaleDhcpHostRows(db)).toBe(0);
    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.72');
    expect(row).toBeTruthy();
    expect(row.mac_address).toBe('00:24:e4:ee:96:18');
  });

  it('spares a locked row', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.73', {
      mac_address: '00:24:e4:ee:96:19',
      status: 'locked',
      is_online: 0,
      detection_source: 'dhcp_lease'
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-25 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.73'")
      .run(subnetId);

    expect(pruneStaleDhcpHostRows(db)).toBe(0);
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.73')).toBeTruthy();
  });

  it('keeps recent offline DHCP rows', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.71', {
      hostname: 'recent-watch',
      mac_address: '00:24:e4:ee:96:17',
      status: 'dhcp',
      is_online: 0,
      detection_source: 'dhcp_lease'
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-23 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.71'")
      .run(subnetId);

    expect(pruneStaleDhcpHostRows(db)).toBe(0);
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.71')).toBeTruthy();
  });

  it('keeps stale DHCP rows with active lease backing', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.72', {
      hostname: 'leased-watch',
      mac_address: '00:24:e4:ee:96:18',
      status: 'dhcp',
      is_online: 0,
      detection_source: 'dhcp_lease'
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-25 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.72'")
      .run(subnetId);
    db.prepare(`
      INSERT INTO dhcp_leases (ip_address, mac_address, hostname, client_id, expires_at, subnet_id)
      VALUES ('10.0.1.72', '00:24:e4:ee:96:18', 'leased-watch', NULL, datetime('now', '+1 hour'), ?)
    `).run(subnetId);

    expect(pruneStaleDhcpHostRows(db)).toBe(0);
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.72')).toBeTruthy();
  });

  it('keeps stale DHCP rows with reservation backing', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.73', {
      hostname: 'reserved-watch',
      mac_address: '00:24:e4:ee:96:19',
      status: 'dhcp',
      is_online: 0,
      detection_source: 'dhcp_lease'
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-25 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.73'")
      .run(subnetId);
    db.prepare(`
      INSERT INTO dhcp_reservations (subnet_id, ip_address, mac_address, hostname, enabled)
      VALUES (?, '10.0.1.73', '00:24:e4:ee:96:19', 'reserved-watch', 1)
    `).run(subnetId);

    expect(pruneStaleDhcpHostRows(db)).toBe(0);
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.73')).toBeTruthy();
  });

  it('removes stale DHCP lease history even if the imported row says online', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.74', {
      hostname: 'imported-phone',
      mac_address: '00:24:e4:ee:96:20',
      status: 'dhcp',
      is_online: 1,
      detection_source: 'dhcp_lease'
    });
    db.prepare("UPDATE ip_addresses SET last_seen_at = datetime('now', '-25 hours') WHERE subnet_id = ? AND ip_address = '10.0.1.74'")
      .run(subnetId);

    expect(pruneStaleDhcpHostRows(db)).toBe(1);
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.74')).toBeUndefined();
  });
});

describe('reconcileUnbackedDhcpLeaseRows', () => {
  it('turns DHCP lease rows without active backing into available history', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.75', {
      hostname: 'restored-lease',
      mac_address: '00:24:e4:ee:96:21',
      status: 'dhcp',
      is_online: 1,
      detection_source: 'dhcp_lease'
    });

    expect(reconcileUnbackedDhcpLeaseRows(db)).toBe(1);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.75');
    expect(row.status).toBe('available');
    expect(row.is_online).toBe(0);
    expect(row.hostname).toBe('restored-lease');
    expect(row.mac_address).toBe('00:24:e4:ee:96:21');
  });

  it('keeps DHCP lease rows with active lease backing assigned', () => {
    IpAddress.upsert(db, subnetId, '10.0.1.76', {
      hostname: 'active-lease',
      mac_address: '00:24:e4:ee:96:22',
      status: 'dhcp',
      is_online: 1,
      detection_source: 'dhcp_lease'
    });
    db.prepare(`
      INSERT INTO dhcp_leases (ip_address, mac_address, hostname, client_id, expires_at, subnet_id)
      VALUES ('10.0.1.76', '00:24:e4:ee:96:22', 'active-lease', NULL, datetime('now', '+1 hour'), ?)
    `).run(subnetId);

    expect(reconcileUnbackedDhcpLeaseRows(db)).toBe(0);
    expect(IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.76').status).toBe('dhcp');
  });
});

describe('reconcileDnsOrphans', () => {
  it('clears a stale zone-qualified hostname after scanner overwrote the source', () => {
    db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)").run();
    IpAddress.upsert(db, subnetId, '10.0.1.60', {
      hostname: 'old.example.test',
      detection_source: 'scanner'
    });

    expect(reconcileDnsOrphans(db)).toBe(1);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.60');
    expect(row.hostname).toBeNull();
    expect(row.detection_source).toBeNull();
  });

  it('clears a stale unqualified hostname using the subnet domain as the zone', () => {
    db.prepare("UPDATE subnets SET domain_name = 'example.test' WHERE id = ?").run(subnetId);
    db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)").run();
    IpAddress.upsert(db, subnetId, '10.0.1.63', {
      hostname: 'old-short',
      detection_source: 'scanner'
    });

    expect(reconcileDnsOrphans(db)).toBe(1);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.63');
    expect(row.hostname).toBeNull();
    expect(row.detection_source).toBeNull();
  });

  it('keeps a scanner-touched hostname when a backing A record exists', () => {
    const zone = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)").run();
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, enabled)
      VALUES (?, 'host', 'A', '10.0.1.61', 1)
    `).run(zone.lastInsertRowid);
    IpAddress.upsert(db, subnetId, '10.0.1.61', {
      hostname: 'host.example.test',
      detection_source: 'scanner'
    });

    expect(reconcileDnsOrphans(db)).toBe(0);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.61');
    expect(row.hostname).toBe('host.example.test');
    expect(row.detection_source).toBe('scanner');
  });

  it('keeps an unqualified hostname when a backing A record exists in the subnet domain', () => {
    db.prepare("UPDATE subnets SET domain_name = 'example.test' WHERE id = ?").run(subnetId);
    const zone = db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)").run();
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, enabled)
      VALUES (?, 'short-host', 'A', '10.0.1.64', 1)
    `).run(zone.lastInsertRowid);
    IpAddress.upsert(db, subnetId, '10.0.1.64', {
      hostname: 'short-host',
      detection_source: 'scanner'
    });

    expect(reconcileDnsOrphans(db)).toBe(0);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.64');
    expect(row.hostname).toBe('short-host');
    expect(row.detection_source).toBe('scanner');
  });

  it('does not clear DHCP-owned hostnames without DNS records', () => {
    db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES ('example.test', 'forward', 1)").run();
    IpAddress.upsert(db, subnetId, '10.0.1.62', {
      hostname: 'lease.example.test',
      status: 'dhcp',
      detection_source: 'scanner'
    });

    expect(reconcileDnsOrphans(db)).toBe(0);

    const row = IpAddress.findBySubnetAndIp(db, subnetId, '10.0.1.62');
    expect(row.hostname).toBe('lease.example.test');
    expect(row.status).toBe('dhcp');
  });
});
