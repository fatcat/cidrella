/**
 * Sync protocol metadata (hostname and MAC) to the canonical IP row.
 * from DNS records and DHCP reservations/leases.
 *
 * All writes go through the IpAddress model.
 */

import { ipToLong } from './ip.js';
import { activeLeaseSql, infiniteLeaseFirstSql } from './lease-sql.js';
import { generateFallbackHostname } from './mac-vendor.js';
import * as IpAddress from '../models/ip-address.js';
import { setPtrForIp, fqdnForRecordName } from '../models/dns-record.js';
import { canonicalHostnameForAllocation } from '../models/ip-lifecycle.js';

// Cached leaf subnets, invalidated on subnet CRUD via invalidateSubnetCache()
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

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function ptrSourceForCanonical(canonical) {
  if (!canonical?.hostname) return 'placeholder';
  if (canonical.source === 'dhcp_reservation') return 'reservation';
  if (canonical.source === 'dhcp_lease') return 'dhcp';
  return 'dns';
}

export function resolveCanonicalHostname(db, subnetId, ip) {
  const allocation = db.prepare(`
    SELECT allocation_state
    FROM ip_addresses
    WHERE subnet_id = ? AND ip_address = ?
  `).get(subnetId, ip)?.allocation_state;

  const reservation = db.prepare(`
    SELECT hostname
    FROM dhcp_reservations
    WHERE subnet_id = ? AND ip_address = ? AND enabled = 1
      AND hostname IS NOT NULL AND trim(hostname) != ''
    LIMIT 1
  `).get(subnetId, ip);
  const lease = db.prepare(`
    SELECT hostname
    FROM dhcp_leases
    WHERE subnet_id = ?
      AND ip_address = ?
      AND hostname IS NOT NULL
      AND trim(hostname) != ''
      AND ${activeLeaseSql()}
    ORDER BY
      ${infiniteLeaseFirstSql()},
      datetime(expires_at) DESC,
      id DESC
    LIMIT 1
  `).get(subnetId, ip);
  const record = db.prepare(`
    SELECT r.name, z.name AS zone_name
    FROM dns_records r
    JOIN dns_zones z ON z.id = r.zone_id
    WHERE r.type = 'A'
      AND r.enabled = 1
      AND z.enabled = 1
      AND z.type = 'forward'
      AND r.value = ?
      AND COALESCE(r.source, 'manual') = 'manual'
    LIMIT 1
  `).get(ip);

  return canonicalHostnameForAllocation({
    allocationState: allocation,
    dnsHostname: record ? fqdnForRecordName(record.name, record.zone_name) : null,
    reservationHostname: nonEmpty(reservation?.hostname) ? reservation.hostname.trim() : null,
    leaseHostname: nonEmpty(lease?.hostname) ? lease.hostname.trim() : null
  });
}

function syncCanonicalHostname(db, subnetId, ip, { clearSource = false } = {}) {
  const canonical = resolveCanonicalHostname(db, subnetId, ip);
  const fields = { hostname: canonical.hostname };
  if (canonical.source || clearSource) fields.detection_source = canonical.source;
  IpAddress.upsert(db, subnetId, ip, fields);
  return canonical;
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

  const fqdn = fqdnForRecordName(recordName, zoneName);
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

  const fqdn = fqdnForRecordName(recordName, zoneName);
  const existing = IpAddress.findBySubnetAndIp(db, subnet.id, ip);
  let canonical;

  if (existing && (existing.hostname === fqdn || existing.allocation_state === 'static_dns')) {
    canonical = syncCanonicalHostname(db, subnet.id, ip, { clearSource: true });
    IpAddress.emitEvent(db, subnet.id, ip, 'dns_removed', { oldValue: fqdn, source: 'dns' });
  } else {
    canonical = resolveCanonicalHostname(db, subnet.id, ip);
  }

  // PTR convergence is unconditional. A stale/mismatched ip_addresses
  // hostname must not leave the removed A record behind in reverse DNS.
  setPtrForIp(db, ip, canonical.hostname || ip, {
    enabledOnly: true,
    source: ptrSourceForCanonical(canonical)
  });
}

/**
 * Upsert the PTR record for a given IP inside a subnet's reverse zone.
 * `hostname` should be a non-empty FQDN to set, or falsy to clear the PTR.
 * If the target reverse zone doesn't exist (reverse DNS wasn't created for
 * this subnet), this is a no-op.
 */
export function syncPtrForIp(db, subnetId, ip, hostname, { source = null } = {}) {
  void subnetId;
  return setPtrForIp(db, ip, hostname || ip, {
    source: source || (hostname ? 'manual' : 'placeholder')
  });
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
    detection_source: 'dhcp_reservation'
  });
  IpAddress.clearRogue(db, subnetId, ip);
}

