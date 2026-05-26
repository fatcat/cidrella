import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { reconcileDnsOrphans, reconcileDuplicateDhcpMacRows, syncLeasesToIps } from '../../../src/utils/ip-sync.js';
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
    expect(current.is_online).toBe(1);
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
