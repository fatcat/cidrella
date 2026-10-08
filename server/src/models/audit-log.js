/**
 * Write one audit row to a given database handle.
 *
 * The everyday path is audit() in db/init.js, bound to the running database.
 * This one exists for the restore, which records itself in the STAGED
 * database before that file replaces the running one: the row has to land in
 * the data that survives, and the running handle cannot reach it.
 */
export function insertAuditRow(
  db,
  { userId = null, action, entityType = null, entityId = null, details = null },
) {
  return db
    .prepare(
      'INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)',
    )
    .run(userId, action, entityType, entityId, details == null ? null : JSON.stringify(details));
}

export function pruneAuditLog(db, days) {
  return db
    .prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)")
    .run(`-${parseInt(days, 10) || 7} days`);
}
