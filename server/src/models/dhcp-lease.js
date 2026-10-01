import { observeDhcpLeases } from '../services/ip-lifecycle-service.js';
import { queueRegen } from '../utils/after-commit.js';
import { addressInRange, isValidAddress } from '../utils/ip.js';
import { addressFamily, sortKey } from '../utils/address.js';
import { resolveEffectiveScopeOptions } from './dhcp-scope.js';
import { clearPtrForARecord, syncPtrForARecord, normalizeRecordNameForZone } from './dns-record.js';

export function replaceLeases(db, leases, { lifecycleValidated = false } = {}) {
  const replace = db.transaction(() => {
    const previous = new Map(
      db
        .prepare(
          `
      SELECT subnet_id, ip_address, mac_address, hostname, client_id, expires_at, last_seen,
        dhcp_version, duid, iaid
      FROM dhcp_leases
    `,
        )
        .all()
        .map((lease) => [`${lease.subnet_id}|${lease.ip_address}`, lease]),
    );
    const reservationKeys = new Set(
      db
        .prepare(
          `
      SELECT subnet_id, ip_address FROM dhcp_reservations WHERE enabled = 1
    `,
        )
        .all()
        .map((row) => `${row.subnet_id}|${row.ip_address}`),
    );
    db.prepare('DELETE FROM dhcp_leases').run();
    const insert = db.prepare(`
      INSERT INTO dhcp_leases (ip_address, mac_address, hostname, client_id, expires_at, subnet_id,
        last_seen, dhcp_version, duid, iaid)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
    `);
    // The client identity is the MAC for DHCPv4 and the DUID for DHCPv6.
    const clientOf = (mac, duid) => String(duid || mac || '').toLowerCase();
    const observedLeases = leases.map((lease) => {
      const old = previous.get(`${lease.subnetId}|${lease.ip}`);
      return {
        ...lease,
        observedActivity:
          !old ||
          clientOf(old.mac_address, old.duid) !== clientOf(lease.mac, lease.duid) ||
          old.expires_at !== lease.expiresAt,
      };
    });
    for (const l of observedLeases) {
      insert.run(
        l.ip,
        l.mac || null,
        l.hostname,
        l.clientId,
        l.expiresAt,
        l.subnetId,
        l.dhcpVersion || 4,
        l.duid || null,
        l.iaid ?? null,
      );
    }
    const currentKeys = new Set(observedLeases.map((lease) => `${lease.subnetId}|${lease.ip}`));
    const retainExpired = db.prepare(`
      INSERT INTO dhcp_leases
        (ip_address, mac_address, hostname, client_id, expires_at, subnet_id, last_seen,
         dhcp_version, duid, iaid)
      VALUES (?, ?, ?, ?,
        CASE
          WHEN ? = 'infinite' OR datetime(?) > datetime('now') THEN datetime('now')
          ELSE ?
        END,
        ?, ?, ?, ?, ?)
    `);
    for (const [key, old] of previous) {
      if (currentKeys.has(key) || reservationKeys.has(key)) continue;
      retainExpired.run(
        old.ip_address,
        old.mac_address,
        old.hostname,
        old.client_id,
        old.expires_at,
        old.expires_at,
        old.expires_at,
        old.subnet_id,
        old.last_seen,
        old.dhcp_version || 4,
        old.duid,
        old.iaid,
      );
    }
    observeDhcpLeases(db, observedLeases, { prevalidated: lifecycleValidated });
  });

  replace();
}

