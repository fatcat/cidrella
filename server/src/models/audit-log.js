/**
 * Write one audit row to a given database handle.
 *
 * Everything records through recordAudit (services/audit.js), which works out
 * the actor and what changed and calls this with the running database. The
 * restore calls it directly with the STAGED database: its row has to land in
 * the data that survives, and the running handle cannot reach it.
 *
 * A member does not own audit_log (sync/registry.js), so its rows wait in
 * sync_outbox for the controller. That choice is made here and nowhere else:
 * recordAudit and the session model both end up in insertAuditRow.
 */
import { MEMBER, storedMode } from '../sync/mode.js';

export const AUDIT_OUTBOX_KIND = 'audit';

// The columns a handle's audit_log has. A restore writes into a backup's
// database before migrations run, so a table from before migration 089 has
// no actor, origin, source or source_ip, and only what exists is written.
const columnCache = new WeakMap();
function auditColumns(db) {
  let cols = columnCache.get(db);
  if (!cols) {
    cols = new Set(
      db
        .prepare('PRAGMA table_info(audit_log)')
        .all()
        .map((c) => c.name),
    );
    columnCache.set(db, cols);
  }
  return cols;
}

export function insertAuditRow(
  db,
  {
    userId = null,
    action,
    entityType = null,
    entityId = null,
    details = null,
    actor = null,
    origin = null,
    source = null,
    sourceIp = null,
    // When it happened, for a row that waited on a member. Now otherwise.
    at = null,
  },
) {
  if (storedMode(db) === MEMBER) {
    const row = { userId, action, entityType, entityId, details, actor, origin, source, sourceIp };
    return db
      .prepare('INSERT INTO sync_outbox (kind, payload) VALUES (?, ?)')
      .run(AUDIT_OUTBOX_KIND, JSON.stringify({ ...row, at: new Date().toISOString() }));
  }
  const values = {
    user_id: userId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    details: details == null ? null : JSON.stringify(details),
    actor,
    origin,
    source,
    source_ip: sourceIp,
  };
  if (at) values.created_at = at;
  const present = auditColumns(db);
  const names = Object.keys(values).filter((name) => present.has(name));
  return db
    .prepare(
      `INSERT INTO audit_log (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    )
    .run(...names.map((name) => values[name]));
}

export function pruneAuditLog(db, days) {
  return db
    .prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)")
    .run(`-${parseInt(days, 10) || 90} days`);
}
