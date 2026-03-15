/**
 * Sync IP metadata (hostname, MAC, status) to the ip_addresses table
 * from DNS records and DHCP reservations/leases.
 *
 * All writes go through the IpAddress model.
 */

import { ipToLong } from './ip.js';
import { generateFallbackHostname } from './mac-vendor.js';
import * as IpAddress from '../models/ip-address.js';

// Cached leaf subnets — invalidated on subnet CRUD via invalidateSubnetCache()
let leafSubnetCache = null;

/**
 * Invalidate the cached leaf subnet list.
 * Call this after any subnet create/update/delete/divide/merge operation.
 */
export function invalidateSubnetCache() {
  leafSubnetCache = null;
}

/**
 * Find the subnet that contains a given IP address.
 * Returns the most specific (longest prefix) match.
 * Uses a cached leaf subnet list to avoid per-call DB queries.
 */
export function findSubnetForIp(db, ip) {
  const ipLong = ipToLong(ip);

  if (!leafSubnetCache) {
    leafSubnetCache = db.prepare(`
      SELECT id, network_address, prefix_length FROM subnets
      WHERE (SELECT COUNT(*) FROM subnets c WHERE c.parent_id = subnets.id) = 0
    `).all().map(s => ({
      ...s,
      netLong: ipToLong(s.network_address),
      size: Math.pow(2, 32 - s.prefix_length),
    }));
  }

  let best = null;
  for (const s of leafSubnetCache) {
    if (ipLong >= s.netLong && ipLong < s.netLong + s.size) {
      if (!best || s.prefix_length > best.prefix_length) best = s;
    }
  }
  return best;
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
  IpAddress.upsert(db, subnet.id, ip, { hostname: fqdn, detection_source: 'dns' });
  IpAddress.clearRogue(db, subnet.id, ip);
  IpAddress.emitEvent(db, subnet.id, ip, 'dns_added', { newValue: fqdn, source: 'dns' });
}

/**
 * Clear hostname from ip_addresses when a DNS A record is deleted.
 * Only clears if the current hostname matches the record being deleted.
 */
export function clearDnsFromIp(db, recordName, ip, zoneName) {
  const subnet = findSubnetForIp(db, ip);
  if (!subnet) return;

  const fqdn = recordName === '@' ? zoneName : `${recordName}.${zoneName}`;
  const existing = IpAddress.findBySubnetAndIp(db, subnet.id, ip);

  if (existing && existing.hostname === fqdn) {
    IpAddress.upsert(db, subnet.id, ip, { hostname: null });
    IpAddress.emitEvent(db, subnet.id, ip, 'dns_removed', { oldValue: fqdn, source: 'dns' });
  }
}

/**
 * Sync DHCP reservation data to ip_addresses.
 * Called when a reservation is created or updated.
 */
export function syncDhcpReservationToIp(db, subnetId, ip, { hostname, mac_address } = {}) {
  const effectiveHostname = hostname || generateFallbackHostname(mac_address) || undefined;
  IpAddress.upsert(db, subnetId, ip, {
    hostname: effectiveHostname,
    mac_address,
    status: 'dhcp',
    detection_source: 'dhcp_reservation'
  });
  IpAddress.clearRogue(db, subnetId, ip);
}

/**
 * Clear DHCP reservation data from ip_addresses when a reservation is deleted.
 * Resets status to 'available' and clears MAC. Preserves hostname if set by DNS.
 */
export function clearDhcpReservationFromIp(db, subnetId, ip, mac_address) {
  const existing = IpAddress.findBySubnetAndIp(db, subnetId, ip);

  if (existing && existing.mac_address === mac_address) {
    IpAddress.upsert(db, subnetId, ip, { mac_address: null, status: 'available' });
  }
}

/**
 * Sync active DHCP leases to ip_addresses.
 * Called after lease file sync. Updates hostname, MAC, and status for leased IPs.
 */
export function syncLeasesToIps(db, leases) {
  for (const l of leases) {
    if (!l.subnetId) continue;
    const before = IpAddress.findBySubnetAndIp(db, l.subnetId, l.ip);
    IpAddress.upsert(db, l.subnetId, l.ip, {
      hostname: l.hostname || undefined,
      mac_address: l.mac || undefined,
      status: 'dhcp',
      is_online: 1,
      last_seen_mac: l.mac || undefined,
      detection_source: 'dhcp_lease'
    });
    IpAddress.clearRogue(db, l.subnetId, l.ip);
    // Only emit lease_obtained on new leases (not already DHCP status)
    if (!before || before.status !== 'dhcp') {
      IpAddress.emitEvent(db, l.subnetId, l.ip, 'lease_obtained', { newValue: l.mac || null, source: 'dhcp_lease' });
    }
  }
}
