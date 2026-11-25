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
 * A snapshot can be larger than memory, or than a string can hold, so it moves
 * as a stream: exportChangesToFile writes it a piece at a time, and
 * receiveChanges takes it in line by line, spooled to a file and checked
 * against the trailer before anything is applied. exportChanges and
 * parseChanges do the same in one Buffer, for a delta.
 *
 * applyChanges makes a database match: the rows exactly as sent, the log rows
 * mirrored (so this copy can serve others after a promotion), and the cursor.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { queueRegen } from '../utils/after-commit.js';
import {
  DHCP_READY_TERM,
  estateTables,
  isEstateSetting,
  readSyncState,
  syncStatus,
  writeSyncState,
} from './log.js';

const FORMAT = 1;
const NEWLINE = 0x0a;
// Lines go to and come from a spool file in pieces about this big.
const CHUNK_BYTES = 1 << 20;
const SPOOL_PREFIX = 'changes-';
const STALE_SPOOL_MS = 24 * 60 * 60 * 1000;

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
 * Hand `write` every line of what a copy holding `dataset` at cursor `since`
 * needs to reach the head, newline included, the trailer last. All of it is
 * read in one transaction. A snapshot when the copy has no cursor, holds
 * another dataset, or is behind the log's floor (or ahead of its head: a copy
 * of something else). Returns { snapshot, rows }.
 */
function writeChanges(db, { dataset = null, since = null }, write) {
  return db.transaction(() => {
    const status = syncStatus(db);
    const snapshot = needsSnapshot(status, { dataset, since });
    const tables = new Map(estateTables(db).map((table) => [table.name, table]));
    const hash = crypto.createHash('sha256');
    let rows = 0;
    const line = (entry) => {
      const text = `${JSON.stringify(entry)}\n`;
      hash.update(text);
      write(text);
    };
    line({
      v: FORMAT,
      dataset: status.dataset,
      epoch: status.epoch,
      schema: status.schema,
      snapshot,
      since: snapshot ? null : since,
      head: status.head,
    });
    const select = (table, where) =>
      db.prepare(`SELECT ${table.columns.join(', ')} FROM ${table.name} AS r WHERE ${where}`);
    if (snapshot) {
      for (const table of tables.values()) {
        for (const row of select(table, table.isEstateRow('r')).iterate()) {
          line({ t: table.name, row: encode(row) });
          rows += 1;
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
        line(row ? { t: tbl, s: seq, row: encode(row) } : { t: tbl, s: seq, del: pk });
        rows += 1;
      }
    }
    write(`${JSON.stringify({ end: true, rows, sha256: hash.digest('hex') })}\n`);
    return { snapshot, rows };
  })();
}

/** What a copy holding `dataset` at cursor `since` needs to reach the head, as one Buffer. */
export function exportChanges(db, options = {}) {
  const parts = [];
  writeChanges(db, options, (text) => parts.push(text));
  return Buffer.from(parts.join(''));
}

/**
 * The same, written to `file` a piece at a time, so a snapshot of any size
 * never sits in memory whole. Returns { snapshot, rows }.
 */
export function exportChangesToFile(db, options, file) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    let held = [];
    let size = 0;
    const writeHeld = () => {
      if (held.length > 0) fs.writeSync(fd, held.join(''));
      held = [];
      size = 0;
    };
    const result = writeChanges(db, options, (text) => {
      held.push(text);
      size += text.length;
      if (size >= CHUNK_BYTES) writeHeld();
    });
    writeHeld();
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A new file name in `dir` for one copy of the changes on its way out or in.
 * The caller removes it. One left behind by a process that died is removed
 * here a day later.
 */
export function spoolFile(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(SPOOL_PREFIX)) continue;
    const file = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > STALE_SPOOL_MS) fs.rmSync(file, { force: true });
    } catch {
      /* gone already */
    }
  }
  return path.join(dir, `${SPOOL_PREFIX}${crypto.randomUUID()}.ndjson`);
}

/** A failure that means "do not retry this: start over" or "wait", named by `code`. */
export class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

const damaged = (why) => new SyncError('damaged', `The changes arrived damaged: ${why}`);

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
    throw damaged(err.message);
  }
  const [header, ...changes] = entries;
  if (!header || header.v !== FORMAT || changes.length !== trailer.rows) {
    throw damaged('the header or row count is off');
  }
  return { header, changes };
}

// The complete lines of `rest` then `chunk`, without their newlines, and the
// bytes after the last one. A newline byte never occurs inside a UTF-8
// character, so lines are split before they are decoded.
function splitLines(rest, chunk) {
  const data = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk;
  const lines = [];
  let start = 0;
  for (let end = data.indexOf(NEWLINE); end !== -1; end = data.indexOf(NEWLINE, start)) {
    lines.push(data.subarray(start, end));
    start = end + 1;
  }
  return { lines, rest: data.subarray(start) };
}

function parseLine(line) {
  try {
    return JSON.parse(line.toString('utf8'));
  } catch (err) {
    throw damaged(err.message);
  }
}

