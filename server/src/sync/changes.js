/**
 * The data of record as a stream of changes, and taking one in.
 *
 * exportChanges writes what a copy at cursor `since` is missing: a delta from
 * the log when it can, the whole dataset (a snapshot) when it cannot. Both are
 * the same format, lines of JSON:
 *
 *   {"v":1,"dataset":"…","epoch":1,"schema":95,"snapshot":false,"since":120,"head":141}
 *   {"t":"dns_records","s":133,"row":{…}}      a row as it is now
 *   {"t":"dns_records","s":137,"del":42}       a row that is gone
 *   {"end":true,"rows":2,"sha256":"…"}         the hash of every line before it
 *
 * A response is always everything up to `head`: the log keeps only the newest
 * change to a row, so part of a delta is not a state the dataset was ever in.
 *
 * applyChanges makes a database match: the rows exactly as sent, the log rows
 * mirrored (so this copy can serve others after a promotion), and the cursor.
 */
import crypto from 'crypto';
import { queueRegen } from '../utils/after-commit.js';
import { estateTables, readSyncState, syncStatus, writeSyncState } from './log.js';

const FORMAT = 1;

// A BLOB crosses as {"$b": base64}; everything else SQLite stores is JSON already.
const encode = (row) => {
  for (const [key, value] of Object.entries(row)) {
    if (Buffer.isBuffer(value)) row[key] = { $b: value.toString('base64') };
  }
  return row;
};
const decodeValue = (value) =>
  value !== null && typeof value === 'object' ? Buffer.from(value.$b, 'base64') : value;

/** Whether a copy holding `dataset` at cursor `since` can only be given everything. */
export function needsSnapshot(status, { dataset = null, since = null } = {}) {
  return (
    since === null || dataset !== status.dataset || since < status.floor || since > status.head
  );
}

/**
 * What a copy holding `dataset` at cursor `since` needs to reach the head, as
 * one Buffer. A snapshot when the copy has no cursor, holds another dataset,
 * or is behind the log's floor (or ahead of its head: a copy of something
 * else).
 */
export function exportChanges(db, { dataset = null, since = null } = {}) {
  return db.transaction(() => {
    const status = syncStatus(db);
    const snapshot = needsSnapshot(status, { dataset, since });
    const tables = new Map(estateTables(db).map((table) => [table.name, table]));
    const lines = [
      JSON.stringify({
        v: FORMAT,
        dataset: status.dataset,
        epoch: status.epoch,
        schema: status.schema,
        snapshot,
        since: snapshot ? null : since,
        head: status.head,
      }),
    ];
    const select = (table, where) =>
      db.prepare(`SELECT ${table.columns.join(', ')} FROM ${table.name} AS r WHERE ${where}`);
    if (snapshot) {
      for (const table of tables.values()) {
        for (const row of select(table, table.isEstateRow('r')).iterate()) {
          lines.push(JSON.stringify({ t: table.name, row: encode(row) }));
        }
      }
    } else {
      const byKey = new Map();
      const changes = db
        .prepare('SELECT seq, tbl, pk, op FROM sync_log WHERE seq > ? ORDER BY seq')
        .all(since);
      for (const { seq, tbl, pk, op } of changes) {
        const table = tables.get(tbl);
        // A table that stopped being data of record since the row was logged.
        if (!table) continue;
        if (!byKey.has(tbl)) byKey.set(tbl, select(table, `r.${table.key} = ?`));
        const row = op === 'u' ? byKey.get(tbl).get(pk) : null;
        lines.push(
          JSON.stringify(row ? { t: tbl, s: seq, row: encode(row) } : { t: tbl, s: seq, del: pk }),
        );
      }
    }
    const body = `${lines.join('\n')}\n`;
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    return Buffer.from(`${body}${JSON.stringify({ end: true, rows: lines.length - 1, sha256 })}\n`);
  })();
}

/** A failure that means "do not retry this: start over" or "wait", named by `code`. */
export class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

/** Check and read what exportChanges wrote. Throws SyncError('damaged') on anything off. */
export function parseChanges(buffer) {
  const text = buffer.toString('utf8');
  const cut = text.lastIndexOf('\n', text.length - 2) + 1;
  let trailer;
  let entries;
  try {
    trailer = JSON.parse(text.slice(cut));
    if (
      !trailer.end ||
      crypto.createHash('sha256').update(text.slice(0, cut)).digest('hex') !== trailer.sha256
    ) {
      throw new Error('the hash does not match');
    }
    entries = text
      .slice(0, cut)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    throw new SyncError('damaged', `The changes arrived damaged: ${err.message}`);
  }
  const [header, ...changes] = entries;
  if (!header || header.v !== FORMAT || changes.length !== trailer.rows) {
    throw new SyncError('damaged', 'The changes arrived damaged: the header or row count is off');
  }
  return { header, changes };
}

