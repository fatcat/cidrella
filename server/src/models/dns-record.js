import { isValidDomain, longToIp, parseCidr } from '../utils/ip.js';
import { activeLeaseSql, infiniteLeaseFirstSql } from '../utils/lease-sql.js';
import { canonicalHostnameForAllocation } from './ip-lifecycle.js';

function normalizeDnsName(name) {
  return String(name || '').trim().replace(/\.$/, '').toLowerCase();
}

function bumpZoneSerial(db, zoneId) {
  db.prepare("UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime('now') WHERE id = ?")
    .run(zoneId);
}

/**
 * The canonical stored form of a record name, relative to its zone.
 *
 * Storage is normalized at the sink so every query can rely on it. In
 * particular `r.name || '.' || z.name` is only a correct FQDN if the stored
 * name is lowercase and does NOT already carry the zone suffix, and two
 * queries build exactly that (utils/ip-sync.js reconcileDnsOrphans, and the
 * CNAME target check in routes/dns.js). Before this was enforced, a record
 * written with a device-reported name like "S24-Ultra" produced
 * "S24-Ultra.example.com" from SQL while the JS builder produced
 * "s24-ultra.example.com", and SQLite's `=` is case-sensitive, so the two
 * never matched and reconcileDnsOrphans would strip the hostname off an
 * address whose A record was still present and still pointing at it.
 *
 * Every write path must go through this: the API routes, the Pi-hole import,
 * and the DHCP/reservation lease sync, which is where the un-normalized names
 * actually came from. See REVIEW.md, duplicate-logic audit #8.
 */
export function normalizeRecordNameForZone(name, zoneName) {
  const raw = String(name || '').trim().toLowerCase();
  const normalized = raw.replace(/\.$/, '');
  const zone = normalizeDnsName(zoneName);
  if (normalized === '@') return '@';
  if (normalized === zone) return '@';
  if (normalized.endsWith(`.${zone}`)) {
    return normalized.slice(0, -(zone.length + 1));
  }
  if (normalized.includes('.')) {
    return raw.endsWith('.') ? raw : normalized;
  }
  return normalized;
}

export function fqdnForRecordName(recordName, zoneName) {
  const raw = String(recordName || '').trim().toLowerCase();
  const normalized = raw.replace(/\.$/, '');
  const zone = normalizeDnsName(zoneName);
  if (normalized === '@' || normalized === zone) return zoneName;
  if (normalized.endsWith(`.${zone}`)) return normalized;
  if (normalized.includes('.')) return raw.endsWith('.') ? raw : normalized;
  return `${normalized}.${zoneName}`;
}

/**
 * A manual A record in an enabled forward zone is the operator declaring "this
 * address is in use", and that declaration is what makes an address NOT rogue.
 *
 * Three places need to know it: the scanner's bulk assignment map, the IP-view
 * static-DNS set, and the passive DNS-query path. Each used to carry its own
 * copy of this predicate and the passive path was missing it entirely, so a host
 * with a name in DNS got flagged rogue the moment it resolved anything. One
 * definition now, so the three cannot drift apart again.
 *
 * DHCP-sourced A records are excluded deliberately: those track a lease rather
 * than an operator decision, and restored lease history can leave one behind
 * after the lease itself is gone.
 */
// The predicate itself, in one place. Both shapes below are built from it, so
// they cannot say different things about what "a manual forward A record"
// means. Assumes the record table is aliased `r` and the zone table `z`.
const MANUAL_FORWARD_A_WHERE = `
        r.type = 'A'
    AND r.enabled = 1
    AND z.enabled = 1
    AND z.type = 'forward'
    AND COALESCE(r.source, 'manual') = 'manual'
`;

const DNS_ASSIGNED_SELECT = `
  SELECT r.value AS ip_address, r.name, z.name AS zone_name
    FROM dns_records r
    JOIN dns_zones z ON z.id = r.zone_id
   WHERE ${MANUAL_FORWARD_A_WHERE}
`;

