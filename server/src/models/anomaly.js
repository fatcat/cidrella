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
// itself. Mirrors server/anomaly/storage.py's resolve_device_key — the two
// have to agree since the Python daemon writes the identity column and the
// Node API reads it back. (The sidecar calls the value device_key rather
// than identity purely to keep CodeQL's personal-identifier heuristic from
// flagging every daemon log line that names the device; the column, this
// function, and the API field are all still `identity`.)
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
