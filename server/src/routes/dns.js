import { Router } from 'express';
import { getDb, getSetting, setSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { queueRegen } from '../utils/after-commit.js';
import { syncDnsToIp, clearDnsFromIp } from '../utils/ip-sync.js';
import { testDnsForwarder } from '../utils/dns-test.js';
import { dnsmasqSupportsDnssec } from '../utils/dnsmasq.js';
import { ensureNtpEnabled, getNtpStatus, armDnssecTimecheckWhenSynced } from '../utils/timesync.js';
import { applyEncryptedForwarder, getEncryptedForwarderStatus } from '../utils/encrypted-forwarder.js';
import { DOH_PROVIDERS } from '../data/doh-providers.js';
import {
  createRecord,
  updateRecord,
  deleteRecord,
  fqdnForRecordName
} from '../models/dns-record.js';
import {
  createZone,
  updateZone,
  deleteZone
} from '../models/dns-zone.js';

const router = Router();

// Validation helpers
import { isValidIpv4, isValidDomain, validateDisplayString } from '../utils/ip.js';
import { isValidPtrName, validateTxtValue } from '../utils/dnsmasq-escape.js';
import { validateSoaFields } from '../utils/validation.js';
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const SRV_NAME_RE = /^_[a-zA-Z0-9-]+\._[a-zA-Z]+$/;

function isValidHostname(name) {
  if (name === '@') return true;
  if (typeof name !== 'string' || name.length > 253) return false;
  return HOSTNAME_RE.test(name.replace(/\.$/, ''));
}

function isIntInRange(v, lo, hi) {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}

function normalizeDnsName(name) {
  return String(name || '').trim().replace(/\.$/, '').toLowerCase();
}

function normalizeRecordNameForZone(name, zoneName) {
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

function findSubnetDomainForIp(db, ip) {
  if (!isValidIpv4(ip)) return null;
  const octets = ip.split('.').map(Number);
  const ipLong = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];

  const subnets = db.prepare(`
    SELECT id, network_address, prefix_length, domain_name
    FROM subnets
    WHERE status = 'allocated'
      AND domain_name IS NOT NULL
      AND domain_name != ''
    ORDER BY prefix_length DESC
  `).all();

  for (const subnet of subnets) {
    const netOctets = subnet.network_address.split('.').map(Number);
    const netLong = ((netOctets[0] << 24) >>> 0) + (netOctets[1] << 16) + (netOctets[2] << 8) + netOctets[3];
    const size = 2 ** (32 - subnet.prefix_length);
    if (ipLong >= netLong && ipLong < netLong + size) {
      return normalizeDnsName(subnet.domain_name);
    }
  }

  return null;
}

function normalizeARecordName(db, name, ip, zoneName) {
  const domainName = findSubnetDomainForIp(db, ip) || zoneName;
  return normalizeRecordNameForZone(name, domainName);
}

function cnameNameErrorForZone(name, zoneName) {
  const normalized = normalizeDnsName(name);
  const zone = normalizeDnsName(zoneName);
  if (!normalized || normalized === '@' || normalized === zone) return 'CNAME cannot be at zone apex (@)';
  if (normalized.includes('.') && !normalized.endsWith(`.${zone}`)) {
    return `CNAME name must be inside ${zoneName}`;
  }
  return null;
}

// Build the FQDN that a record name points at inside its zone. '@' means the
// zone apex. Used for CNAME self-loop detection.
function fqdnFor(name, zoneName) {
  return fqdnForRecordName(name, zoneName);
}

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

function findAHostnameConflict(db, ip, recordName, zoneName, excludeRecordId = null) {
  const proposed = fqdnFor(recordName, zoneName);

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
      AND (l.expires_at = 'infinite' OR datetime(l.expires_at) > datetime('now'))
    ORDER BY
      s.prefix_length DESC,
      CASE WHEN l.expires_at = 'infinite' THEN 1 ELSE 0 END DESC,
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
    const hostname = fqdnFor(record.name, record.zone_name);
    if (!hostnameMatches(hostname, proposed, null)) {
      return { hostname, source: 'static DNS' };
    }
  }

  return null;
}