/**
 * The same claim as a correlated EXISTS, for queries that need it as a column
 * rather than as a row source.
 *
 * `ipColumn` is interpolated as SQL, so it must be a column reference the caller
 * controls (for example 'ip.ip_address'), never user input. Same contract as
 * scannerCoveredSql in utils/scan-coverage.js.
 *
 * This exists because routes/subnets.js carried FOUR hand-written copies of this
 * predicate across the four modes of GET /:id/ips, outside the guarantee the
 * comment above claims. The predicate had already drifted once before, which is
 * why it was centralized in the first place. See REVIEW.md, duplicate-logic
 * audit #19.
 */
/**
 * Is this a legal CNAME target for `zone`?
 *
 * Lived in routes/dns.js, so only the UI create/update path enforced it.
 * routes/pihole.js validated an imported CNAME with `isValidDomain` alone, which
 * skipped all three rules below: an import could therefore write a CNAME in a
 * local zone pointing at an arbitrary external domain, or at nothing at all,
 * that the same appliance would refuse if you typed it into the UI.
 * See REVIEW.md, duplicate-logic audit #18.
 *
 * `extraKnownFqdns` exists for the import path and is the reason this could not
 * simply be called as-is from there. The rule "target must already exist" is
 * evaluated against the DB, but a bulk import validates every record BEFORE
 * inserting any of them, so a CNAME pointing at an A record in the same batch
 * would be rejected even though the finished import is perfectly consistent.
 * Callers importing a batch pass the batch's own FQDNs in.
 */
export function cnameTargetError(db, target, zone, extraKnownFqdns = null) {
  const normalized = normalizeDnsName(target);
  const zoneName = normalizeDnsName(zone.name);

  if (!isValidDomain(normalized)) return 'Invalid target domain';
  if (!normalized.includes('.')) return 'CNAME target must be fully qualified';
  if (!normalized.endsWith(`.${zoneName}`) && normalized !== zoneName) {
    return `CNAME target must be inside ${zone.name}`;
  }

  if (extraKnownFqdns && extraKnownFqdns.has(normalized)) return null;

  const known = db.prepare(`
    SELECT 1
    FROM dns_records r
    JOIN dns_zones z ON z.id = r.zone_id
    WHERE z.enabled = 1
      AND z.type = 'forward'
      AND r.enabled = 1
      AND r.type IN ('A', 'CNAME')
      AND lower(CASE WHEN r.name = '@' THEN z.name ELSE r.name || '.' || z.name END) = ?
    LIMIT 1
  `).get(normalized);

  if (!known) {
    return `CNAME target must already exist as an enabled A or CNAME record in ${zone.name}`;
  }
  return null;
}

/**
 * Does giving `ip` the name `recordName` in `zoneName` clash with a name the
 * appliance already has for that address?
 *
 * Returns { hostname, source } for the first clash found, or null. Sources are
 * checked most-authoritative first: a DHCP reservation, then an active lease,
 * then an existing manual A record.
 *
 * The rule is that one address gets one name; a second name for the same host
 * should be a CNAME. Both the DNS page and the Pi-hole importer enforce it now
 * (duplicate-logic audit #18). It lived in routes/dns.js, so only the UI
 * applied it and an import could quietly give one IP a second name.
 *
 * `ignoreFqdns` is the import path's equivalent of cnameTargetError's
 * `extraKnownFqdns`. A bulk import is validated against the DB before anything
 * is inserted, so callers pass the batch's own FQDNs to keep re-importing the
 * same valid records idempotent. The importer separately rejects multiple A
 * records for one IP before using this exception. It relaxes only the manual-A
 * check, never reservation or lease checks.
 */
function hostnameMatches(candidate, proposed, domainName) {
  const c = normalizeDnsName(candidate);
  const p = normalizeDnsName(proposed);
  const d = normalizeDnsName(domainName);
  if (!c || !p) return false;
  if (c === p) return true;
  if (d && !c.includes('.') && `${c}.${d}` === p) return true;
  if (d && !p.includes('.') && `${p}.${d}` === c) return true;
  return false;
}

