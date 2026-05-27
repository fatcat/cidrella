export function pruneAuditLog(db, days) {
  return db.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)").run(`-${parseInt(days, 10) || 7} days`);
}
