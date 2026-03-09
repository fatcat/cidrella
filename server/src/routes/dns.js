import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import { regenerateConfigs, regenerateDnsmasqConf, signalDnsmasq } from '../utils/dnsmasq.js';
import { syncDnsToIp, clearDnsFromIp } from '../utils/ip-sync.js';

const router = Router();

function requirePerm(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Validation helpers
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const SRV_NAME_RE = /^_[a-zA-Z0-9-]+\._[a-zA-Z]+$/;

function isValidIpv4(ip) {
  if (!IPV4_RE.test(ip)) return false;
  return ip.split('.').every(o => { const n = parseInt(o, 10); return n >= 0 && n <= 255; });
}

function isValidHostname(name) {
  return name === '@' || HOSTNAME_RE.test(name);
}

function isValidDomain(name) {
  return DOMAIN_RE.test(name) && name.length <= 253;
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
      (SELECT COUNT(*) FROM dns_records WHERE zone_id = z.id) as record_count,
      f.name as folder_name
    FROM dns_zones z
    LEFT JOIN folders f ON f.id = z.folder_id
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
    SELECT * FROM dns_records WHERE zone_id = ? ORDER BY type, name
  `).all(zone.id);

  res.json({ ...zone, records });
});

// POST /api/dns/zones
router.post('/zones', requirePerm('dns:write'), (req, res) => {
  const { name, type, subnet_id, folder_id, description,
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

  if (subnet_id) {
    const subnet = db.prepare('SELECT id FROM subnets WHERE id = ?').get(subnet_id);
    if (!subnet) return res.status(400).json({ error: 'Referenced subnet not found' });
  }

  if (folder_id) {
    const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folder_id);
    if (!folder) return res.status(400).json({ error: 'Referenced organization not found' });
  }

  const result = db.prepare(`
    INSERT INTO dns_zones (name, type, subnet_id, folder_id, description,
      soa_primary_ns, soa_admin_email, soa_refresh, soa_retry, soa_expire, soa_minimum_ttl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, type, subnet_id || null, folder_id || null, description || null,
    soa_primary_ns || 'ns1.localhost', soa_admin_email || 'admin.localhost',
    soa_refresh ?? 3600, soa_retry ?? 900, soa_expire ?? 604800, soa_minimum_ttl ?? 86400);

  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(result.lastInsertRowid);
  audit(req.user.id, 'zone_created', 'dns_zone', zone.id, { name, type });

  regenerateConfigs(db);
  res.status(201).json(zone);
});

// PUT /api/dns/zones/:id
router.put('/zones/:id', requirePerm('dns:write'), (req, res) => {
  const { name, description, enabled, folder_id,
          soa_primary_ns, soa_admin_email, soa_refresh, soa_retry, soa_expire, soa_minimum_ttl } = req.body;
  const db = getDb();

  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(req.params.id);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  if (name && name !== zone.name) {
    const dup = db.prepare('SELECT id FROM dns_zones WHERE name = ? AND id != ?').get(name, zone.id);
    if (dup) return res.status(409).json({ error: 'Zone name already taken' });
  }

  // Auto-increment SOA serial when zone is updated
  const newSerial = (zone.soa_serial || 0) + 1;

  db.prepare(`
    UPDATE dns_zones SET name = ?, description = ?, enabled = ?, folder_id = ?,
      soa_primary_ns = ?, soa_admin_email = ?, soa_serial = ?,
      soa_refresh = ?, soa_retry = ?, soa_expire = ?, soa_minimum_ttl = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? zone.name,
    description !== undefined ? description : zone.description,
    enabled !== undefined ? (enabled ? 1 : 0) : zone.enabled,
    folder_id !== undefined ? (folder_id || null) : zone.folder_id,
    soa_primary_ns !== undefined ? soa_primary_ns : zone.soa_primary_ns,
    soa_admin_email !== undefined ? soa_admin_email : zone.soa_admin_email,
    newSerial,
    soa_refresh !== undefined ? soa_refresh : zone.soa_refresh,
    soa_retry !== undefined ? soa_retry : zone.soa_retry,
    soa_expire !== undefined ? soa_expire : zone.soa_expire,
    soa_minimum_ttl !== undefined ? soa_minimum_ttl : zone.soa_minimum_ttl,
    zone.id
  );

  const updated = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(zone.id);
  audit(req.user.id, 'zone_updated', 'dns_zone', zone.id, { changes: req.body });

  regenerateConfigs(db);
  res.json(updated);
});

// DELETE /api/dns/zones/:id
router.delete('/zones/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(req.params.id);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  db.prepare('DELETE FROM dns_zones WHERE id = ?').run(zone.id);
  audit(req.user.id, 'zone_deleted', 'dns_zone', zone.id, { name: zone.name });

  regenerateConfigs(db);
  res.json({ message: 'Zone deleted' });
});

// ─── Records ─────────────────────────────────────────────

// GET /api/dns/zones/:zoneId/records
router.get('/zones/:zoneId/records', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const zone = db.prepare('SELECT id FROM dns_zones WHERE id = ?').get(req.params.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const records = db.prepare(`
    SELECT * FROM dns_records WHERE zone_id = ? ORDER BY type, name
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

  regenerateConfigs(db);
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

  regenerateConfigs(db);
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
  db.prepare('UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime(\'now\') WHERE id = ?').run(parseInt(req.params.zoneId, 10));

  // Clear PTR and IP hostname when A record is deleted from a forward zone
  const delZone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(parseInt(req.params.zoneId, 10));
  if (record.type === 'A' && delZone?.type === 'forward') {
    clearPtrForIp(db, record.value);
    clearDnsFromIp(db, record.name, record.value, delZone.name);
  }

  audit(req.user.id, 'record_deleted', 'dns_record', record.id, { type: record.type, name: record.name });

  regenerateConfigs(db);
  res.json({ message: 'Record deleted' });
});

// ─── Utility ─────────────────────────────────────────────

// POST /api/dns/apply — force regenerate all config files
router.post('/apply', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  regenerateConfigs(db);
  signalDnsmasq();

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
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'dns_upstream_servers'").get();
  let servers = ['8.8.8.8', '1.1.1.1'];
  try {
    if (row?.value) servers = JSON.parse(row.value);
  } catch { /* use defaults */ }
  res.json({ servers });
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

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dns_upstream_servers', ?)").run(JSON.stringify(servers));

  regenerateDnsmasqConf(db);
  signalDnsmasq();

  audit(req.user.id, 'dns_forwarders_updated', 'dns', null, {
    old: oldRow?.value,
    new: JSON.stringify(servers)
  });

  res.json({ servers });
});

// POST /api/dns/forwarders/test — test if a DNS forwarder is reachable
router.post('/forwarders/test', requirePerm('dns:read'), async (req, res) => {
  const { ip } = req.body;
  if (!ip || !isValidIpv4(ip)) {
    return res.status(400).json({ error: 'Valid IPv4 address required' });
  }

  async function tryResolve() {
    const dns = await import('dns');
    const resolver = new dns.Resolver();
    resolver.setServers([ip]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
      resolver.resolve4('google.com', (err, addresses) => {
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve(addresses);
      });
    });
  }

  try {
    const result = await tryResolve();
    res.json({ ip, reachable: true, resolved: result });
  } catch {
    // Retry once after 5 seconds
    await new Promise(r => setTimeout(r, 5000));
    try {
      const result = await tryResolve();
      res.json({ ip, reachable: true, resolved: result });
    } catch (err) {
      res.json({ ip, reachable: false, error: err.message || err.code });
    }
  }
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
