/**
 * The change log of the data of record: the sync_log table, the triggers that
 * fill it, and the identity of the dataset it describes.
 *
 * Every insert, update and delete of an estate row (sync/registry.js) leaves
 * one log row naming the table and key, replacing the row's earlier entry. The
 * triggers are plain SQL, so a second connection (the anomaly sidecar) and raw
 * SQL in a model are logged like anything else. They are generated from the
 * registry and the live schema, and put right at every boot.
 *
 * The log describes one dataset. A restore, a rolled-back update or a
 * migration changes rows without the log seeing it, so each gives the dataset
 * a new id and empties the log: a copy of the old dataset starts over from a
 * snapshot (sync/changes.js).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { SETTINGS, TABLES } from './registry.js';

const TRIGGER_PREFIX = 'sync_log_';
const ESTATE = 'estate';

const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;

/** The settings keys that are data of record, as a SQL list. */
export const estateSettingsSql = () =>
  Object.entries(SETTINGS)
    .filter(([, dataClass]) => dataClass === ESTATE)
    .map(([key]) => quote(key))
    .join(', ');

/**
 * Every estate table as { name, key, columns, where }: the columns that are
 * data of record (an estate table's host columns stay behind) and, for
 * settings, the rows that are.
 */
export function estateTables(db) {
  return Object.entries(TABLES)
    .filter(([, entry]) => entry.class === ESTATE)
    .map(([name, entry]) => {
      const hostColumns = new Set(entry.hostColumns || []);
      return {
        name,
        key: entry.key,
        hooks: entry.hooks || [],
        keepsHostColumns: hostColumns.size > 0,
        columns: db
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((column) => column.name)
          .filter((column) => !hostColumns.has(column)),
        // SQL true for a row that is data of record; `row` is NEW, OLD or a table alias.
        isEstateRow: (row) =>
          name === 'settings' ? `${row}.key IN (${estateSettingsSql()})` : '1',
      };
    });
}

function triggerSql(table) {
  const { name, key } = table;
  const log = (row, op) =>
    `INSERT INTO sync_log (tbl, pk, op) SELECT ${quote(name)}, ${row}.${key}, '${op}' WHERE ${table.isEstateRow(row)}`;
  // Delete then insert: an INSERT OR REPLACE here would take on the conflict
  // rule of the statement that fired the trigger (UPDATE OR IGNORE).
  const forget = (...rows) =>
    `DELETE FROM sync_log WHERE tbl = ${quote(name)} AND pk IN (${rows.map((row) => `${row}.${key}`).join(', ')})`;
  const changed = table.columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(' OR ');
  return {
    [`${TRIGGER_PREFIX}${name}_ai`]: `CREATE TRIGGER ${TRIGGER_PREFIX}${name}_ai AFTER INSERT ON ${name} BEGIN
  ${forget('NEW')};
  ${log('NEW', 'u')};
END`,
    // An update that changes nothing in the data of record is not a change.
    [`${TRIGGER_PREFIX}${name}_au`]: `CREATE TRIGGER ${TRIGGER_PREFIX}${name}_au AFTER UPDATE ON ${name} WHEN ${changed} BEGIN
  ${forget('OLD', 'NEW')};
  INSERT INTO sync_log (tbl, pk, op) SELECT ${quote(name)}, OLD.${key}, 'd' WHERE OLD.${key} IS NOT NEW.${key} AND ${table.isEstateRow('OLD')};
  ${log('NEW', 'u')};
END`,
    [`${TRIGGER_PREFIX}${name}_ad`]: `CREATE TRIGGER ${TRIGGER_PREFIX}${name}_ad AFTER DELETE ON ${name} BEGIN
  ${forget('OLD')};
  ${log('OLD', 'd')};
END`,
  };
}

const installedTriggers = (db) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
    .all()
    .filter((row) => row.name.startsWith(TRIGGER_PREFIX));

/** Remove the log triggers. A migration runs without them: a rebuild drops them anyway. */
export function dropSyncTriggers(db) {
  for (const { name } of installedTriggers(db)) db.exec(`DROP TRIGGER ${name}`);
}

