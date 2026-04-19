import { Router } from 'express';
import { getDb, getSetting, setSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { queueRegen } from '../utils/after-commit.js';
import { syncDnsToIp, clearDnsFromIp } from '../utils/ip-sync.js';
import { testDnsForwarder } from '../utils/dns-test.js';

const router = Router();

// Validation helpers
import { isValidIpv4, isValidDomain } from '../utils/ip.js';
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const SRV_NAME_RE = /^_[a-zA-Z0-9-]+\._[a-zA-Z]+$/;

function isValidHostname(name) {
  return name === '@' || HOSTNAME_RE.test(name);
}


function validateRecord(type, { name, value, priority, weight, port }) {
  switch (type) {
    case 'A':
      if (!isValidHostname(name)) return 'Invalid hostname';
      if (!isValidIpv4(value)) return 'Invalid IPv4 address';
      break;
    case 'CNAME':
      if (name === '@') return 'CNAME cannot be at zone apex (@)';
      if (!isValidHostname(name)) return 'Invalid hostname';
      if (!isValidDomain(value)) return 'Invalid target domain';
      break;
    case 'MX':
      if (!isValidHostname(name)) return 'Invalid hostname';
      if (!isValidDomain(value)) return 'Invalid mail server domain';
      if (priority === undefined || priority === null) return 'Priority is required for MX records';
      if (priority < 0 || priority > 65535) return 'Priority must be 0-65535';
      break;
    case 'TXT':
      if (!isValidHostname(name)) return 'Invalid hostname';
      if (!value || value.length === 0) return 'TXT value is required';
      break;
    case 'SRV':
      if (!SRV_NAME_RE.test(name)) return 'SRV name must be _service._protocol format';
      if (!isValidDomain(value)) return 'Invalid target domain';
      if (port === undefined || port === null) return 'Port is required for SRV records';
      if (port < 0 || port > 65535) return 'Port must be 0-65535';
      if (priority === undefined || priority === null) return 'Priority is required for SRV records';
      if (weight === undefined || weight === null) return 'Weight is required for SRV records';
      break;
    case 'PTR':
      if (!name) return 'PTR name is required (e.g., reversed IP octets)';
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
 * Create or update a PTR record for an A record's IP in the matching reverse zone.
 */
function syncPtrForARecord(db, recordName, ip, forwardZoneName) {
  const match = findReverseZone(db, ip);
  if (!match) return; // No matching reverse zone

  const { zone, ptrName } = match;
  const fqdn = recordName === '@' ? forwardZoneName : `${recordName}.${forwardZoneName}`;

  // Check if PTR already exists for this octet
  const existing = db.prepare('SELECT * FROM dns_records WHERE zone_id = ? AND type = ? AND name = ?').get(zone.id, 'PTR', ptrName);

  if (existing) {
    // Update existing PTR with the hostname
    db.prepare("UPDATE dns_records SET value = ?, updated_at = datetime('now') WHERE id = ?").run(fqdn, existing.id);
  } else {
    // Create new PTR
    db.prepare('INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, ?, ?, ?, 1)').run(zone.id, ptrName, 'PTR', fqdn);
  }

  // Increment SOA serial
  db.prepare("UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime('now') WHERE id = ?").run(zone.id);
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

// POST /api/dns/zones
router.post('/zones', requirePerm('dns:write'), (req, res) => {
  const { name, type, subnet_id, description,
          soa_primary_ns, soa_admin_email, soa_refresh, soa_retry, soa_expire, soa_minimum_ttl } = req.body;

  if (!name) return res.status(400).json({ error: 'Zone name is required' });
  if (!type || !['forward', 'reverse'].includes(type)) {
    return res.status(400).json({ error: 'Zone type must be forward or reverse' });
  }
  if (!isValidDomain(name) && !name.endsWith('.in-addr.arpa')) {
    return res.status(400).json({ error: 'Invalid zone name' });
  }

  const db = getDb();

  const existing = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(name);
  if (existing) return res.status(409).json({ error: 'Zone already exists' });

  let ownedSubnet = null;
  if (subnet_id) {
    const subnet = db.prepare('SELECT id, domain_name FROM subnets WHERE id = ?').get(subnet_id);
    if (!subnet) return res.status(400).json({ error: 'Referenced subnet not found' });
    ownedSubnet = subnet;

    // Forward-zone ownership guard: a subnet can own at most one forward
    // zone (schema 1:1). Back-door creation via this endpoint would defeat
    // the 409 checks the subnet routes enforce.
    if (type === 'forward') {
      const existingFwd = db.prepare(
        "SELECT id, name FROM dns_zones WHERE subnet_id = ? AND type = 'forward'"
      ).get(subnet_id);
      if (existingFwd) {
        return res.status(409).json({
          error: `Subnet already owns forward zone "${existingFwd.name}". Delete or detach it first.`
        });
      }

      // If the subnet already has a domain_name that differs from the new
      // zone name, the user has a real conflict — reject rather than
      // silently overwrite. (NULL is fine; we'll sync it in.)
      if (subnet.domain_name && subnet.domain_name !== name) {
        return res.status(409).json({
          error: `Subnet's domain_name is "${subnet.domain_name}", which doesn't match new zone name "${name}". Clear subnet.domain_name first or pick a matching zone name.`
        });
      }
    }
  }

  // Load SOA defaults from settings
  const soaDefaults = getSetting('dns_soa_defaults');

  // Wrap the zone INSERT + the subnet domain_name mirror in a transaction
  // so a partial failure doesn't leave dns_zones.subnet_id set while
  // subnets.domain_name stays NULL (the exact split-brain R3 #7 tried to
  // close from the DELETE side).
  const ins = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO dns_zones (name, type, subnet_id, description,
        soa_primary_ns, soa_admin_email, soa_refresh, soa_retry, soa_expire, soa_minimum_ttl)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, type, subnet_id || null, description || null,
      soa_primary_ns || soaDefaults.soa_primary_ns, soa_admin_email || soaDefaults.soa_admin_email,
      soa_refresh ?? soaDefaults.soa_refresh, soa_retry ?? soaDefaults.soa_retry,
      soa_expire ?? soaDefaults.soa_expire, soa_minimum_ttl ?? soaDefaults.soa_minimum_ttl);

    if (type === 'forward' && ownedSubnet && !ownedSubnet.domain_name) {
      db.prepare(
        "UPDATE subnets SET domain_name = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(name, ownedSubnet.id);
    }
    return result.lastInsertRowid;
  });
  const zoneId = ins();

  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(zoneId);
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

  // Auto-increment SOA serial when zone is updated
  const newSerial = (zone.soa_serial || 0) + 1;

  // Wrap the zone UPDATE and the subnets.domain_name mirror in a single txn
  // so a rename either applies everywhere or nowhere. Without the mirror,
  // subnets.domain_name keeps pointing at the OLD zone name — which breaks
  // DHCP option 15/119 emission and DHCP-sourced A-record generation.
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

    if (renaming && zone.type === 'forward' && zone.subnet_id != null) {
      db.prepare(
        "UPDATE subnets SET domain_name = ?, updated_at = datetime('now') WHERE id = ? AND domain_name = ?"
      ).run(name, zone.subnet_id, zone.name);
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
    // If this is the forward zone backing an allocated subnet's domain_name,
    // clear the subnet side too — otherwise subnet.domain_name stays pointing
    // at a zone that no longer exists, and subsequent configure/rename flows
    // see orphaned state.
    if (zone.type === 'forward' && zone.subnet_id) {
      db.prepare(
        "UPDATE subnets SET domain_name = NULL, updated_at = datetime('now') WHERE id = ? AND domain_name = ?"
      ).run(zone.subnet_id, zone.name);
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
  const { name, type, value, priority, weight, port, ttl, enabled } = req.body;
  const db = getDb();

  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(req.params.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

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

  if (ttl !== undefined && ttl !== null && (ttl < 0 || ttl > 2147483647)) {
    return res.status(400).json({ error: 'TTL must be between 0 and 2147483647' });
  }

  const validationError = validateRecord(type, { name, value, priority, weight, port });
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

  // Auto-create/update PTR record when A record is added to a forward zone
  if (type === 'A' && zone.type === 'forward') {
    syncPtrForARecord(db, name, value, zone.name);
    syncDnsToIp(db, name, value, zone.name);
  }

  req.afterCommit('regenerate_dns');
  res.status(201).json(record);
});

// PUT /api/dns/zones/:zoneId/records/:id
router.put('/zones/:zoneId/records/:id', requirePerm('dns:write'), (req, res) => {
  const { name, type, value, priority, weight, port, ttl, enabled } = req.body;
  const db = getDb();

  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(req.params.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const record = db.prepare('SELECT * FROM dns_records WHERE id = ? AND zone_id = ?').get(req.params.id, zone.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  if (record.source === 'dhcp') {
    return res.status(403).json({ error: 'DHCP-managed records cannot be edited manually' });
  }

  const newType = type || record.type;
  const newName = name ?? record.name;
  const newValue = value ?? record.value;
  const newPriority = priority !== undefined ? priority : record.priority;
  const newWeight = weight !== undefined ? weight : record.weight;
  const newPort = port !== undefined ? port : record.port;
  const newTtl = ttl !== undefined ? ttl : record.ttl;

  if (newTtl !== null && (newTtl < 0 || newTtl > 2147483647)) {
    return res.status(400).json({ error: 'TTL must be between 0 and 2147483647' });
  }

  const validationError = validateRecord(newType, {
    name: newName, value: newValue,
    priority: newPriority, weight: newWeight, port: newPort
  });
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

  // Sync PTR when A record is updated in a forward zone
  if (newType === 'A' && zone.type === 'forward') {
    // If IP changed, clear old PTR and old IP hostname
    if (record.value !== newValue) {
      clearPtrForIp(db, record.value);
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
