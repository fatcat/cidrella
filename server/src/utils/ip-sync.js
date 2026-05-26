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
 * Reconcile `ip_addresses` rows that look like stale DNS hostnames against
 * currently-enabled DNS A records. Scanner updates used to overwrite
 * `detection_source = 'dns'`, so this deliberately checks hostname ownership
 * by data shape: a zone-qualified hostname, no backing A record, and no DHCP
 * row/reservation that should own the hostname.
 *
 * Runs at server startup (see index.js). Returns the number of rows cleared.
 */
export function reconcileDnsOrphans(db) {
  const orphans = db.prepare(`
    SELECT ip.id, ip.ip_address, ip.hostname
    FROM ip_addresses ip
    WHERE ip.hostname IS NOT NULL
      AND (ip.detection_source IS NULL OR ip.detection_source IN ('dns', 'scanner'))
      AND COALESCE(ip.status, 'available') != 'dhcp'
      AND EXISTS (
        SELECT 1 FROM dns_zones hz
        WHERE hz.type = 'forward'
          AND hz.enabled = 1
          AND (ip.hostname = hz.name OR ip.hostname LIKE '%.' || hz.name)
      )
      AND NOT EXISTS (
        SELECT 1 FROM dhcp_reservations dr
        WHERE dr.subnet_id = ip.subnet_id
          AND dr.ip_address = ip.ip_address
          AND dr.enabled = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM dhcp_leases dl
        WHERE dl.subnet_id = ip.subnet_id
          AND dl.ip_address = ip.ip_address
          AND (dl.expires_at = 'infinite' OR datetime(dl.expires_at) > datetime('now'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM dns_records r
        JOIN dns_zones z ON r.zone_id = z.id
        WHERE r.type = 'A'
          AND r.enabled = 1
          AND z.type = 'forward'
          AND r.value = ip.ip_address
          AND ( (r.name || '.' || z.name) = ip.hostname
                OR (r.name = '@' AND z.name = ip.hostname) )
      )
  `).all();
  if (orphans.length === 0) return 0;
  const clearRow = db.prepare(
    "UPDATE ip_addresses SET hostname = NULL, detection_source = NULL, updated_at = datetime('now') WHERE id = ?"
  );
  const cleared = db.transaction(() => {
    for (const o of orphans) clearRow.run(o.id);
    return orphans.length;
  })();
  return cleared;
}

/**
 * Derive the reverse-zone name + record name for an IPv4 in a covering
 * reverse zone stored in dns_zones. Looks up the matching /24 (or larger)
 * reverse zone by NAME only — zones are subnet-agnostic post-decouple, so
 * any subnet's reservation writes into whichever reverse zone happens to
 * cover the IP, regardless of who "owns" the zone.
 *
 * The `subnetId` argument is retained in the signature for call-site
 * compatibility but deliberately unused.
 */
function findPtrLocation(db, _subnetId, ip) {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4) return null;
  const candidates = [
    // Prefer /24 reverse: "c.b.a.in-addr.arpa"
    `${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`,
    `${octets[1]}.${octets[0]}.in-addr.arpa`,       // /16
    `${octets[0]}.in-addr.arpa`,                    // /8
  ];
  for (const zoneName of candidates) {
    const zone = db.prepare(
      "SELECT id, name FROM dns_zones WHERE type = 'reverse' AND name = ?"
    ).get(zoneName);
    if (!zone) continue;
    const zoneParts = zoneName.replace('.in-addr.arpa', '').split('.');
    let recordName;
    if (zoneParts.length === 3) recordName = String(octets[3]);
    else if (zoneParts.length === 2) recordName = `${octets[3]}.${octets[2]}`;
    else recordName = `${octets[3]}.${octets[2]}.${octets[1]}`;
    return { zoneId: zone.id, recordName };
  }
  return null;
}

/**
 * Upsert the PTR record for a given IP inside a subnet's reverse zone.
 * `hostname` should be a non-empty FQDN to set, or falsy to clear the PTR.
 * If the target reverse zone doesn't exist (reverse DNS wasn't created for
 * this subnet), this is a no-op.
 */