export function findAHostnameConflict(db, ip, recordName, zoneName, excludeRecordId = null, ignoreFqdns = null) {
  const proposed = fqdnForRecordName(recordName, zoneName);

  const reservation = db.prepare(`
    SELECT r.hostname, s.domain_name
    FROM dhcp_reservations r
    JOIN subnets s ON s.id = r.subnet_id
    WHERE r.ip_address = ?
      AND r.enabled = 1
      AND r.hostname IS NOT NULL
      AND trim(r.hostname) != ''
    ORDER BY s.prefix_length DESC, r.id DESC
    LIMIT 1
  `).get(ip);
  if (reservation?.hostname && !hostnameMatches(reservation.hostname, proposed, reservation.domain_name)) {
    return { hostname: reservation.hostname, source: 'reserved DHCP' };
  }

  const lease = db.prepare(`
    SELECT l.hostname, s.domain_name
    FROM dhcp_leases l
    JOIN subnets s ON s.id = l.subnet_id
    WHERE l.ip_address = ?
      AND l.hostname IS NOT NULL
      AND trim(l.hostname) != ''
      AND ${activeLeaseSql('l')}
    ORDER BY
      s.prefix_length DESC,
      ${infiniteLeaseFirstSql('l')},
      datetime(l.expires_at) DESC,
      l.id DESC
    LIMIT 1
  `).get(ip);
  if (lease?.hostname && !hostnameMatches(lease.hostname, proposed, lease.domain_name)) {
    return { hostname: lease.hostname, source: 'dynamic DHCP' };
  }

  const excludeClause = excludeRecordId ? 'AND r.id != ?' : '';
  const params = excludeRecordId ? [ip, excludeRecordId] : [ip];
  const existingRecords = db.prepare(`
    SELECT r.name, z.name AS zone_name
    FROM dns_records r
    JOIN dns_zones z ON z.id = r.zone_id
    WHERE r.type = 'A'
      AND r.enabled = 1
      AND z.enabled = 1
      AND z.type = 'forward'
      AND r.value = ?
      AND COALESCE(r.source, 'manual') = 'manual'
      ${excludeClause}
    ORDER BY lower(z.name), lower(r.name), r.id
  `).all(...params);

  for (const record of existingRecords) {
    const hostname = fqdnForRecordName(record.name, record.zone_name);
    // An exact A record the caller is re-importing is not a conflict with
    // itself. Multiple names for one IP are rejected at the batch boundary.
    if (ignoreFqdns && ignoreFqdns.has(normalizeDnsName(hostname))) continue;
    if (!hostnameMatches(hostname, proposed, null)) {
      return { hostname, source: 'static DNS' };
    }
  }

  return null;
}

export function staticDnsClaimSql(ipColumn) {
  return `EXISTS (
    SELECT 1
      FROM dns_records r
      JOIN dns_zones z ON z.id = r.zone_id
     WHERE ${MANUAL_FORWARD_A_WHERE}
       AND r.value = ${ipColumn}
  )`;
}

/** Every address a manual forward A record claims, with the FQDN it claims it as. */
export function listDnsAssignedIps(db) {
  return db.prepare(DNS_ASSIGNED_SELECT).all().map(r => ({
    ip_address: r.ip_address,
    hostname: fqdnForRecordName(r.name, r.zone_name),
  }));
}

/** The set of addresses DNS claims. Cheap: bounded by operator-created records. */
export function dnsAssignedIpSet(db) {
  return new Set(db.prepare(DNS_ASSIGNED_SELECT).all().map(r => r.ip_address));
}

/** The FQDN DNS assigns to `ip`, or null when no manual A record claims it. */
export function dnsAssignedHostname(db, ip) {
  if (!ip) return null;
  const row = db.prepare(`${DNS_ASSIGNED_SELECT} AND r.value = ? LIMIT 1`).get(ip);
  return row ? fqdnForRecordName(row.name, row.zone_name) : null;
}

