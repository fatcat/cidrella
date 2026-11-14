/**
 * The read side of filtering exemptions, kept apart from the model's writes
 * (models/filtering-exemption.js) so the DNS proxy process can carry it: it
 * imports only leaf helpers, never the audit or event code.
 */
import { canonicalizeIp } from '../utils/address.js';
import { activeLeaseSql } from '../utils/lease-sql.js';

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
