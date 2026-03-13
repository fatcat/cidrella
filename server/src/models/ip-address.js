/**
 * IP Address model — single owner of all ip_addresses table writes.
 *
 * All systems that need to create or update IP address records should
 * go through this module rather than writing inline SQL.
 */

/**
 * Record an IP lifecycle event.
 */
function emit(db, ipAddressId, subnetId, ip, eventType, { oldValue, newValue, source } = {}) {
  db.prepare(`
    INSERT INTO ip_events (ip_address_id, subnet_id, ip_address, event_type, old_value, new_value, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ipAddressId, subnetId, ip, eventType, oldValue ?? null, newValue ?? null, source ?? null);
}

/**
 * Prune ip_events older than the configured retention period.
 * Reads ip_history_retention_days from settings (default 7).
 */
export function pruneEvents(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ip_history_retention_days'").get();
  const retentionDays = parseInt(row?.value, 10) || 7;
  const offset = `-${retentionDays} days`;
  return db.prepare(`
    DELETE FROM ip_events WHERE created_at < datetime('now', ?)
  `).run(offset);
}

/**
 * Get events for a specific IP, newest first.
 */
export function getEvents(db, ipAddressId, { limit = 50 } = {}) {
  return db.prepare(`
    SELECT * FROM ip_events WHERE ip_address_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(ipAddressId, limit);
}

/**
 * Get events for a subnet within a time window, newest first.
 */
export function getSubnetEvents(db, subnetId, { hours = 24, limit = 200 } = {}) {
  const offset = `-${hours} hours`;
  return db.prepare(`
    SELECT * FROM ip_events WHERE subnet_id = ? AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT ?
  `).all(subnetId, offset, limit);
}

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
    const events = [];

    if (hostname !== undefined && hostname !== existing.hostname) {
      updates.push('hostname = ?');
      params.push(hostname);
      events.push({ type: 'hostname_changed', old: existing.hostname, new: hostname });
    }
    if (mac_address !== undefined && mac_address !== existing.mac_address) {
      updates.push('mac_address = ?');
      params.push(mac_address);
      events.push({ type: 'mac_changed', old: existing.mac_address, new: mac_address });
    }
    if (status !== undefined && status !== existing.status) {
      updates.push('status = ?');
      params.push(status);
      events.push({ type: 'status_changed', old: existing.status, new: status });
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
      for (const e of events) {
        emit(db, existing.id, subnetId, ip, e.type, { oldValue: e.old, newValue: e.new, source: detection_source });
      }
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
  const existing = db.prepare(
    'SELECT id, is_online FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);
  if (!existing) return { changes: 0 };

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

  params.push(existing.id);
  const result = db.prepare(
    `UPDATE ip_addresses SET ${updates.join(', ')} WHERE id = ?`
  ).run(...params);

  if (!existing.is_online) {
    emit(db, existing.id, subnetId, ip, 'online', { source });
  }

  return result;
}

/**
 * Check whether an IP record should be kept when going offline.
 * Persistent reasons: manual status (locked/assigned), DNS hostname,
 * DHCP reservation, or per-IP scan override.
 */
function shouldKeepOffline(db, row) {
  if (row.status === 'locked' || row.status === 'assigned') return true;
  if (row.hostname) return true;
  if (row.scan_enabled !== null && row.scan_enabled !== undefined) return true;
  const hasReservation = db.prepare(
    'SELECT 1 FROM dhcp_reservations WHERE subnet_id = ? AND ip_address = ? LIMIT 1'
  ).get(row.subnet_id, row.ip_address);
  if (hasReservation) return true;
  return false;
}

/**
 * Mark a single IP as offline. Also clears rogue status.
 * Ephemeral IPs (dynamic leases, rogues, scan-only) are deleted.
 */
export function markOffline(db, subnetId, ip) {
  const existing = db.prepare(
    'SELECT id, is_online, is_rogue, status, hostname, scan_enabled, subnet_id, ip_address FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);
  if (!existing) return { changes: 0 };

  if (existing.is_online) {
    emit(db, existing.id, subnetId, ip, 'offline');
  }
  if (existing.is_rogue) {
    emit(db, existing.id, subnetId, ip, 'rogue_cleared', { source: 'offline' });
  }

  if (!shouldKeepOffline(db, existing)) {
    return db.prepare('DELETE FROM ip_addresses WHERE id = ?').run(existing.id);
  }

  return db.prepare(`
    UPDATE ip_addresses SET
      is_online = 0, is_rogue = 0, rogue_reason = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(existing.id);
}

/**
 * Bulk staleness sweep: mark IPs offline if not seen within staleMinutes.
 * Ephemeral IPs are deleted; persistent IPs are marked offline.
 * Also clears rogue status for stale IPs (rogue device went away).
 */
export function bulkMarkStale(db, staleMinutes) {
  const offset = `-${staleMinutes} minutes`;

  const staleIps = db.prepare(`
    SELECT ip.id, ip.subnet_id, ip.ip_address, ip.is_rogue, ip.status,
           ip.hostname, ip.scan_enabled,
           (dr.id IS NOT NULL) AS has_reservation
    FROM ip_addresses ip
    LEFT JOIN dhcp_reservations dr
      ON dr.subnet_id = ip.subnet_id AND dr.ip_address = ip.ip_address
    WHERE ip.is_online = 1 AND ip.last_seen_at < datetime('now', ?)
  `).all(offset);

  const toDelete = [];
  const toUpdate = [];

  for (const row of staleIps) {
    emit(db, row.id, row.subnet_id, row.ip_address, 'offline', { source: 'stale' });
    if (row.is_rogue) {
      emit(db, row.id, row.subnet_id, row.ip_address, 'rogue_cleared', { source: 'stale' });
    }
    const keep = row.status === 'locked' || row.status === 'assigned'
      || row.hostname || row.scan_enabled !== null || row.has_reservation;
    if (keep) {
      toUpdate.push(row.id);
    } else {
      toDelete.push(row.id);
    }
  }

  if (toUpdate.length > 0) {
    const updateStmt = db.prepare(`
      UPDATE ip_addresses SET
        is_online = 0, is_rogue = 0, rogue_reason = NULL,
        updated_at = datetime('now')
      WHERE id = ?
    `);
    for (const id of toUpdate) updateStmt.run(id);
  }

  if (toDelete.length > 0) {
    const deleteStmt = db.prepare('DELETE FROM ip_addresses WHERE id = ?');
    for (const id of toDelete) deleteStmt.run(id);
  }

  return { changes: toUpdate.length + toDelete.length, deleted: toDelete.length, updated: toUpdate.length };
}

/**
 * Set rogue status on a single IP.
 */
export function setRogue(db, subnetId, ip, reason) {
  const existing = db.prepare(
    'SELECT id FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  const result = db.prepare(`
    UPDATE ip_addresses SET
      is_rogue = 1, rogue_reason = ?,
      updated_at = datetime('now')
    WHERE subnet_id = ? AND ip_address = ?
  `).run(reason, subnetId, ip);

  if (existing) {
    emit(db, existing.id, subnetId, ip, 'rogue_detected', { newValue: reason, source: 'scanner' });
  }
  return result;
}

/**
 * Clear rogue status on a single IP.
 */
export function clearRogue(db, subnetId, ip) {
  const existing = db.prepare(
    'SELECT id, is_rogue FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  if (!existing || !existing.is_rogue) return { changes: 0 };

  const result = db.prepare(`
    UPDATE ip_addresses SET
      is_rogue = 0, rogue_reason = NULL,
      updated_at = datetime('now')
    WHERE subnet_id = ? AND ip_address = ?
  `).run(subnetId, ip);

  emit(db, existing.id, subnetId, ip, 'rogue_cleared');
  return result;
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
    'SELECT id, is_online, is_rogue, status FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  // Re-check: if scanner says conflict but the IP now has a static assignment
  // (reservation/DNS added after the assignment map was built), don't mark rogue
  let effectiveConflict = isConflict;
  let effectiveReason = conflictReason;
  if (isConflict && existing && existing.status !== 'available') {
    effectiveConflict = 0;
    effectiveReason = null;
  } else if (isConflict) {
    const hasReservation = db.prepare(
      'SELECT 1 FROM dhcp_reservations WHERE subnet_id = ? AND ip_address = ? LIMIT 1'
    ).get(subnetId, ip);
    if (hasReservation) {
      effectiveConflict = 0;
      effectiveReason = null;
    }
  }

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
    params.push(effectiveConflict ? 1 : 0);
    updates.push('rogue_reason = ?');
    params.push(effectiveConflict ? effectiveReason : null);

    params.push(existing.id);
    db.prepare(`UPDATE ip_addresses SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // Emit lifecycle events for state transitions
    emit(db, existing.id, subnetId, ip, 'scanned', { newValue: responded ? 'responded' : 'no_response', source: 'scanner' });
    if (responded && !existing.is_online) {
      emit(db, existing.id, subnetId, ip, 'online', { source: 'scanner' });
    } else if (!responded && existing.is_online) {
      emit(db, existing.id, subnetId, ip, 'offline', { source: 'scanner' });
    }
    if (effectiveConflict && !existing.is_rogue) {
      emit(db, existing.id, subnetId, ip, 'rogue_detected', { newValue: effectiveReason, source: 'scanner' });
    } else if (!effectiveConflict && existing.is_rogue) {
      emit(db, existing.id, subnetId, ip, 'rogue_cleared', { source: 'scanner' });
    }
  } else if (responded) {
    // Rogue device with no existing record — create one
    // Re-check for reservation before inserting as rogue
    if (effectiveConflict) {
      const hasReservation = db.prepare(
        'SELECT 1 FROM dhcp_reservations WHERE subnet_id = ? AND ip_address = ? LIMIT 1'
      ).get(subnetId, ip);
      if (hasReservation) {
        effectiveConflict = 0;
        effectiveReason = null;
      }
    }
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
      effectiveConflict ? 1 : 0, effectiveConflict ? effectiveReason : null
    );
    const newId = db.prepare(
      'SELECT id FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
    ).get(subnetId, ip).id;
    emit(db, newId, subnetId, ip, 'scanned', { newValue: 'responded', source: 'scanner' });
    emit(db, newId, subnetId, ip, 'online', { source: 'scanner' });
    if (effectiveConflict) {
      emit(db, newId, subnetId, ip, 'rogue_detected', { newValue: effectiveReason, source: 'scanner' });
    }
  }
  // If no existing row and didn't respond, nothing to record
}

/**
 * Set IP status and reservation note (manual lock/unlock/assign).
 * Upserts — creates the row if it doesn't exist.
 */
export function setStatus(db, subnetId, ip, status, reservationNote = null) {
  const existing = db.prepare(
    'SELECT id, status as old_status FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  if (existing) {
    db.prepare(`
      UPDATE ip_addresses SET
        status = ?, reservation_note = ?, detection_source = 'manual',
        updated_at = datetime('now')
      WHERE id = ?
    `).run(status, reservationNote, existing.id);
    if (status !== existing.old_status) {
      emit(db, existing.id, subnetId, ip, 'status_changed', { oldValue: existing.old_status, newValue: status, source: 'manual' });
    }
  } else {
    db.prepare(`
      INSERT INTO ip_addresses (subnet_id, ip_address, status, reservation_note, detection_source)
      VALUES (?, ?, ?, ?, 'manual')
    `).run(subnetId, ip, status, reservationNote);
    const newId = db.prepare(
      'SELECT id FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
    ).get(subnetId, ip).id;
    emit(db, newId, subnetId, ip, 'status_changed', { newValue: status, source: 'manual' });
  }
}

/**
 * Set per-IP scan-enabled override.
 * Upserts — creates the row if it doesn't exist.
 */
export function setScanEnabled(db, subnetId, ip, scanEnabled) {
  const existing = db.prepare(
    'SELECT id, scan_enabled as old_scan FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  if (existing) {
    db.prepare(
      "UPDATE ip_addresses SET scan_enabled = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(scanEnabled, existing.id);
    const oldLabel = existing.old_scan === 1 ? 'enabled' : existing.old_scan === 0 ? 'disabled' : 'inherit';
    const newLabel = scanEnabled === 1 || scanEnabled === true ? 'enabled' : scanEnabled === 0 || scanEnabled === false ? 'disabled' : 'inherit';
    if (oldLabel !== newLabel) {
      emit(db, existing.id, subnetId, ip, 'scan_enabled_changed', { oldValue: oldLabel, newValue: newLabel, source: 'manual' });
    }
  } else {
    db.prepare(
      "INSERT INTO ip_addresses (subnet_id, ip_address, status, scan_enabled) VALUES (?, ?, 'available', ?)"
    ).run(subnetId, ip, scanEnabled);
    const newId = db.prepare(
      'SELECT id FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
    ).get(subnetId, ip).id;
    const newLabel = scanEnabled === 1 || scanEnabled === true ? 'enabled' : scanEnabled === 0 || scanEnabled === false ? 'disabled' : 'inherit';
    emit(db, newId, subnetId, ip, 'scan_enabled_changed', { newValue: newLabel, source: 'manual' });
  }
}

/**
 * Emit an event for a known IP record. Used by external modules (ip-sync, etc.)
 * that need to record lifecycle events after calling model write methods.
 */
export function emitEvent(db, subnetId, ip, eventType, { oldValue, newValue, source } = {}) {
  const existing = db.prepare(
    'SELECT id FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);
  if (existing) {
    emit(db, existing.id, subnetId, ip, eventType, { oldValue, newValue, source });
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
