/**
 * Network scan model, single owner for network_scans and scan_results writes.
 */

export function list(db, { subnetId, limit = 50 } = {}) {
  let query = `
    SELECT ns.*, sub.cidr as subnet_cidr, sub.name as subnet_name
    FROM network_scans ns
    JOIN subnets sub ON ns.subnet_id = sub.id
  `;
  const params = [];

  if (subnetId) {
    query += ' WHERE ns.subnet_id = ?';
    params.push(subnetId);
  }

  query += ' ORDER BY ns.created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(query).all(...params);
}

export function findById(db, id) {
  return db.prepare(`
    SELECT ns.*, sub.cidr as subnet_cidr, sub.name as subnet_name
    FROM network_scans ns
    JOIN subnets sub ON ns.subnet_id = sub.id
    WHERE ns.id = ?
  `).get(id);
}

export function getResults(db, scanId) {
  return db.prepare('SELECT * FROM scan_results WHERE scan_id = ? ORDER BY ip_address').all(scanId);
}

export function getResultForIp(db, scanId, ip) {
  return db.prepare('SELECT * FROM scan_results WHERE scan_id = ? AND ip_address = ?').get(scanId, ip);
}

export function findActiveForSubnet(db, subnetId) {
  return db.prepare(`
    SELECT id FROM network_scans
    WHERE subnet_id = ? AND status IN ('pending', 'running')
    ORDER BY created_at DESC LIMIT 1
  `).get(subnetId);
}

export function createPending(db, subnetId) {
  const result = db.prepare("INSERT INTO network_scans (subnet_id, status) VALUES (?, 'pending')").run(subnetId);
  return result.lastInsertRowid;
}

export function createPendingIfIdle(db, subnetId) {
  return db.transaction(() => {
    const active = findActiveForSubnet(db, subnetId);
    if (active) return { created: false, scanId: active.id };
    return { created: true, scanId: createPending(db, subnetId) };
  })();
}

export function markRunning(db, scanId, totalIps) {
  return db.prepare(`
    UPDATE network_scans
       SET status = 'running',
           total_ips = ?,
           started_at = COALESCE(started_at, datetime('now'))
     WHERE id = ?
  `).run(totalIps, scanId);
}

export function markFailed(db, scanId, error) {
  return db.prepare(`
    UPDATE network_scans
       SET status = 'failed',
           error = ?,
           completed_at = datetime('now')
     WHERE id = ?
  `).run(error, scanId);
}

export function insertResult(db, scanId, { ip, mac, responded, isConflict, conflictReason }) {
  return db.prepare(`
    INSERT INTO scan_results (scan_id, ip_address, mac_address, responded, is_conflict, conflict_reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    scanId,
    ip,
    mac || null,
    responded ? 1 : 0,
    isConflict ? 1 : 0,
    conflictReason || null
  );
}

export function updateProgress(db, scanId, { scannedIps, conflictsFound }) {
  return db.prepare(`
    UPDATE network_scans
       SET scanned_ips = ?,
           conflicts_found = ?
     WHERE id = ?
  `).run(scannedIps, conflictsFound, scanId);
}

export function markCompleted(db, scanId, { scannedIps, conflictsFound }) {
  return db.prepare(`
    UPDATE network_scans
       SET status = 'completed',
           scanned_ips = ?,
           conflicts_found = ?,
           completed_at = datetime('now')
     WHERE id = ?
  `).run(scannedIps, conflictsFound, scanId);
}

export function deleteById(db, scanId) {
  return db.prepare('DELETE FROM network_scans WHERE id = ?').run(scanId);
}

export function deleteIfNotRunning(db, scanId) {
  const scan = db.prepare('SELECT * FROM network_scans WHERE id = ?').get(scanId);
  if (!scan) return { deleted: false, missing: true };
  if (scan.status === 'running') return { deleted: false, running: true, scan };
  deleteById(db, scanId);
  return { deleted: true, scan };
}

export function existingResultIps(db, scanId) {
  return new Set(db.prepare('SELECT ip_address FROM scan_results WHERE scan_id = ?')
    .all(scanId)
    .map(r => r.ip_address));
}

export function countConflicts(db, scanId) {
  return db.prepare('SELECT COUNT(*) as cnt FROM scan_results WHERE scan_id = ? AND is_conflict = 1')
    .get(scanId).cnt;
}

export function getMaterializedResults(db, scanId) {
  return db.prepare(
    'SELECT ip_address, responded, mac_address, is_conflict, conflict_reason FROM scan_results WHERE scan_id = ?'
  ).all(scanId);
}

export function pruneOldResults(db, subnetId, keepScanId) {
  return db.prepare(`
    DELETE FROM scan_results WHERE scan_id IN (
      SELECT id FROM network_scans
      WHERE subnet_id = ? AND status = 'completed' AND id != ?
    )
  `).run(subnetId, keepScanId);
}
