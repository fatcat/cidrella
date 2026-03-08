/**
 * Sync IP metadata (hostname, MAC, status) to the ip_addresses table
 * from DNS records and DHCP reservations/leases.
 *
 * Called from dns.js, dhcp.js, and pihole.js whenever records change.
 */

import { ipToLong } from './ip.js';
import { generateFallbackHostname } from './mac-vendor.js';

/**
 * Find the subnet that contains a given IP address.
 * Returns the most specific (longest prefix) match.
 */
function findSubnetForIp(db, ip) {
  const ipLong = ipToLong(ip);
  const subnets = db.prepare(`
    SELECT id, network_address, prefix_length FROM subnets
    WHERE (SELECT COUNT(*) FROM subnets c WHERE c.parent_id = subnets.id) = 0
  `).all();

  let best = null;
  for (const s of subnets) {
    const netLong = ipToLong(s.network_address);
    const size = Math.pow(2, 32 - s.prefix_length);
    if (ipLong >= netLong && ipLong < netLong + size) {
      if (!best || s.prefix_length > best.prefix_length) best = s;
    }
  }
  return best;
}

/**
 * Ensure an ip_addresses row exists for the given IP, then update its metadata.
 * Only updates fields that are provided (non-undefined).
 */
function upsertIpMeta(db, subnetId, ip, { hostname, mac_address, status } = {}) {
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

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(existing.id);
      db.prepare(`UPDATE ip_addresses SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
  } else {
    db.prepare(
      'INSERT INTO ip_addresses (subnet_id, ip_address, hostname, mac_address, status) VALUES (?, ?, ?, ?, ?)'
    ).run(subnetId, ip, hostname || null, mac_address || null, status || 'assigned');
  }
}

/**
 * Sync hostname from a DNS A record to ip_addresses.
 * Called when an A record is created or updated.
 * @param {string} recordName - The DNS record name (e.g. "server1")
 * @param {string} ip - The IP address (A record value)
 * @param {string} zoneName - The zone name (e.g. "example.com")
 */
export function syncDnsToIp(db, recordName, ip, zoneName) {
  const subnet = findSubnetForIp(db, ip);
  if (!subnet) return;

  const fqdn = recordName === '@' ? zoneName : `${recordName}.${zoneName}`;
  upsertIpMeta(db, subnet.id, ip, { hostname: fqdn });
}

/**
 * Clear hostname from ip_addresses when a DNS A record is deleted.
 * Only clears if the current hostname matches the record being deleted.
 */
export function clearDnsFromIp(db, recordName, ip, zoneName) {
  const subnet = findSubnetForIp(db, ip);
  if (!subnet) return;

  const fqdn = recordName === '@' ? zoneName : `${recordName}.${zoneName}`;
  const existing = db.prepare(
    'SELECT id, hostname FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnet.id, ip);

  if (existing && existing.hostname === fqdn) {
    db.prepare("UPDATE ip_addresses SET hostname = NULL, updated_at = datetime('now') WHERE id = ?").run(existing.id);
  }
}

/**
 * Sync DHCP reservation data to ip_addresses.
 * Called when a reservation is created or updated.
 */
export function syncDhcpReservationToIp(db, subnetId, ip, { hostname, mac_address } = {}) {
  const effectiveHostname = hostname || generateFallbackHostname(mac_address) || undefined;
  upsertIpMeta(db, subnetId, ip, { hostname: effectiveHostname, mac_address, status: 'dhcp' });
}

/**
 * Clear DHCP reservation data from ip_addresses when a reservation is deleted.
 * Resets status to 'available' and clears MAC. Preserves hostname if set by DNS.
 */
export function clearDhcpReservationFromIp(db, subnetId, ip, mac_address) {
  const existing = db.prepare(
    'SELECT id, mac_address, status FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnetId, ip);

  if (existing && existing.mac_address === mac_address) {
    db.prepare(
      "UPDATE ip_addresses SET mac_address = NULL, status = 'available', updated_at = datetime('now') WHERE id = ?"
    ).run(existing.id);
  }
}

/**
 * Sync active DHCP leases to ip_addresses.
 * Called after lease file sync. Updates hostname, MAC, and status for leased IPs.
 */
export function syncLeasesToIps(db, leases) {
  for (const l of leases) {
    if (!l.subnetId) continue;
    upsertIpMeta(db, l.subnetId, l.ip, {
      hostname: l.hostname || undefined,
      mac_address: l.mac || undefined,
      status: 'dhcp'
    });
  }
}
