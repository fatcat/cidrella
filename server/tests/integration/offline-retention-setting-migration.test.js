/**
 * Migration 094 (SETTING-RETENTION-01): the retired
 * offline_metadata_retention_days row goes, and every other setting stays.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { databaseThrough } from '../helpers/migrations.js';

const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const setting = (db, key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key);

describe('migration 094: offline_metadata_retention_days', () => {
  it('deletes the retired row and keeps the rest', () => {
    const { db, migrate } = databaseThrough(93, { tmpDirs });
    const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    upsert.run('offline_metadata_retention_days', '7');
    upsert.run('dns_listen_port', '53');

    migrate(94);

    expect(setting(db, 'offline_metadata_retention_days')).toBeUndefined();
    expect(setting(db, 'dns_listen_port')).toEqual({ value: '53' });
  });

  it('runs on an install that never had the row', () => {
    const { db, migrate } = databaseThrough(93, { tmpDirs });
    expect(() => migrate(94)).not.toThrow();
    expect(setting(db, 'offline_metadata_retention_days')).toBeUndefined();
  });
});
