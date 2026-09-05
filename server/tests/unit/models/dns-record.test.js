import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import * as DnsRecord from '../../../src/models/dns-record.js';

let db;
let tmpDir;

function createZone(name, type = 'reverse', enabled = 1) {
  return db.prepare('INSERT INTO dns_zones (name, type, enabled) VALUES (?, ?, ?)')
    .run(name, type, enabled).lastInsertRowid;
}

function getPtr(zoneId, name) {
  return db.prepare("SELECT * FROM dns_records WHERE zone_id = ? AND type = 'PTR' AND name = ?")
    .get(zoneId, name);
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
});

describe('PTR record ownership', () => {
  it('fills missing managed rows and promotes placeholders to canonical protocol names', () => {
    const subnetId = db.prepare(`
      INSERT INTO subnets (
        cidr, name, network_address, broadcast_address, prefix_length,
        total_addresses, gateway_address, status, domain_name, has_reverse_dns
      ) VALUES (
        '10.61.0.0/29', 'ptr-reconcile', '10.61.0.0', '10.61.0.7', 29,
        8, '10.61.0.1', 'allocated', 'reconcile.test', 1
      )
    `).run().lastInsertRowid;
    const reverseZoneId = createZone('0.61.10.in-addr.arpa');
    const forwardZoneId = createZone('reconcile.test', 'forward');
    db.prepare(`
      INSERT INTO ip_addresses
        (subnet_id, ip_address, allocation_state, allocation_source_type)
      VALUES (?, '10.61.0.2', 'static_dns', 'dns'),
             (?, '10.61.0.3', 'static_dhcp', 'dhcp_reservation'),
             (?, '10.61.0.5', 'dynamic_dhcp', 'dhcp_lease')
    `).run(subnetId, subnetId, subnetId);
    db.prepare(`
      INSERT INTO dhcp_reservations
        (subnet_id, ip_address, mac_address, hostname, enabled)
      VALUES (?, '10.61.0.3', 'aa:bb:cc:dd:ee:03', 'dhcp-host', 1)
    `).run(subnetId);
    db.prepare(`
      INSERT INTO dhcp_leases
        (subnet_id, ip_address, mac_address, hostname, expires_at)
      VALUES (?, '10.61.0.5', 'aa:bb:cc:dd:ee:05', 'lease-host', datetime('now', '+1 hour'))
    `).run(subnetId);
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, 'dns-host', 'A', '10.61.0.2', 'manual', 1),
             (?, '2', 'PTR', '10.61.0.2', 'manual', 1),
             (?, '4', 'PTR', '', 'manual', 1)
    `).run(forwardZoneId, reverseZoneId, reverseZoneId);

    const first = DnsRecord.reconcileManagedReverseDns(db);
    const second = DnsRecord.reconcileManagedReverseDns(db);
    const ptrs = db.prepare(`
      SELECT name, value, source FROM dns_records
      WHERE zone_id = ? AND type = 'PTR'
      ORDER BY CAST(name AS INTEGER)
    `).all(reverseZoneId);

    expect(first).toMatchObject({ inserted: 4, updated: 2, unchanged: 0 });
    expect(second).toMatchObject({ inserted: 0, updated: 0, unchanged: 6 });
    expect(ptrs).toEqual([
      { name: '1', value: '10.61.0.1', source: 'placeholder' },
      { name: '2', value: 'dns-host.reconcile.test', source: 'dns' },
      { name: '3', value: 'dhcp-host.reconcile.test', source: 'reservation' },
      { name: '4', value: '10.61.0.4', source: 'placeholder' },
      { name: '5', value: 'lease-host.reconcile.test', source: 'dhcp' },
      { name: '6', value: '10.61.0.6', source: 'placeholder' }
    ]);
  });

  it('repairs stale generated names but preserves explicit manual PTR overrides', () => {
    const subnetId = db.prepare(`
      INSERT INTO subnets (
        cidr, name, network_address, broadcast_address, prefix_length,
        total_addresses, status, has_reverse_dns
      ) VALUES ('10.62.0.0/30', 'ptr-stale', '10.62.0.0', '10.62.0.3', 30, 4, 'allocated', 1)
    `).run().lastInsertRowid;
    const reverseZoneId = createZone('0.62.10.in-addr.arpa');
    db.prepare(`
      INSERT INTO ip_addresses (subnet_id, ip_address, allocation_state)
      VALUES (?, '10.62.0.1', 'unassigned'), (?, '10.62.0.2', 'unassigned')
    `).run(subnetId, subnetId);
    db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
      VALUES (?, '1', 'PTR', 'expired.ptr-stale.test', 'dhcp', 1),
             (?, '2', 'PTR', 'operator.ptr-stale.test', 'manual', 1)
    `).run(reverseZoneId, reverseZoneId);

    DnsRecord.reconcileManagedReverseDns(db);

    expect(getPtr(reverseZoneId, '1')).toMatchObject({
      value: '10.62.0.1',
      source: 'placeholder'
    });
    expect(getPtr(reverseZoneId, '2')).toMatchObject({
      value: 'operator.ptr-stale.test',
      source: 'manual'
    });
  });

  it('creates PTR records in the most-specific reverse zone', () => {
    createZone('10.in-addr.arpa');
    const zoneId = createZone('1.0.10.in-addr.arpa');

    const result = DnsRecord.syncPtrForARecord(db, 'host', '10.0.1.25', 'example.test');
    const ptr = getPtr(zoneId, '25');

    expect(result.updated).toBe(true);
    expect(ptr.value).toBe('host.example.test');
  });

  it('clears existing PTR records back to the bare IP', () => {
    const zoneId = createZone('1.0.10.in-addr.arpa');
    DnsRecord.syncPtrForARecord(db, 'host', '10.0.1.25', 'example.test');

    DnsRecord.clearPtrForIp(db, '10.0.1.25');
    const ptr = getPtr(zoneId, '25');

    expect(ptr.value).toBe('10.0.1.25');
    expect(ptr.source).toBe('placeholder');
  });

  it('detects cross-zone PTR conflicts unless forced', () => {
    const zoneId = createZone('1.0.10.in-addr.arpa');
    db.prepare("INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, '25', 'PTR', 'host.alpha.test', 1)")
      .run(zoneId);

    const conflict = DnsRecord.syncPtrForARecord(db, 'host', '10.0.1.25', 'beta.test');
    const forced = DnsRecord.syncPtrForARecord(db, 'host', '10.0.1.25', 'beta.test', { force: true });
    const ptr = getPtr(zoneId, '25');

    expect(conflict.conflict).toEqual({
      existing: 'host.alpha.test',
      proposed: 'host.beta.test',
      reverseZone: '1.0.10.in-addr.arpa'
    });
    expect(forced.updated).toBe(true);
    expect(ptr.value).toBe('host.beta.test');
  });
});

