/**
 * IP Address model — single owner of all ip_addresses table writes.
 *
 * All systems that need to create or update IP address records should
 * go through this module rather than writing inline SQL.
 */

/**
 * Core upsert: ensure an ip_addresses row exists, then update provided fields.
 * Only updates fields that are explicitly provided (not undefined).
 * Never overwrites first_seen_at on UPDATE (write-once).
 */
export function upsert(db, subnetId, ip, fields = {}) {
  const {
    hostname, mac_address, status, is_online, last_seen_mac,
    is_rogue, rogue_reason, last_scanned_at, detection_source
  } = fields;

  const existing = db.prepare(
    'SELECT id, hostname, mac_address, status FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  if (existing) {
    const updates = [];
    const params = [];

    if (hostname !== undefined && hostname !== existing.hostname) {
      updates.push('hostname = ?');
      params.push(hostname);
    }
    if (mac_address !== undefined && mac_address !== existing.mac_address) {
      updates.push('mac_address = ?');
      params.push(mac_address);
    }
    if (status !== undefined && status !== existing.status) {
      updates.push('status = ?');
      params.push(status);
    }
    if (is_online !== undefined) {
      updates.push('is_online = ?');
      params.push(is_online);
      if (is_online) {
        updates.push("last_seen_at = datetime('now')");
        updates.push("first_seen_at = COALESCE(first_seen_at, datetime('now'))");
      }
    }
    if (last_seen_mac !== undefined) {
      updates.push('last_seen_mac = ?');
      params.push(last_seen_mac);
    }
    if (is_rogue !== undefined) {
      updates.push('is_rogue = ?');
      params.push(is_rogue);
    }
    if (rogue_reason !== undefined) {
      updates.push('rogue_reason = ?');
      params.push(rogue_reason);
    }
    if (last_scanned_at !== undefined) {
      updates.push('last_scanned_at = ?');
      params.push(last_scanned_at);
    }
    if (detection_source !== undefined) {
      updates.push('detection_source = ?');
      params.push(detection_source);
    }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(existing.id);
      db.prepare(`UPDATE ip_addresses SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
    return existing.id;
  }

  // INSERT — set first_seen_at for new rows that show activity
  const hasActivity = is_online || mac_address || last_seen_mac;
  const result = db.prepare(`
    INSERT INTO ip_addresses (
      subnet_id, ip_address, hostname, mac_address, status,
      is_online, last_seen_at, last_seen_mac,
      is_rogue, rogue_reason, last_scanned_at,
      first_seen_at, detection_source
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ${is_online ? "datetime('now')" : 'NULL'}, ?,
      ?, ?, ?,
      ${hasActivity ? "datetime('now')" : 'NULL'}, ?
    )
  `).run(
    subnetId, ip, hostname || null, mac_address || null, status || 'available',
    is_online || 0, last_seen_mac || null,
    is_rogue || 0, rogue_reason || null, last_scanned_at || null,
    detection_source || null
  );
  return result.lastInsertRowid;
}

/**
 * Mark an IP as online. Sets is_online=1, last_seen_at, first_seen_at (if unset).
 * UPDATE only — does not create rows for unknown IPs.
 */
export function markOnline(db, subnetId, ip, { mac, source } = {}) {
  const updates = [
    'is_online = 1',
    "last_seen_at = datetime('now')",
    "first_seen_at = COALESCE(first_seen_at, datetime('now'))",
    "updated_at = datetime('now')"
  ];
  const params = [];

  if (mac) {
    updates.push('last_seen_mac = ?');
    params.push(mac);
  }
  if (source) {
    updates.push('detection_source = ?');
    params.push(source);
  }

  params.push(subnetId, ip);
  return db.prepare(
    `UPDATE ip_addresses SET ${updates.join(', ')} WHERE subnet_id = ? AND ip_address = ?`
  ).run(...params);
}

/**
 * Mark a single IP as offline. Also clears rogue status.
 */
export function markOffline(db, subnetId, ip) {
  return db.prepare(`
    UPDATE ip_addresses SET
      is_online = 0, is_rogue = 0, rogue_reason = NULL,
      updated_at = datetime('now')
    WHERE subnet_id = ? AND ip_address = ?
  `).run(subnetId, ip);
}

/**
 * Bulk staleness sweep: mark IPs offline if not seen within staleMinutes.
 * Also clears rogue status for stale IPs (rogue device went away).
 */
export function bulkMarkStale(db, staleMinutes) {
  const offset = `-${staleMinutes} minutes`;
  return db.prepare(`
    UPDATE ip_addresses SET
      is_online = 0, is_rogue = 0, rogue_reason = NULL,
      updated_at = datetime('now')
    WHERE is_online = 1 AND last_seen_at < datetime('now', ?)
  `).run(offset);
}

/**
 * Set rogue status on a single IP.
 */
export function setRogue(db, subnetId, ip, reason) {
  return db.prepare(`
    UPDATE ip_addresses SET
      is_rogue = 1, rogue_reason = ?,
      updated_at = datetime('now')
    WHERE subnet_id = ? AND ip_address = ?
  `).run(reason, subnetId, ip);
}

/**
 * Clear rogue status on a single IP.
 */
export function clearRogue(db, subnetId, ip) {
  return db.prepare(`
    UPDATE ip_addresses SET
      is_rogue = 0, rogue_reason = NULL,
      updated_at = datetime('now')
    WHERE subnet_id = ? AND ip_address = ?
  `).run(subnetId, ip);
}

/**
 * Bulk clear rogue for all IPs in a subnet, except those in the provided set.
 * Used after a scan to clear rogue on IPs that are no longer conflicting.
 */
export function clearRogueForSubnet(db, subnetId, exceptIps = new Set()) {
  if (exceptIps.size === 0) {
    return db.prepare(`
      UPDATE ip_addresses SET
        is_rogue = 0, rogue_reason = NULL,
        updated_at = datetime('now')
      WHERE subnet_id = ? AND is_rogue = 1
    `).run(subnetId);
  }

  // Build placeholders for the exception list
  const placeholders = [...exceptIps].map(() => '?').join(', ');
  return db.prepare(`
    UPDATE ip_addresses SET
      is_rogue = 0, rogue_reason = NULL,
      updated_at = datetime('now')
    WHERE subnet_id = ? AND is_rogue = 1 AND ip_address NOT IN (${placeholders})
  `).run(subnetId, ...exceptIps);
}

/**
 * Update an IP from scan results. Handles liveness, MAC capture, rogue state,
 * and last_scanned_at in a single operation.
 * Creates a new row if the IP responded but has no existing record (rogue device).
 */
export function updateFromScan(db, subnetId, ip, { responded, mac, isConflict, conflictReason }) {
  const existing = db.prepare(
    'SELECT id FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  if (existing) {
    const updates = [
      'is_online = ?',
      "last_scanned_at = datetime('now')",
      'detection_source = ?',
      "updated_at = datetime('now')"
    ];
    const params = [responded ? 1 : 0, 'scanner'];

    if (responded) {
      updates.push("last_seen_at = datetime('now')");
      updates.push("first_seen_at = COALESCE(first_seen_at, datetime('now'))");
    }
    if (mac) {
      updates.push('last_seen_mac = ?');
      params.push(mac);
      // Only set mac_address if currently empty
      updates.push("mac_address = CASE WHEN mac_address IS NULL OR mac_address = '' THEN ? ELSE mac_address END");
      params.push(mac);
    }

    updates.push('is_rogue = ?');
    params.push(isConflict ? 1 : 0);
    updates.push('rogue_reason = ?');
    params.push(isConflict ? conflictReason : null);

    params.push(existing.id);
    db.prepare(`UPDATE ip_addresses SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  } else if (responded) {
    // Rogue device with no existing record — create one
    db.prepare(`
      INSERT INTO ip_addresses (
        subnet_id, ip_address, status, is_online,
        last_seen_at, last_seen_mac, mac_address,
        is_rogue, rogue_reason, last_scanned_at,
        first_seen_at, detection_source
      ) VALUES (
        ?, ?, 'available', 1,
        datetime('now'), ?, ?,
        ?, ?, datetime('now'),
        datetime('now'), 'scanner'
      )
    `).run(
      subnetId, ip,
      mac || null, mac || null,
      isConflict ? 1 : 0, isConflict ? conflictReason : null
    );
  }
  // If no existing row and didn't respond, nothing to record
}

/**
 * Set IP status and reservation note (manual lock/unlock/assign).
 * Upserts — creates the row if it doesn't exist.
 */
export function setStatus(db, subnetId, ip, status, reservationNote = null) {
  const existing = db.prepare(
    'SELECT id FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  if (existing) {
    db.prepare(`
      UPDATE ip_addresses SET
        status = ?, reservation_note = ?, detection_source = 'manual',
        updated_at = datetime('now')
      WHERE id = ?
    `).run(status, reservationNote, existing.id);
  } else {
    db.prepare(`
      INSERT INTO ip_addresses (subnet_id, ip_address, status, reservation_note, detection_source)
      VALUES (?, ?, ?, ?, 'manual')
    `).run(subnetId, ip, status, reservationNote);
  }
}

/**
 * Set per-IP scan-enabled override.
 * Upserts — creates the row if it doesn't exist.
 */
export function setScanEnabled(db, subnetId, ip, scanEnabled) {
  const existing = db.prepare(
    'SELECT id FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  if (existing) {
    db.prepare(
      "UPDATE ip_addresses SET scan_enabled = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(scanEnabled, existing.id);
  } else {
    db.prepare(
      "INSERT INTO ip_addresses (subnet_id, ip_address, status, scan_enabled) VALUES (?, ?, 'available', ?)"
    ).run(subnetId, ip, scanEnabled);
  }
}

/**
 * Find an IP record by subnet and address.
 */
export function findBySubnetAndIp(db, subnetId, ip) {
  return db.prepare(
    'SELECT * FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);
}

/**
 * Prune old scan_results: keep only the latest completed scan per subnet.
 */
export function pruneOldScanResults(db, subnetId, keepScanId) {
  return db.prepare(`
    DELETE FROM scan_results WHERE scan_id IN (
      SELECT id FROM network_scans
      WHERE subnet_id = ? AND status = 'completed' AND id != ?
    )
  `).run(subnetId, keepScanId);
}
