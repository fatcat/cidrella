/**
 * The database worker (utils/db-worker): slow SQL on a thread of its own, with
 * its own read-only connection. Its answers must match the main thread's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { setupTestDb, cleanupTestDb } from '../helpers/test-db.js';
import { runDbTask } from '../../src/utils/db-worker/index.js';
import { countEnabledBlocklistDomains } from '../../src/models/blocklist-store.js';

let db;
let tmpDir;

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  const category = db.prepare(
    'INSERT OR REPLACE INTO blocklist_categories (slug, enabled) VALUES (?, ?)',
  );
  category.run('worker-ads', 1);
  category.run('worker-trackers', 1);
  category.run('worker-off', 0);
  const domain = db.prepare('INSERT INTO blocklist_domains (domain, category_slug) VALUES (?, ?)');
  db.transaction(() => {
    for (let i = 0; i < 300; i++) domain.run(`ad-${i}.worker.test`, 'worker-ads');
    // A domain in two enabled categories counts once.
    for (let i = 0; i < 50; i++) domain.run(`ad-${i}.worker.test`, 'worker-trackers');
    for (let i = 0; i < 40; i++) domain.run(`off-${i}.worker.test`, 'worker-off');
  })();
});

afterAll(() => cleanupTestDb(tmpDir));

describe('runDbTask', () => {
  it('counts the enabled blocklist domains as the main thread does', async () => {
    const count = await runDbTask('blocklistDomainCount', { dbPath: db.name });
    expect(count).toBe(countEnabledBlocklistDomains(db));
    expect(count).toBeGreaterThanOrEqual(300);
  });

  it('writes a backup copy that is whole and carries no feed domains', async () => {
    const copyPath = path.join(fs.mkdtempSync(path.join(tmpDir, 'copy-')), 'cidrella.db');
    // A write still in the WAL is in the copy: VACUUM INTO reads it.
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('worker_probe', 'in-wal')").run();
    await runDbTask('backupCopy', { dbPath: db.name, copyPath });
    const copy = new Database(copyPath, { readonly: true });
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(copy.prepare('SELECT COUNT(*) AS n FROM blocklist_domains').get().n).toBe(0);
      expect(
        copy.prepare("SELECT value FROM settings WHERE key = 'worker_probe'").get()?.value,
      ).toBe('in-wal');
      expect(copy.prepare("SELECT enabled FROM blocklist_categories WHERE slug = 'worker-ads'").get())
        .toEqual({ enabled: 1 });
    } finally {
      copy.close();
    }
    // The live database is untouched.
    expect(db.prepare('SELECT COUNT(*) AS n FROM blocklist_domains').get().n).toBe(390);
  });

  it('rejects an unknown task and a database that is not there', async () => {
    await expect(runDbTask('dropEverything', { dbPath: db.name })).rejects.toThrow(
      'Unknown database task: dropEverything',
    );
    await expect(
      runDbTask('blocklistDomainCount', { dbPath: path.join(tmpDir, 'missing.db') }),
    ).rejects.toThrow();
  });

  it('gives up on a task past its timeout', async () => {
    await expect(
      runDbTask('blocklistDomainCount', { dbPath: db.name, timeout: 1 }),
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });
});