describe('DNS record ownership', () => {
  it('creates A records and matching PTR records in one model operation', () => {
    const forwardZoneId = createZone('example.test', 'forward');
    const reverseZoneId = createZone('1.0.10.in-addr.arpa');
    const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(forwardZoneId);

    const { record } = DnsRecord.createRecord(db, zone, {
      name: 'host',
      type: 'A',
      value: '10.0.1.25'
    });

    const ptr = getPtr(reverseZoneId, '25');
    const forwardZone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(forwardZoneId);
    const reverseZone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(reverseZoneId);

    expect(record.name).toBe('host');
    expect(record.value).toBe('10.0.1.25');
    expect(ptr.value).toBe('host.example.test');
    expect(forwardZone.soa_serial).toBe(2);
    expect(reverseZone.soa_serial).toBe(2);
  });

  it('rolls back A record creation when PTR conflict validation fails', () => {
    const forwardZoneId = createZone('beta.test', 'forward');
    const reverseZoneId = createZone('1.0.10.in-addr.arpa');
    const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(forwardZoneId);
    db.prepare("INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, '25', 'PTR', 'host.alpha.test', 1)")
      .run(reverseZoneId);

    expect(() => DnsRecord.createRecord(db, zone, {
      name: 'host',
      type: 'A',
      value: '10.0.1.25'
    })).toThrow('PTR conflict');

    const records = db.prepare("SELECT * FROM dns_records WHERE type = 'A'").all();
    expect(records).toHaveLength(0);
  });

  it('updates A records and clears the old PTR when the IP changes', () => {
    const forwardZoneId = createZone('example.test', 'forward');
    const reverseZoneId = createZone('1.0.10.in-addr.arpa');
    const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(forwardZoneId);
    const { record } = DnsRecord.createRecord(db, zone, {
      name: 'host',
      type: 'A',
      value: '10.0.1.25'
    });

    const updated = DnsRecord.updateRecord(db, zone, record, {
      name: 'renamed',
      type: 'A',
      value: '10.0.1.26',
      priority: null,
      weight: null,
      port: null,
      ttl: null
    });

    expect(updated.name).toBe('renamed');
    expect(getPtr(reverseZoneId, '25').value).toBe('10.0.1.25');
    expect(getPtr(reverseZoneId, '26').value).toBe('renamed.example.test');
  });

  it('clears the PTR when an A record is disabled', () => {
    const forwardZoneId = createZone('example.test', 'forward');
    const reverseZoneId = createZone('1.0.10.in-addr.arpa');
    const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(forwardZoneId);
    const { record } = DnsRecord.createRecord(db, zone, {
      name: 'host',
      type: 'A',
      value: '10.0.1.25'
    });

    DnsRecord.updateRecord(db, zone, record, {
      name: 'host',
      type: 'A',
      value: '10.0.1.25',
      priority: null,
      weight: null,
      port: null,
      ttl: null,
      enabled: 0
    });

    expect(getPtr(reverseZoneId, '25').value).toBe('10.0.1.25');
  });

  it('clears the PTR when an A record changes to another type', () => {
    const forwardZoneId = createZone('example.test', 'forward');
    const reverseZoneId = createZone('1.0.10.in-addr.arpa');
    const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(forwardZoneId);
    const { record } = DnsRecord.createRecord(db, zone, {
      name: 'alias',
      type: 'A',
      value: '10.0.1.25'
    });

    DnsRecord.updateRecord(db, zone, record, {
      name: 'alias',
      type: 'CNAME',
      value: 'target.example.test',
      priority: null,
      weight: null,
      port: null,
      ttl: null,
      enabled: 1
    });

    expect(getPtr(reverseZoneId, '25').value).toBe('10.0.1.25');
  });

  it('deletes A records and clears their PTR record', () => {
    const forwardZoneId = createZone('example.test', 'forward');
    const reverseZoneId = createZone('1.0.10.in-addr.arpa');
    const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(forwardZoneId);
    const { record } = DnsRecord.createRecord(db, zone, {
      name: 'host',
      type: 'A',
      value: '10.0.1.25'
    });

    DnsRecord.deleteRecord(db, zone, record);

    const deleted = db.prepare('SELECT * FROM dns_records WHERE id = ?').get(record.id);
    expect(deleted).toBeUndefined();
    expect(getPtr(reverseZoneId, '25').value).toBe('10.0.1.25');
  });
});

