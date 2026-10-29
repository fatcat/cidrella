/**
 * A backup never stops the event loop: the DNS proxy answers on it. The
 * database copy runs in the database worker and tar as a child process, so a
 * timer keeps firing while a backup of a large database runs
 * (BACKUP-STALL-01). Two backups, or a backup and a restore, never overlap.
 */
// First: the modules below read DATA_DIR when they load.
import { DATA_DIR } from '../helpers/isolated-data-dir.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb } from '../helpers/test-db.js';
import { getDb, initDb } from '../../src/db/init.js';
import { createBackup, backupOperationRunning, restoreBackup } from '../../src/utils/backup.js';

let db;

beforeAll(async () => {
  await initDb(DATA_DIR);
  db = getDb();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // Enough rows that a copy on the main thread would hold the loop for
  // well over the limit below.
  const insert = db.prepare('INSERT INTO audit_log (action, entity_type, details) VALUES (?, ?, ?)');
  const filler = 'x'.repeat(400);
  db.transaction(() => {
    for (let i = 0; i < 300_000; i++) insert.run('event_loop_test', 'test', filler);
  })();
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  cleanupTestDb(DATA_DIR);
});

describe('createBackup', () => {
  it('keeps the event loop turning while it runs', async () => {
    let last = performance.now();
    let worst = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 20);
    try {
      const backup = await createBackup(db);
      expect(backup.filename).toMatch(/^cidrella-backup-/);
    } finally {
      clearInterval(timer);
    }
    expect(worst).toBeLessThan(200);
  }, 120_000);

  it('refuses a second backup or a restore while one runs', async () => {
    const first = createBackup(db);
    expect(backupOperationRunning()).toBe('backup');
    await expect(createBackup(db)).rejects.toMatchObject({ code: 'BACKUP_IN_PROGRESS' });
    await expect(restoreBackup('/nonexistent.tar.gz')).rejects.toMatchObject({
      code: 'BACKUP_IN_PROGRESS',
    });
    await first;
    expect(backupOperationRunning()).toBe(null);
  }, 120_000);
});
