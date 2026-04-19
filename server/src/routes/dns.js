import { Router } from 'express';
import { getDb, getSetting, setSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { queueRegen } from '../utils/after-commit.js';
import { syncDnsToIp, clearDnsFromIp } from '../utils/ip-sync.js';
import { testDnsForwarder } from '../utils/dns-test.js';

const router = Router();

// Validation helpers
import { isValidIpv4, isValidDomain } from '../utils/ip.js';
import { isValidPtrName, validateTxtValue } from '../utils/dnsmasq-escape.js';
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const SRV_NAME_RE = /^_[a-zA-Z0-9-]+\._[a-zA-Z]+$/;

function isValidHostname(name) {
  return name === '@' || (typeof name === 'string' && HOSTNAME_RE.test(name) && name.length <= 253);
}

function isIntInRange(v, lo, hi) {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}

// Build the FQDN that a record name points at inside its zone. '@' means the
// zone apex. Used for CNAME self-loop detection.
function fqdnFor(name, zoneName) {
  return name === '@' ? zoneName : `${name}.${zoneName}`;
}

function validateRecord(type, { name, value, priority, weight, port }, zoneName) {
  switch (type) {
    case 'A':
      if (!isValidHostname(name)) return 'Invalid hostname';
      if (!isValidIpv4(value)) return 'Invalid IPv4 address';
      break;
    case 'CNAME':
      if (name === '@') return 'CNAME cannot be at zone apex (@)';
      if (!isValidHostname(name)) return 'Invalid hostname';
      if (!isValidDomain(value)) return 'Invalid target domain';
      // Refuse a CNAME whose value resolves back to itself. dnsmasq handles
      // the loop by returning SERVFAIL, but refusing at validation time
      // catches obvious typos and makes the error message diagnostic.
      if (zoneName && value.toLowerCase() === fqdnFor(name, zoneName).toLowerCase()) {
        return 'CNAME target cannot reference itself';
      }
      break;
    case 'MX':
      if (!isValidHostname(name)) return 'Invalid hostname';
      if (!isValidDomain(value)) return 'Invalid mail server domain';
      if (!isIntInRange(priority, 0, 65535)) return 'Priority must be an integer 0-65535';
      break;
    case 'TXT':
      if (!isValidHostname(name)) return 'Invalid hostname';
      // TXT values end up inside a quoted dnsmasq directive; a newline would
      // terminate the quoted span and let an attacker append directives.
      // validateTxtValue enforces string + no CR/LF/control chars.
      {
        const err = validateTxtValue(value);
        if (err) return `TXT value ${err}`;
      }
      break;
    case 'SRV':
      if (!SRV_NAME_RE.test(name)) return 'SRV name must be _service._protocol format';
      if (!isValidDomain(value)) return 'Invalid target domain';
      if (!isIntInRange(port, 0, 65535)) return 'Port must be an integer 0-65535';
      if (!isIntInRange(priority, 0, 65535)) return 'Priority must be an integer 0-65535';
      if (!isIntInRange(weight, 0, 65535)) return 'Weight must be an integer 0-65535';
      break;
    case 'PTR':
      // PTR name is unreversed octets (e.g. "5" or "5.12"). Locking it to
      // digits-and-dots means the generated ptr-record=<name>.<zone>,<value>
      // line is safe by construction — no newline / "=" / "," injection.
      if (!isValidPtrName(name)) return 'PTR name must be numeric-octets-and-dots (e.g., "5" or "5.12")';
      if (!isValidDomain(value)) return 'Invalid target hostname';
      break;
    default:
      return `Unknown record type: ${type}`;
  }
  return null;
}

// ─── PTR Sync Helpers ─────────────────────────────────────

/**
 * Find the reverse zone matching an IP address.
 * Returns { zone, ptrName } or null.
 */
function findReverseZone(db, ip) {
  const octets = ip.split('.');
  // Try /24 first (most common), then /16, then /8
  const candidates = [
    { name: `${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`, ptrName: octets[3] },
    { name: `${octets[1]}.${octets[0]}.in-addr.arpa`, ptrName: `${octets[3]}.${octets[2]}` },
    { name: `${octets[0]}.in-addr.arpa`, ptrName: `${octets[3]}.${octets[2]}.${octets[1]}` }
  ];

  for (const c of candidates) {
    const zone = db.prepare("SELECT * FROM dns_zones WHERE name = ? AND type = 'reverse' AND enabled = 1").get(c.name);
    if (zone) return { zone, ptrName: c.ptrName };
  }
  return null;
}

/**
 * Create or update a PTR record for an A record's IP in the matching reverse
 * zone. Returns { conflict } if an existing PTR already points at a different
 * FQDN from another forward zone — callers can choose to honor or reject.
 */
function syncPtrForARecord(db, recordName, ip, forwardZoneName, { force = false } = {}) {
  const match = findReverseZone(db, ip);
  if (!match) return { updated: false }; // No matching reverse zone

  const { zone, ptrName } = match;
  const fqdn = recordName === '@' ? forwardZoneName : `${recordName}.${forwardZoneName}`;

  const existing = db.prepare('SELECT * FROM dns_records WHERE zone_id = ? AND type = ? AND name = ?').get(zone.id, 'PTR', ptrName);

  if (existing) {
    // M9 fix: if an existing PTR points at an FQDN in a DIFFERENT forward
    // zone, don't silently overwrite it. In today's single-admin model the
    // last-write-wins behavior is a foot-gun; the moment zone-level RBAC
    // is added it becomes an IDOR. `force:true` lets callers opt in (the
    // UI can surface a confirmation).
    if (!force && existing.value && existing.value !== ip) {
      const bareIp = /^\d+\.\d+\.\d+\.\d+$/.test(existing.value);
      if (!bareIp && existing.value.toLowerCase() !== fqdn.toLowerCase()) {
        // Different forward zone? Only block if the existing target isn't
        // already part of THIS forward zone (catches the cross-zone case
        // while still allowing name changes within the same zone).
        if (!existing.value.toLowerCase().endsWith('.' + forwardZoneName.toLowerCase()) &&
            existing.value.toLowerCase() !== forwardZoneName.toLowerCase()) {
          return { conflict: { existing: existing.value, proposed: fqdn, reverseZone: zone.name } };
        }
      }
    }
    db.prepare("UPDATE dns_records SET value = ?, updated_at = datetime('now') WHERE id = ?").run(fqdn, existing.id);
  } else {
    db.prepare('INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, ?, ?, ?, 1)').run(zone.id, ptrName, 'PTR', fqdn);
  }

  db.prepare("UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime('now') WHERE id = ?").run(zone.id);
  return { updated: true };
}

/**
 * Revert a PTR record back to bare IP when the corresponding A record is deleted.
 */
function clearPtrForIp(db, ip) {
  const match = findReverseZone(db, ip);
  if (!match) return;

  const { zone, ptrName } = match;
  const existing = db.prepare('SELECT * FROM dns_records WHERE zone_id = ? AND type = ? AND name = ?').get(zone.id, 'PTR', ptrName);
  if (existing) {
    // Revert to bare IP (indicating unresolved)
    db.prepare("UPDATE dns_records SET value = ?, updated_at = datetime('now') WHERE id = ?").run(ip, existing.id);
    db.prepare("UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime('now') WHERE id = ?").run(zone.id);
  }
}

// ─── Zones ───────────────────────────────────────────────

// GET /api/dns/zones
router.get('/zones', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const zones = db.prepare(`
    SELECT z.*,
      (SELECT COUNT(*) FROM dns_records WHERE zone_id = z.id) as record_count
    FROM dns_zones z
    ORDER BY z.type, z.name
  `).all();
  res.json(zones);
});

