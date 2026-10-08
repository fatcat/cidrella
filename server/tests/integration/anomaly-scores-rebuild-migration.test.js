/**
 * Migration 081 (ANOM-01): anomaly_scores loses the UNIQUE(client_ip,
 * window_start) an early sidecar created it with, so one client scored under
 * its MAC and then under its IP in the same window keeps both scores. Every
 * install is rebuilt, whoever created the table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from '../../src/db/init.js';

const migrationsDir = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const tmpDirs = [];

function databaseThrough(maxVersion) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-anomaly-scores-'));
  tmpDirs.push(tmpDir);
  const db = new Database(path.join(tmpDir, 'cidrella.db'));
  db.exec(`CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  for (const file of fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const version = Number.parseInt(file.split('_')[0], 10);
    if (version > maxVersion) continue;
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  }
  return { db, tmpDir };
}

async function upgrade(db, tmpDir) {
  db.close();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return await initDb(tmpDir);
  } finally {
    log.mockRestore();
  }
}

// The table as the early sidecar created it, which is what production has.
function useSidecarTable(db) {
  db.exec(`
    DROP TABLE anomaly_scores;
    CREATE TABLE anomaly_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_ip TEXT NOT NULL,
      scored_at TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      anomaly_score REAL NOT NULL,
      is_anomaly INTEGER NOT NULL DEFAULT 0,
      severity TEXT,
      top_features TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT, identity TEXT, threat_score REAL,
      UNIQUE(client_ip, window_start)
    );
    CREATE INDEX idx_anomaly_scores_client ON anomaly_scores(client_ip, window_start);
    CREATE UNIQUE INDEX idx_anomaly_scores_identity_window
      ON anomaly_scores(identity, window_start);
  `);
}

const WINDOW = '2026-10-06T07:00:00+00:00';
const END = '2026-10-06T08:00:00+00:00';

function score(db, { id, ip, identity, anomaly = 0, resolved = 0, threat = null }) {
  db.prepare(
    `INSERT INTO anomaly_scores (id, client_ip, identity, scored_at, window_start, window_end,
       anomaly_score, is_anomaly, severity, top_features, resolved, resolved_at, threat_score)
     VALUES (?, ?, ?, '2026-10-06T07:40:44+00:00', ?, ?, -0.05, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id ?? null,
    ip,
    identity,
    WINDOW,
    END,
    anomaly,
    anomaly ? 'low' : null,
    anomaly ? '[{"feature":"query_count"}]' : null,
    resolved,
    resolved ? '2026-10-06T09:00:00Z' : null,
    threat,
  );
}

const rows = (db) =>
  db
    .prepare(
      `SELECT id, client_ip, identity, scored_at, window_start, window_end, anomaly_score,
         is_anomaly, severity, top_features, resolved, resolved_at, threat_score
       FROM anomaly_scores ORDER BY id`,
    )
    .all();
const indexes = (db) =>
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'anomaly_scores' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('migration 081', () => {
  for (const [name, prepare] of [
    ['a table the sidecar created', useSidecarTable],
    ['a table migration 042 created', () => {}],
  ]) {
    it(`keeps every row and lets one client score under two keys in a window: ${name}`, async () => {
      const { db, tmpDir } = databaseThrough(80);
      prepare(db);
      // IPv4 and IPv6 clients, an open anomaly and a resolved one.
      score(db, { id: 7, ip: '10.0.0.191', identity: 'c8:e0:eb:16:e1:0d', anomaly: 1 });
      score(db, { id: 9, ip: 'fd00:a::191', identity: 'fd00:a::191', resolved: 1, threat: 0.4 });
      // A newer score the retention has since pruned: its id is never reused.
      score(db, { id: 12, ip: '10.0.0.5', identity: '10.0.0.5' });
      db.prepare('DELETE FROM anomaly_scores WHERE id = 12').run();
      const before = rows(db);

      const upgraded = await upgrade(db, tmpDir);

      expect(rows(upgraded)).toEqual(before);
      expect(indexes(upgraded)).toEqual([
        'idx_anomaly_scores_active',
        'idx_anomaly_scores_client',
        'idx_anomaly_scores_identity_window',
      ]);
      // The lease lapsed: the same IP, the same window, now keyed by the IP.
      score(upgraded, { ip: '10.0.0.191', identity: '10.0.0.191' });
      score(upgraded, { ip: 'fd00:a::191', identity: '00:03:00:01:aa:bb:cc:00:01:91' });
      expect(rows(upgraded).map((row) => [row.id, row.identity])).toEqual([
        [7, 'c8:e0:eb:16:e1:0d'],
        [9, 'fd00:a::191'],
        [13, '10.0.0.191'],
        [14, '00:03:00:01:aa:bb:cc:00:01:91'],
      ]);
      // A device still has one score per window.
      expect(() => score(upgraded, { ip: '10.0.0.192', identity: '10.0.0.191' })).toThrow(
        /UNIQUE constraint failed: anomaly_scores.identity, anomaly_scores.window_start/,
      );
      upgraded.close();
    });
  }
});
