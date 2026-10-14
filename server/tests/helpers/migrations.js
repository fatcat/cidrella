import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const MIGRATIONS = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));

/**
 * A database with the migrations up to and including `target` applied, the
 * way initDb applies them, for a test of the next one. Returns { db, tmpDir,
 * migrate(version) }; migrate applies one more. Remove tmpDir when done.
 */
export function databaseThrough(target) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-test-migration-'));
  const db = new Database(path.join(tmpDir, 'cidrella.db'));
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
  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (version <= target) migrate(version);
  }
  return { db, tmpDir, migrate };
}
