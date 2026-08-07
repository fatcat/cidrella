/**
 * IP Address model, single owner of all ip_addresses table writes.
 *
 * All systems that need to create or update IP address records should
 * go through this module rather than writing inline SQL.
 */

import { getSetting } from '../db/init.js';
import { scannerCoveredSql } from '../utils/scan-coverage.js';
import { isLocalAddress } from '../utils/local-addresses.js';
import * as DnsRecord from './dns-record.js';

// The reason string the passive path stamps on an address it has never seen
// assigned. Exported because the self-heal below matches on it exactly rather
// than on a substring, so an unrelated rogue reason is never cleared by mistake.
export const PASSIVE_ROGUE_REASON = 'passive DNS query from unassigned address';

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
  const val = getSetting('ip_history_retention_days');
  const retentionDays = parseInt(val, 10) || 7;
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
    'SELECT id, hostname, mac_address, status, is_online FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
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
      // Edge-only, matching markOnline. Without this a liveness flip is
      // invisible in ip_events, which is how a lease-sync overwrite of the
      // scanner's verdict went unnoticed.
      if (!!is_online !== !!existing.is_online) {
        events.push({ type: is_online ? 'online' : 'offline' });
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

  // INSERT, set first_seen_at for new rows that show activity
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
 * UPDATE only, does not create rows for unknown IPs.
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
 * Everything that makes an address legitimately in use, for an address we hold no
 * ip_addresses row for. This mirrors the assignment map the scanner builds in
 * utils/scanner.js: an operator's manual A record, an active DHCP lease, or a
 * DHCP reservation. The scanner has always consulted all three. The passive path
 * consulted NONE of them, so any host that resolved a name while CIDRella had no
 * row for it was recorded as rogue, including hosts holding a valid lease.
 *
 * `hostname` is returned only for the DNS claim. A lease hostname is deliberately
 * NOT propagated into ip_addresses.hostname: that is the stale-name trap the
 * scanner warns about, where restored lease history keeps a name after the lease
 * is long gone.
 */
function addressClaim(db, subnetId, ip, row = null) {
  // An address the appliance itself holds is obviously in use, and by us.
  if (isLocalAddress(ip)) return { claimed: true, hostname: null };

  // Operator intent recorded on the row. `row` is optional only because not
  // every caller has one to hand, so pass it whenever you do.
  //
  // The scanner has always honored these two arms and the passive path never
  // did, which is the bug this parameter exists to close: an address flagged
  // rogue BEFORE an admin locked it stayed flagged forever on any subnet the
  // scanner does not cover. setStatus() does not clear is_rogue, and
  // computeIpView orders its rogue branch ahead of its locked branch, so such
  // a row rendered as ROGUE rather than LOCKED indefinitely.
  //
  // detection_source === 'dns' is a weaker signal than the live A-record check
  // below, because it can outlive the record that set it. It is kept because
  // the scanner has always honored it, and the two paths agreeing matters more
  // than trimming it. Dropping it is a separate decision with its own blast
  // radius, not something to smuggle into a unification.
  if (row) {
    if (row.status === 'locked' || row.status === 'assigned') return { claimed: true, hostname: null };
    if (row.detection_source === 'dns') return { claimed: true, hostname: null };
  }

  const dnsHostname = DnsRecord.dnsAssignedHostname(db, ip);
  if (dnsHostname) return { claimed: true, hostname: dnsHostname };

  const lease = db.prepare(`
    SELECT 1 FROM dhcp_leases
     WHERE subnet_id = ? AND ip_address = ?
       AND (expires_at = 'infinite' OR datetime(expires_at) > datetime('now'))
     LIMIT 1
  `).get(subnetId, ip);
  if (lease) return { claimed: true, hostname: null };

  const reservation = db.prepare(
    'SELECT 1 FROM dhcp_reservations WHERE subnet_id = ? AND ip_address = ? LIMIT 1'
  ).get(subnetId, ip);
  if (reservation) return { claimed: true, hostname: null };

  return { claimed: false, hostname: null };
}

/**
 * Has an admin declared this address, as opposed to CIDRella merely having
 * observed it? Declared addresses keep everything learned about them until the
 * admin removes the declaration. Observed ones are subject to cleanup.
 *
 * Declared means any of:
 *   - status 'locked' or 'assigned' (a manual assignment)
 *   - an enabled DHCP reservation
 *   - a manual A record in an enabled forward zone
 *
 * Deliberately NOT the same as addressClaim(), which also counts an active
 * lease. A live lease is an observation that expires on its own. It says
 * nothing about what the admin intends for the address.
 */
export function isAdminDeclared(db, row) {
  if (!row) return false;
  if (row.status === 'locked' || row.status === 'assigned') return true;

  const reservation = db.prepare(
    'SELECT 1 FROM dhcp_reservations WHERE subnet_id = ? AND ip_address = ? AND enabled = 1 LIMIT 1'
  ).get(row.subnet_id, row.ip_address);
  if (reservation) return true;

  return !!DnsRecord.dnsAssignedHostname(db, row.ip_address);
}

/**
 * Record passive activity for an IP address, such as a DNS query observed from
 * the host. Existing rows are marked online. Unknown rows can optionally be
 * created as rogue because the host proved it is using an address CIDRella did
 * not assign, but only when nothing else already claims that address.
 */
export function recordPassiveActivity(db, subnetId, ip, {
  mac,
  source = 'passive',
  createRogue = false,
  rogueReason = PASSIVE_ROGUE_REASON
} = {}) {
  // status and detection_source are selected because addressClaim() reads them.
  // They were missing here originally, which is why this path could not see the
  // operator-intent arms the scanner path honored.
  const existing = db.prepare(
    'SELECT id, is_rogue, rogue_reason, hostname, status, detection_source FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  const { claimed, hostname: dnsHostname } = addressClaim(db, subnetId, ip, existing);

  if (existing) {
    const result = markOnline(db, subnetId, ip, { mac, source });
    // Self-heal rows already mislabelled by the old behaviour. Scoped to the
    // "we never assigned this" reason on purpose: a MAC mismatch on a claimed
    // address is a real conflict and must survive.
    if (claimed && existing.is_rogue && existing.rogue_reason === PASSIVE_ROGUE_REASON) {
      clearRogue(db, subnetId, ip);
    }
    // Backfill the name DNS already assigns so the row reads correctly in the
    // UI. Survival across the offline sweep no longer depends on this: the
    // manual A record that produced the name is itself what makes the address
    // admin-declared (see isAdminDeclared).
    if (dnsHostname && !existing.hostname) {
      db.prepare("UPDATE ip_addresses SET hostname = ?, updated_at = datetime('now') WHERE id = ?")
        .run(dnsHostname, existing.id);
    }
    return result;
  }

  if (!createRogue && !claimed) return { changes: 0 };

  const isRogue = createRogue && !claimed;
  const result = db.prepare(`
    INSERT INTO ip_addresses (
      subnet_id, ip_address, status, is_online,
      last_seen_at, last_seen_mac, hostname,
      is_rogue, rogue_reason,
      first_seen_at, detection_source
    ) VALUES (
      ?, ?, 'available', 1,
      datetime('now'), ?, ?,
      ?, ?,
      datetime('now'), ?
    )
  `).run(subnetId, ip, mac || null, dnsHostname, isRogue ? 1 : 0, isRogue ? rogueReason : null, source);

  emit(db, result.lastInsertRowid, subnetId, ip, 'online', { source });
  if (isRogue) {
    emit(db, result.lastInsertRowid, subnetId, ip, 'rogue_detected', { newValue: rogueReason, source });
  }
  return result;
}

/**
 * Check whether an IP record should be kept when going offline.
 *
 * This answers "is there anything here worth keeping right now", NOT "should
 * this be kept forever". Those are different questions and conflating them
 * would delete a dynamic host's MAC the moment it went quiet, which is what the
 * retention window exists to decide. Only a row with nothing on it at all is
 * dropped here, such as a scan blip on an unassigned address.
 *
 * How long learned data then survives is clearStaleDynamicMetadata's call:
 * admin-declared addresses keep it indefinitely, dynamic ones age out.
 */
function shouldKeepOffline(db, row) {
  if (row.scan_enabled !== null && row.scan_enabled !== undefined) return true;
  if (row.hostname || row.mac_address || row.last_seen_mac) return true;
  return isAdminDeclared(db, row);
}

/**
 * Mark a single IP as offline. Also clears rogue status.
 * Ephemeral IPs (dynamic leases, rogues, scan-only) are deleted.
 */
export function markOffline(db, subnetId, ip) {
  const existing = db.prepare(
    'SELECT id, is_online, is_rogue, status, hostname, mac_address, last_seen_mac, scan_enabled, subnet_id, ip_address FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
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
 * Bulk staleness sweep: mark an address offline when nothing has been seen from
 * it within staleMinutes.
 *
 * Scoped to addresses the active scanner will never probe. Where the scanner
 * does run it owns both edges (it sets is_online from the probe result), and a
 * host that answers every scan would otherwise flap offline in the gap between
 * the short staleness window and the much longer scan interval. Coverage is
 * decided by the same predicate the scheduler uses, see utils/scan-coverage.js.
 *
 * Ephemeral IPs are deleted, declared ones are marked offline.
 * Also clears rogue status for stale IPs (rogue device went away).
 */
export function bulkMarkStale(db, staleMinutes) {
  const offset = `-${staleMinutes} minutes`;

  const staleIps = db.prepare(`
    SELECT ip.id, ip.subnet_id, ip.ip_address, ip.is_rogue, ip.status,
           ip.hostname, ip.mac_address, ip.last_seen_mac, ip.scan_enabled
    FROM ip_addresses ip
    JOIN subnets s ON s.id = ip.subnet_id
    WHERE ip.is_online = 1
      AND ip.last_seen_at < datetime('now', ?)
      AND NOT ${scannerCoveredSql('s', 'ip')}
  `).all(offset);

  const toDelete = [];
  const toUpdate = [];

  for (const row of staleIps) {
    emit(db, row.id, row.subnet_id, row.ip_address, 'offline', { source: 'stale' });
    if (row.is_rogue) {
      emit(db, row.id, row.subnet_id, row.ip_address, 'rogue_cleared', { source: 'stale' });
    }
    if (shouldKeepOffline(db, row)) {
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
 * Clear learned metadata from dynamically assigned addresses that have been
 * offline past the retention window. Reads offline_metadata_retention_days from
 * settings (default 7).
 *
 * Admin-declared addresses (static DNS record, DHCP reservation, locked or
 * assigned status) are never touched. They keep everything learned about them
 * until the admin deletes the declaration.
 *
 * Only the observed columns are cleared. Vendor, device type and OS family need
 * no handling: models/ip-view.js derives all three from the MAC at read time, so
 * clearing the MAC clears them too. The fingerprint itself lives in its own
 * MAC-keyed table, so an operator override survives and re-attaches if that MAC
 * comes back. Lease expiry likewise comes from a join, not a column here.
 *
 * A row with nothing left to say is deleted rather than left as an empty husk.
 */
export function clearStaleDynamicMetadata(db) {
  const val = getSetting('offline_metadata_retention_days');
  const retentionDays = parseInt(val, 10) || 7;
  const offset = `-${retentionDays} days`;

  const candidates = db.prepare(`
    SELECT id, subnet_id, ip_address, status, reservation_note, description, scan_enabled
    FROM ip_addresses
    WHERE is_online = 0
      AND last_seen_at IS NOT NULL
      AND last_seen_at < datetime('now', ?)
  `).all(offset);

  const toClear = [];
  const toDelete = [];

  for (const row of candidates) {
    if (isAdminDeclared(db, row)) continue;
    // Keeping anything an operator typed, plus a per-IP scan override.
    const hasOperatorData = !!row.reservation_note || !!row.description
      || (row.scan_enabled !== null && row.scan_enabled !== undefined);
    if (hasOperatorData) toClear.push(row.id);
    else toDelete.push(row.id);
  }

  if (toClear.length > 0) {
    const clearStmt = db.prepare(`
      UPDATE ip_addresses SET
        hostname = NULL, mac_address = NULL, last_seen_mac = NULL,
        last_seen_at = NULL, first_seen_at = NULL, last_scanned_at = NULL,
        detection_source = NULL, status = 'available',
        updated_at = datetime('now')
      WHERE id = ?
    `);
    for (const id of toClear) clearStmt.run(id);
  }

  if (toDelete.length > 0) {
    const deleteStmt = db.prepare('DELETE FROM ip_addresses WHERE id = ?');
    for (const id of toDelete) deleteStmt.run(id);
  }

  return { changes: toClear.length + toDelete.length, cleared: toClear.length, deleted: toDelete.length };
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
 * Remove any IP address rows that belong to the same MAC but are not the
 * current canonical DHCP lease row. DHCP leases are authoritative for a host's
 * current IP, so stale rows from prior leases/scans should not linger.
 */
export function removeOtherRowsForMac(db, subnetId, ip, mac) {
  if (!mac) return { changes: 0 };
  const normalizedMac = String(mac).toLowerCase();
  return db.prepare(`
    DELETE FROM ip_addresses
    WHERE (lower(mac_address) = ? OR lower(last_seen_mac) = ?)
      AND NOT (subnet_id = ? AND ip_address = ?)
  `).run(normalizedMac, normalizedMac, subnetId, ip);
}

/**
 * Clear DNS/hostname ownership for selected IP rows.
 */
export function clearHostnameByIds(db, ids) {
  const uniqueIds = [...new Set((ids || []).filter(id => id !== null && id !== undefined))];
  if (uniqueIds.length === 0) return { changes: 0 };

  const clearRow = db.prepare(
    "UPDATE ip_addresses SET hostname = NULL, detection_source = NULL, updated_at = datetime('now') WHERE id = ?"
  );
  let changes = 0;
  db.transaction(() => {
    for (const id of uniqueIds) changes += clearRow.run(id).changes;
  })();
  return { changes };
}

/**
 * Delete selected IP rows.
 */
export function deleteByIds(db, ids) {
  const uniqueIds = [...new Set((ids || []).filter(id => id !== null && id !== undefined))];
  if (uniqueIds.length === 0) return { changes: 0 };

  const remove = db.prepare('DELETE FROM ip_addresses WHERE id = ?');
  let changes = 0;
  db.transaction(() => {
    for (const id of uniqueIds) changes += remove.run(id).changes;
  })();
  return { changes };
}

export function deleteById(db, id) {
  if (id === null || id === undefined) return { changes: 0 };
  return deleteByIds(db, [id]);
}

export function deleteBySubnet(db, subnetId) {
  return db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(subnetId);
}

export function deleteByIpAddress(db, ip) {
  return db.prepare('DELETE FROM ip_addresses WHERE ip_address = ?').run(ip);
}

/**
 * Move one IP row to another subnet. If the target subnet already has a row
 * for the same IP, the existing target row is deleted and the moved row wins.
 * Lifecycle events are retargeted to the new subnet for subnet-scoped history.
 */
export function moveToSubnet(db, id, ip, targetSubnetId) {
  const dup = db.prepare(
    'SELECT id FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(targetSubnetId, ip);

  if (dup && dup.id !== id) deleteById(db, dup.id);

  const moved = db.prepare(
    "UPDATE ip_addresses SET subnet_id = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(targetSubnetId, id);

  db.prepare('UPDATE ip_events SET subnet_id = ? WHERE ip_address_id = ?')
    .run(targetSubnetId, id);

  return moved;
}

export function ensureAddress(db, subnetId, ip, status = 'available') {
  return db.prepare(
    'INSERT OR IGNORE INTO ip_addresses (subnet_id, ip_address, status) VALUES (?, ?, ?)'
  ).run(subnetId, ip, status);
}

export function ensureAddresses(db, subnetId, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return { changes: 0 };

  const insert = db.prepare(
    'INSERT OR IGNORE INTO ip_addresses (subnet_id, ip_address, status) VALUES (?, ?, ?)'
  );
  let changes = 0;
  for (const entry of entries) {
    const result = insert.run(subnetId, entry.ip, entry.status || 'available');
    changes += result.changes || 0;
  }
  return { changes };
}

/**
 * Clear stale DHCP assignment ownership while keeping recent last-seen
 * metadata for short-term display.
 */
export function clearDhcpAssignmentsByIds(db, ids) {
  const uniqueIds = [...new Set((ids || []).filter(id => id !== null && id !== undefined))];
  if (uniqueIds.length === 0) return { changes: 0 };

  const clear = db.prepare(`
    UPDATE ip_addresses
       SET status = 'available',
           is_online = 0,
           updated_at = datetime('now')
     WHERE id = ?
  `);
  let changes = 0;
  db.transaction(() => {
    for (const id of uniqueIds) changes += clear.run(id).changes;
  })();
  return { changes };
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
    'SELECT id, is_online, is_rogue, status, hostname, mac_address, last_seen_mac, scan_enabled, subnet_id, ip_address, detection_source FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  // Re-check: the scanner built its assignment map before this row was read, so
  // a reservation, lease, DNS record or operator lock may have appeared since.
  //
  // This asks addressClaim() rather than re-deriving the answer. It used to be
  // forty lines of inline checks that answered the same question with a
  // DIFFERENT set of arms from the passive path, and a fourth hand-rolled copy
  // of the static-DNS predicate that models/dns-record.js exists to centralize.
  // The two paths disagreeing is what left a locked address flagged rogue.
  let effectiveConflict = isConflict;
  let effectiveReason = conflictReason;
  if (isConflict && addressClaim(db, subnetId, ip, existing).claimed) {
    effectiveConflict = 0;
    effectiveReason = null;
  }

  if (existing) {
    if (!responded && !shouldKeepOffline(db, existing)) {
      emit(db, existing.id, subnetId, ip, 'scanned', { newValue: 'no_response', source: 'scanner' });
      if (existing.is_online) {
        emit(db, existing.id, subnetId, ip, 'offline', { source: 'scanner' });
      }
      if (existing.is_rogue) {
        emit(db, existing.id, subnetId, ip, 'rogue_cleared', { source: 'scanner' });
      }
      db.prepare('DELETE FROM ip_addresses WHERE id = ?').run(existing.id);
      return;
    }

    const updates = [
      'is_online = ?',
      "last_scanned_at = datetime('now')",
      'detection_source = COALESCE(detection_source, ?)',
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
    // Rogue device with no existing record, create one
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
 * Upserts, creates the row if it doesn't exist.
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
 * Upserts, creates the row if it doesn't exist.
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
