import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { getNextScanTime } from '../../../src/utils/scan-scheduler.js';

let db;
let tmpDir;

function insertSubnet({
  cidr = '10.0.1.0/24',
  network = '10.0.1.0',
  broadcast = '10.0.1.255',
  prefix = 24,
  total = 256,
  status = 'allocated',
  scanEnabled = null,
  scanInterval = null,
} = {}) {
  const result = db.prepare(`
    INSERT INTO subnets (
      cidr, name, network_address, broadcast_address, prefix_length,
      total_addresses, status, scan_enabled, scan_interval
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cidr, cidr, network, broadcast, prefix, total, status, scanEnabled, scanInterval);
  return result.lastInsertRowid;
}

function sqliteUtc(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function expectNearFuture(value, maxMs = 65_000) {
  const delta = new Date(value).getTime() - Date.now();
  expect(delta).toBeGreaterThan(0);
  expect(delta).toBeLessThanOrEqual(maxMs);
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
  db.prepare('DELETE FROM scan_results').run();
  db.prepare('DELETE FROM network_scans').run();
  db.prepare('DELETE FROM ip_addresses').run();
  db.prepare('DELETE FROM ranges').run();
  db.prepare('DELETE FROM subnets').run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_scan_interval', '')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_scan_enabled', '1')").run();
});

describe('getNextScanTime', () => {
  it('schedules subnets using UI interval values', () => {
    db.prepare("UPDATE settings SET value = '15m' WHERE key = 'default_scan_interval'").run();
    insertSubnet();

    expect(getNextScanTime()).toEqual(expect.any(String));
  });

  it('supports legacy integer-minute interval values', () => {
    db.prepare("UPDATE settings SET value = '15' WHERE key = 'default_scan_interval'").run();
    insertSubnet();

    expect(getNextScanTime()).toEqual(expect.any(String));
  });

  it('returns a future scheduler check time when no scan has completed yet', () => {
    db.prepare("UPDATE settings SET value = '15m' WHERE key = 'default_scan_interval'").run();
    insertSubnet();

    expectNearFuture(getNextScanTime());
  });

  it('returns a future scheduler check time when the completed scan is overdue', () => {
    db.prepare("UPDATE settings SET value = '5m' WHERE key = 'default_scan_interval'").run();
    const subnetId = insertSubnet();
    const completedAt = sqliteUtc(new Date(Date.now() - 10 * 60 * 1000));
    db.prepare(`
      INSERT INTO network_scans (subnet_id, status, completed_at)
      VALUES (?, 'completed', ?)
    `).run(subnetId, completedAt);

    expectNearFuture(getNextScanTime());
  });

  it('uses an active scan to calculate the next future scan time', () => {
    db.prepare("UPDATE settings SET value = '15m' WHERE key = 'default_scan_interval'").run();
    const subnetId = insertSubnet();
    const startedAt = sqliteUtc(new Date(Date.now() - 2 * 60 * 1000));
    db.prepare(`
      INSERT INTO network_scans (subnet_id, status, started_at)
      VALUES (?, 'running', ?)
    `).run(subnetId, startedAt);

    const delta = new Date(getNextScanTime()).getTime() - Date.now();
    expect(delta).toBeGreaterThan(12 * 60 * 1000);
    expect(delta).toBeLessThanOrEqual(13 * 60 * 1000);
  });

  it('keeps the next scan time in the future when an active scan has exceeded its interval', () => {
    db.prepare("UPDATE settings SET value = '5m' WHERE key = 'default_scan_interval'").run();
    const subnetId = insertSubnet();
    const startedAt = sqliteUtc(new Date(Date.now() - 10 * 60 * 1000));
    db.prepare(`
      INSERT INTO network_scans (subnet_id, status, started_at)
      VALUES (?, 'running', ?)
    `).run(subnetId, startedAt);

    expectNearFuture(getNextScanTime());
  });

  it('treats boolean-string default_scan_enabled as enabled', () => {
    db.prepare("UPDATE settings SET value = '15m' WHERE key = 'default_scan_interval'").run();
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'default_scan_enabled'").run();
    insertSubnet();

    expect(getNextScanTime()).toEqual(expect.any(String));
  });

  it('does not schedule when default scanning is disabled', () => {
    db.prepare("UPDATE settings SET value = '15m' WHERE key = 'default_scan_interval'").run();
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'default_scan_enabled'").run();
    insertSubnet();

    expect(getNextScanTime()).toBeNull();
  });

  it('includes the largest subnet allowed by manual scans', () => {
    db.prepare("UPDATE settings SET value = '15m' WHERE key = 'default_scan_interval'").run();
    insertSubnet({
      cidr: '10.0.0.0/20',
      network: '10.0.0.0',
      broadcast: '10.0.15.255',
      prefix: 20,
      total: 4096,
    });

    expect(getNextScanTime()).toEqual(expect.any(String));
  });

  it('excludes subnets larger than the manual scan limit', () => {
    db.prepare("UPDATE settings SET value = '15m' WHERE key = 'default_scan_interval'").run();
    insertSubnet({
      cidr: '10.0.0.0/19',
      network: '10.0.0.0',
      broadcast: '10.0.31.255',
      prefix: 19,
      total: 8192,
    });

    expect(getNextScanTime()).toBeNull();
  });
});
