import { Router } from 'express';
import { getDb, getSetting, setSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { queueRegen } from '../utils/after-commit.js';
import {
  allocateStaticDns,
  deallocateStaticDns,
  reconcileStaticDnsZone
} from '../services/ip-lifecycle-service.js';
import { testDnsForwarder } from '../utils/dns-test.js';
import { dnsmasqSupportsDnssec } from '../utils/dnsmasq.js';
import { ensureNtpEnabled, getNtpStatus, armDnssecTimecheckWhenSynced } from '../utils/timesync.js';
import { applyEncryptedForwarder, getEncryptedForwarderStatus } from '../utils/encrypted-forwarder.js';
import { DOH_PROVIDERS } from '../data/doh-providers.js';
import {
  createRecord,
  updateRecord,
  deleteRecord,
  fqdnForRecordName,
  normalizeRecordNameForZone,
  cnameTargetError,
  findAHostnameConflict,
  reconcileManagedReverseDns
} from '../models/dns-record.js';
import {
  createZone,
  updateZone,
  deleteZone
} from '../models/dns-zone.js';
import { enrichIpViewRows } from '../models/ip-view.js';

const router = Router();

// Validation helpers
import { isValidIpv4, isValidDomain, validateDisplayString, ipToLong } from '../utils/ip.js';
import { isBlockedIpv4 } from '../utils/url-guard.js';
import { isValidPtrName, validateTxtValue, isValidRecordName } from '../utils/dnsmasq-escape.js';
import { validateSoaFields, isIntInRange } from '../utils/validation.js';
const SRV_NAME_RE = /^_[a-zA-Z0-9-]+\._[a-zA-Z]+$/;

function enrichDnsAddressRecords(db, records, zoneName) {
  for (const record of records) {
    record.record_fqdn = fqdnForRecordName(record.name, zoneName);
  }
  enrichIpViewRows(db, records.filter(record => record.type === 'A' || record.type === 'AAAA'));
  return records;
}

function normalizeDnsName(name) {
  return String(name || '').trim().replace(/\.$/, '').toLowerCase();
}

function findSubnetDomainForIp(db, ip) {
  if (!isValidIpv4(ip)) return null;
  // Was a fourth hand-rolled copy of the octet arithmetic in a file that could
  // simply import it (duplicate-logic audit #11). isValidIpv4 above already
  // guarantees ipToLong will not throw.
  const ipLong = ipToLong(ip);

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


// cnameTargetError now lives in models/dns-record.js so the Pi-hole import path
// enforces the same three rules. See REVIEW.md, duplicate-logic audit #18.

function validateRecord(type, { name, value, priority, weight, port }, zoneName, db = null, zone = null) {
  switch (type) {
    case 'A':
      if (!isValidRecordName(name)) return 'Invalid hostname';
      if (!isValidIpv4(value)) return 'Invalid IPv4 address';
      break;
    case 'CNAME':
      {
        const nameErr = cnameNameErrorForZone(name, zoneName);
        if (nameErr) return nameErr;
      }
      if (!isValidRecordName(name)) return 'Invalid hostname';
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
      if (!isValidRecordName(name)) return 'Invalid hostname';
      if (!isValidDomain(value)) return 'Invalid mail server domain';
      if (!isIntInRange(priority, 0, 65535)) return 'Priority must be an integer 0-65535';
      break;
    case 'TXT':
      if (!isValidRecordName(name)) return 'Invalid hostname';
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
      // line is safe by construction, no newline / "=" / "," injection.
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
    SELECT r.*, r.type AS record_type, r.source AS dns_source,
      CASE WHEN r.type IN ('A', 'AAAA') THEN r.value END AS ip_address,
      ip.subnet_id, ip.hostname, ip.mac_address,
      ip.last_seen_mac, ip.is_online, ip.is_rogue, ip.rogue_reason,
      ip.detection_source, ip.last_seen_at, ip.last_scanned_at,
      ip.reservation_note, ip.scan_enabled, ip.allocation_state,
      ip.allocation_source_type, ip.allocation_source_id, ip.address_family,
      ip.address_sort_key, ip.interface_id, ip.preferred_until, ip.valid_until,
      ip.dhcp_version
    FROM dns_records r
    LEFT JOIN ip_addresses ip ON r.type IN ('A', 'AAAA') AND ip.ip_address = r.value
    WHERE r.zone_id = ?
    ORDER BY r.type, r.name
  `).all(zone.id);

  res.json({ ...zone, records: enrichDnsAddressRecords(db, records, zone.name) });
});

// POST /api/dns/zones: zones are subnet-agnostic. Any number of subnets
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
  // Forward zones: a normal domain. Reverse zones: ONLY the dotted-decimal
  // in-addr.arpa form the generator produces (`<octet>.<octet>.<octet>.in-addr.arpa`).
  // The old check accepted anything ending in `.in-addr.arpa` with no charset
  // or length guard, so a newline-laden name smuggled arbitrary dnsmasq
  // directives into conf.d/zone-*.conf (the name is interpolated raw at the
  // ptr-record line). Digits and dots only closes that hole and still accepts
  // every legitimate reverse zone.
  const REVERSE_ZONE_RE = /^(?:\d{1,3}\.){1,3}in-addr\.arpa$/;
  if (!isValidDomain(name) && !REVERSE_ZONE_RE.test(name)) {
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
  if (zone.type === 'reverse' && zone.enabled) reconcileManagedReverseDns(db);
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

  const updateWorkflow = db.transaction(() => {
    const result = updateZone(db, zone, {
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
    if (zone.name !== result.name || zone.enabled !== result.enabled) {
      reconcileStaticDnsZone(db, zone, result);
      reconcileManagedReverseDns(db);
    }
    return result;
  });
  const updated = updateWorkflow();
  audit(req.user.id, 'zone_updated', 'dns_zone', zone.id, { changes: req.body });

  req.afterCommit('regenerate_dns');
  res.json(updated);
});

// DELETE /api/dns/zones/:id
router.delete('/zones/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(req.params.id);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const addressRecords = db.prepare(`
    SELECT id, name, value
    FROM dns_records
    WHERE zone_id = ?
      AND type = 'A'
      AND enabled = 1
      AND COALESCE(source, 'manual') = 'manual'
  `).all(zone.id);
  db.transaction(() => {
    deleteZone(db, zone);
    reconcileStaticDnsZone(db, zone, null, addressRecords);
    reconcileManagedReverseDns(db);
  })();

  audit(req.user.id, 'zone_deleted', 'dns_zone', zone.id, { name: zone.name });

  req.afterCommit('regenerate_dns');
  res.json({ message: 'Zone deleted' });
});

// ─── Records ─────────────────────────────────────────────

// GET /api/dns/zones/:zoneId/records
router.get('/zones/:zoneId/records', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const zone = db.prepare('SELECT id, name FROM dns_zones WHERE id = ?').get(req.params.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const records = db.prepare(`
    SELECT r.*, r.type AS record_type, r.source AS dns_source,
      CASE WHEN r.type IN ('A', 'AAAA') THEN r.value END AS ip_address,
      ip.subnet_id, ip.hostname, ip.mac_address,
      ip.last_seen_mac, ip.is_online, ip.is_rogue, ip.rogue_reason,
      ip.detection_source, ip.last_seen_at, ip.last_scanned_at,
      ip.reservation_note, ip.scan_enabled, ip.allocation_state,
      ip.allocation_source_type, ip.allocation_source_id, ip.address_family,
      ip.address_sort_key, ip.interface_id, ip.preferred_until, ip.valid_until,
      ip.dhcp_version
    FROM dns_records r
    LEFT JOIN ip_addresses ip ON r.type IN ('A', 'AAAA') AND ip.ip_address = r.value
    WHERE r.zone_id = ?
    ORDER BY r.type, r.name
  `).all(zone.id);
  res.json(enrichDnsAddressRecords(db, records, zone.name));
});

// POST /api/dns/zones/:zoneId/records
router.post('/zones/:zoneId/records', requirePerm('dns:write'), (req, res) => {
  const body = req.body || {};
  const { name, type, value, priority, weight, port, ttl, enabled, force_ptr } = body;
  const db = getDb();

  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(req.params.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  // String-type guards up front, otherwise `name.endsWith` / `value.split`
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
    const createWorkflow = db.transaction(() => {
      const created = createRecord(db, zone, {
        name: normalizedName,
        type,
        value: normalizedValue,
        priority,
        weight,
        port,
        ttl,
        enabled
      }, { forcePtr: !!force_ptr });
      if (type === 'A' && zone.type === 'forward' && zone.enabled && created.record.enabled) {
        allocateStaticDns(db, normalizedName, normalizedValue, zone.name, created.record.id);
      }
      return created.record;
    });
    record = createWorkflow();
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

  if (['dns', 'dhcp', 'reservation', 'placeholder'].includes(record.source)) {
    return res.status(403).json({
      error: 'Generated DNS/PTR records cannot be edited manually; assign the hostname through DNS or DHCP'
    });
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

  const updateWorkflow = db.transaction(() => {
    const result = updateRecord(db, zone, record, {
      name: newName,
      type: newType,
      value: newValue,
      priority: newPriority,
      weight: newWeight,
      port: newPort,
      ttl: newTtl,
      enabled
    });

    const oldWasActiveAddress = record.type === 'A' && zone.type === 'forward'
      && zone.enabled && record.enabled;
    const newIsActiveAddress = newType === 'A' && zone.type === 'forward'
      && zone.enabled && result.enabled;
    if (oldWasActiveAddress && (!newIsActiveAddress
        || record.value !== newValue || record.name !== newName)) {
        deallocateStaticDns(db, record.name, record.value, zone.name);
    }
    if (newIsActiveAddress) {
      allocateStaticDns(db, newName, newValue, zone.name, result.id);
    }
    return result;
  });
  const updated = updateWorkflow();
  audit(req.user.id, 'record_updated', 'dns_record', record.id, { changes: req.body });

  req.afterCommit('regenerate_dns');
  res.json(updated);
});

// DELETE /api/dns/zones/:zoneId/records/:id
router.delete('/zones/:zoneId/records/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const record = db.prepare('SELECT * FROM dns_records WHERE id = ? AND zone_id = ?').get(req.params.id, req.params.zoneId);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  if (['dns', 'dhcp', 'reservation', 'placeholder'].includes(record.source)) {
    return res.status(403).json({
      error: 'Generated DNS/PTR records cannot be deleted manually; change the DNS or DHCP hostname source, or disable managed reverse DNS'
    });
  }

  // Clear PTR and IP hostname when A record is deleted from a forward zone
  const delZone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(record.zone_id);
  db.transaction(() => {
    deleteRecord(db, delZone, record);
    if (record.type === 'A' && delZone?.type === 'forward'
        && delZone.enabled && record.enabled) {
      deallocateStaticDns(db, record.name, record.value, delZone.name);
    }
  })();

  audit(req.user.id, 'record_deleted', 'dns_record', record.id, { type: record.type, name: record.name });

  req.afterCommit('regenerate_dns');
  res.json({ message: 'Record deleted' });
});

// ─── Utility ─────────────────────────────────────────────

// POST /api/dns/apply: force regenerate all config files. Routes through
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

  // Upstream servers are only required when recursion is enabled, with recursion
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

// GET /api/dns/dnssec: current state + dnsmasq support + clock-sync status
router.get('/dnssec', requirePerm('dns:read'), (req, res) => {
  res.json({
    enabled: getSetting('dnssec_enabled') === 'true',
    supported: dnsmasqSupportsDnssec(),
    ntp: getNtpStatus(),
  });
});

// PUT /api/dns/dnssec: toggle DNSSEC validation. Mirrors /forwarders: the
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
    // SSRF guard: the stub connects directly to these IPs (DoT and DoH alike), so
    // refuse private/loopback/metadata/reserved targets, same ranges url-guard blocks.
    const blocked = u.addresses.find(a => isBlockedIpv4(a));
    if (blocked) return `upstream address ${blocked} is in a private/reserved range`;
    if (typeof u.hostname !== 'string' || !u.hostname) return 'each upstream needs a hostname';
    // doh_url is only used by DoH (https) mode; DoT (tls) never reads it.
    if (mode === 'https' && (typeof u.doh_url !== 'string' || !/^https:\/\//.test(u.doh_url))) {
      return 'each upstream needs an https doh_url';
    }
  }
  return null;
}

// GET /api/dns/encryption: mode, configured upstreams, preset catalog, live status
router.get('/encryption', requirePerm('dns:read'), (req, res) => {
  let upstreams;
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

// PUT /api/dns/encryption: set Off/TLS/HTTPS + upstreams. Authoritative path:
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

// POST /api/dns/forwarders/test: test if a DNS forwarder is reachable
router.post('/forwarders/test', requirePerm('dns:read'), async (req, res) => {
  const { ip } = req.body;
  if (!ip || !isValidIpv4(ip)) {
    return res.status(400).json({ error: 'Valid IPv4 address required' });
  }

  const result = await testDnsForwarder(ip);
  res.json({ ip, ...result });
});

// GET /api/dns/resolve?name=hostname: resolve hostname to IPs
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