// Every trigger on an estate table, set aside while rows are put in exactly
// as sent: a trigger would redo, on top of them, work whose result is already
// among them.
function withoutTriggers(db, tables, work) {
  const names = new Set(tables.map((table) => table.name));
  const triggers = db
    .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'")
    .all()
    .filter((trigger) => names.has(trigger.tbl_name));
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
  work();
  for (const trigger of triggers) db.exec(trigger.sql);
}

/**
 * Make `db` match what parseChanges read. One transaction; nothing changes if
 * it throws. Refuses (SyncError) a different schema version ('schema'), and a
 * delta that does not start at this copy's cursor or belongs to another
 * dataset ('restart': ask again without a cursor). Queues the applies the
 * changed tables call for. Returns { snapshot, rows, head, tables }.
 */
export function applyChanges(db, { header, changes }) {
  const local = syncStatus(db);
  if (header.schema !== local.schema) {
    throw new SyncError(
      'schema',
      `The changes are for schema ${header.schema} and this database is at ${local.schema}`,
    );
  }
  const cursor = readSyncState(db, 'cursor');
  if (!header.snapshot && (header.dataset !== local.dataset || Number(cursor) !== header.since)) {
    throw new SyncError('restart', 'The changes do not follow on from what this copy holds');
  }

  const tables = new Map(estateTables(db).map((table) => [table.name, table]));
  const byTable = new Map();
  for (const change of changes) {
    const table = tables.get(change.t);
    if (!table) throw new SyncError('damaged', `The changes name an unknown table: ${change.t}`);
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(change);
  }

  // Rows go in exactly as sent, in no particular order, so foreign keys are
  // checked once at the end instead of acting on each write. The pragma is
  // ignored inside a transaction, hence around it.
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      withoutTriggers(db, [...tables.values()], () => {
        if (header.snapshot) {
          for (const table of tables.values()) {
            // A table that keeps host columns keeps its rows; the ones the
            // snapshot does not have go below.
            if (!table.keepsHostColumns) {
              db.exec(`DELETE FROM ${table.name} AS r WHERE ${table.isEstateRow('r')}`);
            }
          }
          db.prepare('DELETE FROM sync_log').run();
        }
        const mirror = db.prepare('INSERT INTO sync_log (seq, tbl, pk, op) VALUES (?, ?, ?, ?)');
        const forget = db.prepare('DELETE FROM sync_log WHERE tbl = ? AND pk = ?');
        for (const [table, list] of byTable) {
          const remove = db.prepare(`DELETE FROM ${table.name} WHERE ${table.key} = ?`);
          const columns = table.columns;
          const values = columns.map((column) => `@${column}`).join(', ');
          // Delete then insert takes a row whatever it collides with here
          // (two rows that swapped a unique value). A row with host columns
          // is updated in place so those survive.
          const put = db.prepare(
            table.keepsHostColumns
              ? `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${values})
                 ON CONFLICT(${table.key}) DO UPDATE SET ${columns
                   .filter((column) => column !== table.key)
                   .map((column) => `${column} = excluded.${column}`)
                   .join(', ')}`
              : `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${values})`,
          );
          if (header.snapshot && table.keepsHostColumns) {
            const sent = new Set(list.map((change) => change.row[table.key]));
            for (const { key } of db
              .prepare(`SELECT ${table.key} AS key FROM ${table.name}`)
              .all()) {
              if (!sent.has(key)) remove.run(key);
            }
          }
          if (!header.snapshot) {
            for (const change of list) {
              const key = change.row ? change.row[table.key] : change.del;
              if (!change.row || !table.keepsHostColumns) remove.run(key);
              forget.run(table.name, key);
              mirror.run(change.s, table.name, key, change.row ? 'u' : 'd');
            }
          }
          for (const change of list) {
            if (!change.row) continue;
            put.run(
              Object.fromEntries(
                columns.map((column) => [column, decodeValue(change.row[column] ?? null)]),
              ),
            );
          }
        }
      });
      // The log continues from the sender's head, so a seq never runs backwards.
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'sync_log'").run();
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('sync_log', ?)").run(header.head);
      writeSyncState(db, 'dataset', header.dataset);
      writeSyncState(db, 'epoch', header.epoch);
      writeSyncState(db, 'cursor', header.head);
      if (header.snapshot) writeSyncState(db, 'floor', header.head);
      const broken = db.pragma('foreign_key_check');
      if (broken.length > 0) {
        const { table, rowid, parent } = broken[0];
        throw new SyncError(
          'restart',
          `The changes leave ${broken.length} row(s) pointing at nothing (first: ${table} ${rowid} -> ${parent})`,
        );
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const hooks = new Set([...byTable.keys()].flatMap((table) => table.hooks));
  for (const hook of hooks) queueRegen(hook);
  return {
    snapshot: header.snapshot,
    rows: changes.length,
    head: header.head,
    tables: [...byTable.keys()].map((table) => table.name),
  };
}