// GET /api/dns/zones/:id
router.get('/zones/:id', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const zone = db.prepare(`
    SELECT z.*,
      (SELECT COUNT(*) FROM dns_records WHERE zone_id = z.id) as record_count
    FROM dns_zones z WHERE z.id = ?
  `).get(req.params.id);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const records = db.prepare(`
    SELECT r.*, ip.is_online
    FROM dns_records r
    LEFT JOIN ip_addresses ip ON r.type = 'A' AND ip.ip_address = r.value
    WHERE r.zone_id = ?
    ORDER BY r.type, r.name
  `).all(zone.id);

  res.json({ ...zone, records });
});

// POST /api/dns/zones — zones are subnet-agnostic. Any number of subnets
// can share a forward zone via matching `subnets.domain_name`, and any
// reverse zone is queried by name derived from an IP at PTR time.
router.post('/zones', requirePerm('dns:write'), (req, res) => {
  const body = req.body || {};
  const { name, type, description,
          soa_primary_ns, soa_admin_email, soa_refresh, soa_retry, soa_expire, soa_minimum_ttl } = body;

  if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'Zone name is required (string)' });
  if (typeof type !== 'string' || !['forward', 'reverse'].includes(type)) {
    return res.status(400).json({ error: 'Zone type must be forward or reverse' });
  }
  if (!isValidDomain(name) && !name.endsWith('.in-addr.arpa')) {
    return res.status(400).json({ error: 'Invalid zone name' });
  }

  const db = getDb();

  const existing = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(name);
  if (existing) return res.status(409).json({ error: 'Zone already exists' });

  const soaDefaults = getSetting('dns_soa_defaults');

  const result = db.prepare(`
    INSERT INTO dns_zones (name, type, description,
      soa_primary_ns, soa_admin_email, soa_refresh, soa_retry, soa_expire, soa_minimum_ttl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, type, description || null,
    soa_primary_ns || soaDefaults.soa_primary_ns, soa_admin_email || soaDefaults.soa_admin_email,
    soa_refresh ?? soaDefaults.soa_refresh, soa_retry ?? soaDefaults.soa_retry,
    soa_expire ?? soaDefaults.soa_expire, soa_minimum_ttl ?? soaDefaults.soa_minimum_ttl);

  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(result.lastInsertRowid);
  audit(req.user.id, 'zone_created', 'dns_zone', zone.id, { name, type });

  req.afterCommit('regenerate_dns');
  res.status(201).json(zone);
});

// PUT /api/dns/zones/:id
router.put('/zones/:id', requirePerm('dns:write'), (req, res) => {
  const { name, description, enabled,
          soa_primary_ns, soa_admin_email, soa_refresh, soa_retry, soa_expire, soa_minimum_ttl } = req.body;
  const db = getDb();

  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(req.params.id);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const renaming = name && name !== zone.name;
  if (renaming) {
    const dup = db.prepare('SELECT id FROM dns_zones WHERE name = ? AND id != ?').get(name, zone.id);
    if (dup) return res.status(409).json({ error: 'Zone name already taken' });
  }

  const newSerial = (zone.soa_serial || 0) + 1;

  // On rename, update every subnet whose `domain_name` references the old
  // zone name — zones are now subnet-agnostic, so any number of subnets
  // may point at this zone. Wrap in a txn so rename + sync are atomic.
  const upd = db.transaction(() => {
    db.prepare(`
      UPDATE dns_zones SET name = ?, description = ?, enabled = ?,
        soa_primary_ns = ?, soa_admin_email = ?, soa_serial = ?,
        soa_refresh = ?, soa_retry = ?, soa_expire = ?, soa_minimum_ttl = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? zone.name,
      description !== undefined ? description : zone.description,
      enabled !== undefined ? (enabled ? 1 : 0) : zone.enabled,
      soa_primary_ns !== undefined ? soa_primary_ns : zone.soa_primary_ns,
      soa_admin_email !== undefined ? soa_admin_email : zone.soa_admin_email,
      newSerial,
      soa_refresh !== undefined ? soa_refresh : zone.soa_refresh,
      soa_retry !== undefined ? soa_retry : zone.soa_retry,
      soa_expire !== undefined ? soa_expire : zone.soa_expire,
      soa_minimum_ttl !== undefined ? soa_minimum_ttl : zone.soa_minimum_ttl,
      zone.id
    );

    if (renaming && zone.type === 'forward') {
      db.prepare(
        "UPDATE subnets SET domain_name = ?, updated_at = datetime('now') WHERE domain_name = ?"
      ).run(name, zone.name);
    }
  });
  upd();

  const updated = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(zone.id);
  audit(req.user.id, 'zone_updated', 'dns_zone', zone.id, { changes: req.body });

  req.afterCommit('regenerate_dns');
  res.json(updated);
});

