/**
 * Whose measurements a read counts, from its `?instance=` (the analytics and
 * metrics endpoints). Absent or `all` is every instance; otherwise one
 * instance's id from sync_instances. A row a box measured itself carries no
 * instance id (migration 098), so this box's own id selects those.
 */
import { EVERY_INSTANCE } from '../db/duckdb.js';
import { getDb } from '../db/init.js';
import { ownInstanceId, ownInstanceName } from '../models/sync-instance.js';

export { EVERY_INSTANCE };

const OWN = Object.freeze({ and: ' AND instance_id IS NULL', params: [], one: true });

/**
 * The filter a request asks for: { and, params }, where `and` is a fixed
 * piece of SQL to end a WHERE with (SQLite and DuckDB both) and `params` what
 * it binds; `one` is set when a single instance was named. Answers 400 and
 * returns null for an instance this box does not know.
 */
export function readInstanceFilter(req, res, db = getDb()) {
  const value = req.query.instance;
  if (value === undefined || value === '' || value === 'all') return EVERY_INSTANCE;
  if (typeof value === 'string') {
    if (value === ownInstanceId(db)) return OWN;
    if (db.prepare('SELECT 1 FROM sync_instances WHERE instance_id = ?').get(value)) {
      return { and: ' AND instance_id = ?', params: [value], one: true };
    }
  }
  res.status(400).json({ error: 'Unknown instance.', code: 'unknown_instance' });
  return null;
}

/**
 * The instances a read can be filtered by: [{ instance_id, name, is_self }],
 * this box first. A single box lists itself alone.
 */
export function filterableInstances(db = getDb()) {
  const self = ownInstanceId(db);
  const rows = db
    .prepare('SELECT instance_id, name FROM sync_instances ORDER BY is_controller DESC, name, id')
    .all()
    .map((row) => ({ ...row, is_self: row.instance_id === self }));
  if (!rows.some((row) => row.is_self)) {
    rows.unshift({ instance_id: self, name: ownInstanceName(db), is_self: true });
  }
  return rows;
}

/** Whether `table` holds any row a member sent up (the partial indexes of migration 098). */
export const hasMemberRows = (db, table) =>
  db.prepare(`SELECT 1 FROM ${table} WHERE instance_id IS NOT NULL LIMIT 1`).get() !== undefined;
