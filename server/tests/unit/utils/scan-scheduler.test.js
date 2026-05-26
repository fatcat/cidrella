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
  db.prepare(`
    INSERT INTO subnets (
      cidr, name, network_address, broadcast_address, prefix_length,
      total_addresses, status, scan_enabled, scan_interval
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cidr, cidr, network, broadcast, prefix, total, status, scanEnabled, scanInterval);
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