// DELETE /api/dns/zones/:id
router.delete('/zones/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(req.params.id);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const del = db.transaction(() => {
    // Clear every subnet that was pointing at this forward zone — multiple
    // subnets may reference it via `domain_name` post-decouple.
    if (zone.type === 'forward') {
      db.prepare(
        "UPDATE subnets SET domain_name = NULL, updated_at = datetime('now') WHERE domain_name = ?"
      ).run(zone.name);
    }
    db.prepare('DELETE FROM dns_zones WHERE id = ?').run(zone.id);
  });
  del();

  audit(req.user.id, 'zone_deleted', 'dns_zone', zone.id, { name: zone.name });

  req.afterCommit('regenerate_dns');
  res.json({ message: 'Zone deleted' });
});

// ─── Records ─────────────────────────────────────────────

// GET /api/dns/zones/:zoneId/records
router.get('/zones/:zoneId/records', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const zone = db.prepare('SELECT id FROM dns_zones WHERE id = ?').get(req.params.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const records = db.prepare(`
    SELECT r.*, ip.is_online
    FROM dns_records r
    LEFT JOIN ip_addresses ip ON r.type = 'A' AND ip.ip_address = r.value
    WHERE r.zone_id = ?
    ORDER BY r.type, r.name
  `).all(zone.id);
  res.json(records);
});

