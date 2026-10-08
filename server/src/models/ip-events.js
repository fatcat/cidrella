/**
 * Address history: the single owner of ip_events and ip_range_events writes.
 *
 * History belongs to the address, not to its ip_addresses row: an event keeps
 * the canonical address (and interface, for a link-local IPv6 address) and
 * outlives the row, so deleting or deallocating a network leaves the record
 * of what happened. Reads go by the address for the same reason.
 *
 * Callers pass a canonical address; models/ip-address.js canonicalizes.
 */

import { getSetting } from '../db/init.js';
import { sortKey } from '../utils/address.js';
import { currentActor } from '../utils/request-actor.js';

export const RANGE_ASSIGNED = 'range_assigned';
export const RANGE_UNASSIGNED = 'range_unassigned';

// Milliseconds, in the same text shape datetime('now') writes, so events from
// both tables written in one request sort in the order they happened and
// still compare against older second-resolution rows.
const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

export function insertEvent(
  db,
  { ipAddressId = null, subnetId = null, ip, interfaceId = null, type, oldValue, newValue, source },
) {
  db.prepare(
    `
    INSERT INTO ip_events (ip_address_id, subnet_id, ip_address, interface_id, event_type,
      old_value, new_value, source, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_MS})
  `,
  ).run(
    ipAddressId,
    subnetId,
    ip,
    interfaceId,
    type,
    oldValue ?? null,
    newValue ?? null,
    source ?? null,
    currentActor(),
  );
}

/**
 * Record a Network Range Type added to or taken off a run of addresses.
 * One row covers the whole run; an address's history picks it up.
 */
export function insertRangeEvent(
  db,
  { subnetId, rangeId = null, rangeType, startIp, endIp, type },
) {
  db.prepare(
    `
    INSERT INTO ip_range_events (subnet_id, range_id, range_type, start_ip, end_ip,
      start_key, end_key, event_type, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_MS})
  `,
  ).run(
    subnetId,
    rangeId,
    rangeType,
    startIp,
    endIp,
    sortKey(startIp),
    sortKey(endIp),
    type,
    currentActor(),
  );
}

/** Rows that moved to another network keep their history under it. */
export function moveEventsToSubnet(db, ipAddressId, subnetId) {
  db.prepare('UPDATE ip_events SET subnet_id = ? WHERE ip_address_id = ?').run(
    subnetId,
    ipAddressId,
  );
}

/**
 * One address's history, newest first: its own events plus the range runs
 * that cover it, in one shape (a range event's old or new value is the type).
 */
export function listAddressEvents(db, ip, interfaceId, { limit = 50 } = {}) {
  const key = sortKey(ip);
  return db
    .prepare(
      `
    SELECT id, ip_address_id, subnet_id, ip_address, interface_id, event_type,
           old_value, new_value, source, actor, created_at
    FROM ip_events
    WHERE ip_address = ? AND COALESCE(interface_id, '') = COALESCE(?, '')
    UNION ALL
    SELECT -id, NULL, subnet_id, ?, NULL, event_type,
           CASE WHEN event_type = 'range_unassigned' THEN range_type END,
           CASE WHEN event_type = 'range_assigned' THEN range_type END,
           'range', actor, created_at
    FROM ip_range_events
    WHERE start_key <= ? AND end_key >= ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `,
    )
    .all(ip, interfaceId, ip, key, key, limit);
}

/**
 * Drop history older than ip_history_retention_days (default 7).
 */
export function pruneEvents(db) {
  const retentionDays = parseInt(getSetting('ip_history_retention_days'), 10) || 7;
  const offset = `-${retentionDays} days`;
  const events = db
    .prepare("DELETE FROM ip_events WHERE created_at < datetime('now', ?)")
    .run(offset);
  const ranges = db
    .prepare("DELETE FROM ip_range_events WHERE created_at < datetime('now', ?)")
    .run(offset);
  return { changes: events.changes + ranges.changes };
}
