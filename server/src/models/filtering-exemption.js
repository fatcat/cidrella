/**
 * Hosts with DNS filtering turned off: the one place that rule lives.
 *
 * A host is keyed by its device's MAC when one is known and by its address
 * otherwise (migration 088). The DNS proxy only sees a client's address, so
 * exemptAddressSet() turns the stored keys into the addresses they cover now;
 * the proxy holds that set (utils/dns-proxy.js loadFilteringOverrides) and the
 * read model shows the same answer per row (attachFilteringFacts).
 */

import { canonicalizeIp } from '../utils/address.js';
import { isClientMac } from '../utils/ip.js';
import { activeLeaseSql } from '../utils/lease-sql.js';
import { currentActor } from '../utils/request-actor.js';
import { insertEvent } from './ip-events.js';

export const FILTERING_CHANGED = 'filtering_changed';

function clientMac(value) {
  const mac = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return isClientMac(mac) ? mac : null;
}

/**
 * The device MAC behind an address: the stored MAC, then the one a scan last
 * saw, then the newest active lease's. Null when none is a real client MAC.
 */
export function deviceMac(db, { ip, subnetId = null, interfaceId = null }) {
  const row = db
    .prepare(
      `SELECT mac_address, last_seen_mac FROM ip_addresses
        WHERE ip_address = ? AND (? IS NULL OR subnet_id = ?)
          AND COALESCE(interface_id, '') = COALESCE(?, '')
        LIMIT 1`,
    )
    .get(ip, subnetId, subnetId, interfaceId);
  const stored = clientMac(row?.mac_address) || clientMac(row?.last_seen_mac);
  if (stored) return stored;
  const lease = db
    .prepare(
      `SELECT mac_address FROM dhcp_leases
        WHERE ip_address = ? AND mac_address IS NOT NULL AND ${activeLeaseSql()}
        ORDER BY last_seen DESC LIMIT 1`,
    )
    .get(ip);
  return clientMac(lease?.mac_address);
}

/** The key a host's exemption is stored under: { mac } or { ip }. */
export function hostKey(db, address) {
  const mac = deviceMac(db, address);
  return mac ? { mac } : { ip: address.ip };
}

/**
 * Turn filtering on or off for the host at an address. Turning it on clears
 * the host under either key, so an exemption stored before the device's MAC
 * was known goes too. Returns whether anything changed.
 */
export function setHostFiltering(db, { ip, subnetId = null, interfaceId = null }, enabled) {
  const address = { ip: canonicalizeIp(ip), subnetId, interfaceId };
  if (!address.ip) throw new Error(`Invalid IP address: ${ip}`);
  const key = hostKey(db, address);
  const before = exemptAddressSet(db).has(address.ip);
  if (enabled === !before) return false;

  if (enabled) {
    db.prepare('DELETE FROM filtering_exemptions WHERE ip_address = ?').run(address.ip);
    if (key.mac) {
      db.prepare('DELETE FROM filtering_exemptions WHERE mac_address = ?').run(key.mac);
    }
  } else {
    db.prepare(
      `INSERT OR IGNORE INTO filtering_exemptions (mac_address, ip_address, created_by)
       VALUES (?, ?, ?)`,
    ).run(key.mac ?? null, key.mac ? null : address.ip, currentActor());
  }
  insertEvent(db, {
    subnetId,
    ip: address.ip,
    interfaceId,
    type: FILTERING_CHANGED,
    oldValue: before ? 'off' : 'on',
    newValue: enabled ? 'on' : 'off',
    source: key.mac ? `device ${key.mac}` : 'address',
  });
  return true;
}

/**
 * Every address with filtering off right now: the exempt addresses, plus the
 * addresses an exempt MAC holds (stored on the address, seen by a scan, or on
 * an active lease, either family).
 */
export function exemptAddressSet(db) {
  const rows = db.prepare('SELECT mac_address, ip_address FROM filtering_exemptions').all();
  const set = new Set();
  if (!rows.length) return set;
  const macs = [];
  for (const row of rows) {
    if (row.ip_address) set.add(row.ip_address);
    if (row.mac_address) macs.push(row.mac_address);
  }
  if (macs.length) {
    const marks = macs.map(() => '?').join(',');
    const held = db
      .prepare(
        `SELECT ip_address FROM ip_addresses
          WHERE lower(mac_address) IN (${marks}) OR lower(last_seen_mac) IN (${marks})
         UNION
         SELECT ip_address FROM dhcp_leases
          WHERE lower(mac_address) IN (${marks}) AND ${activeLeaseSql()}`,
      )
      .pluck()
      .all(...macs, ...macs, ...macs);
    for (const ip of held) {
      const canonical = canonicalizeIp(ip);
      if (canonical) set.add(canonical);
    }
  }
  return set;
}

/** How many hosts have filtering off. */
export function exemptHostCount(db) {
  return db.prepare('SELECT COUNT(*) FROM filtering_exemptions').pluck().get();
}

/**
 * Set filtering_enabled on read rows: false for an exempt address, true for
 * any other address, null for a row with no address (a CNAME, MX, TXT or SRV).
 */
export function attachFilteringFacts(db, rows, exempt = exemptAddressSet(db)) {
  for (const row of rows || []) {
    const ip = row.ip_address ? canonicalizeIp(row.ip_address) : null;
    row.filtering_enabled = ip ? !exempt.has(ip) : null;
  }
  return rows;
}