// The forward zone a DHCP-named address belongs to: the domain of the enabled
// scope whose pool holds it, else its network's domain. Shared by the name
// assignment and the DNS sync so both see the same zone.
function dhcpZoneResolver(db) {
  const scopes = db
    .prepare(
      `
    SELECT s.*, sub.cidr AS subnet_cidr, sub.gateway_address AS subnet_gateway,
      sub.domain_name AS subnet_domain_name
    FROM dhcp_scopes s
    JOIN subnets sub ON s.subnet_id = sub.id
    WHERE s.enabled = 1
  `,
    )
    .all();

  const scopesBySubnet = new Map();
  const allDomains = new Set();
  for (const scope of scopes) {
    scope.pools = db
      .prepare(
        `
      SELECT start_ip, end_ip FROM dhcp_scope_pools
      WHERE scope_id = ? ORDER BY sort_order, id
    `,
      )
      .all(scope.id);
    const effective = resolveEffectiveScopeOptions(db, scope);
    // DHCPv4 names the domain in option 15; DHCPv6 only has the search list
    // (24), whose first entry is the domain a lease's hostname belongs to.
    const domainOption = Number(scope.address_family) === 6 ? 24 : 15;
    scope.effective_domain =
      effective.options
        .find((option) => option.option_code === domainOption)
        ?.value.split(',')[0]
        .trim() ||
      scope.subnet_domain_name ||
      null;
    if (scope.effective_domain) allDomains.add(scope.effective_domain);
    if (!scopesBySubnet.has(scope.subnet_id)) scopesBySubnet.set(scope.subnet_id, []);
    scopesBySubnet.get(scope.subnet_id).push(scope);
  }
  const subnetDomains = new Map(
    db
      .prepare(
        "SELECT id, domain_name FROM subnets WHERE domain_name IS NOT NULL AND domain_name != ''",
      )
      .all()
      .map((subnet) => [subnet.id, subnet.domain_name]),
  );
  for (const domain of subnetDomains.values()) allDomains.add(domain);
  const domainFor = (subnetId, ip) => {
    const scope = isValidAddress(ip)
      ? (scopesBySubnet.get(subnetId) || []).find((candidate) =>
          candidate.pools.some((pool) => addressInRange(ip, pool.start_ip, pool.end_ip)),
        )
      : null;
    return scope?.effective_domain || subnetDomains.get(subnetId) || null;
  };

  const zoneByName = new Map(
    db
      .prepare("SELECT * FROM dns_zones WHERE type = 'forward' AND enabled = 1")
      .all()
      .map((zone) => [zone.name, zone]),
  );
  return {
    allDomains,
    zoneByName,
    domainFor,
    zoneFor: (subnetId, ip) => {
      const domain = subnetId ? domainFor(subnetId, ip) : null;
      return domain ? zoneByName.get(domain) || null : null;
    },
  };
}

const recordTypeFor = (ip) => (addressFamily(ip) === 6 ? 'AAAA' : 'A');

// The suffixes a taken lease name tries in turn: -00 through -FF (ADR 005).
const NAME_SUFFIXES = Array.from(
  { length: 256 },
  (_, i) => `-${i.toString(16).toUpperCase().padStart(2, '0')}`,
);
const MAX_LABEL = 63;

/**
 * Decide each lease's effective name before the leases are stored (ADR 005).
 * A name is unique within its forward zone and sticky to the address that
 * holds it, so two clients sending one name, or dnsmasq handing that name to
 * whichever renewed last, no longer move it between addresses. Mutates and
 * returns `leases`; `fallbackName(mac)` is the vendor name for an unnamed
 * client that holds no name yet.
 */
