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
  db.prepare(
    "INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length, total_addresses, status) VALUES ('10.0.1.0/24', 'Test', '10.0.1.0', '10.0.1.255', 24, 256, 'allocated')",
  ).run();
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
      isConflict: false,
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

  it('invalidates a scan when its operating-network topology changes', () => {
    const scanId = ScanRun.createPending(db, subnetId);
    expect(ScanRun.targetIsCurrent(db, scanId)).toBe(true);
    db.prepare(
      `
      UPDATE subnets SET topology_revision = topology_revision + 1 WHERE id = ?
    `,
    ).run(subnetId);
    expect(ScanRun.targetIsCurrent(db, scanId)).toBe(false);

    const replacement = ScanRun.createPending(db, subnetId);
    expect(ScanRun.targetIsCurrent(db, replacement)).toBe(true);
    db.prepare("UPDATE subnets SET status = 'unallocated' WHERE id = ?").run(subnetId);
    expect(ScanRun.targetIsCurrent(db, replacement)).toBe(false);
    expect(() => ScanRun.createPending(db, subnetId)).toThrow(/allocated subnet/);
    db.prepare("UPDATE subnets SET status = 'allocated' WHERE id = ?").run(subnetId);
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

  it('keeps the newest finished scans per network and never a running one', () => {
    const v6 = db
      .prepare(
        `INSERT INTO subnets (cidr, name, network_address, last_address, prefix_length,
           address_family, status)
         VALUES ('fd00:5c::/120', 'Scan6', 'fd00:5c::', 'fd00:5c::ff', 120, 6, 'allocated')`,
      )
      .run().lastInsertRowid;
    const finished = (subnet, n) => {
      const ids = [];
      for (let i = 0; i < n; i++) {
        const id = ScanRun.createPending(db, subnet);
        if (i % 2) ScanRun.markFailed(db, id, 'probe error');
        else ScanRun.markCompleted(db, id, { scannedIps: 1, conflictsFound: 0 });
        ids.push(id);
      }
      return ids;
    };
    const v4Ids = finished(subnetId, 5);
    const v6Ids = finished(v6, 5);
    const running = ScanRun.createPending(db, subnetId);
    ScanRun.markRunning(db, running, 1);
    ScanRun.insertResult(db, v4Ids[0], { ip: '10.0.1.10', responded: true });

    ScanRun.pruneOldScans(db, subnetId, 3);
    ScanRun.pruneOldScans(db, v6, 3);

    const ids = (subnet) =>
      db
        .prepare('SELECT id FROM network_scans WHERE subnet_id = ? ORDER BY id')
        .all(subnet)
        .map((row) => row.id);
    expect(ids(subnetId)).toEqual([...v4Ids.slice(2), running]);
    expect(ids(v6)).toEqual(v6Ids.slice(2));
    expect(ScanRun.getResults(db, v4Ids[0])).toHaveLength(0);
  });
});
