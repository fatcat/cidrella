import { getDb } from '../db/init.js';

/**
 * Add `hostname` to rows with an IP field. ip_addresses is authoritative
 * because it is CIDRella's normalized IP read model; dhcp_leases is retained
 * as a fallback for legacy/restored data that has not been consolidated yet.
 */
export function enrichWithHostnames(rows, { ipField = 'client_ip' } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const ips = [...new Set(rows.map(r => r?.[ipField]).filter(Boolean))];
  if (ips.length === 0) {
    return rows.map(r => ({ ...r, hostname: null }));
  }

  const db = getDb();
  const placeholders = ips.map(() => '?').join(',');
  const ipRows = db.prepare(
    `SELECT ip_address, hostname FROM ip_addresses WHERE ip_address IN (${placeholders}) AND hostname IS NOT NULL`
  ).all(...ips);
  const leaseRows = db.prepare(
    `SELECT ip_address, hostname FROM dhcp_leases WHERE ip_address IN (${placeholders}) AND hostname IS NOT NULL`
  ).all(...ips);

  const hostMap = new Map();
  for (const r of leaseRows) hostMap.set(r.ip_address, r.hostname);
  for (const r of ipRows) hostMap.set(r.ip_address, r.hostname);

  return rows.map(r => ({
    ...r,
    hostname: hostMap.get(r?.[ipField]) || null,
  }));
}
