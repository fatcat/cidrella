/**
 * Sync IP metadata (hostname, MAC, status) to the ip_addresses table
 * from DNS records and DHCP reservations/leases.
 *
 * All writes go through the IpAddress model.
 */

import { ipToLong } from './ip.js';
import { generateFallbackHostname } from './mac-vendor.js';
import * as IpAddress from '../models/ip-address.js';
import { setPtrForIp, dnsAssignedIpSet } from '../models/dns-record.js';

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

function normalizeDnsName(name) {
  return String(name || '').trim().replace(/\.$/, '').toLowerCase();
}

function fqdnForRecordName(recordName, zoneName) {
  const raw = String(recordName || '').trim().toLowerCase();
  const normalized = raw.replace(/\.$/, '');
  const zone = normalizeDnsName(zoneName);
  if (normalized === '@' || normalized === zone) return zone;
  if (normalized.endsWith(`.${zone}`)) return normalized;
  if (normalized.includes('.')) return raw.endsWith('.') ? raw : normalized;
  return `${normalized}.${zone}`;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function resolveCanonicalHostname(db, subnetId, ip) {
  const reservation = db.prepare(`
    SELECT hostname
    FROM dhcp_reservations
    WHERE subnet_id = ?
      AND ip_address = ?
      AND enabled = 1
      AND hostname IS NOT NULL
      AND trim(hostname) != ''
    ORDER BY id DESC
    LIMIT 1
  `).get(subnetId, ip);
  if (nonEmpty(reservation?.hostname)) {
    return { hostname: reservation.hostname.trim(), source: 'dhcp_reservation' };
  }

  const lease = db.prepare(`
    SELECT hostname
    FROM dhcp_leases
    WHERE subnet_id = ?
      AND ip_address = ?
      AND hostname IS NOT NULL
      AND trim(hostname) != ''
      AND (expires_at = 'infinite' OR datetime(expires_at) > datetime('now'))
    ORDER BY
      CASE WHEN expires_at = 'infinite' THEN 1 ELSE 0 END DESC,
      datetime(expires_at) DESC,
      id DESC
    LIMIT 1
  `).get(subnetId, ip);
  if (nonEmpty(lease?.hostname)) {
    return { hostname: lease.hostname.trim(), source: 'dhcp_lease' };
  }

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
    ORDER BY lower(z.name), lower(r.name), r.id
    LIMIT 1
  `).get(ip);
  if (record) {
    return { hostname: fqdnForRecordName(record.name, record.zone_name), source: 'dns' };
  }

  return { hostname: null, source: null };
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
  const canonical = resolveCanonicalHostname(db, subnet.id, ip);
  if (!canonical.hostname || canonical.source === 'dns' || canonical.hostname === fqdn) {
    IpAddress.upsert(db, subnet.id, ip, { hostname: fqdn, detection_source: 'dns' });
  }
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

  if (existing && existing.hostname === fqdn) {
    syncCanonicalHostname(db, subnet.id, ip, { clearSource: true });
    IpAddress.emitEvent(db, subnet.id, ip, 'dns_removed', { oldValue: fqdn, source: 'dns' });
  }
}

/**
 * Reconcile `ip_addresses` rows that look like stale DNS hostnames against
 * currently-enabled DNS A records. Scanner updates used to overwrite
 * `detection_source = 'dns'`, so this deliberately checks hostname ownership
 * by data shape: a hostname that either is zone-qualified or can be qualified
 * by the subnet domain, no backing A record, and no DHCP row/reservation that
 * should own the hostname.
 *
 * Runs at server startup (see index.js). Returns the number of rows cleared.
 */
export function reconcileDnsOrphans(db) {
  const orphans = db.prepare(`
    SELECT ip.id, ip.ip_address, ip.hostname
    FROM ip_addresses ip
    JOIN subnets s ON s.id = ip.subnet_id
    WHERE ip.hostname IS NOT NULL
      AND (ip.detection_source IS NULL OR ip.detection_source IN ('dns', 'scanner'))
      AND COALESCE(ip.status, 'available') != 'dhcp'
      AND EXISTS (
        SELECT 1 FROM dns_zones hz
        WHERE hz.type = 'forward'
          AND hz.enabled = 1
          AND (
            ip.hostname = hz.name
            OR ip.hostname LIKE '%.' || hz.name
            OR (instr(ip.hostname, '.') = 0 AND s.domain_name = hz.name)
          )
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
          AND (
            (r.name || '.' || z.name) = ip.hostname
            OR (r.name = '@' AND z.name = ip.hostname)
            OR (instr(ip.hostname, '.') = 0 AND z.name = s.domain_name AND r.name = ip.hostname)
          )
      )
  `).all();
  if (orphans.length === 0) return 0;
  return IpAddress.clearHostnameByIds(db, orphans.map(o => o.id)).changes;
}

/**
 * Keep a single DHCP-owned ip_addresses row per MAC address.
 *
 * Active lease/reservation rows win. If a MAC has no current DHCP backing row
 * at all, keep the row most recently seen/updated and delete older rows. This
 * cleans up historic offline DHCP duplicates that were created before lease
 * sync became authoritative per MAC.
 */
export function reconcileDuplicateDhcpMacRows(db) {
  const rows = db.prepare(`
    SELECT ip.id, ip.ip_address,
           lower(COALESCE(NULLIF(ip.mac_address, ''), NULLIF(ip.last_seen_mac, ''))) AS mac_key,
           CASE WHEN dl.id IS NOT NULL OR dr.id IS NOT NULL THEN 1 ELSE 0 END AS has_dhcp_backing,
           ip.last_seen_at, ip.updated_at
    FROM ip_addresses ip
    LEFT JOIN dhcp_leases dl
      ON dl.subnet_id = ip.subnet_id
     AND dl.ip_address = ip.ip_address
     AND lower(dl.mac_address) = lower(COALESCE(NULLIF(ip.mac_address, ''), NULLIF(ip.last_seen_mac, '')))
     AND (dl.expires_at = 'infinite' OR datetime(dl.expires_at) > datetime('now'))
    LEFT JOIN dhcp_reservations dr
      ON dr.subnet_id = ip.subnet_id
     AND dr.ip_address = ip.ip_address
     AND dr.enabled = 1
    WHERE ip.status = 'dhcp'
      AND COALESCE(NULLIF(ip.mac_address, ''), NULLIF(ip.last_seen_mac, '')) IS NOT NULL
    ORDER BY mac_key,
             has_dhcp_backing DESC,
             datetime(ip.last_seen_at) DESC,
             datetime(ip.updated_at) DESC,
             ip.id DESC
  `).all();

  const seen = new Set();
  const staleIds = [];
  for (const row of rows) {
    if (!row.mac_key) continue;
    if (seen.has(row.mac_key)) {
      staleIds.push(row.id);
    } else {
      seen.add(row.mac_key);
    }
  }

  if (staleIds.length === 0) return 0;
  return IpAddress.deleteByIds(db, staleIds).changes;
}

/**
 * DHCP lease rows in ip_addresses are historical once there is no active
 * lease or reservation backing them. Keep the recent last-seen metadata, but
 * stop treating the address as DHCP-assigned.
 */
export function reconcileUnbackedDhcpLeaseRows(db, activeLeases = []) {
  const activeKeys = new Set(activeLeases
    .filter(l => l?.subnetId && l?.ip)
    .map(l => `${l.subnetId}|${l.ip}|${String(l.mac || '').toLowerCase()}`));
  const staleAssignments = db.prepare(`
    SELECT ip.id, ip.subnet_id, ip.ip_address,
           lower(COALESCE(NULLIF(ip.mac_address, ''), NULLIF(ip.last_seen_mac, ''))) AS mac_key
    FROM ip_addresses ip
    LEFT JOIN dhcp_leases dl
      ON dl.subnet_id = ip.subnet_id
     AND dl.ip_address = ip.ip_address
     AND lower(dl.mac_address) = lower(COALESCE(NULLIF(ip.mac_address, ''), NULLIF(ip.last_seen_mac, '')))
     AND (dl.expires_at = 'infinite' OR datetime(dl.expires_at) > datetime('now'))
    LEFT JOIN dhcp_reservations dr
      ON dr.subnet_id = ip.subnet_id
     AND dr.ip_address = ip.ip_address
     AND dr.enabled = 1
    WHERE ip.status = 'dhcp'
      AND ip.detection_source = 'dhcp_lease'
      AND dl.id IS NULL
      AND dr.id IS NULL
  `).all();

  const rowsToClear = activeKeys.size === 0
    ? staleAssignments
    : staleAssignments.filter(row => !activeKeys.has(`${row.subnet_id}|${row.ip_address}|${row.mac_key || ''}`));

  if (rowsToClear.length === 0) return 0;

  return IpAddress.clearDhcpAssignmentsByIds(db, rowsToClear.map(row => row.id)).changes;
}

/**
 * Remove stale DHCP host rows once they are no longer useful recent history.
 *
 * A DHCP row with no active lease/reservation is only a remembered lease. Keep
 * it briefly so the UI can show where a device was seen, then clear it so the
 * address returns to a reusable state.
 */
export function pruneStaleDhcpHostRows(db, maxAgeHours = 24) {
  const hours = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : 24;
  const offset = `-${hours} hours`;

  const staleRows = db.prepare(`
    SELECT ip.id, ip.ip_address
    FROM ip_addresses ip
    LEFT JOIN dhcp_leases dl
      ON dl.subnet_id = ip.subnet_id
     AND dl.ip_address = ip.ip_address
     AND lower(dl.mac_address) = lower(COALESCE(NULLIF(ip.mac_address, ''), NULLIF(ip.last_seen_mac, '')))
     AND (dl.expires_at = 'infinite' OR datetime(dl.expires_at) > datetime('now'))
    LEFT JOIN dhcp_reservations dr
      ON dr.subnet_id = ip.subnet_id
     AND dr.ip_address = ip.ip_address
     AND dr.enabled = 1
    WHERE (ip.status = 'dhcp' OR ip.detection_source = 'dhcp_lease')
      AND dl.id IS NULL
      AND dr.id IS NULL
      AND ip.status NOT IN ('locked', 'assigned')
      AND datetime(COALESCE(ip.last_seen_at, ip.updated_at, ip.created_at)) < datetime('now', ?)
  `).all(offset);

  if (staleRows.length === 0) return 0;

  // This deletes the whole row, MAC included, which also takes vendor and
  // device with it. An address a manual A record points at is admin-declared,
  // so it keeps what was learned until that record is deleted.
  const declaredByDns = dnsAssignedIpSet(db);
  const deletable = staleRows.filter(row => !declaredByDns.has(row.ip_address));
  if (deletable.length === 0) return 0;

  return IpAddress.deleteByIds(db, deletable.map(row => row.id)).changes;
}

/**
 * Upsert the PTR record for a given IP inside a subnet's reverse zone.
 * `hostname` should be a non-empty FQDN to set, or falsy to clear the PTR.
 * If the target reverse zone doesn't exist (reverse DNS wasn't created for
 * this subnet), this is a no-op.
 */
export function syncPtrForIp(db, subnetId, ip, hostname) {
  void subnetId;
  return setPtrForIp(db, ip, hostname);
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
  syncCanonicalHostname(db, subnetId, ip);
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
 *   - Otherwise, clear just the reservation-owned fields (mac, status, and
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
        AND (expires_at = 'infinite' OR datetime(expires_at) > datetime('now'))
      ORDER BY
        CASE WHEN expires_at = 'infinite' THEN 1 ELSE 0 END DESC,
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
        status: 'dhcp',
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
        status: 'available',
        detection_source: canonical.source
      });
      return;
    }

    IpAddress.deleteById(db, existing.id);
    return;
  }

  // For non-reservation-owned rows, only blow away MAC if it still matches
  // what the reservation owned, otherwise something else (scan, live lease)
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
    const reservation = db.prepare(`
      SELECT hostname
      FROM dhcp_reservations
      WHERE subnet_id = ?
        AND ip_address = ?
        AND enabled = 1
        AND hostname IS NOT NULL
        AND trim(hostname) != ''
      LIMIT 1
    `).get(l.subnetId, l.ip);
    // Deliberately no is_online. Holding a lease is not evidence the host is
    // up: a reservation appears here with expires_at='infinite' and would stay
    // "online" forever, and every lease-file rewrite would re-assert it over
    // the scanner's verdict. Liveness is owned by the scanner and the passive
    // DNS watcher. Assignment (status, MAC, hostname) is owned here.
    IpAddress.upsert(db, l.subnetId, l.ip, {
      hostname: reservation ? undefined : (l.hostname || undefined),
      mac_address: l.mac || undefined,
      status: 'dhcp',
      last_seen_mac: l.mac || undefined,
      detection_source: 'dhcp_lease'
    });
    if (reservation) {
      syncCanonicalHostname(db, l.subnetId, l.ip);
    }
    IpAddress.clearRogue(db, l.subnetId, l.ip);
    // Only emit lease_obtained on new leases (not already DHCP status)
    if (!before || before.status !== 'dhcp') {
      IpAddress.emitEvent(db, l.subnetId, l.ip, 'lease_obtained', { newValue: l.mac || null, source: 'dhcp_lease' });
    }
  }
  reconcileDuplicateDhcpMacRows(db);
  reconcileUnbackedDhcpLeaseRows(db, leases);
  pruneStaleDhcpHostRows(db);
}
