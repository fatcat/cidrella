// Every table and every settings key has a data class (src/sync/registry.js).
// This builds a database, reads the settings keys the code names, and fails on
// anything unclassified, and on a registry entry for something that is gone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { DEFAULTS } from '../../../src/config/defaults.js';
import { SETTINGS, TABLES } from '../../../src/sync/registry.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');
const CLASSES = ['estate', 'host', 'collected'];
// A settings key as the first argument of a settings read or write.
const SETTING_CALL =
  /\b(?:getSetting|setSetting|readSetting|setting|upsertSetting\w*|deleteSetting)\(\s*(?:\w+(?:\(\))?,\s*)?'([a-z0-9_]+)'/g;

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(js|sql)$/.test(entry.name) ? [full] : [];
  });
}

let db;
let tmpDir;
let source;
beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  source = sourceFiles(SRC)
    .filter((file) => !file.endsWith(path.join('sync', 'registry.js')))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
});
afterAll(() => cleanupTestDb(tmpDir));

const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all();

describe('data class registry: tables', () => {
  const tables = () =>
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

  it('classifies every table in the schema', () => {
    expect(tables().filter((name) => !TABLES[name])).toEqual([]);
  });

  it('has no entry for a table that is gone', () => {
    const real = new Set(tables());
    expect(Object.keys(TABLES).filter((name) => !real.has(name))).toEqual([]);
  });

  it('gives every table a known class', () => {
    expect(Object.values(TABLES).filter((entry) => !CLASSES.includes(entry.class))).toEqual([]);
  });

  it('names the one-column primary key of every estate table', () => {
    const wrong = Object.entries(TABLES)
      .filter(([, entry]) => entry.class === 'estate')
      .filter(([name, entry]) => {
        const pk = columnsOf(name)
          .filter((column) => column.pk)
          .map((column) => column.name);
        return pk.length !== 1 || pk[0] !== entry.key;
      })
      .map(([name]) => name);
    expect(wrong).toEqual([]);
  });

  it('names host columns that exist and are not the key', () => {
    const wrong = Object.entries(TABLES)
      .filter(([, entry]) => entry.hostColumns)
      .flatMap(([name, entry]) => {
        const real = new Set(columnsOf(name).map((column) => column.name));
        return entry.hostColumns
          .filter((column) => !real.has(column) || column === entry.key)
          .map((column) => `${name}.${column}`);
      });
    expect(wrong).toEqual([]);
  });
});

describe('data class registry: settings', () => {
  const namedInCode = () => new Set([...source.matchAll(SETTING_CALL)].map((match) => match[1]));

  it('classifies every default, every seeded key and every key the code reads or writes', () => {
    const seeded = db
      .prepare('SELECT key FROM settings')
      .all()
      .map((row) => row.key);
    const keys = new Set([...Object.keys(DEFAULTS), ...seeded, ...namedInCode()]);
    // Keys a migration removed for good; the code names them only to do that.
    for (const retired of ['password_complexity', 'offline_metadata_retention_days']) {
      keys.delete(retired);
    }
    expect([...keys].filter((key) => !SETTINGS[key]).sort()).toEqual([]);
  });

  it('has no entry for a key the code never names', () => {
    const stale = Object.keys(SETTINGS).filter((key) => !source.includes(`'${key}'`));
    expect(stale).toEqual([]);
  });

  it('gives every key a known class', () => {
    expect(Object.values(SETTINGS).filter((value) => !CLASSES.includes(value))).toEqual([]);
  });
});
