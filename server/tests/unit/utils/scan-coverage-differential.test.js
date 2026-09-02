import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { intervalToMs, scannerCoveredSql } from '../../../src/utils/scan-coverage.js';

/**
 * The two arms of "will the scanner ever probe this" must agree.
 *
 * intervalToMs (JS, used by the scheduler) is an allowlist. scannerCoveredSql
 * (SQL, used by bulkMarkStale) was a denylist: TRIM(interval) NOT IN ('','off','0').
 * The module comment asserted they mirrored each other. They did not, and the
 * disagreement was one-directional and invisible: a value outside the map made
 * the scheduler skip the subnet forever while the SQL called it covered, so the
 * staleness sweep was forbidden from aging those hosts out. They stayed online
 * permanently, which reads as "everything is up" rather than as a fault.
 *
 * This is a cross-tier duplicate (JS vs SQL, a boundary `import` cannot cross),
 * so per docs/CROSS-TIER-DUPLICATION.md the price of keeping both is a test
 * that fails on drift.
 *
 * See REVIEW.md, duplicate-logic audit #5.
 */

let db, tmpDir;

// Every shape worth asking about, including the ones that told the arms apart.
const CANDIDATES = [
  '', 'off', '0', '00', '000',
  '5m', '15m', '30m', '1h', '4h',
  '2h', '10m', '1h30m', 'never', 'abc', 'OFF', ' 5m ',
  '1', '5', '60', '-5', '3.5', null,
];

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
  db.prepare("DELETE FROM settings WHERE key = 'default_scan_interval'").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_scan_enabled', '1')").run();
});
afterAll(() => cleanupTestDb(tmpDir));

/** Ask the SQL predicate about one interval value, in isolation. */
function sqlSaysCovered(intervalValue) {
  db.prepare('DELETE FROM ip_addresses').run();
  db.prepare('DELETE FROM subnets').run();
  const subnetId = db.prepare(`
    INSERT INTO subnets (
      cidr, name, network_address, broadcast_address, prefix_length,
      total_addresses, gateway_address, status, scan_interval
    )
    VALUES ('10.9.0.0/24', 'scan-diff', '10.9.0.0', '10.9.0.255', 24, 256, '10.9.0.1', 'allocated', ?)
  `).run(intervalValue).lastInsertRowid;
  db.prepare("INSERT INTO ip_addresses (subnet_id, ip_address) VALUES (?, '10.9.0.10')").run(subnetId);

  const row = db.prepare(`
    SELECT ${scannerCoveredSql('s', 'ip')} AS covered
    FROM ip_addresses ip JOIN subnets s ON s.id = ip.subnet_id
  `).get();
  return row.covered === 1;
}

describe('scan coverage: JS scheduler vs SQL staleness sweep', () => {
  for (const value of CANDIDATES) {
    it(`agrees on ${JSON.stringify(value)}`, () => {
      const jsWillScan = intervalToMs(value) !== null;
      expect(sqlSaysCovered(value), `intervalToMs says ${jsWillScan ? 'scan' : 'never'}`)
        .toBe(jsWillScan);
    });
  }

  it('treats the documented "never" values as never on both sides', () => {
    for (const v of ['', 'off', '0']) {
      expect(intervalToMs(v)).toBeNull();
      expect(sqlSaysCovered(v)).toBe(false);
    }
  });

  it('treats every named interval as covered on both sides', () => {
    for (const v of ['5m', '15m', '30m', '1h', '4h']) {
      expect(intervalToMs(v)).toBeGreaterThan(0);
      expect(sqlSaysCovered(v)).toBe(true);
    }
  });

  it('does not strand a subnet on an unrecognised interval', () => {
    // The exact production failure: neither arm should say "never scan" while
    // the other says "covered", because that combination means nothing scans
    // the subnet AND nothing may age it out.
    for (const v of ['2h', '10m', '00', 'never']) {
      expect(intervalToMs(v), `${v} should mean never`).toBeNull();
      expect(sqlSaysCovered(v), `${v} must not be reported as covered`).toBe(false);
    }
  });
});
