/**
 * Audit rows for actions that change nothing anyone edits but are worth
 * knowing: a backup copied off the appliance, a scan's results deleted.
 */
// First: backup.js builds its paths from DATA_DIR when it loads.
import '../../helpers/isolated-data-dir.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createMultiRouterApp } from '../../helpers/test-app.js';

const { default: request } = await import('supertest');

let tmpDir;
let db;
let app;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  const { default: operationsRouter } = await import('../../../src/routes/operations.js');
  const { default: scanRouter } = await import('../../../src/routes/scans.js');
  app = createMultiRouterApp([
    { prefix: '/api/operations', router: operationsRouter },
    { prefix: '/api/scans', router: scanRouter },
  ]);
});
afterAll(() => cleanupTestDb(tmpDir));

const lastRow = (action) => {
  const row = db
    .prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1')
    .get(action);
  return row && { ...row, details: JSON.parse(row.details) };
};

describe('a backup download', () => {
  it('names who took a copy, and of what', async () => {
    const made = await request(app).post('/api/operations/backup');
    expect(made.status).toBe(201);
    const res = await request(app).get(`/api/operations/backups/${made.body.id}/download`);
    expect(res.status).toBe(200);
    expect(lastRow('backup_downloaded')).toMatchObject({
      actor: 'testadmin',
      entity_id: made.body.id,
      details: { filename: made.body.filename, bytes: made.body.size_bytes },
    });
  });
});

describe('a scan deleted', () => {
  it('records the scan and its network', async () => {
    const subnetId = db
      .prepare(
        `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
           total_addresses, status)
         VALUES ('10.77.0.0/24', 'scan', '10.77.0.0', '10.77.0.255', 24, 256, 'allocated')`,
      )
      .run().lastInsertRowid;
    const scanId = db
      .prepare("INSERT INTO network_scans (subnet_id, status) VALUES (?, 'completed')")
      .run(subnetId).lastInsertRowid;
    expect((await request(app).delete(`/api/scans/${scanId}`)).status).toBe(200);
    expect(lastRow('scan_deleted')).toMatchObject({
      entity_id: scanId,
      details: { subnet_id: subnetId },
    });
  });
});
