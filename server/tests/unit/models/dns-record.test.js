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
      { name: 'old', value: '10.0.0.11' },
      { name: 'new', value: '10.0.0.12' }
    ]);
    expect(rows).toEqual([
      { name: 'new', type: 'A', value: '10.0.0.12' },
      { name: 'old', type: 'A', value: '10.0.0.11' },
      { name: 'alias', type: 'CNAME', value: 'new.import.test' }
    ]);
    expect(updatedZone.soa_serial).toBe(2);
  });
});
