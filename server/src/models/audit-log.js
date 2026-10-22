/**
 * Write one audit row to a given database handle.
 *
 * Everything records through recordAudit (services/audit.js), which works out
 * the actor and what changed and calls this with the running database. The
 * restore calls it directly with the STAGED database: its row has to land in
 * the data that survives, and the running handle cannot reach it.
 */
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
  },
) {
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
