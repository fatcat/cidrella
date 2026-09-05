/**
 * IP Address model, single owner of all ip_addresses table writes.
 *
 * All systems that need to create or update IP address records should
 * go through this module rather than writing inline SQL.
 */

import { getSetting } from '../db/init.js';
import { activeLeaseSql } from '../utils/lease-sql.js';
import { scannerCoveredSql } from '../utils/scan-coverage.js';
import { canonicalizeIp, parseIp, sortKey } from '../utils/address.js';

// The reason string the passive path stamps on an unassigned address.
export const PASSIVE_ROGUE_REASON = 'passive DNS query from unassigned address';

function canonicalIdentity(ip, interfaceId) {
  const parsed = parseIp(ip);
  if (!parsed) throw new Error(`Invalid IP address: ${ip}`);
  if (interfaceId !== undefined && interfaceId !== null && typeof interfaceId !== 'string') {
    throw new Error('Interface context must be a string');
  }
  const explicitInterface = interfaceId?.trim() || null;
  const parsedInterface = parsed.zoneId?.trim() || null;
  const effectiveInterface = explicitInterface ?? parsedInterface;
  if (parsedInterface && explicitInterface && parsedInterface !== explicitInterface) {
    throw new Error('IPv6 zone identifier does not match interface context');
  }
  if (effectiveInterface && !/^[a-zA-Z0-9._:-]{1,64}$/.test(effectiveInterface)) {
    throw new Error('Invalid interface context');
  }
  const isV6LinkLocal = parsed.bits === 128
    && parsed.value >= 0xfe800000000000000000000000000000n
    && parsed.value <= 0xfebfffffffffffffffffffffffffffffn;
  if (isV6LinkLocal && !effectiveInterface) {
    throw new Error('IPv6 link-local addresses require interface context');
  }
  if (!isV6LinkLocal && effectiveInterface) {
    throw new Error('Interface context is only valid for IPv6 link-local addresses');
  }
  const canonical = canonicalizeIp(ip);
  return {
    ip: canonical,
    addressFamily: parsed.bits === 32 ? 4 : 6,
    addressSortKey: sortKey(canonical),
    interfaceId: effectiveInterface
  };
}

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
  const identity = canonicalIdentity(ip, fields.interface_id);
  ip = identity.ip;
  const {
    hostname, mac_address, is_online, last_seen_mac,
    is_rogue, rogue_reason, last_scanned_at, detection_source,
    allocation_state, allocation_source_type, allocation_source_id,
    preferred_until, valid_until, dhcp_version, dhcp_duid, dhcp_iaid,
    reservation_note, scan_enabled
  } = fields;

  const existing = db.prepare(`
    SELECT id, hostname, mac_address, is_online, allocation_state,
           allocation_source_type, allocation_source_id, preferred_until,
           valid_until, dhcp_version, dhcp_duid, dhcp_iaid,
           reservation_note, scan_enabled
    FROM ip_addresses
    WHERE subnet_id = ? AND ip_address = ?
      AND COALESCE(interface_id, '') = COALESCE(?, '')
  `).get(subnetId, ip, identity.interfaceId);

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
    if (is_online !== undefined) {
      updates.push('is_online = ?');
      params.push(is_online);
      if (is_online) {
        updates.push("last_seen_at = datetime('now')");
        updates.push("first_seen_at = COALESCE(first_seen_at, datetime('now'))");
        updates.push('offline_since_at = NULL');
      } else {
        updates.push("offline_since_at = COALESCE(offline_since_at, datetime('now'))");
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
    for (const [column, value] of [
      ['allocation_state', allocation_state],
      ['allocation_source_type', allocation_source_type],
      ['allocation_source_id', allocation_source_id],
      ['preferred_until', preferred_until],
      ['valid_until', valid_until],
      ['dhcp_version', dhcp_version],
      ['dhcp_duid', dhcp_duid],
      ['dhcp_iaid', dhcp_iaid],
      ['reservation_note', reservation_note],
      ['scan_enabled', scan_enabled]
    ]) {
      if (value !== undefined && value !== existing[column]) {
        updates.push(`${column} = ?`);
        params.push(value);
        if (column === 'allocation_state') {
          events.push({ type: 'allocation_changed', old: existing.allocation_state, new: value });
        }
      }
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
      subnet_id, ip_address, hostname, mac_address,
      is_online, last_seen_at, last_seen_mac,
      is_rogue, rogue_reason, last_scanned_at,
      first_seen_at, detection_source, allocation_state,
      allocation_source_type, allocation_source_id, address_family,
      address_sort_key, interface_id, preferred_until, valid_until, dhcp_version,
      dhcp_duid, dhcp_iaid, reservation_note, scan_enabled, offline_since_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ${is_online ? "datetime('now')" : 'NULL'}, ?,
      ?, ?, ?,
      ${hasActivity ? "datetime('now')" : 'NULL'}, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
    )
  `).run(
    subnetId, ip, hostname || null, mac_address || null,
    is_online || 0, last_seen_mac || null,
    is_rogue || 0, rogue_reason || null, last_scanned_at || null,
    detection_source || null, allocation_state || 'unassigned',
    allocation_source_type || null, allocation_source_id || null,
    identity.addressFamily, identity.addressSortKey, identity.interfaceId,
    preferred_until || null, valid_until || null, dhcp_version || null,
    dhcp_duid || null, dhcp_iaid ?? null, reservation_note || null, scan_enabled ?? null
  );
  if (allocation_state && allocation_state !== 'unassigned') {
    emit(db, result.lastInsertRowid, subnetId, ip, 'allocation_changed', {
      oldValue: 'unassigned', newValue: allocation_state, source: allocation_source_type || detection_source
    });
  }
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
    'offline_since_at = NULL',
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
 * Canonical allocation is the only claim authority. Protocol writers must
 * establish it before observation paths evaluate liveness or rogue state.
 */
function addressClaim(row) {
  return Boolean(row?.allocation_state && row.allocation_state !== 'unassigned');
}

/**
 * Has an admin declared this address, as opposed to CIDRella merely having
 * observed it? Declared addresses keep everything learned about them until the
 * admin removes the declaration. Observed ones are subject to cleanup.
 *
 * Declared means a canonical administrative or static allocation.
 *
 * Deliberately NOT the same as addressClaim(), which also counts an active
 * lease. A live lease is an observation that expires on its own. It says
 * nothing about what the admin intends for the address.
 */
export function isAdminDeclared(db, row) {
  void db;
  if (!row) return false;
  return ['reserved', 'static_dns', 'static_dhcp', 'system', 'gateway']
    .includes(row.allocation_state);
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
  const existing = db.prepare(
    'SELECT id, is_rogue, rogue_reason, hostname, allocation_state FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  const claimed = addressClaim(existing);

  if (existing) {
    const result = markOnline(db, subnetId, ip, { mac, source });
    return result;
  }

  if (!createRogue && !claimed) return { changes: 0 };

  const isRogue = createRogue && !claimed;
  const newId = upsert(db, subnetId, ip, {
    is_online: 1,
    last_seen_mac: mac || null,
    is_rogue: isRogue ? 1 : 0,
    rogue_reason: isRogue ? rogueReason : null,
    detection_source: source,
    allocation_state: 'unassigned',
    allocation_source_type: null
  });

  emit(db, newId, subnetId, ip, 'online', { source });
  if (isRogue) {
    emit(db, newId, subnetId, ip, 'rogue_detected', { newValue: rogueReason, source });
  }
  return { changes: 1, lastInsertRowid: newId };
}

/**
 * Mark a single IP as offline and start its continuous-offline interval.
 * Learned data and rogue evidence survive until the retirement boundary.
 */
export function markOffline(db, subnetId, ip) {
  const existing = db.prepare(
    'SELECT id, is_online, is_rogue FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);
  if (!existing) return { changes: 0 };

  if (existing.is_online) {
    emit(db, existing.id, subnetId, ip, 'offline');
  }
  if (existing.is_rogue) {
    emit(db, existing.id, subnetId, ip, 'rogue_cleared', { source: 'offline' });
  }
  return db.prepare(`
    UPDATE ip_addresses SET
      is_online = 0, is_rogue = 0,
      offline_since_at = COALESCE(offline_since_at, datetime('now')),
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
 * Every stale row is retained until its one-hour retirement boundary. This
 * function owns only the online-to-offline edge.
 */
export function bulkMarkStale(db, staleMinutes) {
  const offset = `-${staleMinutes} minutes`;

  const staleIps = db.prepare(`
    SELECT ip.id, ip.subnet_id, ip.ip_address, ip.is_rogue,
           ip.hostname, ip.mac_address, ip.last_seen_mac, ip.scan_enabled
    FROM ip_addresses ip
    JOIN subnets s ON s.id = ip.subnet_id
    WHERE ip.is_online = 1
      AND ip.last_seen_at < datetime('now', ?)
      AND NOT ${scannerCoveredSql('s', 'ip')}
  `).all(offset);

  for (const row of staleIps) {
    emit(db, row.id, row.subnet_id, row.ip_address, 'offline', { source: 'stale' });
    if (row.is_rogue) {
      emit(db, row.id, row.subnet_id, row.ip_address, 'rogue_cleared', { source: 'stale' });
    }
  }

  if (staleIps.length > 0) {
    const updateStmt = db.prepare(`
      UPDATE ip_addresses SET
        is_online = 0, is_rogue = 0,
        offline_since_at = COALESCE(offline_since_at, datetime('now')),
        updated_at = datetime('now')
      WHERE id = ?
    `);
    for (const row of staleIps) updateStmt.run(row.id);
  }

  return { changes: staleIps.length, deleted: 0, updated: staleIps.length };
}

/**
 * Return a bounded batch whose continuous offline interval has reached the
 * fixed retirement boundary. Static and still-valid SLAAC allocations are not
 * candidates.
 */
export function findRetirementCandidates(db, cutoff, now, limit = 500) {
  return db.prepare(`
    SELECT *
    FROM ip_addresses
    WHERE is_online = 0
      AND offline_since_at IS NOT NULL
      AND datetime(offline_since_at) <= datetime(?)
      AND (
        allocation_state = 'dynamic_dhcp'
        OR (allocation_state = 'slaac' AND valid_until IS NOT NULL AND datetime(valid_until) <= datetime(?))
        OR (
          allocation_state = 'unassigned'
          AND NOT EXISTS (
            SELECT 1 FROM dhcp_reservations dr
            WHERE dr.subnet_id = ip_addresses.subnet_id
              AND dr.ip_address = ip_addresses.ip_address
              AND dr.enabled = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM dns_records r
            JOIN dns_zones z ON z.id = r.zone_id
            WHERE r.type = 'A' AND r.enabled = 1 AND z.enabled = 1
              AND z.type = 'forward'
              AND COALESCE(r.source, 'manual') = 'manual'
              AND r.value = ip_addresses.ip_address
          )
          AND (is_rogue = 1 OR detection_source IN (
            'dhcp_lease', 'slaac', 'scanner', 'passive', 'neighbor_discovery'
          ))
        )
      )
    ORDER BY datetime(offline_since_at), id
    LIMIT ?
  `).all(cutoff, now, limit);
}

export function startMissingRetirementWindows(db, now) {
  return db.prepare(`
    UPDATE ip_addresses
    SET offline_since_at = datetime(?), updated_at = datetime('now')
    WHERE is_online = 0
      AND offline_since_at IS NULL
      AND (
        allocation_state IN ('dynamic_dhcp', 'slaac')
        OR is_rogue = 1
        OR detection_source IN ('dhcp_lease', 'slaac', 'scanner', 'passive', 'neighbor_discovery')
      )
  `).run(now);
}

/**
 * Clear address-bound observations while retaining identity and any fields an
 * operator authored, such as description, reservation note, or scan policy.
 */
export function retireLearnedMetadata(db, row) {
  if (row.is_rogue) {
    emit(db, row.id, row.subnet_id, row.ip_address, 'rogue_cleared', { source: 'retirement' });
  }
  const result = db.prepare(`
    UPDATE ip_addresses SET
      hostname = NULL, mac_address = NULL, last_seen_mac = NULL,
      last_seen_at = NULL, first_seen_at = NULL, last_scanned_at = NULL,
      offline_since_at = NULL, detection_source = NULL,
      is_rogue = 0, rogue_reason = NULL,
      allocation_state = 'unassigned', allocation_source_type = NULL,
      allocation_source_id = NULL, preferred_until = NULL, valid_until = NULL,
      dhcp_version = NULL, dhcp_duid = NULL, dhcp_iaid = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(row.id);
  emit(db, row.id, row.subnet_id, row.ip_address, 'retired', {
    oldValue: row.allocation_state,
    newValue: 'unassigned',
    source: 'retirement'
  });
  return result;
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
    DELETE FROM ip_addresses AS stale
    WHERE (lower(stale.mac_address) = ? OR lower(stale.last_seen_mac) = ?)
      AND NOT (stale.subnet_id = ? AND stale.ip_address = ?)
      AND stale.allocation_state = 'dynamic_dhcp'
      AND NOT EXISTS (
        SELECT 1 FROM dhcp_reservations reservation
        WHERE reservation.subnet_id = stale.subnet_id
          AND reservation.ip_address = stale.ip_address
          AND reservation.enabled = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM dhcp_leases lease
        WHERE lease.subnet_id = stale.subnet_id
          AND lease.ip_address = stale.ip_address
          AND ${activeLeaseSql('lease')}
      )
  `).run(normalizedMac, normalizedMac, subnetId, ip);
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

export function ensureAddress(db, subnetId, ip, fields = {}) {
  const identity = canonicalIdentity(ip);
  const existing = db.prepare(
    'SELECT id FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, identity.ip);
  if (existing) return { changes: 0, lastInsertRowid: existing.id };
  const id = upsert(db, subnetId, identity.ip, fields);
  return { changes: 1, lastInsertRowid: id };
}

export function ensureAddresses(db, subnetId, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return { changes: 0 };

  let changes = 0;
  for (const entry of entries) {
    const { ip, ...fields } = entry;
    const result = ensureAddress(db, subnetId, ip, fields);
    changes += result.changes || 0;
  }
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
    WHERE subnet_id = ? AND is_rogue = 1
      AND ip_address NOT IN (${placeholders})
  `).run(subnetId, ...exceptIps);
}

/**
 * Update an IP from scan results. Handles liveness, MAC capture, rogue state,
 * and last_scanned_at in a single operation.
 * Creates a new row if the IP responded but has no existing record (rogue device).
 */
export function updateFromScan(db, subnetId, ip, { responded, mac, isConflict, conflictReason }) {
  const existing = db.prepare(
    'SELECT id, is_online, is_rogue, allocation_state, hostname, mac_address, last_seen_mac, scan_enabled, subnet_id, ip_address, detection_source FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  // Re-check the canonical row because its allocation may have changed after
  // the scanner built its assignment map.
  let effectiveConflict = isConflict;
  let effectiveReason = conflictReason;
  if (isConflict && addressClaim(existing)) {
    effectiveConflict = 0;
    effectiveReason = null;
  }

  if (existing) {
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
      updates.push('offline_since_at = NULL');
    } else {
      updates.push("offline_since_at = COALESCE(offline_since_at, datetime('now'))");
    }
    if (mac) {
      updates.push('last_seen_mac = ?');
      params.push(mac);
      // Only set mac_address if currently empty
      updates.push("mac_address = CASE WHEN mac_address IS NULL OR mac_address = '' THEN ? ELSE mac_address END");
      params.push(mac);
    }

    if (responded) {
      updates.push('is_rogue = ?');
      params.push(effectiveConflict ? 1 : 0);
      updates.push('rogue_reason = ?');
      params.push(effectiveConflict ? effectiveReason : null);
    } else {
      updates.push('is_rogue = 0');
    }

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
    const newId = upsert(db, subnetId, ip, {
      is_online: 1,
      last_seen_mac: mac || null,
      mac_address: mac || null,
      is_rogue: effectiveConflict ? 1 : 0,
      rogue_reason: effectiveConflict ? effectiveReason : null,
      last_scanned_at: new Date().toISOString(),
      detection_source: 'scanner'
    });
    emit(db, newId, subnetId, ip, 'scanned', { newValue: 'responded', source: 'scanner' });
    emit(db, newId, subnetId, ip, 'online', { source: 'scanner' });
    if (effectiveConflict) {
      emit(db, newId, subnetId, ip, 'rogue_detected', { newValue: effectiveReason, source: 'scanner' });
    }
  }
  // If no existing row and didn't respond, nothing to record
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
    const newId = upsert(db, subnetId, ip);
    db.prepare(
      "UPDATE ip_addresses SET scan_enabled = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(scanEnabled, newId);
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
  const identity = canonicalIdentity(ip);
  return db.prepare(
    `SELECT * FROM ip_addresses
     WHERE subnet_id = ? AND ip_address = ?
       AND COALESCE(interface_id, '') = COALESCE(?, '')`
  ).get(subnetId, identity.ip, identity.interfaceId);
}
