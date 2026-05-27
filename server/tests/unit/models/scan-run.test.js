import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import * as ScanRun from '../../../src/models/scan-run.js';

let db;
let tmpDir;
let subnetId;

beforeAll(async () => {
  const setup = await setupTestDb();
  db = setup.db;
  tmpDir = setup.tmpDir;
  db.prepare("INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length, total_addresses, status) VALUES ('10.0.1.0/24', 'Test', '10.0.1.0', '10.0.1.255', 24, 256, 'allocated')").run();
  subnetId = db.prepare("SELECT id FROM subnets WHERE cidr = '10.0.1.0/24'").get().id;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  db.prepare('DELETE FROM scan_results').run();
  db.prepare('DELETE FROM network_scans').run();
});

describe('scan run ownership', () => {
  it('creates one pending scan when idle', () => {
    const first = ScanRun.createPendingIfIdle(db, subnetId);
    const second = ScanRun.createPendingIfIdle(db, subnetId);

    expect(first.created).toBe(true);
    expect(first.scanId).toBeGreaterThan(0);
    expect(second).toEqual({ created: false, scanId: first.scanId });
  });

  it('tracks progress and completion', () => {
    const scanId = ScanRun.createPending(db, subnetId);

    ScanRun.markRunning(db, scanId, 2);
    ScanRun.insertResult(db, scanId, {
      ip: '10.0.1.10',
      mac: 'aa:bb:cc:dd:ee:ff',
      responded: true,
      isConflict: false
    });
    ScanRun.updateProgress(db, scanId, { scannedIps: 1, conflictsFound: 0 });
    ScanRun.markCompleted(db, scanId, { scannedIps: 1, conflictsFound: 0 });

    const scan = ScanRun.findById(db, scanId);
    const result = ScanRun.getResultForIp(db, scanId, '10.0.1.10');

    expect(scan.status).toBe('completed');
    expect(scan.scanned_ips).toBe(1);
    expect(result.responded).toBe(1);
    expect(result.mac_address).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('does not delete running scans', () => {
    const scanId = ScanRun.createPending(db, subnetId);
    ScanRun.markRunning(db, scanId, 1);

    const result = ScanRun.deleteIfNotRunning(db, scanId);
    const scan = ScanRun.findById(db, scanId);

    expect(result.running).toBe(true);
    expect(scan).toBeTruthy();
  });

  it('deletes old scan results for completed scans in the same subnet', () => {
    const oldScanId = ScanRun.createPending(db, subnetId);
    ScanRun.markCompleted(db, oldScanId, { scannedIps: 1, conflictsFound: 0 });
    const newScanId = ScanRun.createPending(db, subnetId);
    ScanRun.markCompleted(db, newScanId, { scannedIps: 1, conflictsFound: 0 });

    ScanRun.insertResult(db, oldScanId, { ip: '10.0.1.10', responded: true });
    ScanRun.insertResult(db, newScanId, { ip: '10.0.1.10', responded: true });
    ScanRun.pruneOldResults(db, subnetId, newScanId);

    expect(ScanRun.getResults(db, oldScanId)).toHaveLength(0);
    expect(ScanRun.getResults(db, newScanId)).toHaveLength(1);
  });
});
