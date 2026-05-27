export function deleteScore(db, id) {
  return db.prepare('DELETE FROM anomaly_scores WHERE id = ?').run(id);
}

export function dismissScore(db, id) {
  return db.prepare(`
    UPDATE anomaly_scores SET resolved = 1, resolved_at = datetime('now')
    WHERE id = ? AND resolved = 0
  `).run(id);
}

export function addWhitelistEntry(db, clientIp, reason) {
  return db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO anomaly_whitelist (client_ip, reason) VALUES (?, ?)'
    ).run(clientIp, reason || null);

    db.prepare('DELETE FROM anomaly_models WHERE client_ip = ?').run(clientIp);
    db.prepare('DELETE FROM anomaly_scores WHERE client_ip = ?').run(clientIp);
    return result.lastInsertRowid;
  })();
}

export function deleteWhitelistEntry(db, id) {
  return db.prepare('DELETE FROM anomaly_whitelist WHERE id = ?').run(id);
}
