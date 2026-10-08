/**
 * Migration 077: anomaly_scores gains threat_score, the sidecar's 0..1 rule
 * score. Rows scored before the column existed stay NULL; nothing backfills.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const migrationsDir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const tmpDirs = [];
const files = fs
  .readdirSync(migrationsDir)
  .filter((n) => n.endsWith('.sql'))
  .sort();
const versionOf = (f) => Number.parseInt(f.split('_')[0], 10);

function databaseThrough(target) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-test-threat-'));
  tmpDirs.push(tmpDir);
  const db = new Database(path.join(tmpDir, 'cidrella.db'));
  db.pragma('foreign_keys = ON');
  db.exec(
    "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  for (const f of files) {
    if (versionOf(f) > target) continue;
    db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(versionOf(f));
  }
  return db;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('migration 077', () => {
  it('adds threat_score and leaves rows scored earlier at NULL', () => {
    const db = databaseThrough(76);
    db.prepare(
      `INSERT INTO anomaly_scores (client_ip, identity, window_start, window_end, anomaly_score, is_anomaly)
       VALUES ('10.0.0.5', '10.0.0.5', '2026-09-19T02:00:00+00:00', '2026-09-19T03:00:00+00:00', -0.3, 1)`,
    ).run();
    db.exec(
      fs.readFileSync(
        path.join(
          migrationsDir,
          files.find((f) => versionOf(f) === 77),
        ),
        'utf8',
      ),
    );

    const cols = db
      .prepare('PRAGMA table_info(anomaly_scores)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('threat_score');
    expect(db.prepare('SELECT threat_score FROM anomaly_scores').get().threat_score).toBeNull();
    db.prepare(`UPDATE anomaly_scores SET threat_score = 0.73`).run();
    expect(db.prepare('SELECT threat_score FROM anomaly_scores').get().threat_score).toBe(0.73);
  });
});
