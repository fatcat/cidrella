import { observeDhcpLeases } from '../services/ip-lifecycle-service.js';
import { queueRegen } from '../utils/after-commit.js';
import { clearPtrForARecord, syncPtrForARecord, normalizeRecordNameForZone } from './dns-record.js';

export function findLeasesByAddress(db, subnetId, ip) {
  return db.prepare(`
    SELECT ip_address, mac_address, client_id, expires_at
    FROM dhcp_leases
    WHERE subnet_id = ? AND ip_address = ?
  `).all(subnetId, ip);
}

export function deleteLeasesByAddress(db, subnetId, ip) {
  return db.prepare(
    'DELETE FROM dhcp_leases WHERE subnet_id = ? AND ip_address = ?'
  ).run(subnetId, ip);
}

export function replaceLeases(db, leases, { lifecycleValidated = false } = {}) {
  const replace = db.transaction(() => {
    const previous = new Map(db.prepare(`
      SELECT subnet_id, ip_address, mac_address, hostname, client_id, expires_at, last_seen
      FROM dhcp_leases
    `).all().map(lease => [`${lease.subnet_id}|${lease.ip_address}`, lease]));
    const reservationKeys = new Set(db.prepare(`
      SELECT subnet_id, ip_address FROM dhcp_reservations WHERE enabled = 1
    `).all().map(row => `${row.subnet_id}|${row.ip_address}`));
    db.prepare('DELETE FROM dhcp_leases').run();
    const insert = db.prepare(`
      INSERT INTO dhcp_leases (ip_address, mac_address, hostname, client_id, expires_at, subnet_id, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    const observedLeases = leases.map(lease => {
      const old = previous.get(`${lease.subnetId}|${lease.ip}`);
      return {
        ...lease,
        observedActivity: !old
          || String(old.mac_address).toLowerCase() !== String(lease.mac || '').toLowerCase()
          || old.expires_at !== lease.expiresAt
      };
    });
    for (const l of observedLeases) {
      insert.run(l.ip, l.mac, l.hostname, l.clientId, l.expiresAt, l.subnetId);
    }
    const currentKeys = new Set(observedLeases.map(lease => `${lease.subnetId}|${lease.ip}`));
    const retainExpired = db.prepare(`
      INSERT INTO dhcp_leases
        (ip_address, mac_address, hostname, client_id, expires_at, subnet_id, last_seen)
      VALUES (?, ?, ?, ?,
        CASE
          WHEN ? = 'infinite' OR datetime(?) > datetime('now') THEN datetime('now')
          ELSE ?
        END,
        ?, ?)
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
        old.last_seen
      );
    }
    observeDhcpLeases(db, observedLeases, { prevalidated: lifecycleValidated });
  });

  replace();
}

/**
 * Sync DHCP lease and reservation hostnames into dns_records table as A records.
 * Reservations take priority over dynamic leases for the same IP.
 */
export function syncDhcpDnsRecords(db, leases) {
  const scopes = db.prepare(`
    SELECT s.subnet_id, s.domain_name as scope_domain, sub.domain_name as subnet_domain
    FROM dhcp_scopes s
    JOIN subnets sub ON s.subnet_id = sub.id
    WHERE s.enabled = 1
  `).all();

  const subnetDomainMap = new Map();
  for (const s of scopes) {
    const domain = s.scope_domain || s.subnet_domain;
    if (domain) subnetDomainMap.set(s.subnet_id, domain);
  }

  let reservations;
  try {
    reservations = db.prepare(`
      SELECT r.ip_address, r.hostname, r.mac_address, r.subnet_id
      FROM dhcp_reservations r
      WHERE r.enabled = 1 AND r.hostname IS NOT NULL AND r.hostname != ''
    `).all();
  } catch (err) {
    console.error('Failed to query DHCP reservations for DNS sync:', err.message);
    return;
  }

  const reservationIps = new Set(reservations.map(r => r.ip_address));
  const entries = leases
    .filter(l => !reservationIps.has(l.ip))
    .map(l => ({ ...l, source: 'dhcp' }));

  for (const r of reservations) {
    entries.push({
      ip: r.ip_address,
      hostname: r.hostname,
      subnetId: r.subnet_id,
      source: 'reservation'
    });
  }

  const forwardZones = db.prepare("SELECT * FROM dns_zones WHERE type = 'forward' AND enabled = 1").all();
  const zoneByName = new Map();
  for (const z of forwardZones) zoneByName.set(z.name, z);

  const activeRecordIds = new Set();
  const processedZoneIds = new Set();
  for (const domain of subnetDomainMap.values()) {
    const z = zoneByName.get(domain);
    if (z) processedZoneIds.add(z.id);
  }
  let configChanged = false;

  const findRecord = db.prepare(`
    SELECT id, source FROM dns_records WHERE zone_id = ? AND name = ? AND type = 'A' AND value = ?
  `);
  const insertDhcp = db.prepare(`
    INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
    VALUES (?, ?, 'A', ?, ?, 1)
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
        `Skipping DHCP PTR sync for ${ip}: ${result.conflict.existing} already owns ${result.conflict.reverseZone}`
      );
      return false;
    }
    return Boolean(result?.updated);
  };
  const activeIps = new Set();

  for (const l of entries) {
    if (!l.hostname || !l.subnetId) continue;

    const domain = subnetDomainMap.get(l.subnetId);
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

    const existing = findRecord.get(zone.id, recordName, l.ip);
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
      const result = insertDhcp.run(zone.id, recordName, l.ip, l.source || 'dhcp');
      activeRecordIds.add(result.lastInsertRowid);
      activeIps.add(l.ip);
      syncPtr(zone, recordName, l.ip, l.source || 'dhcp');
      configChanged = true;
    }
  }

  if (processedZoneIds.size > 0) {
    const zoneIds = [...processedZoneIds];
    const placeholders = zoneIds.map(() => '?').join(',');
    const staleRecords = db.prepare(
      `SELECT r.id, r.name, r.value, r.source, z.name AS zone_name
       FROM dns_records r
       JOIN dns_zones z ON z.id = r.zone_id
       WHERE r.source IN ('dhcp', 'reservation') AND r.zone_id IN (${placeholders})`
    ).all(...zoneIds);
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