export function findReversePtrLocation(db, ip, { enabledOnly = false } = {}) {
  const candidates = reversePtrCandidates(ip);
  if (candidates.length === 0) return null;

  const enabledSql = enabledOnly ? 'AND enabled = 1' : '';
  for (const candidate of candidates) {
    const zone = db.prepare(`
      SELECT id, name FROM dns_zones
      WHERE type = 'reverse' AND name = ? ${enabledSql}
    `).get(candidate.name);
    if (zone) return { zone, ptrName: candidate.ptrName };
  }
  return null;
}

export function reversePtrCandidates(ip) {
  const octets = String(ip || '').split('.');
  if (octets.length !== 4) return [];
  return [
    { name: `${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`, ptrName: octets[3] },
    { name: `${octets[1]}.${octets[0]}.in-addr.arpa`, ptrName: `${octets[3]}.${octets[2]}` },
    { name: `${octets[0]}.in-addr.arpa`, ptrName: `${octets[3]}.${octets[2]}.${octets[1]}` }
  ];
}

export function syncPtrForARecord(db, recordName, ip, forwardZoneName, {
  force = false,
  source = 'dns'
} = {}) {
  const match = findReversePtrLocation(db, ip, { enabledOnly: true });
  if (!match) return { updated: false };

  const { zone, ptrName } = match;
  const fqdn = fqdnForRecordName(recordName, forwardZoneName);
  const existing = db.prepare(
    "SELECT * FROM dns_records WHERE zone_id = ? AND type = 'PTR' AND name = ?"
  ).get(zone.id, ptrName);

  if (existing) {
    if (!force && existing.value && existing.value !== ip) {
      const bareIp = /^\d+\.\d+\.\d+\.\d+$/.test(existing.value);
      if (!bareIp && existing.value.toLowerCase() !== fqdn.toLowerCase()) {
        if (!existing.value.toLowerCase().endsWith('.' + forwardZoneName.toLowerCase()) &&
            existing.value.toLowerCase() !== forwardZoneName.toLowerCase()) {
          return { conflict: { existing: existing.value, proposed: fqdn, reverseZone: zone.name } };
        }
      }
    }

    if (existing.value === fqdn && existing.source === source && existing.enabled === 1) {
      return { updated: false };
    }

    db.prepare(`
      UPDATE dns_records SET value = ?, source = ?, enabled = 1,
        updated_at = datetime('now') WHERE id = ?
    `).run(fqdn, source, existing.id);
  } else {
    db.prepare(
      "INSERT INTO dns_records (zone_id, name, type, value, source, enabled) VALUES (?, ?, 'PTR', ?, ?, 1)"
    ).run(zone.id, ptrName, fqdn, source);
  }

  bumpZoneSerial(db, zone.id);
  return { updated: true };
}

export function setPtrForIp(db, ip, hostname, {
  enabledOnly = false,
  source = hostname ? 'manual' : 'placeholder'
} = {}) {
  const match = findReversePtrLocation(db, ip, { enabledOnly });
  if (!match) return { updated: false };

  // An address covered by managed reverse DNS always has a visible row. When
  // no real DNS/DHCP hostname exists, its canonical IP text is the placeholder.
  const fqdn = String(hostname || ip).trim();
  const existing = db.prepare(
    "SELECT id, value, source, enabled FROM dns_records WHERE zone_id = ? AND type = 'PTR' AND name = ?"
  ).get(match.zone.id, match.ptrName);

  if (existing) {
    if (existing.value === fqdn && existing.source === source && existing.enabled === 1) {
      return { updated: false };
    }
    db.prepare(`
      UPDATE dns_records SET value = ?, source = ?, enabled = 1,
        updated_at = datetime('now') WHERE id = ?
    `).run(fqdn, source, existing.id);
  } else if (fqdn) {
    db.prepare(
      "INSERT INTO dns_records (zone_id, name, type, value, source, enabled) VALUES (?, ?, 'PTR', ?, ?, 1)"
    ).run(match.zone.id, match.ptrName, fqdn, source);
  } else {
    return { updated: false };
  }

  bumpZoneSerial(db, match.zone.id);
  return { updated: true };
}