/**
 * Clear DHCP reservation data from ip_addresses when a reservation is deleted
 * or its IP address changes. The reservation being deleted is authoritative,
 * so we always clear reservation-owned fields, even when the MAC drifted
 * (e.g. a live lease retagged the row before delete arrived).
 *
 *   - If the row was written exclusively by the reservation
 *     (detection_source = 'dhcp_reservation'), delete it entirely. Something
 *     else will recreate it when it has data to record.
 *   - Otherwise, clear just the reservation-owned fields (MAC and
 *     the reservation's hostname). A later DNS/scan source can repopulate.
 */
export function clearDhcpReservationFromIp(db, subnetId, ip, mac_address) {
  const existing = IpAddress.findBySubnetAndIp(db, subnetId, ip);
  if (!existing) return;

  if (existing.detection_source === 'dhcp_reservation') {
    const lease = db.prepare(`
      SELECT mac_address, hostname
      FROM dhcp_leases
      WHERE subnet_id = ?
        AND ip_address = ?
        AND ${activeLeaseSql()}
      ORDER BY
        ${infiniteLeaseFirstSql()},
        datetime(expires_at) DESC,
        id DESC
      LIMIT 1
    `).get(subnetId, ip);
    if (lease) {
      // No is_online here. A lease says the address is assigned, not that the
      // host is present. Liveness belongs to the scanner and the passive DNS
      // watcher, which actually observe it.
      IpAddress.upsert(db, subnetId, ip, {
        hostname: lease.hostname || undefined,
        mac_address: lease.mac_address || undefined,
        last_seen_mac: lease.mac_address || undefined,
        detection_source: 'dhcp_lease'
      });
      syncCanonicalHostname(db, subnetId, ip);
      return;
    }

    const canonical = resolveCanonicalHostname(db, subnetId, ip);
    if (canonical.hostname) {
      IpAddress.upsert(db, subnetId, ip, {
        hostname: canonical.hostname,
        mac_address: null,
        detection_source: canonical.source
      });
      return;
    }

    IpAddress.deleteById(db, existing.id);
    return;
  }

  // For non-reservation-owned rows, only blow away MAC if it still matches
  // what the reservation owned, otherwise something else (scan, live lease)
  // overwrote the MAC and is the current owner. Hostname is cleared because it
  // was reservation-derived.
  const clearMac = existing.mac_address === mac_address;
  IpAddress.upsert(db, subnetId, ip, {
    mac_address: clearMac ? null : existing.mac_address,
    hostname: null,
    detection_source: null
  });
}

/**
 * Sync active DHCP leases to ip_addresses.
 * Called after lease file sync. Updates hostname and MAC for leased IPs.
 */
export function syncLeasesToIps(db, leases) {
  for (const l of leases) {
    if (!l.subnetId) continue;
    if (l.mac) {
      IpAddress.removeOtherRowsForMac(db, l.subnetId, l.ip, l.mac);
    }
    const before = IpAddress.findBySubnetAndIp(db, l.subnetId, l.ip);
    const reservation = before?.allocation_state === 'static_dhcp' ? db.prepare(`
      SELECT hostname
      FROM dhcp_reservations
      WHERE subnet_id = ?
        AND ip_address = ?
        AND enabled = 1
        AND hostname IS NOT NULL
        AND trim(hostname) != ''
      LIMIT 1
    `).get(l.subnetId, l.ip) : null;
    // Deliberately no is_online. Holding a lease is not evidence the host is
    // up: a reservation appears here with expires_at='infinite' and would stay
    // "online" forever, and every lease-file rewrite would re-assert it over
    // the scanner's verdict. Liveness is owned by the scanner and the passive
    // DNS watcher. Allocation is owned by the lifecycle service.
    IpAddress.upsert(db, l.subnetId, l.ip, {
      hostname: reservation ? undefined : (l.hostname || undefined),
      mac_address: l.mac || undefined,
      is_online: !reservation && l.observedActivity === true ? 1 : undefined,
      last_seen_mac: l.mac || undefined,
      detection_source: 'dhcp_lease'
    });
    if (reservation) {
      syncCanonicalHostname(db, l.subnetId, l.ip);
    }
    IpAddress.clearRogue(db, l.subnetId, l.ip);
    if (!before || before.allocation_state !== 'dynamic_dhcp') {
      IpAddress.emitEvent(db, l.subnetId, l.ip, 'lease_obtained', { newValue: l.mac || null, source: 'dhcp_lease' });
    }
  }
}
