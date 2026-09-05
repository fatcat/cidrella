/**
 * DNS names are canonical in storage, so `r.name || '.' || z.name` is a correct
 * FQDN by construction.
 *
 * SQLite compares TEXT with `=` case-sensitively, so every write path must
 * produce the same normalized form used by fqdnForRecordName().
 *
 * The fix is normalization at every sink, not defensive lower() at each query.
 * These tests pin that: if a write path stops normalizing, the FQDN assertions
 * below fail rather than a hostname quietly disappearing on someone's appliance.
 *
 * See REVIEW.md, duplicate-logic audit #8.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { normalizeRecordNameForZone, fqdnForRecordName } from '../../../src/models/dns-record.js';
import { normalizeZoneName } from '../../../src/models/dns-zone.js';

let db;
let tmpDir;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
});
afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  db.prepare('DELETE FROM dns_records').run();
  db.prepare('DELETE FROM dns_zones').run();
  db.prepare('DELETE FROM ip_addresses').run();
  db.prepare('DELETE FROM subnets').run();
});

describe('normalizeRecordNameForZone', () => {
  it('lowercases a device-reported name', () => {
    expect(normalizeRecordNameForZone('S24-Ultra', 'example.com')).toBe('s24-ultra');
  });

  it('strips a redundant zone suffix, in any case', () => {
    expect(normalizeRecordNameForZone('web.example.com', 'example.com')).toBe('web');
    expect(normalizeRecordNameForZone('WEB.Example.COM', 'example.com')).toBe('web');
  });

  it('maps the apex to @', () => {
    expect(normalizeRecordNameForZone('@', 'example.com')).toBe('@');
    expect(normalizeRecordNameForZone('example.com', 'example.com')).toBe('@');
    expect(normalizeRecordNameForZone('Example.COM', 'example.com')).toBe('@');
  });

  it('leaves an out-of-zone name qualified', () => {
    expect(normalizeRecordNameForZone('host.other.com', 'example.com')).toBe('host.other.com');
  });

  it('is idempotent', () => {
    const once = normalizeRecordNameForZone('WEB.Example.COM', 'example.com');
    expect(normalizeRecordNameForZone(once, 'example.com')).toBe(once);
  });
});

describe('normalizeZoneName', () => {
  it('lowercases and drops a trailing dot', () => {
    expect(normalizeZoneName('Example.COM.')).toBe('example.com');
  });
});

describe('the SQL concatenation and the JS builder agree on normalized rows', () => {
  // This is the actual invariant. If it breaks, reconcileDnsOrphans starts
  // clearing hostnames that have a live A record.
  it.each([
    ['S24-Ultra', 'example.com'],
    ['web.example.com', 'example.com'],
    ['plain', 'example.com'],
    ['@', 'example.com'],
  ])('%s in %s', (rawName, rawZone) => {
    const zoneName = normalizeZoneName(rawZone);
    db.prepare("INSERT INTO dns_zones (name, type, enabled) VALUES (?, 'forward', 1)").run(zoneName);
    const zoneId = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(zoneName).id;
    const stored = normalizeRecordNameForZone(rawName, zoneName);
    db.prepare("INSERT INTO dns_records (zone_id, type, name, value, enabled, source) VALUES (?, 'A', ?, '10.1.2.3', 1, 'manual')")
      .run(zoneId, stored);

    const fromSql = db.prepare(
      "SELECT CASE WHEN r.name = '@' THEN z.name ELSE r.name || '.' || z.name END AS f"
      + ' FROM dns_records r JOIN dns_zones z ON z.id = r.zone_id'
    ).get().f;

    expect(fromSql).toBe(fqdnForRecordName(stored, zoneName));
  });
});