/**
 * Fill and repair the generated PTR projection for managed IPv4 subnets.
 *
 * Real names come from the protocol source selected by allocation_state. A
 * missing/empty row becomes either that name or the bare-IP placeholder. An
 * explicit non-placeholder PTR is left alone so this repair cannot erase a
 * deliberate operator override.
 */
export function reconcileManagedReverseDns(db, {
  subnetIds = null,
  maxAddressesPerSubnet = 65536
} = {}) {
  const idFilter = Array.isArray(subnetIds) && subnetIds.length > 0
    ? `AND id IN (${subnetIds.map(() => '?').join(',')})`
    : '';
  const subnets = db.prepare(`
    SELECT id, cidr, prefix_length
    FROM subnets
    WHERE status = 'allocated' AND has_reverse_dns = 1 ${idFilter}
    ORDER BY prefix_length DESC, id
  `).all(...(idFilter ? subnetIds : []));
  const zones = db.prepare(`
    SELECT id, name FROM dns_zones
    WHERE type = 'reverse' AND enabled = 1
  `).all();
  const zonesByName = new Map(zones.map(zone => [zone.name, zone]));

  const protocolNames = new Map();
  const rememberProtocolName = (ip, source, hostname) => {
    if (!ip || !hostname) return;
    if (!protocolNames.has(ip)) protocolNames.set(ip, new Map());
    if (!protocolNames.get(ip).has(source)) {
      protocolNames.get(ip).set(source, hostname);
    }
  };
  const dhcpFqdn = (hostname, domainName) => domainName
    ? fqdnForRecordName(hostname, domainName)
    : normalizeDnsName(hostname);

  for (const record of db.prepare(`
    SELECT r.value AS ip_address, r.name, r.source, z.name AS zone_name
    FROM dns_records r
    JOIN dns_zones z ON z.id = r.zone_id
    WHERE r.type = 'A' AND r.enabled = 1
      AND z.type = 'forward' AND z.enabled = 1
    ORDER BY r.id
  `).all()) {
    const source = ['dhcp', 'reservation'].includes(record.source) ? record.source : 'manual';
    rememberProtocolName(
      record.ip_address,
      source,
      fqdnForRecordName(record.name, record.zone_name)
    );
  }
  for (const reservation of db.prepare(`
    SELECT r.ip_address, r.hostname,
      COALESCE(
        (SELECT ds.domain_name FROM dhcp_scopes ds
         WHERE ds.subnet_id = r.subnet_id AND ds.enabled = 1
           AND ds.domain_name IS NOT NULL AND trim(ds.domain_name) != ''
         ORDER BY ds.id LIMIT 1),
        s.domain_name
      ) AS domain_name
    FROM dhcp_reservations r
    JOIN subnets s ON s.id = r.subnet_id
    WHERE r.enabled = 1 AND r.hostname IS NOT NULL AND trim(r.hostname) != ''
    ORDER BY r.id
  `).all()) {
    rememberProtocolName(
      reservation.ip_address,
      'reservation',
      dhcpFqdn(reservation.hostname, reservation.domain_name)
    );
  }
  for (const lease of db.prepare(`
    SELECT l.ip_address, l.hostname,
      COALESCE(
        (SELECT ds.domain_name FROM dhcp_scopes ds
         WHERE ds.subnet_id = l.subnet_id AND ds.enabled = 1
           AND ds.domain_name IS NOT NULL AND trim(ds.domain_name) != ''
         ORDER BY ds.id LIMIT 1),
        s.domain_name
      ) AS domain_name
    FROM dhcp_leases l
    JOIN subnets s ON s.id = l.subnet_id
    WHERE l.hostname IS NOT NULL AND trim(l.hostname) != ''
      AND ${activeLeaseSql('l')}
    ORDER BY ${infiniteLeaseFirstSql('l')}, datetime(l.expires_at) DESC, l.id DESC
  `).all()) {
    rememberProtocolName(
      lease.ip_address,
      'dhcp',
      dhcpFqdn(lease.hostname, lease.domain_name)
    );
  }

  const allocationByIdentity = new Map(db.prepare(`
    SELECT subnet_id, ip_address, allocation_state FROM ip_addresses
  `).all().map(row => [`${row.subnet_id}|${row.ip_address}`, row.allocation_state]));
  const desired = new Map();
  const skippedSubnets = [];

  for (const subnet of subnets) {
    const parsed = parseCidr(subnet.cidr);
    if (parsed.usableCount > maxAddressesPerSubnet) {
      skippedSubnets.push({ subnet_id: subnet.id, cidr: subnet.cidr, addresses: parsed.usableCount });
      continue;
    }
    const first = parsed.prefix >= 31 ? parsed.networkLong : parsed.networkLong + 1;
    const last = parsed.prefix >= 31 ? parsed.broadcastLong : parsed.broadcastLong - 1;
    for (let value = first; value <= last; value++) {
      const ip = longToIp(value);
      const candidate = reversePtrCandidates(ip)
        .find(item => zonesByName.has(item.name));
      if (!candidate) continue;
      const zone = zonesByName.get(candidate.name);
      const key = `${zone.id}|${candidate.ptrName}`;
      // More-specific subnets were visited first. Do not let an overlapping
      // parent choose a different canonical allocation source for this PTR.
      if (desired.has(key)) continue;

      const names = protocolNames.get(ip);
      const state = allocationByIdentity.get(`${subnet.id}|${ip}`);
      const canonical = canonicalHostnameForAllocation({
        allocationState: state,
        dnsHostname: names?.get('manual') || null,
        reservationHostname: names?.get('reservation') || null,
        leaseHostname: names?.get('dhcp') || null
      });
      const hostname = canonical.hostname;
      const source = canonical.source === 'dhcp_reservation'
        ? 'reservation'
        : canonical.source === 'dhcp_lease'
          ? 'dhcp'
          : canonical.source || 'placeholder';

      desired.set(key, {
        zoneId: zone.id,
        ptrName: candidate.ptrName,
        ip,
        value: hostname || ip,
        source
      });
    }
  }

  const zoneIds = [...new Set([...desired.values()].map(row => row.zoneId))];
  const existing = new Map();
  if (zoneIds.length > 0) {
    const rows = db.prepare(`
      SELECT id, zone_id, name, value, source, enabled FROM dns_records
      WHERE type = 'PTR' AND zone_id IN (${zoneIds.map(() => '?').join(',')})
    `).all(...zoneIds);
    for (const row of rows) existing.set(`${row.zone_id}|${row.name}`, row);
  }

  const insert = db.prepare(`
    INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
    VALUES (?, ?, 'PTR', ?, ?, 1)
  `);
  const update = db.prepare(`
    UPDATE dns_records
    SET value = ?, source = ?, enabled = 1, updated_at = datetime('now')
    WHERE id = ?
  `);
  const touchZone = db.prepare(`
    UPDATE dns_zones
    SET soa_serial = soa_serial + 1, updated_at = datetime('now')
    WHERE id = ?
  `);

  return db.transaction(() => {
    let inserted = 0;
    let updated = 0;
    const changedZones = new Set();
    for (const [key, row] of desired) {
      const current = existing.get(key);
      if (!current) {
        insert.run(row.zoneId, row.ptrName, row.value, row.source);
        inserted++;
        changedZones.add(row.zoneId);
        continue;
      }
      const currentValue = String(current.value || '').trim();
      const isPlaceholder = currentValue === '' || /^\d+\.\d+\.\d+\.\d+$/.test(currentValue);
      const sameValue = currentValue.toLowerCase() === row.value.toLowerCase();
      const generatedRow = isPlaceholder
        || ['dns', 'dhcp', 'reservation', 'placeholder'].includes(current.source)
        || sameValue;
      if (generatedRow && (!sameValue || current.source !== row.source || current.enabled !== 1)) {
        update.run(row.value, row.source, current.id);
        updated++;
        changedZones.add(row.zoneId);
      }
    }
    for (const zoneId of changedZones) touchZone.run(zoneId);
    return {
      inserted,
      updated,
      unchanged: desired.size - inserted - updated,
      skipped_subnets: skippedSubnets
    };
  })();
}

