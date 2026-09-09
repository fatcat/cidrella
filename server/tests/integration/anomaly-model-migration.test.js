import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from '../../src/db/init.js';

const migrationsDir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const tmpDirs = [];

function createDatabaseThrough(maxVersion) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-anomaly-migration-'));
  tmpDirs.push(tmpDir);
  const db = new Database(path.join(tmpDir, 'cidrella.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const apply = db.transaction((sql, version) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  });
  for (const file of fs.readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort()) {
    const version = Number.parseInt(file.split('_')[0], 10);
    if (version > maxVersion) continue;
    apply(fs.readFileSync(path.join(migrationsDir, file), 'utf8'), version);
  }
  return { db, tmpDir };
}

async function finishUpgrade(db, tmpDir) {
  db.close();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return await initDb(tmpDir);
  } finally {
    log.mockRestore();
  }
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('anomaly model identity migration compatibility', () => {
  it('upgrades the historical sidecar schema and preserves model versions', async () => {
    const { db: legacyDb, tmpDir } = createDatabaseThrough(59);
    legacyDb.exec(`
      DROP TABLE anomaly_models;
      CREATE TABLE anomaly_models (
        client_ip TEXT PRIMARY KEY,
        trained_at TEXT NOT NULL,
        training_rows INTEGER NOT NULL,
        model_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'learning'
      );
      INSERT INTO anomaly_models
        (client_ip, trained_at, training_rows, model_version, status)
      VALUES
        ('10.0.0.80', '2026-09-01T12:00:00Z', 480, 336, 'active'),
        ('10.0.0.81', '2026-09-02T12:00:00Z', 24, 7, 'learning');
    `);

    const upgraded = await finishUpgrade(legacyDb, tmpDir);

    expect(upgraded.prepare('SELECT MAX(version) AS version FROM schema_version').get().version)
      .toBe(63);
    expect(upgraded.prepare(`
      SELECT identity, client_ip, trained_at, training_rows, model_version, status
      FROM anomaly_models ORDER BY client_ip
    `).all()).toEqual([
      {
        identity: '10.0.0.80',
        client_ip: '10.0.0.80',
        trained_at: '2026-09-01T12:00:00Z',
        training_rows: 480,
        model_version: 336,
        status: 'active'
      },
      {
        identity: '10.0.0.81',
        client_ip: '10.0.0.81',
        trained_at: '2026-09-02T12:00:00Z',
        training_rows: 24,
        model_version: 7,
        status: 'learning'
      }
    ]);
    expect(upgraded.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = '_migration_060_anomaly_model_versions'
    `).get()).toBeUndefined();
    expect(upgraded.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    upgraded.close();
  });

  it('repairs databases where the published migration 060 already completed', async () => {
    const { db: pre4Db, tmpDir } = createDatabaseThrough(61);
    pre4Db.prepare(`
      INSERT INTO anomaly_models
        (identity, client_ip, status, training_rows, trained_at, model_path)
      VALUES (?, ?, 'active', 120, '2026-09-03T12:00:00Z', NULL)
    `).run('10.0.0.90', '10.0.0.90');

    const upgraded = await finishUpgrade(pre4Db, tmpDir);

    expect(upgraded.prepare('SELECT MAX(version) AS version FROM schema_version').get().version)
      .toBe(63);
    expect(upgraded.prepare(`
      SELECT model_version FROM anomaly_models WHERE identity = '10.0.0.90'
    `).get()).toEqual({ model_version: 1 });
    expect(upgraded.pragma('table_info(anomaly_models)').map(column => column.name))
      .toContain('model_version');
    expect(upgraded.pragma('integrity_check', { simple: true })).toBe('ok');
    upgraded.close();
  });
});
