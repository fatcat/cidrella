import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const MIGRATIONS = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));

/** The newest migration number: the schema version a fully upgraded database reports. */
export const LATEST_MIGRATION = Math.max(
  ...fs
    .readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => Number.parseInt(name, 10)),
);

/**
 * A database with the migrations up to and including `target` applied, the
 * way initDb applies them, for a test of the next one. Returns { db, dbPath,
 * tmpDir, migrate(version), migrateThrough(last) }; migrate applies one more,
 * migrateThrough every one after the newest applied up to `last` (all by
 * default). Remove tmpDir when done.
 */
export function databaseThrough(target, { tmpDirs } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-test-migration-'));
  // A test that cleans up a list of directories passes it to have tmpDir added.
  tmpDirs?.push(tmpDir);
  const dbPath = path.join(tmpDir, 'cidrella.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(
    "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const migrate = (version) => {
    const file = files.find((name) => Number.parseInt(name, 10) === version);
    if (!file) throw new Error(`No migration ${version}`);
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    })();
  };
  const migrateThrough = (last = Infinity) => {
    const newest = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v ?? 0;
    for (const file of files) {
      const version = Number.parseInt(file, 10);
      if (version > newest && version <= last) migrate(version);
    }
  };
  migrateThrough(target);
  return { db, dbPath, tmpDir, migrate, migrateThrough };
}