export function clearPtrForIp(db, ip) {
  return setPtrForIp(db, ip, ip, { enabledOnly: true, source: 'placeholder' });
}

export function clearPtrForARecord(db, recordName, ip, forwardZoneName) {
  const match = findReversePtrLocation(db, ip, { enabledOnly: true });
  if (!match) return { updated: false };

  const fqdn = fqdnForRecordName(recordName, forwardZoneName).toLowerCase();
  const existing = db.prepare(
    "SELECT value FROM dns_records WHERE zone_id = ? AND type = 'PTR' AND name = ?"
  ).get(match.zone.id, match.ptrName);

  if (!existing || String(existing.value || '').toLowerCase() !== fqdn) {
    return { updated: false };
  }

  return clearPtrForIp(db, ip);
}

export function createRecord(db, zone, fields, { forcePtr = false } = {}) {
  const insert = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO dns_records (zone_id, name, type, value, priority, weight, port, ttl, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      zone.id,
      normalizeRecordNameForZone(fields.name, zone.name),
      fields.type,
      fields.value,
      fields.priority ?? null,
      fields.weight ?? null,
      fields.port ?? null,
      fields.ttl ?? null,
      fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : 1
    );

    bumpZoneSerial(db, zone.id);

    let ptrResult = null;
    const enabled = fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : 1;
    if (enabled && fields.type === 'A' && zone.type === 'forward') {
      ptrResult = syncPtrForARecord(db, fields.name, fields.value, zone.name, { force: forcePtr });
      if (ptrResult?.conflict) {
        const err = new Error('PTR conflict');
        err.code = 'PTR_CONFLICT';
        err.conflict = ptrResult.conflict;
        throw err;
      }
    }

    return {
      record: db.prepare('SELECT * FROM dns_records WHERE id = ?').get(result.lastInsertRowid),
      ptrResult
    };
  });

  return insert();
}

