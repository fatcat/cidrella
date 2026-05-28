import { syncLeasesToIps } from '../utils/ip-sync.js';
import { queueRegen } from '../utils/after-commit.js';

export function replaceLeases(db, leases) {
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM dhcp_leases').run();
    const insert = db.prepare(`
      INSERT INTO dhcp_leases (ip_address, mac_address, hostname, client_id, expires_at, subnet_id, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    for (const l of leases) {
      insert.run(l.ip, l.mac, l.hostname, l.clientId, l.expiresAt, l.subnetId);
    }
  });

  replace();
  syncLeasesToIps(db, leases);
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

  let reservations = [];
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

  for (const l of entries) {
    if (!l.hostname || !l.subnetId) continue;

    const domain = subnetDomainMap.get(l.subnetId);
    if (!domain) continue;

    const zone = zoneByName.get(domain);
    if (!zone) continue;

    processedZoneIds.add(zone.id);

    let recordName = l.hostname;
    if (recordName.endsWith('.' + domain)) {
      recordName = recordName.slice(0, -(domain.length + 1));
    }

    const existing = findRecord.get(zone.id, recordName, l.ip);
    if (existing) {
      if (existing.source === 'dhcp' || existing.source === 'reservation') {
        if (existing.source !== (l.source || 'dhcp')) {
          updateSource.run(l.source || 'dhcp', existing.id);
        } else {
          touchDhcp.run(existing.id);
        }
        activeRecordIds.add(existing.id);
      }
    } else {
      const result = insertDhcp.run(zone.id, recordName, l.ip, l.source || 'dhcp');
      activeRecordIds.add(result.lastInsertRowid);
      configChanged = true;
    }
  }

  if (processedZoneIds.size > 0) {
    const zoneIds = [...processedZoneIds];
    const placeholders = zoneIds.map(() => '?').join(',');
    const staleRecords = db.prepare(
      `SELECT id FROM dns_records WHERE source IN ('dhcp', 'reservation') AND zone_id IN (${placeholders})`
    ).all(...zoneIds);
    for (const r of staleRecords) {
      if (!activeRecordIds.has(r.id)) {
        db.prepare('DELETE FROM dns_records WHERE id = ?').run(r.id);
        configChanged = true;
      }
    }
  }

  if (configChanged) {
    queueRegen('regenerate_dns');
  }
}