// POST /api/dns/zones/:zoneId/records
router.post('/zones/:zoneId/records', requirePerm('dns:write'), (req, res) => {
  const body = req.body || {};
  const { name, type, value, priority, weight, port, ttl, enabled, force_ptr } = body;
  const db = getDb();

  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(req.params.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  // String-type guards up front — otherwise `name.endsWith` / `value.split`
  // calls later crash with `.foo is not a function` 500s (H6 in v0.4.14).
  if (typeof name !== 'string' || typeof type !== 'string' || typeof value !== 'string') {
    return res.status(400).json({ error: 'name, type, and value must be strings' });
  }
  if (!name || !type || !value) {
    return res.status(400).json({ error: 'Name, type, and value are required' });
  }

  const validTypes = ['A', 'CNAME', 'MX', 'TXT', 'SRV', 'PTR'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `Type must be one of: ${validTypes.join(', ')}` });
  }

  // Reverse zones only allow PTR records
  if (zone.type === 'reverse' && type !== 'PTR') {
    return res.status(400).json({ error: 'Reverse zones only support PTR records' });
  }

  if (ttl !== undefined && ttl !== null) {
    if (!isIntInRange(ttl, 0, 2147483647)) {
      return res.status(400).json({ error: 'TTL must be an integer 0-2147483647' });
    }
  }

  const validationError = validateRecord(type, { name, value, priority, weight, port }, zone.name);
  if (validationError) return res.status(400).json({ error: validationError });

  // Check for duplicate A records
  if (type === 'A') {
    const dup = db.prepare(
      'SELECT id FROM dns_records WHERE zone_id = ? AND name = ? AND type = ? AND value = ?'
    ).get(zone.id, name, type, value);
    if (dup) return res.status(409).json({ error: 'Duplicate A record (same name and value)' });
  }

  // Warn about CNAME conflicts
  if (type === 'CNAME') {
    const conflict = db.prepare(
      'SELECT id, type FROM dns_records WHERE zone_id = ? AND name = ? AND type != ?'
    ).get(zone.id, name, 'CNAME');
    if (conflict) {
      return res.status(409).json({ error: `CNAME at "${name}" conflicts with existing ${conflict.type} record` });
    }
  }

  const result = db.prepare(`
    INSERT INTO dns_records (zone_id, name, type, value, priority, weight, port, ttl, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    zone.id, name, type, value,
    priority ?? null, weight ?? null, port ?? null, ttl ?? null,
    enabled !== undefined ? (enabled ? 1 : 0) : 1
  );

  // Increment zone SOA serial on record change
  db.prepare('UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime(\'now\') WHERE id = ?').run(zone.id);

  const record = db.prepare('SELECT * FROM dns_records WHERE id = ?').get(result.lastInsertRowid);
  audit(req.user.id, 'record_created', 'dns_record', record.id, { zone: zone.name, name, type, value });

  // Auto-create/update PTR record when A record is added to a forward zone.
  // If the PTR already points at a different forward zone's FQDN, refuse
  // unless the caller passed force_ptr:true (M9 — cross-zone PTR hijack).
  if (type === 'A' && zone.type === 'forward') {
    const ptrResult = syncPtrForARecord(db, name, value, zone.name, { force: !!force_ptr });
    if (ptrResult?.conflict) {
      // Undo the A record insert so the state is consistent with the 409.
      db.prepare('DELETE FROM dns_records WHERE id = ?').run(result.lastInsertRowid);
      return res.status(409).json({
        error: 'PTR for this IP already points at a different forward zone',
        ptr_conflict: ptrResult.conflict,
        hint: 'Pass force_ptr:true to overwrite'
      });
    }
    syncDnsToIp(db, name, value, zone.name);
  }

  req.afterCommit('regenerate_dns');
  res.status(201).json(record);
});

// PUT /api/dns/zones/:zoneId/records/:id
router.put('/zones/:zoneId/records/:id', requirePerm('dns:write'), (req, res) => {
  const body = req.body || {};
  const { name, type, value, priority, weight, port, ttl, enabled } = body;
  const db = getDb();

  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(req.params.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const record = db.prepare('SELECT * FROM dns_records WHERE id = ? AND zone_id = ?').get(req.params.id, zone.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  if (record.source === 'dhcp') {
    return res.status(403).json({ error: 'DHCP-managed records cannot be edited manually' });
  }

  // Type guards for string fields: if the client sent one explicitly but as
  // a non-string, refuse up front rather than crashing the writer.
  for (const [k, v] of [['name', name], ['type', type], ['value', value]]) {
    if (v !== undefined && typeof v !== 'string') {
      return res.status(400).json({ error: `${k} must be a string` });
    }
  }

  const newType = type || record.type;
  const newName = name ?? record.name;
  const newValue = value ?? record.value;
  const newPriority = priority !== undefined ? priority : record.priority;
  const newWeight = weight !== undefined ? weight : record.weight;
  const newPort = port !== undefined ? port : record.port;
  const newTtl = ttl !== undefined ? ttl : record.ttl;

  if (newTtl !== null && newTtl !== undefined) {
    if (!isIntInRange(newTtl, 0, 2147483647)) {
      return res.status(400).json({ error: 'TTL must be an integer 0-2147483647' });
    }
  }

  const validationError = validateRecord(newType, {
    name: newName, value: newValue,
    priority: newPriority, weight: newWeight, port: newPort
  }, zone.name);
  if (validationError) return res.status(400).json({ error: validationError });

  db.prepare(`
    UPDATE dns_records SET name = ?, type = ?, value = ?, priority = ?, weight = ?, port = ?, ttl = ?,
      enabled = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    newName, newType, newValue, newPriority, newWeight, newPort, newTtl,
    enabled !== undefined ? (enabled ? 1 : 0) : record.enabled,
    record.id
  );

  // Increment zone SOA serial on record change
  db.prepare('UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime(\'now\') WHERE id = ?').run(zone.id);

  const updated = db.prepare('SELECT * FROM dns_records WHERE id = ?').get(record.id);
  audit(req.user.id, 'record_updated', 'dns_record', record.id, { changes: req.body });

  // Sync PTR + ip_addresses when an A record is updated in a forward zone.
  // Clear the OLD hostname whenever NAME OR VALUE changed — the previous
  // version would skip the clear when only the name changed, leaving an
  // orphan entry pointing at the old hostname on the IP.
  if (newType === 'A' && zone.type === 'forward') {
    if (record.value !== newValue) {
      clearPtrForIp(db, record.value);
      clearDnsFromIp(db, record.name, record.value, zone.name);
    } else if (record.name !== newName) {
      // Name-only change on the same IP: the ip_addresses row still has the
      // old FQDN. syncDnsToIp below will overwrite it, but we clear
      // explicitly so the `dns_removed` event is recorded.
      clearDnsFromIp(db, record.name, record.value, zone.name);
    }
    syncPtrForARecord(db, newName, newValue, zone.name);
    syncDnsToIp(db, newName, newValue, zone.name);
  }

  req.afterCommit('regenerate_dns');
  res.json(updated);
});