export function updateRecord(db, zone, record, fields) {
  const update = db.transaction(() => {
    const oldEnabledA = record.enabled !== 0 && record.type === 'A' && zone.type === 'forward';
    const newEnabled = fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : record.enabled;
    const newEnabledA = newEnabled !== 0 && fields.type === 'A' && zone.type === 'forward';

    db.prepare(`
      UPDATE dns_records SET name = ?, type = ?, value = ?, priority = ?, weight = ?, port = ?, ttl = ?,
        enabled = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      normalizeRecordNameForZone(fields.name, zone.name),
      fields.type,
      fields.value,
      fields.priority,
      fields.weight,
      fields.port,
      fields.ttl,
      newEnabled,
      record.id
    );

    bumpZoneSerial(db, zone.id);

    if (oldEnabledA && (!newEnabledA || record.value !== fields.value)) {
      clearPtrForARecord(db, record.name, record.value, zone.name);
    }
    if (newEnabledA) {
      syncPtrForARecord(db, fields.name, fields.value, zone.name);
    }

    return db.prepare('SELECT * FROM dns_records WHERE id = ?').get(record.id);
  });

  return update();
}

export function deleteRecord(db, zone, record) {
  const del = db.transaction(() => {
    db.prepare('DELETE FROM dns_records WHERE id = ?').run(record.id);
    bumpZoneSerial(db, zone.id);

    if (record.enabled !== 0 && record.type === 'A' && zone.type === 'forward') {
      clearPtrForARecord(db, record.name, record.value, zone.name);
    }
  });

  del();
}

export function deleteDynamicDhcpRecordsByIps(db, addresses) {
  const recordsById = new Map();
  for (const address of addresses || []) {
    const ip = typeof address === 'string' ? address : address.ip_address;
    const subnetId = typeof address === 'string' ? null : address.subnet_id;
    let zoneNames = [];
    if (subnetId != null) {
      zoneNames = db.prepare(`
        SELECT DISTINCT COALESCE(NULLIF(s.domain_name, ''), NULLIF(sub.domain_name, '')) AS name
        FROM subnets sub
        LEFT JOIN dhcp_scopes s ON s.subnet_id = sub.id AND s.enabled = 1
        WHERE sub.id = ?
      `).all(subnetId).map(row => row.name).filter(Boolean);
    }
    if (subnetId != null && zoneNames.length === 0) continue;
    const zoneFilter = zoneNames.length > 0
      ? `AND z.name IN (${zoneNames.map(() => '?').join(',')})`
      : '';
    const matches = db.prepare(`
      SELECT r.*, z.name AS zone_name, z.type AS zone_type
      FROM dns_records r
      JOIN dns_zones z ON z.id = r.zone_id
      WHERE r.type = 'A' AND r.source = 'dhcp' AND r.value = ?
        ${zoneFilter}
    `).all(ip, ...zoneNames);
    for (const record of matches) recordsById.set(record.id, record);
  }
  const records = [...recordsById.values()];

  for (const record of records) {
    const reverse = findReversePtrLocation(db, record.value, { enabledOnly: true });
    const ptr = reverse && db.prepare(`
      SELECT id FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND name = ? AND lower(value) = lower(?)
    `).get(
      reverse.zone.id,
      reverse.ptrName,
      fqdnForRecordName(record.name, record.zone_name)
    );
    deleteRecord(db, {
      id: record.zone_id,
      name: record.zone_name,
      type: record.zone_type
    }, record);
    if (ptr) {
      db.prepare('DELETE FROM dns_records WHERE id = ?').run(ptr.id);
      bumpZoneSerial(db, reverse.zone.id);
    }
  }
  return records.length;
}

export function importRecords(db, zone, records) {
  const importTxn = db.transaction(() => {
    const existingExact = new Set();
    const existingByNameType = new Map();
    for (const r of db.prepare('SELECT id, type, name, value FROM dns_records WHERE zone_id = ?').all(zone.id)) {
      existingExact.add(`${r.type}|${r.name}|${r.value}`);
      existingByNameType.set(`${r.type}|${r.name}`, { id: r.id, value: r.value });
    }

    const insertRecord = db.prepare(
      'INSERT INTO dns_records (zone_id, name, type, value) VALUES (?, ?, ?, ?)'
    );
    const updateRecordValue = db.prepare(
      "UPDATE dns_records SET value = ?, updated_at = datetime('now') WHERE id = ?"
    );

    const results = {
      A: { created: 0, updated: 0, skipped: 0, failed: 0 },
      CNAME: { created: 0, updated: 0, skipped: 0, failed: 0 }
    };
    const aRecordsToSync = [];
    let changed = false;

    for (const r of records) {
      if (!results[r.type]) {
        continue;
      }

      // Normalize at the sink. The import path historically wrote the raw name
      // straight from the Pi-hole file, which is precisely the shape the
      // FQDN-building SQL cannot match.
      const name = normalizeRecordNameForZone(r.name, zone.name);

      const exactKey = `${r.type}|${name}|${r.value}`;
      if (existingExact.has(exactKey)) {
        results[r.type].skipped++;
        continue;
      }

      const nameKey = `${r.type}|${name}`;
      const existing = existingByNameType.get(nameKey);
      try {
        let recordId;
        let previousValue = null;
        if (existing) {
          updateRecordValue.run(r.value, existing.id);
          recordId = existing.id;
          previousValue = existing.value;
          existingExact.delete(`${r.type}|${name}|${existing.value}`);
          existingExact.add(exactKey);
          existingByNameType.set(nameKey, { id: existing.id, value: r.value });
          results[r.type].updated++;
        } else {
          const result = insertRecord.run(zone.id, name, r.type, r.value);
          recordId = result.lastInsertRowid;
          existingExact.add(exactKey);
          existingByNameType.set(nameKey, { id: result.lastInsertRowid, value: r.value });
          results[r.type].created++;
        }
        changed = true;
        if (r.type === 'A') {
          aRecordsToSync.push({ id: recordId, name, value: r.value, previousValue });
        }
      } catch {
        results[r.type].failed++;
      }
    }

    if (changed) {
      bumpZoneSerial(db, zone.id);
    }

    return { results, aRecordsToSync, changed };
  });

  return importTxn();
}