export function syncPtrForIp(db, subnetId, ip, hostname) {
  const loc = findPtrLocation(db, subnetId, ip);
  if (!loc) return;
  const fqdn = (hostname || '').trim();
  const existing = db.prepare(
    "SELECT id FROM dns_records WHERE zone_id = ? AND name = ? AND type = 'PTR'"
  ).get(loc.zoneId, loc.recordName);
  if (existing) {
    db.prepare("UPDATE dns_records SET value = ?, updated_at = datetime('now') WHERE id = ?")
      .run(fqdn, existing.id);
  } else if (fqdn) {
    db.prepare(
      "INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, ?, 'PTR', ?, 1)"
    ).run(loc.zoneId, loc.recordName, fqdn);
  }
  db.prepare("UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime('now') WHERE id = ?")
    .run(loc.zoneId);
}

/**
 * Sync DHCP reservation data to ip_addresses.
 * Called when a reservation is created or updated.
 *
 * `hostname === null` is an EXPLICIT clear (user cleared the reservation
 * hostname). `hostname === undefined` means "not set, use a fallback if we
 * can derive one from the MAC." The distinction matters because a bare
 * `||` check below used to overwrite an explicit clear with the fallback,
 * leaving ip_addresses.hostname out of sync with dhcp_reservations.hostname.
 */
export function syncDhcpReservationToIp(db, subnetId, ip, { hostname, mac_address } = {}) {
  let effectiveHostname;
  if (hostname === null) {
    effectiveHostname = null;
  } else if (hostname) {
    effectiveHostname = hostname;
  } else {
    // undefined / empty string: fall back to vendor-derived name if possible.
    effectiveHostname = generateFallbackHostname(mac_address) || undefined;
  }
  IpAddress.upsert(db, subnetId, ip, {
    hostname: effectiveHostname,
    mac_address,
    status: 'dhcp',
    detection_source: 'dhcp_reservation'
  });
  IpAddress.clearRogue(db, subnetId, ip);
}

/**
 * Clear DHCP reservation data from ip_addresses when a reservation is deleted
 * or its IP address changes. The reservation being deleted is authoritative,
 * so we always clear reservation-owned fields — even when the MAC drifted
 * (e.g. a live lease retagged the row before delete arrived).
 *
 *   - If the row was written exclusively by the reservation
 *     (detection_source = 'dhcp_reservation'), delete it entirely. Something
 *     else will recreate it when it has data to record.
 *   - Otherwise, clear just the reservation-owned fields (mac, status, and
 *     the reservation's hostname). A later DNS/scan source can repopulate.
 */
export function clearDhcpReservationFromIp(db, subnetId, ip, mac_address) {
  const existing = IpAddress.findBySubnetAndIp(db, subnetId, ip);
  if (!existing) return;

  if (existing.detection_source === 'dhcp_reservation') {
    db.prepare('DELETE FROM ip_addresses WHERE id = ?').run(existing.id);
    return;
  }

  // For non-reservation-owned rows, only blow away MAC if it still matches
  // what the reservation owned — otherwise something else (scan, live lease)
  // overwrote the MAC and is the current owner. Hostname and status we clear
  // regardless, since they were reservation-derived.
  const clearMac = existing.mac_address === mac_address;
  IpAddress.upsert(db, subnetId, ip, {
    mac_address: clearMac ? null : existing.mac_address,
    hostname: null,
    status: 'available',
    detection_source: null
  });
}

/**
 * Sync active DHCP leases to ip_addresses.
 * Called after lease file sync. Updates hostname, MAC, and status for leased IPs.
 */
export function syncLeasesToIps(db, leases) {
  for (const l of leases) {
    if (!l.subnetId) continue;
    if (l.mac) {
      IpAddress.removeOtherRowsForMac(db, l.subnetId, l.ip, l.mac);
    }
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