describe('DNS import ownership', () => {
  it('imports A and CNAME records with merge semantics and bumps SOA once', () => {
    const zoneId = createZone('import.test', 'forward');
    const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(zoneId);
    db.prepare("INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, 'old', 'A', '10.0.0.10', 1)")
      .run(zoneId);
    db.prepare("INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, 'alias', 'CNAME', 'old.import.test', 1)")
      .run(zoneId);

    const result = DnsRecord.importRecords(db, zone, [
      { type: 'A', name: 'old', value: '10.0.0.11' },
      { type: 'A', name: 'new', value: '10.0.0.12' },
      { type: 'A', name: 'new', value: '10.0.0.12' },
      { type: 'CNAME', name: 'alias', value: 'new.import.test' }
    ]);

    const rows = db.prepare('SELECT name, type, value FROM dns_records WHERE zone_id = ? ORDER BY type, name')
      .all(zoneId);
    const updatedZone = db.prepare('SELECT soa_serial FROM dns_zones WHERE id = ?').get(zoneId);

    expect(result.results.A).toEqual({ created: 1, updated: 1, skipped: 1, failed: 0 });
    expect(result.results.CNAME).toEqual({ created: 0, updated: 1, skipped: 0, failed: 0 });
    expect(result.aRecordsToSync).toEqual([
      { id: expect.any(Number), name: 'old', value: '10.0.0.11', previousValue: '10.0.0.10' },
      { id: expect.any(Number), name: 'new', value: '10.0.0.12', previousValue: null }
    ]);
    expect(rows).toEqual([
      { name: 'new', type: 'A', value: '10.0.0.12' },
      { name: 'old', type: 'A', value: '10.0.0.11' },
      { name: 'alias', type: 'CNAME', value: 'new.import.test' }
    ]);
    expect(updatedZone.soa_serial).toBe(2);
  });
});
