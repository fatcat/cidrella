/**
 * An update on a member. Its database refuses every write to the data of
 * record (the guard triggers), and a later release's migration is exactly
 * such a write: it updates rows, drops a column, rebuilds a table. Boot
 * runs the pending migrations with the guards off (db/init.js), puts them
 * back, and forgets the cursor, since nobody checked the migrated copy
 * against the controller's: the next sync is a snapshot.
 *
 * The migration here is not a real one. It is handed to initDb as a file in
 * the migrations directory would be, so it takes the same path.
 */
// First: the modules below read DATA_DIR when they load.
import { DATA_DIR } from '../helpers/isolated-data-dir.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { cleanupTestDb } from '../helpers/test-db.js';
import { databaseThrough, LATEST_MIGRATION } from '../helpers/migrations.js';
import { makeMember } from '../helpers/member-mode.js';
import { getDb, initDb } from '../../src/db/init.js';
import {
  ensureSyncLog,
  GUARD_MESSAGE,
  MEMBER,
  readSyncState,
  storedMode,
  syncStatus,
  writeSyncState,
} from '../../src/sync/log.js';
import { controllerOf } from '../../src/sync/mode.js';

const NEXT = LATEST_MIGRATION + 1;
const NEXT_FILE = `${String(NEXT).padStart(3, '0')}_a_later_release.sql`;
// What a later release might do to the data of record: change rows, add a
// column to an estate table, and rebuild another (create, copy, drop, rename).
const NEXT_SQL = `
UPDATE folders SET name = name || ' (migrated)';
ALTER TABLE folders ADD COLUMN later_note TEXT;
UPDATE folders SET later_note = 'set by the migration';
CREATE TABLE sync_instances_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 443,
  fingerprint TEXT NOT NULL,
  credential_hash TEXT,
  is_controller INTEGER NOT NULL DEFAULT 0,
  serves_dns INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_contact_at TEXT,
  cursor INTEGER,
  version TEXT,
  schema_version INTEGER,
  dns_addresses TEXT NOT NULL DEFAULT '[]',
  rebuilt INTEGER NOT NULL DEFAULT 1
);
INSERT INTO sync_instances_new
  (id, instance_id, name, address, port, fingerprint, credential_hash, is_controller,
   serves_dns, created_at, last_contact_at, cursor, version, schema_version, dns_addresses)
  SELECT id, instance_id, name, address, port, fingerprint, credential_hash, is_controller,
   serves_dns, created_at, last_contact_at, cursor, version, schema_version, dns_addresses
  FROM sync_instances;
DROP TABLE sync_instances;
ALTER TABLE sync_instances_new RENAME TO sync_instances;
`;

const dataDir = DATA_DIR;
const tmpDirs = [];
let controller;

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
  try {
    getDb().close();
  } catch {
    /* never opened */
  }
  cleanupTestDb(dataDir);
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const guards = (db) =>
  db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_guard_%'",
    )
    .get().n;
const logTriggers = (db) =>
  db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_log_%'",
    )
    .get().n;

/** A member that has followed its controller, as its database sits on disk. */
function memberOnDisk() {
  const built = databaseThrough(LATEST_MIGRATION, { tmpDirs });
  built.db.prepare("INSERT INTO folders (name) VALUES ('Branch'), ('Lab')").run();
  built.db
    .prepare(
      `INSERT INTO sync_instances (instance_id, name, fingerprint, is_controller)
       VALUES ('test-controller', 'ctl-1', ?, 1)`,
    )
    .run('ab'.repeat(32));
  controller = makeMember(built.db);
  writeSyncState(built.db, 'dataset', 'the-controllers-dataset');
  writeSyncState(built.db, 'epoch', 2);
  writeSyncState(built.db, 'schema', LATEST_MIGRATION);
  // Boot once as a member, so the guards and the incarnation are in place.
  ensureSyncLog(built.db, dataDir);
  writeSyncState(built.db, 'cursor', 4242);
  expect(ensureSyncLog(built.db, dataDir).started).toBeNull();
  expect(readSyncState(built.db, 'cursor')).toBe('4242');
  expect(guards(built.db)).toBeGreaterThan(0);
  expect(() => built.db.prepare("UPDATE folders SET name = 'x'").run()).toThrow(GUARD_MESSAGE);
  built.db.close();
  fs.copyFileSync(built.dbPath, path.join(dataDir, 'cidrella.db'));
}

