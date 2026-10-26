/**
 * Migration 078: blocklist_whitelist and anomaly_whitelist become
 * blocklist_allowlist and anomaly_allowlist, and whitelisted_at becomes
 * allowlisted_at. Rows survive the rename with their values intact.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { databaseThrough } from '../helpers/migrations.js';

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

const tables = (db) =>
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%\\_whitelist' ESCAPE '\\' OR name LIKE '%\\_allowlist' ESCAPE '\\')",
    )
    .all()
    .map((row) => row.name)
    .sort();

describe('migration 078', () => {
  it('renames both lists and keeps their rows', () => {
    const { db, migrate } = databaseThrough(77, { tmpDirs });
    db.prepare(
      "INSERT INTO blocklist_whitelist (domain, reason) VALUES ('ok.example', 'lab')",
    ).run();
    db.prepare(
      `INSERT INTO anomaly_whitelist (identity, client_ip, reason, whitelisted_at)
       VALUES ('aa:bb:cc:dd:ee:ff', '10.0.0.9', 'printer', '2026-09-01T00:00:00Z')`,
    ).run();
    // geoip_ip_allowlist was named that way from the start (migration 050).
    expect(tables(db)).toEqual(['anomaly_whitelist', 'blocklist_whitelist', 'geoip_ip_allowlist']);

    migrate(78);

    expect(tables(db)).toEqual(['anomaly_allowlist', 'blocklist_allowlist', 'geoip_ip_allowlist']);
    expect(db.prepare('SELECT domain, reason FROM blocklist_allowlist').all()).toEqual([
      { domain: 'ok.example', reason: 'lab' },
    ]);
    expect(
      db.prepare('SELECT identity, client_ip, reason, allowlisted_at FROM anomaly_allowlist').all(),
    ).toEqual([
      {
        identity: 'aa:bb:cc:dd:ee:ff',
        client_ip: '10.0.0.9',
        reason: 'printer',
        allowlisted_at: '2026-09-01T00:00:00Z',
      },
    ]);
    const columns = db
      .prepare('PRAGMA table_info(anomaly_allowlist)')
      .all()
      .map((c) => c.name);
    expect(columns).not.toContain('whitelisted_at');
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'anomaly_allowlist'",
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toContain('idx_anomaly_allowlist_identity');
    expect(indexes).not.toContain('idx_anomaly_whitelist_identity');
  });
});