export function assignLeaseNames(db, leases, { fallbackName = () => null } = {}) {
  const zones = dhcpZoneResolver(db);
  const previousNames = new Map(
    db
      .prepare('SELECT ip_address, hostname FROM dhcp_leases WHERE hostname IS NOT NULL')
      .all()
      .map((row) => [row.ip_address, row.hostname]),
  );
  const zoneRecords = new Map();
  const recordsIn = (zone) => {
    if (!zoneRecords.has(zone.id)) {
      zoneRecords.set(
        zone.id,
        db
          .prepare(
            `SELECT lower(name) AS name, type, value, source FROM dns_records
             WHERE zone_id = ? AND type IN ('A', 'AAAA', 'CNAME')`,
          )
          .all(zone.id),
      );
    }
    return zoneRecords.get(zone.id);
  };
  // Names settled in this batch, per zone: name -> [{ type, ip }].
  const claimed = new Map();
  const isFree = (zone, name, ip) => {
    const type = recordTypeFor(ip);
    const clash = (other) => other.type === 'CNAME' || (other.type === type && other.value !== ip);
    if (recordsIn(zone).some((record) => record.name === name && clash(record))) return false;
    return !(claimed.get(zone.id)?.get(name) || []).some((other) =>
      clash({ type: other.type, value: other.ip }),
    );
  };
  const claim = (zone, lease, hostname) => {
    lease.hostname = hostname;
    if (!hostname) return;
    const name = normalizeRecordNameForZone(hostname, zone.name);
    if (!claimed.has(zone.id)) claimed.set(zone.id, new Map());
    const names = claimed.get(zone.id);
    names.set(name, [...(names.get(name) || []), { type: recordTypeFor(lease.ip), ip: lease.ip }]);
  };

  const pending = [];
  for (const lease of leases) {
    const zone = zones.zoneFor(lease.subnetId, lease.ip);
    if (!zone) {
      if (!lease.hostname && lease.mac) lease.hostname = fallbackName(lease.mac) || null;
      continue;
    }
    // The DHCP-derived name this address already holds, if any.
    const held = recordsIn(zone).find(
      (record) =>
        record.source === 'dhcp' &&
        record.value === lease.ip &&
        record.type === recordTypeFor(lease.ip),
    )?.name;
    const wanted = lease.hostname ? normalizeRecordNameForZone(lease.hostname, zone.name) : null;
    const keepsHeld =
      held &&
      (!wanted ||
        held === wanted ||
        new RegExp(`^${escapeRegExp(wanted)}-[0-9a-f]{2}$`).test(held));
    if (keepsHeld) {
      // Keep the spelling the lease was stored with when it still names the
      // held record, so the case a client sent does not churn.
      const previous = previousNames.get(lease.ip);
      const stored =
        previous && normalizeRecordNameForZone(previous, zone.name) === held
          ? previous
          : held === wanted
            ? lease.hostname
            : held;
      claim(zone, lease, stored);
    } else {
      pending.push({ lease, zone, candidate: lease.hostname || fallbackName(lease.mac) || null });
    }
  }

  pending.sort((a, b) => sortKey(a.lease.ip).localeCompare(sortKey(b.lease.ip)));
  for (const { lease, zone, candidate } of pending) {
    if (!candidate) {
      lease.hostname = null;
      continue;
    }
    const base = candidate.slice(0, MAX_LABEL - 3);
    const options = [candidate, ...NAME_SUFFIXES.map((suffix) => `${base}${suffix}`)];
    const free = options.find((option) =>
      isFree(zone, normalizeRecordNameForZone(option, zone.name), lease.ip),
    );
    if (!free) {
      console.warn(
        `DHCP lease ${lease.ip}: ${candidate} and all 256 suffixes are taken in ${zone.name}; leaving it unnamed`,
      );
    }
    claim(zone, lease, free || null);
  }
  return leases;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sync DHCP lease and reservation hostnames into dns_records table as A records.
 * Reservations take priority over dynamic leases for the same IP.
 */
export function syncDhcpDnsRecords(db, leases) {
  const { allDomains, zoneByName, domainFor } = dhcpZoneResolver(db);

  let reservations;
  try {
    reservations = db
      .prepare(
        `
      SELECT r.ip_address, r.hostname, r.mac_address, r.subnet_id
      FROM dhcp_reservations r
      WHERE r.enabled = 1 AND r.hostname IS NOT NULL AND r.hostname != ''
    `,
      )
      .all();
  } catch (err) {
    console.error('Failed to query DHCP Reservations for DNS sync:', err.message);
    return;
  }

  const reservationIps = new Set(reservations.map((r) => r.ip_address));
  const entries = leases
    .filter((l) => !reservationIps.has(l.ip))
    .map((l) => ({ ...l, source: 'dhcp' }));

  for (const r of reservations) {
    entries.push({
      ip: r.ip_address,
      hostname: r.hostname,
      subnetId: r.subnet_id,
      source: 'reservation',
    });
  }

  const activeRecordIds = new Set();
  const processedZoneIds = new Set();
  for (const domain of allDomains) {
    const z = zoneByName.get(domain);
    if (z) processedZoneIds.add(z.id);
  }
  let configChanged = false;

  // A DHCPv6 lease names its address with an AAAA record.
  const findRecord = db.prepare(`
    SELECT id, source FROM dns_records WHERE zone_id = ? AND name = ? AND type = ? AND value = ?
  `);
  const insertDhcp = db.prepare(`
    INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  const touchDhcp = db.prepare(`
    UPDATE dns_records SET updated_at = datetime('now') WHERE id = ?
  `);
  const updateSource = db.prepare(`
    UPDATE dns_records SET source = ?, updated_at = datetime('now') WHERE id = ?
  `);
  const syncPtr = (zone, recordName, ip, source) => {
    const result = syncPtrForARecord(db, recordName, ip, zone.name, { source });
    if (result?.conflict) {
      console.warn(
        `Skipping DHCP PTR sync for ${ip}: ${result.conflict.existing} already owns ${result.conflict.reverseZone}`,
      );
      return false;
    }
    return Boolean(result?.updated);
  };
  const activeIps = new Set();

  for (const l of entries) {
    if (!l.hostname || !l.subnetId) continue;

    const domain = domainFor(l.subnetId, l.ip);
    if (!domain) continue;

    const zone = zoneByName.get(domain);
    if (!zone) continue;

    processedZoneIds.add(zone.id);

    // Normalize at the sink. This is where the un-normalized names came from:
    // the lease hostname is whatever the client reported ("S24-Ultra"), and it
    // used to be stored raw with only the domain suffix stripped by hand. The
    // FQDN-building SQL then produced "S24-Ultra.example.com" where the JS
    // builder produced "s24-ultra.example.com", and SQLite `=` is
    // case-sensitive. See REVIEW.md, duplicate-logic audit #8.
    const recordName = normalizeRecordNameForZone(l.hostname, domain);

    const existing = findRecord.get(zone.id, recordName, recordTypeFor(l.ip), l.ip);
    if (existing) {
      if (existing.source === 'dhcp' || existing.source === 'reservation') {
        if (existing.source !== (l.source || 'dhcp')) {
          updateSource.run(l.source || 'dhcp', existing.id);
          configChanged = true;
        } else {
          touchDhcp.run(existing.id);
        }
        activeRecordIds.add(existing.id);
        activeIps.add(l.ip);
        if (syncPtr(zone, recordName, l.ip, l.source || 'dhcp')) configChanged = true;
      }
    } else {
      const result = insertDhcp.run(
        zone.id,
        recordName,
        recordTypeFor(l.ip),
        l.ip,
        l.source || 'dhcp',
      );
      activeRecordIds.add(result.lastInsertRowid);
      activeIps.add(l.ip);
      syncPtr(zone, recordName, l.ip, l.source || 'dhcp');
      configChanged = true;
    }
  }

  if (processedZoneIds.size > 0) {
    const zoneIds = [...processedZoneIds];
    const placeholders = zoneIds.map(() => '?').join(',');
    const staleRecords = db
      .prepare(
        `SELECT r.id, r.name, r.value, r.source, z.name AS zone_name
       FROM dns_records r
       JOIN dns_zones z ON z.id = r.zone_id
       WHERE r.source IN ('dhcp', 'reservation') AND r.zone_id IN (${placeholders})`,
      )
      .all(...zoneIds);
    for (const r of staleRecords) {
      if (!activeRecordIds.has(r.id)) {
        // A vanished dynamic lease loses allocation authority immediately, but
        // its generated name remains with the learned host metadata until the
        // one-hour continuous-offline retirement boundary. A replacement name
        // for the same active IP still removes this stale row immediately.
        if (r.source === 'dhcp' && !activeIps.has(r.value)) continue;
        if (!activeIps.has(r.value)) {
          clearPtrForARecord(db, r.name, r.value, r.zone_name);
        }
        db.prepare('DELETE FROM dns_records WHERE id = ?').run(r.id);
        configChanged = true;
      }
    }
  }

  if (configChanged) {
    queueRegen('regenerate_dns');
  }
}
