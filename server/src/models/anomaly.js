export function deleteScore(db, id) {
  return db.prepare('DELETE FROM anomaly_scores WHERE id = ?').run(id);
}

export function dismissScore(db, id) {
  return db.prepare(`
    UPDATE anomaly_scores SET resolved = 1, resolved_at = datetime('now')
    WHERE id = ? AND resolved = 0
  `).run(id);
}

// Resolve a client IP to the anomaly-detection identity it's scored under:
// its current DHCP MAC if known (survives an IP renewal), else the IP
// itself. Mirrors server/anomaly/storage.py's resolve_identity — the two
// have to agree since the Python daemon writes identity and the Node API
// reads it back.
export function resolveIdentity(db, clientIp) {
  const row = db.prepare('SELECT mac_address FROM dhcp_leases WHERE ip_address = ?').get(clientIp);
  return row?.mac_address || clientIp;
}

export function addWhitelistEntry(db, clientIp, reason) {
  return db.transaction(() => {
    const identity = resolveIdentity(db, clientIp);
    const result = db.prepare(
      'INSERT INTO anomaly_whitelist (identity, client_ip, reason) VALUES (?, ?, ?)'
    ).run(identity, clientIp, reason || null);

    db.prepare('DELETE FROM anomaly_models WHERE identity = ?').run(identity);
    db.prepare('DELETE FROM anomaly_scores WHERE identity = ?').run(identity);
    return result.lastInsertRowid;
  })();
}

export function deleteWhitelistEntry(db, id) {
  return db.prepare('DELETE FROM anomaly_whitelist WHERE id = ?').run(id);
}