// DELETE /api/dns/zones/:zoneId/records/:id
router.delete('/zones/:zoneId/records/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const record = db.prepare('SELECT * FROM dns_records WHERE id = ? AND zone_id = ?').get(req.params.id, req.params.zoneId);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  if (record.source === 'dhcp') {
    return res.status(403).json({ error: 'DHCP-managed records cannot be deleted manually' });
  }

  db.prepare('DELETE FROM dns_records WHERE id = ?').run(record.id);

  // Increment zone SOA serial on record change
  db.prepare('UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime(\'now\') WHERE id = ?').run(record.zone_id);

  // Clear PTR and IP hostname when A record is deleted from a forward zone
  const delZone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(record.zone_id);
  if (record.type === 'A' && delZone?.type === 'forward') {
    clearPtrForIp(db, record.value);
    clearDnsFromIp(db, record.name, record.value, delZone.name);
  }

  audit(req.user.id, 'record_deleted', 'dns_record', record.id, { type: record.type, name: record.name });

  req.afterCommit('regenerate_dns');
  res.json({ message: 'Record deleted' });
});

// ─── Utility ─────────────────────────────────────────────

// POST /api/dns/apply — force regenerate all config files. Routes through
// the shared single-flight so a concurrent lease watcher or request hook
// doesn't race on hosts.d/*.hosts emission.
router.post('/apply', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  queueRegen('regenerate_dns');

  const zoneCount = db.prepare('SELECT COUNT(*) as c FROM dns_zones WHERE enabled = 1').get().c;
  const recordCount = db.prepare(`
    SELECT COUNT(*) as c FROM dns_records r
    JOIN dns_zones z ON r.zone_id = z.id
    WHERE r.enabled = 1 AND z.enabled = 1
  `).get().c;

  audit(req.user.id, 'dns_config_applied', 'dns', null, { zones: zoneCount, records: recordCount });
  res.json({ message: 'Configuration applied', zones: zoneCount, records: recordCount });
});