// The change lines of a spool file, one at a time, read with the file
// already checked (receiveChanges).
function* spooledChanges(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let rest = Buffer.alloc(0);
    for (;;) {
      // A fresh buffer each time: `rest` and the lines point into it.
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      const read = fs.readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (read === 0) break;
      const split = splitLines(rest, buffer.subarray(0, read));
      rest = split.rest;
      for (const line of split.lines) yield parseLine(line);
    }
    if (rest.length > 0) yield parseLine(rest);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Take changes as they arrive on `stream` (the lines exportChanges writes, in
 * Buffers of any size) into `file`, checked as parseChanges checks them.
 * Resolves { header, changes } for applyChanges, `changes` reading the rows
 * back from the file one at a time (as often as it is iterated), so a
 * snapshot never sits in memory whole. Rejects with SyncError('damaged') when
 * the hash, the header or the row count is off; an error of the stream itself
 * goes through as it is. The caller removes the file after the apply.
 */
export async function receiveChanges(stream, file) {
  // Nothing listens to the stream until the loop below starts, and an error
  // it emits meanwhile (the connection dropped) would be uncaught, which ends
  // the process. Keep it, and throw it once the file is open.
  let early = null;
  const keep = (err) => {
    early = err;
  };
  stream.on('error', keep);
  let out;
  try {
    out = await fs.promises.open(file, 'wx', 0o600);
  } finally {
    stream.off('error', keep);
  }
  const hash = crypto.createHash('sha256');
  let header = null;
  let last = null;
  let rows = 0;
  let held = [];
  let size = 0;
  // Every line before the last is hashed and kept; the last is the trailer.
  const take = (line) => {
    if (last !== null) {
      hash.update(last).update('\n');
      if (header === null) header = last;
      else {
        held.push(last, Buffer.from('\n'));
        size += last.length + 1;
        rows += 1;
      }
    }
    last = line;
  };
  const flush = async () => {
    if (held.length > 0) await out.write(Buffer.concat(held));
    held = [];
    size = 0;
  };
  try {
    if (early) throw early;
    let rest = Buffer.alloc(0);
    for await (const chunk of stream) {
      const split = splitLines(rest, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      rest = split.rest;
      split.lines.forEach(take);
      if (size >= CHUNK_BYTES) await flush();
    }
    if (rest.length > 0) take(rest);
    await flush();
  } finally {
    await out.close();
  }

  if (last === null) throw damaged('nothing arrived');
  const trailer = parseLine(last);
  if (!trailer?.end || hash.digest('hex') !== trailer.sha256) {
    throw damaged('the hash does not match');
  }
  const parsed = header === null ? null : parseLine(header);
  if (parsed?.v !== FORMAT || rows !== trailer.rows) {
    throw damaged('the header or row count is off');
  }
  return { header: parsed, changes: { [Symbol.iterator]: () => spooledChanges(file) } };
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
 * Rows went in with foreign keys off, so a row deleted on the sender did not
 * do here what its foreign keys ask of the tables only this box keeps (a
 * session of a user who is gone, the downloaded domains of a list that is).
 * Do that now: SET NULL where the key says so, the row removed otherwise.
 * Returns the violations left, which are in the data of record itself.
 */
function settleHostRows(db, estate) {
  const left = [];
  const settled = new Set();
  for (const violation of db.pragma('foreign_key_check')) {
    const { table, fkid, parent } = violation;
    if (estate.has(table)) {
      left.push(violation);
      continue;
    }
    if (settled.has(`${table}/${fkid}`)) continue;
    settled.add(`${table}/${fkid}`);
    // Every row of the table whose key has no parent, at once: a table
    // without rowids gives the check no row to name.
    const keys = db.pragma(`foreign_key_list(${quoteName(table)})`).filter((fk) => fk.id === fkid);
    if (keys.length === 0 || keys.some((fk) => !fk.to)) {
      left.push(violation);
      continue;
    }
    const child = quoteName(table);
    const orphan =
      keys.map((fk) => `${child}.${quoteName(fk.from)} IS NOT NULL`).join(' AND ') +
      ` AND NOT EXISTS (SELECT 1 FROM ${quoteName(parent)} AS p WHERE ${keys
        .map((fk) => `p.${quoteName(fk.to)} = ${child}.${quoteName(fk.from)}`)
        .join(' AND ')})`;
    if (keys.every((fk) => fk.on_delete === 'SET NULL')) {
      const cleared = keys.map((fk) => `${quoteName(fk.from)} = NULL`).join(', ');
      db.exec(`UPDATE ${child} SET ${cleared} WHERE ${orphan}`);
    } else {
      db.exec(`DELETE FROM ${child} WHERE ${orphan}`);
    }
  }
  return left;
}

const quoteName = (name) => `"${String(name).replaceAll('"', '""')}"`;

/**
 * Make `db` match what parseChanges or receiveChanges read: `changes` is
 * anything that can be iterated twice. One transaction; nothing changes if
 * it throws. Refuses (SyncError) a different schema version ('schema'),
 * changes from an epoch before this copy's ('stale_epoch'), and a delta that
 * does not start at this copy's cursor or belongs to another dataset
 * ('restart': ask again without a cursor). Queues the applies the
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
  // A controller at a lower epoch than this copy has been replaced
  // (docs/REDUNDANCY-PLAN.md, section 7): nothing of it is taken.
  if (header.epoch < local.epoch) {
    throw new SyncError(
      'stale_epoch',
      `The changes are from epoch ${header.epoch} and this copy is of epoch ${local.epoch}`,
    );
  }
  const cursor = readSyncState(db, 'cursor');
  if (!header.snapshot && (header.dataset !== local.dataset || Number(cursor) !== header.since)) {
    throw new SyncError('restart', 'The changes do not follow on from what this copy holds');
  }

  const tables = new Map(estateTables(db).map((table) => [table.name, table]));
  const tableOf = (change) => {
    const table = tables.get(change.t);
    if (!table) throw new SyncError('damaged', `The changes name an unknown table: ${change.t}`);
    // Only the settings that are data of record: a key about this box (its
    // ports, its sign-in secret) is never taken from another one.
    if (table.name === 'settings') {
      const key = change.row ? change.row.key : change.del;
      if (!isEstateSetting(key)) {
        throw new SyncError('damaged', `The changes name a setting that is not shared: ${key}`);
      }
    }
    if (header.snapshot && !change.row) throw damaged('a snapshot names a row that is gone');
    return table;
  };
  const touched = new Set();
  let rows = 0;

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
        const statements = new Map();
        const statementsOf = (table) => {
          if (statements.has(table)) return statements.get(table);
          const columns = table.columns;
          const values = columns.map((column) => `@${column}`).join(', ');
          // Delete then insert takes a row whatever it collides with here
          // (two rows that swapped a unique value). A row with host columns
          // is updated in place so those survive.
          const made = {
            remove: db.prepare(`DELETE FROM ${table.name} WHERE ${table.key} = ?`),
            put: db.prepare(
              table.keepsHostColumns
                ? `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${values})
                   ON CONFLICT(${table.key}) DO UPDATE SET ${columns
                     .filter((column) => column !== table.key)
                     .map((column) => `${column} = excluded.${column}`)
                     .join(', ')}`
                : `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${values})`,
            ),
          };
          statements.set(table, made);
          return made;
        };

        // Two passes over the changes, each reading them afresh (a snapshot
        // is read back from its spool file, never held): first every row
        // that goes, then every row as sent, so a row never collides with
        // one that is about to leave.
        // The keys a snapshot sends for each table that keeps host columns,
        // an empty set for one it sends no rows of: those rows go too.
        const sent = new Map();
        if (header.snapshot) {
          for (const table of tables.values()) {
            if (table.keepsHostColumns) sent.set(table, new Set());
          }
        }
        for (const change of changes) {
          const table = tableOf(change);
          rows += 1;
          touched.add(table);
          if (header.snapshot) {
            if (table.keepsHostColumns) sent.get(table).add(change.row[table.key]);
            continue;
          }
          const key = change.row ? change.row[table.key] : change.del;
          if (!change.row || !table.keepsHostColumns) statementsOf(table).remove.run(key);
          forget.run(table.name, key);
          mirror.run(change.s, table.name, key, change.row ? 'u' : 'd');
        }
        for (const [table, keys] of sent) {
          const { remove } = statementsOf(table);
          for (const { key } of db.prepare(`SELECT ${table.key} AS key FROM ${table.name}`).all()) {
            if (keys.has(key)) continue;
            remove.run(key);
            touched.add(table);
          }
        }
        for (const change of changes) {
          if (!change.row) continue;
          const table = tables.get(change.t);
          statementsOf(table).put.run(
            Object.fromEntries(
              table.columns.map((column) => [column, decodeValue(change.row[column] ?? null)]),
            ),
          );
        }
      });
      // The log continues from the sender's head, so a seq never runs backwards.
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'sync_log'").run();
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('sync_log', ?)").run(header.head);
      // The DHCP terms of another dataset are another count: a mark of term
      // n here says nothing of term n there.
      if (header.dataset !== local.dataset) {
        db.prepare('DELETE FROM sync_state WHERE key = ?').run(DHCP_READY_TERM);
      }
      writeSyncState(db, 'dataset', header.dataset);
      writeSyncState(db, 'epoch', header.epoch);
      writeSyncState(db, 'cursor', header.head);
      if (header.snapshot) writeSyncState(db, 'floor', header.head);
      const broken = settleHostRows(db, tables);
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

  const hooks = new Set([...touched].flatMap((table) => table.hooks));
  for (const hook of hooks) queueRegen(hook);
  return {
    snapshot: header.snapshot,
    rows,
    head: header.head,
    tables: [...touched].map((table) => table.name),
  };
}
