/**
 * Migration 077: anomaly_scores gains threat_score, the sidecar's 0..1 rule
 * score. Rows scored before the column existed stay NULL; nothing backfills.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { databaseThrough } from '../helpers/migrations.js';

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('migration 077', () => {
  it('adds threat_score and leaves rows scored earlier at NULL', () => {
    const { db, migrate } = databaseThrough(76, { tmpDirs });
    db.prepare(
      `INSERT INTO anomaly_scores (client_ip, identity, window_start, window_end, anomaly_score, is_anomaly)
       VALUES ('10.0.0.5', '10.0.0.5', '2026-09-19T02:00:00+00:00', '2026-09-19T03:00:00+00:00', -0.3, 1)`,
    ).run();
    migrate(77);

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