// GET /api/dns/forwarders
router.get('/forwarders', requirePerm('dns:read'), (req, res) => {
  res.json({ servers: getSetting('dns_upstream_servers') });
});

// PUT /api/dns/forwarders
router.put('/forwarders', requirePerm('dns:write'), (req, res) => {
  const { servers } = req.body;
  if (!Array.isArray(servers) || servers.length === 0) {
    return res.status(400).json({ error: 'At least one upstream server is required' });
  }

  for (const s of servers) {
    if (!isValidIpv4(s)) {
      return res.status(400).json({ error: `Invalid IP address: ${s}` });
    }
  }

  const db = getDb();
  const oldRow = db.prepare("SELECT value FROM settings WHERE key = 'dns_upstream_servers'").get();

  setSetting('dns_upstream_servers', JSON.stringify(servers));

  req.afterCommit('regenerate_dnsmasq_conf');

  audit(req.user.id, 'dns_forwarders_updated', 'dns', null, {
    old: oldRow?.value,
    new: JSON.stringify(servers)
  });

  res.json({ servers });
});

// GET /api/dns/soa-defaults
router.get('/soa-defaults', requirePerm('dns:read'), (req, res) => {
  res.json(getSetting('dns_soa_defaults'));
});

// PUT /api/dns/soa-defaults
router.put('/soa-defaults', requirePerm('dns:write'), (req, res) => {
  const { soa_refresh, soa_retry, soa_expire, soa_minimum_ttl, soa_primary_ns, soa_admin_email } = req.body;
  const current = getSetting('dns_soa_defaults');
  const defaults = {
    soa_refresh: soa_refresh ?? current.soa_refresh, soa_retry: soa_retry ?? current.soa_retry,
    soa_expire: soa_expire ?? current.soa_expire, soa_minimum_ttl: soa_minimum_ttl ?? current.soa_minimum_ttl,
    soa_primary_ns: soa_primary_ns || current.soa_primary_ns, soa_admin_email: soa_admin_email || current.soa_admin_email
  };
  setSetting('dns_soa_defaults', JSON.stringify(defaults));
  audit(req.user.id, 'configure', 'dns_soa_defaults', null, defaults);
  res.json(defaults);
});

// POST /api/dns/forwarders/test — test if a DNS forwarder is reachable
router.post('/forwarders/test', requirePerm('dns:read'), async (req, res) => {
  const { ip } = req.body;
  if (!ip || !isValidIpv4(ip)) {
    return res.status(400).json({ error: 'Valid IPv4 address required' });
  }

  const result = await testDnsForwarder(ip);
  res.json({ ip, ...result });
});

// GET /api/dns/resolve?name=hostname — resolve hostname to IPs
router.get('/resolve', requirePerm('dns:read'), async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name parameter required' });

  try {
    const dns = await import('dns');
    const { resolve4 } = dns.promises;
    const ips = await resolve4(name);
    res.json({ name, ips });
  } catch (err) {
    res.status(404).json({ error: `Could not resolve ${name}`, details: err.code });
  }
});

export default router;
