/**
 * Migration 074 decides whether an existing database has already been set
 * up. Anything that shows the appliance was used marks setup done: a
 * network, a user who changed their password, or the classic network wizard's
 * flag. A database with only a freshly seeded admin (must_change_password = 1)
 * is a first run and stays unmarked.
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
  .filter((name) => name.endsWith('.sql'))
  .sort();
const versionOf = (file) => Number.parseInt(file.split('_')[0], 10);
const sqlOf = (version) =>
  fs.readFileSync(
    path.join(
      migrationsDir,
      files.find((f) => versionOf(f) === version),
    ),
    'utf8',
  );

function databaseThrough(targetVersion) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-test-setup-state-'));
  tmpDirs.push(tmpDir);
  const db = new Database(path.join(tmpDir, 'cidrella.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  for (const file of files) {
    const version = versionOf(file);
    if (version > targetVersion) continue;
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  }
  return db;
}

const stateOf = (db) =>
  db.prepare("SELECT value FROM settings WHERE key = 'setup_state'").get()?.value ?? null;

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('migration 074: setup_state for existing databases', () => {
  it('leaves a fresh database unmarked', () => {
    const db = databaseThrough(73);
    db.exec(sqlOf(74));
    expect(stateOf(db)).toBeNull();
  });

  it('leaves a database with only the seeded admin unmarked', () => {
    const db = databaseThrough(73);
    db.prepare(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('admin', 'x', 'admin', 1)",
    ).run();
    db.exec(sqlOf(74));
    expect(stateOf(db)).toBeNull();
  });

  it('marks a database with a network as done', () => {
    const db = databaseThrough(73);
    db.prepare(
      `INSERT INTO subnets (cidr, name, network_address, broadcast_address, prefix_length,
        total_addresses, status, depth) VALUES ('10.9.0.0/24', 'lan', '10.9.0.0', '10.9.0.255',
        24, 256, 'allocated', 0)`,
    ).run();
    db.exec(sqlOf(74));
    expect(JSON.parse(stateOf(db))).toMatchObject({ done: true, source: 'upgrade' });
  });

  it('marks a database whose admin has changed their password as done', () => {
    const db = databaseThrough(73);
    db.prepare(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('admin', 'x', 'admin', 0)",
    ).run();
    db.exec(sqlOf(74));
    expect(JSON.parse(stateOf(db)).done).toBe(true);
  });

  it('marks a database that finished the classic network wizard as done', () => {
    const db = databaseThrough(73);
    db.prepare("INSERT INTO settings (key, value) VALUES ('setup_wizard_completed', '1')").run();
    db.exec(sqlOf(74));
    expect(JSON.parse(stateOf(db)).done).toBe(true);
  });

  it('never overwrites a state that already exists', () => {
    const db = databaseThrough(73);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('setup_state', '{\"done\":false}')",
    ).run();
    db.prepare(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('admin', 'x', 'admin', 0)",
    ).run();
    db.exec(sqlOf(74));
    expect(stateOf(db)).toBe('{"done":false}');
  });
});