/** Boot with one more migration in the directory than the release ships. */
async function bootWithLaterMigration() {
  const readdir = fs.readdirSync;
  const readFile = fs.readFileSync;
  const isMigrations = (dir) => String(dir).endsWith(`${path.sep}db${path.sep}migrations`);
  const list = vi.spyOn(fs, 'readdirSync').mockImplementation((dir, ...rest) => {
    const names = readdir(dir, ...rest);
    return isMigrations(dir) ? [...names, NEXT_FILE] : names;
  });
  const read = vi
    .spyOn(fs, 'readFileSync')
    .mockImplementation((file, ...rest) =>
      path.basename(String(file)) === NEXT_FILE ? NEXT_SQL : readFile(file, ...rest),
    );
  try {
    await initDb(dataDir);
  } finally {
    list.mockRestore();
    read.mockRestore();
  }
  return getDb();
}

describe('a member booting a release with a migration of the data of record', () => {
  let db;
  beforeAll(async () => {
    memberOnDisk();
    db = await bootWithLaterMigration();
  });

  it('runs the migration, guards or not', () => {
    expect(syncStatus(db).schema).toBe(NEXT);
    expect(db.prepare('SELECT name, later_note FROM folders ORDER BY name').all()).toEqual([
      { name: 'Branch (migrated)', later_note: 'set by the migration' },
      { name: 'Lab (migrated)', later_note: 'set by the migration' },
    ]);
    expect(db.prepare('SELECT name, rebuilt FROM sync_instances').all()).toEqual([
      { name: 'ctl-1', rebuilt: 1 },
    ]);
  });

  it('is still a member of the same controller, at the same epoch and dataset', () => {
    expect(storedMode(db)).toBe(MEMBER);
    expect(controllerOf(db)).toEqual(controller);
    expect(syncStatus(db)).toMatchObject({ dataset: 'the-controllers-dataset', epoch: 2 });
  });

  it('has its guards back, over the schema as it is now, and no log triggers', () => {
    expect(guards(db)).toBeGreaterThan(0);
    expect(logTriggers(db)).toBe(0);
    expect(() => db.prepare("UPDATE folders SET name = 'x'").run()).toThrow(GUARD_MESSAGE);
    // The columns the migration added are data of record too, and the
    // rebuilt table lost its triggers with the table it replaced.
    expect(() => db.prepare("UPDATE folders SET later_note = 'x'").run()).toThrow(GUARD_MESSAGE);
    expect(() => db.prepare('UPDATE sync_instances SET rebuilt = 2').run()).toThrow(GUARD_MESSAGE);
    expect(() => db.prepare("INSERT INTO folders (name) VALUES ('New')").run()).toThrow(
      GUARD_MESSAGE,
    );
    expect(() => db.prepare('DELETE FROM sync_instances').run()).toThrow(GUARD_MESSAGE);
    expect(db.prepare('SELECT count(*) AS n FROM sync_log').get().n).toBe(0);
  });

  it('has forgotten its cursor, so the next sync is a snapshot', () => {
    expect(readSyncState(db, 'cursor')).toBeNull();
    expect(Number(readSyncState(db, 'schema'))).toBe(NEXT);
  });

  it('keeps a cursor it earns afterwards across a boot with nothing to migrate', async () => {
    writeSyncState(db, 'cursor', 5000);
    db.close();
    // The same directory listing again: the migration is applied already.
    const again = await bootWithLaterMigration();
    expect(readSyncState(again, 'cursor')).toBe('5000');
    expect(guards(again)).toBeGreaterThan(0);
    again.close();
    // A plain connection sees the guards too: they are in the file.
    const plain = new Database(path.join(dataDir, 'cidrella.db'));
    expect(() => plain.prepare("UPDATE folders SET name = 'x'").run()).toThrow(GUARD_MESSAGE);
    plain.close();
  });
});