/** Make the log triggers match the registry and the schema. Returns how many changed. */
export function ensureSyncTriggers(db) {
  const wanted = Object.assign({}, ...estateTables(db).map(triggerSql));
  let changed = 0;
  db.transaction(() => {
    const installed = new Map(installedTriggers(db).map((row) => [row.name, row.sql]));
    for (const [name, sql] of installed) {
      if (wanted[name] === sql) continue;
      db.exec(`DROP TRIGGER ${name}`);
      installed.delete(name);
      changed++;
    }
    for (const [name, sql] of Object.entries(wanted)) {
      if (installed.has(name)) continue;
      db.exec(sql);
      changed++;
    }
  })();
  return changed;
}

export function readSyncState(db, key) {
  return db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value ?? null;
}

export function writeSyncState(db, key, value) {
  db.prepare(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

/** The newest seq the log has ever given out. */
export function syncHead(db) {
  return (
    db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sync_log'").get()?.seq ?? 0
  );
}

/** { dataset, epoch, floor, head, schema }: what a copy must match to take a delta. */
export function syncStatus(db) {
  return {
    dataset: readSyncState(db, 'dataset'),
    epoch: Number(readSyncState(db, 'epoch') ?? 1),
    floor: Number(readSyncState(db, 'floor') ?? 0),
    head: syncHead(db),
    schema: schemaVersion(db),
  };
}

export const schemaVersion = (db) =>
  db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0;

const incarnationFile = (dataDir) => path.join(dataDir, 'sync', 'incarnation');

function readIncarnationFile(dataDir) {
  try {
    return fs.readFileSync(incarnationFile(dataDir), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Start a new dataset: a new id, an empty log, and a floor at the head so no
 * cursor from before is served.
 */
export function startNewDataset(db) {
  const dataset = crypto.randomUUID();
  db.transaction(() => {
    db.prepare('DELETE FROM sync_log').run();
    writeSyncState(db, 'dataset', dataset);
    writeSyncState(db, 'floor', syncHead(db));
    writeSyncState(db, 'schema', schemaVersion(db));
    if (readSyncState(db, 'epoch') === null) writeSyncState(db, 'epoch', 1);
  })();
  return dataset;
}

/** Make `db` start a new dataset at its next boot. A restore does this to the database it brings in. */
export function forgetDataset(db) {
  const hasState = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'")
    .get();
  if (hasState) db.prepare("DELETE FROM sync_state WHERE key = 'dataset'").run();
}

/**
 * Boot, after the migrations: put the triggers right, and start a new dataset
 * when the log cannot vouch for this database. That is when it has never had
 * one (or a restore brought it in, forgetDataset), when a migration ran (it
 * changes rows with the triggers off), and when the database file is not the
 * one this data directory last booted: every boot writes a fresh token into
 * the database and into DATA_DIR/sync/incarnation, which no backup or update
 * snapshot carries, so a database put back from before does not match it.
 * Returns { dataset, started } where started says why a new one began.
 */
export function ensureSyncLog(db, dataDir) {
  const triggersChanged = ensureSyncTriggers(db) > 0;
  const dataset = readSyncState(db, 'dataset');
  let started = null;
  if (!dataset) started = 'first run';
  else if (Number(readSyncState(db, 'schema')) !== schemaVersion(db)) started = 'schema changed';
  else if (readIncarnationFile(dataDir) !== readSyncState(db, 'incarnation')) {
    started = 'database replaced';
  }
  // What counts as data of record changed with no migration: rows that now
  // belong were never logged.
  else if (triggersChanged) started = 'what is logged changed';

  const incarnation = crypto.randomUUID();
  writeSyncState(db, 'incarnation', incarnation);
  fs.mkdirSync(path.dirname(incarnationFile(dataDir)), { recursive: true });
  fs.writeFileSync(incarnationFile(dataDir), `${incarnation}\n`, { mode: 0o600 });
  return { dataset: started ? startNewDataset(db) : dataset, started };
}

/**
 * Drop the tombstones every copy has taken: those up to `upTo`, the lowest
 * cursor among the copies (the head when there are none). The floor rises to
 * the newest one dropped, and a cursor below it starts over from a snapshot.
 */
export function pruneTombstones(db, upTo = syncHead(db)) {
  return db.transaction(() => {
    const newest = db
      .prepare("SELECT MAX(seq) AS seq FROM sync_log WHERE op = 'd' AND seq <= ?")
      .get(upTo).seq;
    if (newest === null) return 0;
    const { changes } = db.prepare("DELETE FROM sync_log WHERE op = 'd' AND seq <= ?").run(upTo);
    if (newest > Number(readSyncState(db, 'floor') ?? 0)) writeSyncState(db, 'floor', newest);
    return changes;
  })();
}