function cnameTargetError(db, target, zone) {
  const normalized = normalizeDnsName(target);
  const zoneName = normalizeDnsName(zone.name);

  if (!isValidDomain(normalized)) return 'Invalid target domain';
  if (!normalized.includes('.')) return 'CNAME target must be fully qualified';
  if (!normalized.endsWith(`.${zoneName}`) && normalized !== zoneName) {
    return `CNAME target must be inside ${zone.name}`;
  }

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

function validateRecord(type, { name, value, priority, weight, port }, zoneName, db = null, zone = null) {
  switch (type) {
    case 'A':
      if (!isValidHostname(name)) return 'Invalid hostname';
      if (!isValidIpv4(value)) return 'Invalid IPv4 address';
      break;
    case 'CNAME':
      {
        const nameErr = cnameNameErrorForZone(name, zoneName);
        if (nameErr) return nameErr;
      }
      if (!isValidHostname(name)) return 'Invalid hostname';
      if (db && zone) {
        const targetErr = cnameTargetError(db, value, zone);
        if (targetErr) return targetErr;
      } else if (!isValidDomain(value)) {
        return 'Invalid target domain';
      }
      // Refuse a CNAME whose value resolves back to itself. dnsmasq handles
      // the loop by returning SERVFAIL, but refusing at validation time
      // catches obvious typos and makes the error message diagnostic.
      if (zoneName && normalizeDnsName(value) === fqdnFor(name, zoneName).toLowerCase()) {
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
    SELECT r.*, r.type AS record_type, r.source AS dns_source, ip.is_online
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

  if (description !== undefined) {
    const err = validateDisplayString(description, { maxLength: 1024 });
    if (err) return res.status(400).json({ error: `description ${err}` });
  }
  {
    const err = validateSoaFields({ soa_primary_ns, soa_admin_email, soa_refresh, soa_retry, soa_expire, soa_minimum_ttl });
    if (err) return res.status(400).json({ error: err });
  }

  const db = getDb();

  const existing = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(name);
  if (existing) return res.status(409).json({ error: 'Zone already exists' });

  const soaDefaults = getSetting('dns_soa_defaults');

  const zone = createZone(db, {
    name,
    type,
    description,
    soa_primary_ns,
    soa_admin_email,
    soa_refresh,
    soa_retry,
    soa_expire,
    soa_minimum_ttl
  }, soaDefaults);
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

  if (description !== undefined) {
    const err = validateDisplayString(description, { maxLength: 1024 });
    if (err) return res.status(400).json({ error: `description ${err}` });
  }
  {
    const err = validateSoaFields({ soa_primary_ns, soa_admin_email, soa_refresh, soa_retry, soa_expire, soa_minimum_ttl });
    if (err) return res.status(400).json({ error: err });
  }

  const renaming = name && name !== zone.name;
  if (renaming) {
    const dup = db.prepare('SELECT id FROM dns_zones WHERE name = ? AND id != ?').get(name, zone.id);
    if (dup) return res.status(409).json({ error: 'Zone name already taken' });
  }

  const updated = updateZone(db, zone, {
    name,
    description,
    enabled,
    soa_primary_ns,
    soa_admin_email,
    soa_refresh,
    soa_retry,
    soa_expire,
    soa_minimum_ttl
  });
  audit(req.user.id, 'zone_updated', 'dns_zone', zone.id, { changes: req.body });

  req.afterCommit('regenerate_dns');
  res.json(updated);
});

// DELETE /api/dns/zones/:id
router.delete('/zones/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(req.params.id);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  deleteZone(db, zone);

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
    SELECT r.*, r.type AS record_type, r.source AS dns_source, ip.is_online
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

  const normalizedName = type === 'A' && zone.type === 'forward'
    ? normalizeARecordName(db, name, value, zone.name)
    : type === 'CNAME' && zone.type === 'forward'
      ? normalizeRecordNameForZone(name, zone.name)
      : name;
  const normalizedValue = type === 'CNAME'
    ? normalizeDnsName(value)
    : value;

  const validationError = validateRecord(type, {
    name: normalizedName, value: normalizedValue, priority, weight, port
  }, zone.name, db, zone);
  if (validationError) return res.status(400).json({ error: validationError });

  if (type === 'A' && zone.type === 'forward') {
    const conflict = findAHostnameConflict(db, normalizedValue, normalizedName, zone.name);
    if (conflict) {
      return res.status(409).json({
        error: `IP already has hostname "${conflict.hostname}" from ${conflict.source}; create a CNAME pointing at that hostname instead`
      });
    }
  }

  // Check for duplicate A records
  if (type === 'A') {
    const dup = db.prepare(
      'SELECT id FROM dns_records WHERE zone_id = ? AND name = ? AND type = ? AND value = ?'
    ).get(zone.id, normalizedName, type, normalizedValue);
    if (dup) return res.status(409).json({ error: 'Duplicate A record (same name and value)' });
  }

  // Warn about CNAME conflicts
  if (type === 'CNAME') {
    const dup = db.prepare(
      'SELECT id FROM dns_records WHERE zone_id = ? AND name = ? AND type = ?'
    ).get(zone.id, normalizedName, 'CNAME');
    if (dup) return res.status(409).json({ error: `CNAME at "${normalizedName}" already exists` });

    const conflict = db.prepare(
      'SELECT id, type FROM dns_records WHERE zone_id = ? AND name = ? AND type != ?'
    ).get(zone.id, normalizedName, 'CNAME');
    if (conflict) {
      return res.status(409).json({ error: `CNAME at "${normalizedName}" conflicts with existing ${conflict.type} record` });
    }
  }

  let record;
  try {
    ({ record } = createRecord(db, zone, {
      name: normalizedName,
      type,
      value: normalizedValue,
      priority,
      weight,
      port,
      ttl,
      enabled
    }, { forcePtr: !!force_ptr }));
  } catch (err) {
    if (err.code === 'PTR_CONFLICT') {
      return res.status(409).json({
        error: 'PTR for this IP already points at a different forward zone',
        ptr_conflict: err.conflict,
        hint: 'Pass force_ptr:true to overwrite'
      });
    }
    throw err;
  }

  audit(req.user.id, 'record_created', 'dns_record', record.id, { zone: zone.name, name: normalizedName, type, value: normalizedValue });

  if (type === 'A' && zone.type === 'forward') {
    syncDnsToIp(db, normalizedName, normalizedValue, zone.name);
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

  if (record.source === 'dhcp' || record.source === 'reservation') {
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
  const rawNewName = name ?? record.name;
  const rawNewValue = value ?? record.value;
  const newName = newType === 'A' && zone.type === 'forward'
    ? normalizeARecordName(db, rawNewName, rawNewValue, zone.name)
    : newType === 'CNAME' && zone.type === 'forward'
      ? normalizeRecordNameForZone(rawNewName, zone.name)
      : rawNewName;
  const newValue = newType === 'CNAME'
    ? normalizeDnsName(rawNewValue)
    : rawNewValue;
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
  }, zone.name, db, zone);
  if (validationError) return res.status(400).json({ error: validationError });

  if (newType === 'A' && zone.type === 'forward') {
    const conflict = findAHostnameConflict(db, newValue, newName, zone.name, record.id);
    if (conflict) {
      return res.status(409).json({
        error: `IP already has hostname "${conflict.hostname}" from ${conflict.source}; create a CNAME pointing at that hostname instead`
      });
    }
  }

  if (newType === 'CNAME') {
    const dup = db.prepare(
      'SELECT id FROM dns_records WHERE zone_id = ? AND name = ? AND type = ? AND id != ?'
    ).get(zone.id, newName, 'CNAME', record.id);
    if (dup) return res.status(409).json({ error: `CNAME at "${newName}" already exists` });

    const conflict = db.prepare(
      'SELECT id, type FROM dns_records WHERE zone_id = ? AND name = ? AND type != ? AND id != ?'
    ).get(zone.id, newName, 'CNAME', record.id);
    if (conflict) {
      return res.status(409).json({ error: `CNAME at "${newName}" conflicts with existing ${conflict.type} record` });
    }
  }

  const updated = updateRecord(db, zone, record, {
    name: newName,
    type: newType,
    value: newValue,
    priority: newPriority,
    weight: newWeight,
    port: newPort,
    ttl: newTtl,
    enabled
  });
  audit(req.user.id, 'record_updated', 'dns_record', record.id, { changes: req.body });

  // Sync PTR + ip_addresses when an A record is updated in a forward zone.
  // Clear the OLD hostname whenever NAME OR VALUE changed — the previous
  // version would skip the clear when only the name changed, leaving an
  // orphan entry pointing at the old hostname on the IP.
  if (newType === 'A' && zone.type === 'forward') {
    if (record.value !== newValue) {
      clearDnsFromIp(db, record.name, record.value, zone.name);
    } else if (record.name !== newName) {
      // Name-only change on the same IP: the ip_addresses row still has the
      // old FQDN. syncDnsToIp below will overwrite it, but we clear
      // explicitly so the `dns_removed` event is recorded.
      clearDnsFromIp(db, record.name, record.value, zone.name);
    }
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

  if (record.source === 'dhcp' || record.source === 'reservation') {
    return res.status(403).json({ error: 'DHCP-managed records cannot be deleted manually' });
  }

  // Clear PTR and IP hostname when A record is deleted from a forward zone
  const delZone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(record.zone_id);
  deleteRecord(db, delZone, record);
  if (record.type === 'A' && delZone?.type === 'forward') {
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
  res.json({
    servers: getSetting('dns_upstream_servers'),
    no_recursion: getSetting('dns_no_recursion') === 'true',
  });
});

// PUT /api/dns/forwarders
router.put('/forwarders', requirePerm('dns:write'), (req, res) => {
  const { servers, no_recursion } = req.body;
  const noRecursion = !!no_recursion;

  // Upstream servers are only required when recursion is enabled — with recursion
  // off, CIDRella is authoritative-only and forwarders are ignored.
  if (!noRecursion) {
    if (!Array.isArray(servers) || servers.length === 0) {
      return res.status(400).json({ error: 'At least one upstream server is required' });
    }
  }
  if (Array.isArray(servers)) {
    for (const s of servers) {
      if (!isValidIpv4(s)) return res.status(400).json({ error: `Invalid IP address: ${s}` });
    }
  }

  const db = getDb();
  const oldRow = db.prepare("SELECT value FROM settings WHERE key = 'dns_upstream_servers'").get();

  // Preserve the existing forwarder list when recursion is off and none sent,
  // so toggling recursion back on restores them.
  if (Array.isArray(servers) && servers.length > 0) {
    setSetting('dns_upstream_servers', JSON.stringify(servers));
  }
  setSetting('dns_no_recursion', noRecursion ? 'true' : 'false');

  // Re-evaluate the encrypted-forwarder stub: enabling no-recursion must stop it
  // (forwarding is off); disabling it restarts the stub if encryption is on.
  applyEncryptedForwarder();
  req.afterCommit('regenerate_dnsmasq_conf');

  audit(req.user.id, 'dns_forwarders_updated', 'dns', null, {
    old: oldRow?.value,
    new: JSON.stringify(servers),
    no_recursion: noRecursion,
  });

  res.json({ servers: getSetting('dns_upstream_servers'), no_recursion: noRecursion });
});

// GET /api/dns/dnssec — current state + dnsmasq support + clock-sync status
router.get('/dnssec', requirePerm('dns:read'), (req, res) => {
  res.json({
    enabled: getSetting('dnssec_enabled') === 'true',
    supported: dnsmasqSupportsDnssec(),
    ntp: getNtpStatus(),
  });
});

// PUT /api/dns/dnssec — toggle DNSSEC validation. Mirrors /forwarders: the
// authoritative write path that regenerates dnsmasq.conf and restarts dnsmasq
// via the regenerate_dnsmasq_conf afterCommit hook.
router.put('/dnssec', requirePerm('dns:write'), (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  if (enabled && !dnsmasqSupportsDnssec()) {
    return res.status(400).json({ error: 'dnsmasq on this host was not built with DNSSEC support' });
  }

  const oldVal = getSetting('dnssec_enabled');
  setSetting('dnssec_enabled', enabled ? 'true' : 'false');

  if (enabled) {
    // Make sure the clock will sync, and arm the one-shot SIGHUP that switches
    // dnsmasq from lenient (dnssec-no-timecheck) to enforcing once it has.
    ensureNtpEnabled();
    armDnssecTimecheckWhenSynced();
  }

  req.afterCommit('regenerate_dnsmasq_conf');

  audit(req.user.id, 'dns_dnssec_updated', 'dns', null, {
    old: oldVal, new: enabled ? 'true' : 'false'
  });

  res.json({ enabled, ntp: getNtpStatus() });
});

// ─── Encrypted forwarding (DoT/DoH) ──────────────────────

function validateUpstreamList(arr, mode) {
  if (!Array.isArray(arr) || arr.length === 0) return 'at least one upstream is required';
  if (arr.length > 8) return 'too many upstreams (max 8)';
  for (const u of arr) {
    if (!u || typeof u !== 'object') return 'each upstream must be an object';
    if (!Array.isArray(u.addresses) || u.addresses.length === 0 || !u.addresses.every(a => isValidIpv4(a))) {
      return 'each upstream needs a non-empty addresses[] of IPv4 strings';
    }
    if (typeof u.hostname !== 'string' || !u.hostname) return 'each upstream needs a hostname';
    // doh_url is only used by DoH (https) mode; DoT (tls) never reads it.
    if (mode === 'https' && (typeof u.doh_url !== 'string' || !/^https:\/\//.test(u.doh_url))) {
      return 'each upstream needs an https doh_url';
    }
  }
  return null;
}

// GET /api/dns/encryption — mode, configured upstreams, preset catalog, live status
router.get('/encryption', requirePerm('dns:read'), (req, res) => {
  let upstreams = [];
  try {
    const raw = getSetting('forwarder_encrypted_upstreams');
    upstreams = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
  } catch { upstreams = []; }
  res.json({
    mode: getSetting('forwarder_encryption') || 'off',
    upstreams,
    providers: DOH_PROVIDERS,
    status: getEncryptedForwarderStatus(),
  });
});

// PUT /api/dns/encryption — set Off/TLS/HTTPS + upstreams. Authoritative path:
// (re)configures the in-Node stub and regenerates dnsmasq.conf (server= → stub).
router.put('/encryption', requirePerm('dns:write'), (req, res) => {
  const { mode, upstreams } = req.body || {};
  if (!['off', 'tls', 'https'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be off, tls, or https' });
  }
  let list = [];
  if (mode !== 'off') {
    list = Array.isArray(upstreams) ? upstreams : [];
    const err = validateUpstreamList(list, mode);
    if (err) return res.status(400).json({ error: err });
  }

  setSetting('forwarder_encryption', mode);
  setSetting('forwarder_encrypted_upstreams', JSON.stringify(list));

  applyEncryptedForwarder();            // start/stop/reconfigure the stub now
  req.afterCommit('regenerate_dnsmasq_conf'); // server= → stub (or back to IPs)

  audit(req.user.id, 'dns_encryption_updated', 'dns', null, {
    mode, upstreams: list.map(u => u.hostname),
  });

  res.json({ mode, upstreams: list, status: getEncryptedForwarderStatus() });
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
  {
    const err = validateSoaFields(defaults);
    if (err) return res.status(400).json({ error: err });
  }
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
