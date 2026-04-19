import { Router } from 'express';
import { getDb, getSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { isIpInSubnet, ipToLong, parseCidr, getServerIpForSubnet, isValidIpv4, isValidMac, isClientMac, isValidDomain } from '../utils/ip.js';
import { syncLeases } from '../utils/dhcp.js';
import { DHCP_OPTIONS, DHCP_OPTION_GROUPS, LEGACY_COLUMN_MAP, DHCP_OPTIONS_BY_CODE } from '../utils/dhcp-options.js';
import { syncDhcpReservationToIp, clearDhcpReservationFromIp, syncPtrForIp } from '../utils/ip-sync.js';
import { lookupVendorBatch } from '../utils/mac-vendor.js';
import { validateDnsmasqConfigValue } from '../utils/dnsmasq-escape.js';

const router = Router();
const LEASE_TIME_RE = /^\d+[smhd]?$/;

// v0.4.15: validate each scope option value before it reaches the scope-
// options table. The config writer (utils/dhcp.js) already drops bad rows
// so a malformed row is non-exploitable, but catching it at write-time
// surfaces a clear error and keeps the DB clean.
function validateScopeOption(opt) {
  if (!opt || typeof opt !== 'object') return 'option must be an object';
  const code = Number(opt.code);
  if (!Number.isInteger(code) || code < 1 || code > 254) return 'code must be an integer 1-254';
  const value = opt.value;
  if (value == null || value === '') return null; // caller skips empty values
  if (typeof value !== 'string') return 'value must be a string';
  const optDef = DHCP_OPTIONS_BY_CODE[code];
  const type = optDef?.type || 'text';
  const allowComma = type === 'ip-list' || type === 'text-list';
  return validateDnsmasqConfigValue(value, { allowComma });
}



// Helper: parse and validate a JSON IP array field
// Returns { servers } on success or { error } on failure
function parseIpList(jsonStr, fieldName) {
  try {
    const servers = JSON.parse(jsonStr);
    if (!Array.isArray(servers) || !servers.every(isValidIpv4)) {
      return { error: `${fieldName} must be a JSON array of valid IPs` };
    }
    return { servers };
  } catch {
    return { error: `${fieldName} must be a valid JSON array` };
  }
}

// Helper: compute DHCP option values that are inherited from the subnet.
// These are skipped when saving explicit scope options to avoid redundant storage.
function computeInheritedOptions(subnet) {
  const inherited = {};
  if (subnet?.gateway_address) inherited[3] = subnet.gateway_address;
  if (subnet?.cidr) {
    const pfx = parseInt(subnet.cidr.split('/')[1], 10);
    if (pfx >= 0 && pfx <= 32) {
      const m = pfx === 0 ? 0 : (0xFFFFFFFF << (32 - pfx)) >>> 0;
      inherited[1] = [(m >>> 24) & 255, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join('.');
    }
  }
  if (subnet?.domain_name) {
    inherited[15] = subnet.domain_name;
    inherited[119] = subnet.domain_name;
  }
  return inherited;
}

// ─── Scopes ──────────────────────────────────────────────

// GET /api/dhcp/scopes
router.get('/scopes', requirePerm('dhcp:read'), (req, res) => {
  const db = getDb();
  const scopes = db.prepare(`
    SELECT s.*, r.start_ip, r.end_ip,
      sub.cidr as subnet_cidr, sub.name as subnet_name, sub.gateway_address as subnet_gateway,
      sub.domain_name as subnet_domain_name, sub.folder_id
    FROM dhcp_scopes s
    JOIN ranges r ON s.range_id = r.id
    JOIN subnets sub ON s.subnet_id = sub.id
    ORDER BY sub.network_address
  `).all();

  // Attach options and server IP to each scope
  const optStmt = db.prepare('SELECT option_code, value FROM dhcp_scope_options WHERE scope_id = ?');
  for (const scope of scopes) {
    scope.options = optStmt.all(scope.id);
    if (scope.subnet_cidr) {
      scope.server_ip = getServerIpForSubnet(scope.subnet_cidr);
    }
  }

  res.json(scopes);
});

// POST /api/dhcp/scopes
router.post('/scopes', requirePerm('dhcp:write'), (req, res) => {
  const body = req.body || {};
  const { range_id, subnet_id, lease_time, dns_servers, domain_name, gateway, ntp_servers, domain_search, description } = body;
  const db = getDb();

  if (!range_id || !subnet_id) {
    return res.status(400).json({ error: 'range_id and subnet_id are required' });
  }

  // v0.4.15 type guards + injection guards. domain_name / domain_search land
  // in dnsmasq config as dhcp-option=15 / 119 so newlines would inject
  // directives; route them through the shared sanitizer.
  if (domain_name !== undefined && domain_name !== null && domain_name !== '') {
    if (!isValidDomain(domain_name)) return res.status(400).json({ error: 'Invalid domain_name' });
    if (validateDnsmasqConfigValue(domain_name) != null) {
      return res.status(400).json({ error: 'domain_name contains disallowed characters' });
    }
  }
  if (domain_search !== undefined && domain_search !== null && domain_search !== '') {
    if (typeof domain_search !== 'string') return res.status(400).json({ error: 'domain_search must be a string' });
    if (validateDnsmasqConfigValue(domain_search, { allowComma: true }) != null) {
      return res.status(400).json({ error: 'domain_search contains disallowed characters' });
    }
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string' });
  }
  if (lease_time !== undefined && lease_time !== null && typeof lease_time !== 'string') {
    return res.status(400).json({ error: 'lease_time must be a string' });
  }

  // Validate range exists and is a DHCP Scope type
  const range = db.prepare(`
    SELECT r.*, rt.name as range_type_name FROM ranges r
    JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.id = ?
  `).get(range_id);
  if (!range) return res.status(404).json({ error: 'Range not found' });
  if (range.range_type_name !== 'DHCP Scope') {
    return res.status(400).json({ error: 'Range must be of type DHCP Scope' });
  }

  // Validate subnet
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnet_id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  // Check no existing scope for this range
  const existing = db.prepare('SELECT id FROM dhcp_scopes WHERE range_id = ?').get(range_id);
  if (existing) return res.status(409).json({ error: 'A scope already exists for this range' });

  // Validate lease time format
  if (lease_time && !LEASE_TIME_RE.test(lease_time)) {
    return res.status(400).json({ error: 'Invalid lease time format (e.g., 24h, 3600, 1d)' });
  }

  // Validate DNS servers
  if (dns_servers) {
    const { error: dnsErr } = parseIpList(dns_servers, 'dns_servers');
    if (dnsErr) return res.status(400).json({ error: dnsErr });
  }

  // Validate gateway
  if (gateway && !isValidIpv4(gateway)) {
    return res.status(400).json({ error: 'Invalid gateway IP address' });
  }

  // Validate NTP servers
  if (ntp_servers) {
    const { error: ntpErr } = parseIpList(ntp_servers, 'ntp_servers');
    if (ntpErr) return res.status(400).json({ error: ntpErr });
  }

  const { options } = body;

  // Validate every scope option up front so a single bad entry doesn't leave
  // a half-populated scope behind.
  if (Array.isArray(options)) {
    for (const opt of options) {
      if (opt == null || opt.value == null || opt.value === '') continue;
      const err = validateScopeOption(opt);
      if (err) return res.status(400).json({ error: `Scope option ${opt?.code ?? '?'}: ${err}` });
    }
  } else if (options !== undefined) {
    return res.status(400).json({ error: 'options must be an array' });
  }

  const txn = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, dns_servers, domain_name, gateway, ntp_servers, domain_search, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      range_id, subnet_id,
      lease_time || getSetting('default_lease_time'),
      dns_servers || null,
      domain_name || null,
      gateway || null,
      ntp_servers || null,
      domain_search || null,
      description || null
    );

    const scopeId = result.lastInsertRowid;

    // Save scope options — skip values that match subnet defaults (inherited dynamically)
    if (Array.isArray(options) && options.length > 0) {
      const inherited = computeInheritedOptions(subnet);
      const insertOpt = db.prepare('INSERT INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)');
      for (const opt of options) {
        if (opt.code && opt.value != null && opt.value !== '') {
          if (inherited[opt.code] && String(opt.value) === inherited[opt.code]) continue;
          insertOpt.run(scopeId, opt.code, String(opt.value));
        }
      }
    }

    return scopeId;
  });

  const scopeId = txn();

  const scope = db.prepare(`
    SELECT s.*, r.start_ip, r.end_ip,
      sub.cidr as subnet_cidr, sub.name as subnet_name, sub.gateway_address as subnet_gateway
    FROM dhcp_scopes s
    JOIN ranges r ON s.range_id = r.id
    JOIN subnets sub ON s.subnet_id = sub.id
    WHERE s.id = ?
  `).get(scopeId);

  // Attach scope options
  scope.options = db.prepare('SELECT option_code, value FROM dhcp_scope_options WHERE scope_id = ?').all(scopeId);

  audit(req.user.id, 'dhcp_scope_created', 'dhcp_scope', scope.id, { subnet: subnet.cidr, range_id });
  req.afterCommit('regenerate_dhcp');
  res.status(201).json(scope);
});

// PUT /api/dhcp/scopes/:id
router.put('/scopes/:id', requirePerm('dhcp:write'), (req, res) => {
  const body = req.body || {};
  const { lease_time, dns_servers, domain_name, gateway, ntp_servers, domain_search, enabled, description, start_ip, end_ip } = body;
  const db = getDb();

  const scope = db.prepare('SELECT * FROM dhcp_scopes WHERE id = ?').get(req.params.id);
  if (!scope) return res.status(404).json({ error: 'Scope not found' });

  // v0.4.15 type + injection guards, symmetric to POST.
  if (domain_name !== undefined && domain_name !== null && domain_name !== '') {
    if (!isValidDomain(domain_name)) return res.status(400).json({ error: 'Invalid domain_name' });
    if (validateDnsmasqConfigValue(domain_name) != null) {
      return res.status(400).json({ error: 'domain_name contains disallowed characters' });
    }
  }
  if (domain_search !== undefined && domain_search !== null && domain_search !== '') {
    if (typeof domain_search !== 'string') return res.status(400).json({ error: 'domain_search must be a string' });
    if (validateDnsmasqConfigValue(domain_search, { allowComma: true }) != null) {
      return res.status(400).json({ error: 'domain_search contains disallowed characters' });
    }
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string' });
  }
  if (lease_time !== undefined && lease_time !== null && typeof lease_time !== 'string') {
    return res.status(400).json({ error: 'lease_time must be a string' });
  }

  if (lease_time && !LEASE_TIME_RE.test(lease_time)) {
    return res.status(400).json({ error: 'Invalid lease time format' });
  }

  if (dns_servers !== undefined && dns_servers !== null) {
    const { error: dnsErr } = parseIpList(dns_servers, 'dns_servers');
    if (dnsErr) return res.status(400).json({ error: dnsErr });
  }

  if (gateway !== undefined && gateway !== null && gateway !== '' && !isValidIpv4(gateway)) {
    return res.status(400).json({ error: 'Invalid gateway IP address' });
  }

  if (ntp_servers !== undefined && ntp_servers !== null) {
    const { error: ntpErr } = parseIpList(ntp_servers, 'ntp_servers');
    if (ntpErr) return res.status(400).json({ error: ntpErr });
  }

  // Validate start_ip / end_ip if provided
  if (start_ip !== undefined && !isValidIpv4(start_ip)) {
    return res.status(400).json({ error: 'Invalid start IP address' });
  }
  if (end_ip !== undefined && !isValidIpv4(end_ip)) {
    return res.status(400).json({ error: 'Invalid end IP address' });
  }
  if (start_ip !== undefined || end_ip !== undefined) {
    const range = db.prepare('SELECT * FROM ranges WHERE id = ?').get(scope.range_id);
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(scope.subnet_id);
    const newStart = start_ip || range.start_ip;
    const newEnd = end_ip || range.end_ip;
    if (!isIpInSubnet(newStart, subnet.cidr) || !isIpInSubnet(newEnd, subnet.cidr)) {
      return res.status(400).json({ error: 'IP addresses must be within the subnet' });
    }
    if (ipToLong(newStart) > ipToLong(newEnd)) {
      return res.status(400).json({ error: 'Start IP must be before or equal to end IP' });
    }
    // Symmetric to the PUT /api/subnets/:id gateway-in-pool guard: block a
    // resize that would place the subnet's gateway inside the DHCP pool.
    // dnsmasq would hand out the gateway IP as a dynamic lease otherwise.
    if (subnet.gateway_address) {
      const gwLong = ipToLong(subnet.gateway_address);
      if (gwLong >= ipToLong(newStart) && gwLong <= ipToLong(newEnd)) {
        return res.status(409).json({
          error: `Pool ${newStart}–${newEnd} would include the subnet gateway ${subnet.gateway_address}. Shrink the pool or change the gateway first.`,
          gateway_address: subnet.gateway_address
        });
      }
    }
  }

  const { options } = body;

  if (Array.isArray(options)) {
    for (const opt of options) {
      if (opt == null || opt.value == null || opt.value === '') continue;
      const err = validateScopeOption(opt);
      if (err) return res.status(400).json({ error: `Scope option ${opt?.code ?? '?'}: ${err}` });
    }
  } else if (options !== undefined) {
    return res.status(400).json({ error: 'options must be an array' });
  }

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE dhcp_scopes SET lease_time = ?, dns_servers = ?, domain_name = ?,
        gateway = ?, ntp_servers = ?, domain_search = ?, enabled = ?, description = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      lease_time ?? scope.lease_time,
      dns_servers !== undefined ? dns_servers : scope.dns_servers,
      domain_name !== undefined ? domain_name : scope.domain_name,
      gateway !== undefined ? (gateway || null) : scope.gateway,
      ntp_servers !== undefined ? (ntp_servers || null) : scope.ntp_servers,
      domain_search !== undefined ? (domain_search || null) : scope.domain_search,
      enabled !== undefined ? (enabled ? 1 : 0) : scope.enabled,
      description !== undefined ? description : scope.description,
      scope.id
    );

    // Update range IPs if provided
    if (start_ip !== undefined || end_ip !== undefined) {
      const range = db.prepare('SELECT * FROM ranges WHERE id = ?').get(scope.range_id);
      db.prepare("UPDATE ranges SET start_ip = ?, end_ip = ?, updated_at = datetime('now') WHERE id = ?").run(
        start_ip || range.start_ip,
        end_ip || range.end_ip,
        scope.range_id
      );
    }

    // Replace scope options if provided — skip values that match subnet defaults (inherited dynamically)
    if (Array.isArray(options)) {
      const subnet = db.prepare('SELECT gateway_address, cidr, domain_name FROM subnets WHERE id = ?').get(scope.subnet_id);
      db.prepare('DELETE FROM dhcp_scope_options WHERE scope_id = ?').run(scope.id);
      const insertOpt = db.prepare('INSERT INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)');
      const inherited = computeInheritedOptions(subnet);

      for (const opt of options) {
        if (opt.code && opt.value != null && opt.value !== '') {
          // Skip if value matches what the config generator inherits from the subnet
          if (inherited[opt.code] && String(opt.value) === inherited[opt.code]) continue;
          insertOpt.run(scope.id, opt.code, String(opt.value));
        }
      }
    }
  });

  txn();

  const updated = db.prepare(`
    SELECT s.*, r.start_ip, r.end_ip,
      sub.cidr as subnet_cidr, sub.name as subnet_name, sub.gateway_address as subnet_gateway
    FROM dhcp_scopes s
    JOIN ranges r ON s.range_id = r.id
    JOIN subnets sub ON s.subnet_id = sub.id
    WHERE s.id = ?
  `).get(scope.id);

  updated.options = db.prepare('SELECT option_code, value FROM dhcp_scope_options WHERE scope_id = ?').all(scope.id);

  audit(req.user.id, 'dhcp_scope_updated', 'dhcp_scope', scope.id, { changes: req.body });
  req.afterCommit('regenerate_dhcp');
  res.json(updated);
});

// DELETE /api/dhcp/scopes/:id
router.delete('/scopes/:id', requirePerm('dhcp:write'), (req, res) => {
  const db = getDb();
  const scope = db.prepare('SELECT * FROM dhcp_scopes WHERE id = ?').get(req.params.id);
  if (!scope) return res.status(404).json({ error: 'Scope not found' });

  db.prepare('DELETE FROM dhcp_scope_options WHERE scope_id = ?').run(scope.id);
  db.prepare('DELETE FROM dhcp_scopes WHERE id = ?').run(scope.id);
  db.prepare('DELETE FROM ranges WHERE id = ?').run(scope.range_id);
  audit(req.user.id, 'dhcp_scope_deleted', 'dhcp_scope', scope.id, { range_id: scope.range_id });
  req.afterCommit('regenerate_dhcp');
  res.json({ message: 'Scope deleted' });
});

// ─── Reservations ────────────────────────────────────────

// GET /api/dhcp/reservations
router.get('/reservations', requirePerm('dhcp:read'), (req, res) => {
  const db = getDb();
  const { subnet_id } = req.query;

  let query = `
    SELECT dr.*, sub.cidr as subnet_cidr, sub.name as subnet_name
    FROM dhcp_reservations dr
    JOIN subnets sub ON dr.subnet_id = sub.id
  `;
  const params = [];

  if (subnet_id) {
    query += ' WHERE dr.subnet_id = ?';
    params.push(subnet_id);
  }

  query += ' ORDER BY dr.ip_address';
  res.json(db.prepare(query).all(...params));
});

// Returns null if the IP is safe to reserve, or a string error reason otherwise.
// Blocks the subnet's network address, broadcast, gateway, and any IP marked
// locked in ip_addresses. Callers have already validated format + subnet bounds.
export function reservationIpRejectionReason(db, subnet, ipAddress) {
  const parsed = parseCidr(subnet.cidr);
  const ipLong = ipToLong(ipAddress);
  if (ipLong === parsed.networkLong)   return 'Cannot reserve the network address';
  if (ipLong === parsed.broadcastLong) return 'Cannot reserve the broadcast address';
  if (subnet.gateway_address && ipAddress === subnet.gateway_address) {
    return 'Cannot reserve the gateway address';
  }
  const row = db.prepare(
    'SELECT status FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?'
  ).get(subnet.id, ipAddress);
  if (row && row.status === 'locked') return 'Cannot reserve a locked IP';
  return null;
}

// POST /api/dhcp/reservations
router.post('/reservations', requirePerm('dhcp:write'), (req, res) => {
  const body = req.body || {};
  const { subnet_id, mac_address, ip_address, hostname, description } = body;
  const db = getDb();

  if (!subnet_id || !mac_address || !ip_address) {
    return res.status(400).json({ error: 'subnet_id, mac_address, and ip_address are required' });
  }

  // Type guards BEFORE any string method is called — prevents the
  // `mac_address.toLowerCase is not a function` 500 that v0.4.14's API
  // fuzzer logged.
  if (typeof mac_address !== 'string' || typeof ip_address !== 'string') {
    return res.status(400).json({ error: 'mac_address and ip_address must be strings' });
  }
  if (hostname !== undefined && hostname !== null && typeof hostname !== 'string') {
    return res.status(400).json({ error: 'hostname must be a string' });
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string' });
  }

  const mac = mac_address.toLowerCase();
  if (!isValidMac(mac)) {
    return res.status(400).json({ error: 'Invalid MAC address format (expected XX:XX:XX:XX:XX:XX)' });
  }
  if (!isClientMac(mac)) {
    return res.status(400).json({ error: 'MAC address cannot be all-zero, broadcast, or multicast' });
  }

  if (!isValidIpv4(ip_address)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }

  if (hostname && !isValidDomain(hostname)) {
    return res.status(400).json({ error: 'Invalid hostname (letters, digits, dots, hyphens; 1–253 chars)' });
  }

  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnet_id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  // Reservations only make sense on an allocated leaf subnet. Refusing
  // non-leaf / unallocated targets closes a race where a POST commits after
  // a concurrent divide turns the target into an intermediate container,
  // which would leave the row invisible from any leaf's DHCP surface.
  // Check "has children" first so a post-divide parent (which becomes
  // unallocated AND non-leaf) gets the clearer "not a leaf" message.
  const hasChildren = db.prepare('SELECT 1 FROM subnets WHERE parent_id = ? LIMIT 1').get(subnet.id);
  if (hasChildren) {
    return res.status(400).json({ error: 'Subnet has child subnets — reservations must be placed on a leaf.' });
  }
  if (subnet.status !== 'allocated') {
    return res.status(400).json({ error: 'Subnet is not allocated — reservations require an allocated subnet.' });
  }

  if (!isIpInSubnet(ip_address, subnet.cidr)) {
    return res.status(400).json({ error: 'IP address is not within the selected subnet' });
  }

  const rejection = reservationIpRejectionReason(db, subnet, ip_address);
  if (rejection) return res.status(400).json({ error: rejection });

  // Check duplicate MAC in this subnet
  const dupMac = db.prepare('SELECT id FROM dhcp_reservations WHERE subnet_id = ? AND mac_address = ?').get(subnet_id, mac);
  if (dupMac) return res.status(409).json({ error: 'MAC address already has a reservation in this subnet' });

  // Check duplicate IP in this subnet
  const dupIp = db.prepare('SELECT id FROM dhcp_reservations WHERE subnet_id = ? AND ip_address = ?').get(subnet_id, ip_address);
  if (dupIp) return res.status(409).json({ error: 'IP address already reserved in this subnet' });

  const result = db.prepare(`
    INSERT INTO dhcp_reservations (subnet_id, mac_address, ip_address, hostname, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(subnet_id, mac, ip_address, hostname || null, description || null);

  const reservation = db.prepare(`
    SELECT dr.*, sub.cidr as subnet_cidr, sub.name as subnet_name
    FROM dhcp_reservations dr
    JOIN subnets sub ON dr.subnet_id = sub.id
    WHERE dr.id = ?
  `).get(result.lastInsertRowid);

  syncDhcpReservationToIp(db, subnet_id, ip_address, { hostname: hostname || null, mac_address: mac });
  // Populate the matching PTR record with the FQDN (hostname + domain), or
  // blank it if no hostname was provided.
  const fqdn = hostname
    ? (subnet.domain_name ? `${hostname}.${subnet.domain_name}` : hostname)
    : '';
  syncPtrForIp(db, subnet_id, ip_address, fqdn);
  audit(req.user.id, 'dhcp_reservation_created', 'dhcp_reservation', reservation.id, { mac, ip: ip_address, subnet: subnet.cidr });
  req.afterCommit('regenerate_dhcp');
  res.status(201).json(reservation);
});

// PUT /api/dhcp/reservations/:id
router.put('/reservations/:id', requirePerm('dhcp:write'), (req, res) => {
  const body = req.body || {};
  const { mac_address, ip_address, hostname, description, enabled } = body;
  const db = getDb();

  const reservation = db.prepare('SELECT * FROM dhcp_reservations WHERE id = ?').get(req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(reservation.subnet_id);

  // Type guards on every optional string field.
  if (mac_address !== undefined && typeof mac_address !== 'string') {
    return res.status(400).json({ error: 'mac_address must be a string' });
  }
  if (ip_address !== undefined && typeof ip_address !== 'string') {
    return res.status(400).json({ error: 'ip_address must be a string' });
  }
  if (hostname !== undefined && hostname !== null && typeof hostname !== 'string') {
    return res.status(400).json({ error: 'hostname must be a string' });
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string' });
  }

  const newMac = mac_address ? mac_address.toLowerCase() : reservation.mac_address;
  const newIp = ip_address ?? reservation.ip_address;

  if (mac_address && !isValidMac(newMac)) {
    return res.status(400).json({ error: 'Invalid MAC address format' });
  }
  if (mac_address && !isClientMac(newMac)) {
    return res.status(400).json({ error: 'MAC address cannot be all-zero, broadcast, or multicast' });
  }

  if (ip_address && !isValidIpv4(ip_address)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }

  if (hostname !== undefined && hostname && !isValidDomain(hostname)) {
    return res.status(400).json({ error: 'Invalid hostname (letters, digits, dots, hyphens; 1–253 chars)' });
  }

  if (ip_address && !isIpInSubnet(ip_address, subnet.cidr)) {
    return res.status(400).json({ error: 'IP address is not within the subnet' });
  }

  if (ip_address) {
    const rejection = reservationIpRejectionReason(db, subnet, ip_address);
    if (rejection) return res.status(400).json({ error: rejection });
  }

  // Check duplicate MAC (excluding self)
  if (newMac !== reservation.mac_address) {
    const dupMac = db.prepare('SELECT id FROM dhcp_reservations WHERE subnet_id = ? AND mac_address = ? AND id != ?').get(reservation.subnet_id, newMac, reservation.id);
    if (dupMac) return res.status(409).json({ error: 'MAC address already has a reservation in this subnet' });
  }

  // Check duplicate IP (excluding self)
  if (newIp !== reservation.ip_address) {
    const dupIp = db.prepare('SELECT id FROM dhcp_reservations WHERE subnet_id = ? AND ip_address = ? AND id != ?').get(reservation.subnet_id, newIp, reservation.id);
    if (dupIp) return res.status(409).json({ error: 'IP address already reserved in this subnet' });
  }

  db.prepare(`
    UPDATE dhcp_reservations SET mac_address = ?, ip_address = ?, hostname = ?,
      description = ?, enabled = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    newMac, newIp,
    hostname !== undefined ? (hostname || null) : reservation.hostname,
    description !== undefined ? (description || null) : reservation.description,
    enabled !== undefined ? (enabled ? 1 : 0) : reservation.enabled,
    reservation.id
  );

  const updated = db.prepare(`
    SELECT dr.*, sub.cidr as subnet_cidr, sub.name as subnet_name
    FROM dhcp_reservations dr
    JOIN subnets sub ON dr.subnet_id = sub.id
    WHERE dr.id = ?
  `).get(reservation.id);

  // If IP changed, clear old IP's DHCP metadata + PTR
  if (newIp !== reservation.ip_address) {
    clearDhcpReservationFromIp(db, reservation.subnet_id, reservation.ip_address, reservation.mac_address);
    syncPtrForIp(db, reservation.subnet_id, reservation.ip_address, '');
  }
  const newHostname = hostname !== undefined ? (hostname || null) : reservation.hostname;
  syncDhcpReservationToIp(db, reservation.subnet_id, newIp, {
    hostname: newHostname,
    mac_address: newMac
  });
  const fqdn = newHostname
    ? (subnet.domain_name ? `${newHostname}.${subnet.domain_name}` : newHostname)
    : '';
  syncPtrForIp(db, reservation.subnet_id, newIp, fqdn);
  audit(req.user.id, 'dhcp_reservation_updated', 'dhcp_reservation', reservation.id, { changes: req.body });
  req.afterCommit('regenerate_dhcp');
  res.json(updated);
});

// DELETE /api/dhcp/reservations/:id
router.delete('/reservations/:id', requirePerm('dhcp:write'), (req, res) => {
  const db = getDb();
  const reservation = db.prepare('SELECT * FROM dhcp_reservations WHERE id = ?').get(req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

  db.prepare('DELETE FROM dhcp_reservations WHERE id = ?').run(reservation.id);
  clearDhcpReservationFromIp(db, reservation.subnet_id, reservation.ip_address, reservation.mac_address);
  syncPtrForIp(db, reservation.subnet_id, reservation.ip_address, '');
  audit(req.user.id, 'dhcp_reservation_deleted', 'dhcp_reservation', reservation.id, {
    mac: reservation.mac_address, ip: reservation.ip_address
  });
  req.afterCommit('regenerate_dhcp');
  res.json({ message: 'Reservation deleted' });
});

// ─── Leases ──────────────────────────────────────────────

// GET /api/dhcp/leases — unified view: dynamic leases + reservations
router.get('/leases', requirePerm('dhcp:read'), (req, res) => {
  const db = getDb();

  // Fetch all dynamic leases
  const leases = db.prepare(`
    SELECT dl.*, sub.cidr as subnet_cidr, sub.name as subnet_name, sub.domain_name as subnet_domain_name, sub.folder_id
    FROM dhcp_leases dl
    LEFT JOIN subnets sub ON dl.subnet_id = sub.id
    ORDER BY dl.ip_address
  `).all();

  // Fetch all reservations
  const reservations = db.prepare(`
    SELECT dr.*, sub.cidr as subnet_cidr, sub.name as subnet_name, sub.domain_name as subnet_domain_name, sub.folder_id
    FROM dhcp_reservations dr
    JOIN subnets sub ON dr.subnet_id = sub.id
    ORDER BY dr.ip_address
  `).all();

  // Build a map of leases by MAC+IP for matching
  const leaseMap = new Map();
  for (const l of leases) {
    leaseMap.set(`${l.mac_address}:${l.ip_address}`, l);
  }

  const unified = [];

  // Add reservations first (they take priority)
  const matchedLeaseKeys = new Set();
  for (const r of reservations) {
    const key = `${r.mac_address}:${r.ip_address}`;
    const matchedLease = leaseMap.get(key);
    const entry = {
      id: r.id,
      type: 'reserved',
      ip_address: r.ip_address,
      mac_address: r.mac_address,
      hostname: r.hostname,
      description: r.description,
      subnet_id: r.subnet_id,
      subnet_cidr: r.subnet_cidr,
      subnet_name: r.subnet_name,
      subnet_domain_name: r.subnet_domain_name,
      folder_id: r.folder_id,
      enabled: r.enabled,
      status: matchedLease ? 'active' : 'offline',
      expires_at: matchedLease ? matchedLease.expires_at : null,
      reservation_id: r.id,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
    unified.push(entry);
    if (matchedLease) matchedLeaseKeys.add(key);
  }

  // Add dynamic leases that don't match a reservation
  for (const l of leases) {
    const key = `${l.mac_address}:${l.ip_address}`;
    if (!matchedLeaseKeys.has(key)) {
      unified.push({
        id: l.id,
        type: 'dynamic',
        ip_address: l.ip_address,
        mac_address: l.mac_address,
        hostname: l.hostname,
        description: null,
        subnet_id: l.subnet_id,
        subnet_cidr: l.subnet_cidr,
        subnet_name: l.subnet_name,
        subnet_domain_name: l.subnet_domain_name,
        folder_id: l.folder_id,
        enabled: true,
        status: 'active',
        expires_at: l.expires_at,
        reservation_id: null,
        created_at: l.created_at,
        updated_at: l.updated_at
      });
    }
  }

  // Sort by IP address
  unified.sort((a, b) => ipToLong(a.ip_address) - ipToLong(b.ip_address));

  // Vendor lookup
  const allMacs = unified.map(e => e.mac_address).filter(Boolean);
  const vendorMap = lookupVendorBatch([...new Set(allMacs)]);
  for (const entry of unified) {
    entry.vendor = entry.mac_address ? (vendorMap.get(entry.mac_address) || null) : null;
  }

  // Enrich with is_online from ip_addresses
  const allIps = unified.map(e => e.ip_address).filter(Boolean);
  if (allIps.length) {
    const CHUNK_SIZE = 900;
    const onlineMap = new Map();
    for (let i = 0; i < allIps.length; i += CHUNK_SIZE) {
      const chunk = allIps.slice(i, i + CHUNK_SIZE);
      const ipRows = db.prepare(
        `SELECT ip_address, is_online FROM ip_addresses WHERE ip_address IN (${chunk.map(() => '?').join(',')})`
      ).all(...chunk);
      for (const r of ipRows) onlineMap.set(r.ip_address, !!r.is_online);
    }
    for (const entry of unified) {
      entry.is_online = onlineMap.get(entry.ip_address) ?? null;
    }
  }

  res.json(unified);
});

// POST /api/dhcp/sync-leases
router.post('/sync-leases', requirePerm('dhcp:write'), (req, res) => {
  const db = getDb();
  const result = syncLeases(db);
  res.json({ message: 'Leases synced', ...result });
});

// ─── Utility ─────────────────────────────────────────────

// POST /api/dhcp/apply
router.post('/apply', requirePerm('dhcp:write'), (req, res) => {
  const db = getDb();
  req.afterCommit('regenerate_dhcp');

  const scopeCount = db.prepare('SELECT COUNT(*) as c FROM dhcp_scopes WHERE enabled = 1').get().c;
  const reservationCount = db.prepare('SELECT COUNT(*) as c FROM dhcp_reservations WHERE enabled = 1').get().c;

  audit(req.user.id, 'dhcp_config_applied', 'dhcp', null, { scopes: scopeCount, reservations: reservationCount });
  res.json({ message: 'DHCP configuration applied', scopes: scopeCount, reservations: reservationCount });
});

// GET /api/dhcp/available-ranges — ranges eligible for scope creation
router.get('/available-ranges', requirePerm('dhcp:read'), (req, res) => {
  const db = getDb();
  const ranges = db.prepare(`
    SELECT r.*, rt.name as range_type_name, sub.cidr as subnet_cidr, sub.name as subnet_name,
      sub.gateway_address as subnet_gateway, sub.domain_name as subnet_domain_name
    FROM ranges r
    JOIN range_types rt ON r.range_type_id = rt.id
    JOIN subnets sub ON r.subnet_id = sub.id
    WHERE rt.name = 'DHCP Scope'
      AND r.id NOT IN (SELECT range_id FROM dhcp_scopes)
    ORDER BY sub.network_address, r.start_ip
  `).all();
  for (const range of ranges) {
    if (range.subnet_cidr) {
      range.server_ip = getServerIpForSubnet(range.subnet_cidr);
    }
  }
  res.json(ranges);
});

// ─── DHCP Options ────────────────────────────────────────

// GET /api/dhcp/options — catalog + global defaults + custom options
router.get('/options', requirePerm('dhcp:read'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT option_code, value, enabled_by_default FROM dhcp_option_defaults').all();
  const defaults = Object.fromEntries(rows.filter(r => r.value != null).map(r => [r.option_code, r.value]));
  const enabledDefaults = rows.filter(r => r.enabled_by_default).map(r => r.option_code);

  // Merge built-in catalog with custom options
  const customRows = db.prepare('SELECT * FROM dhcp_custom_options ORDER BY code').all();
  const customOptions = customRows.map(r => ({
    code: r.code, name: r.name, label: r.label, type: r.type,
    dnsmasqName: String(r.code),
    group: 'Custom', rfc: null, rfcUrl: null,
    description: r.description || 'User-defined option.',
    custom: true
  }));

  const catalog = [...DHCP_OPTIONS, ...customOptions];
  res.json({ catalog, defaults, enabledDefaults, groups: DHCP_OPTION_GROUPS });
});

// POST /api/dhcp/options/custom — create a custom option (codes 128-254)
router.post('/options/custom', requirePerm('dhcp:write'), (req, res) => {
  const db = getDb();
  const { code, name, label, type, description } = req.body;

  if (!code || !label) return res.status(400).json({ error: 'code and label are required' });
  const codeNum = parseInt(code, 10);
  if (isNaN(codeNum) || codeNum < 128 || codeNum > 254) {
    return res.status(400).json({ error: 'Code must be between 128 and 254' });
  }

  const allowedTypes = ['ip', 'ip-list', 'text', 'text-list', 'number'];
  const optType = allowedTypes.includes(type) ? type : 'text';

  // Check conflict with built-in catalog
  const builtIn = DHCP_OPTIONS.find(o => o.code === codeNum);
  if (builtIn) return res.status(409).json({ error: `Code ${codeNum} is already a built-in option (${builtIn.label})` });

  // Check conflict with existing custom option
  const existing = db.prepare('SELECT id FROM dhcp_custom_options WHERE code = ?').get(codeNum);
  if (existing) return res.status(409).json({ error: `Code ${codeNum} already exists as a custom option` });

  const optName = name || `custom-${codeNum}`;
  const result = db.prepare('INSERT INTO dhcp_custom_options (code, name, label, type, description) VALUES (?, ?, ?, ?, ?)')
    .run(codeNum, optName, label, optType, description || null);

  audit(req.user.id, 'create', 'dhcp_custom_option', result.lastInsertRowid, { code: codeNum, label });
  res.status(201).json({ id: result.lastInsertRowid, code: codeNum, label, type: optType });
});

// DELETE /api/dhcp/options/custom/:code — delete a custom option
router.delete('/options/custom/:code', requirePerm('dhcp:write'), (req, res) => {
  const db = getDb();
  const codeNum = parseInt(req.params.code, 10);

  const entry = db.prepare('SELECT * FROM dhcp_custom_options WHERE code = ?').get(codeNum);
  if (!entry) return res.status(404).json({ error: 'Custom option not found' });

  db.transaction(() => {
    db.prepare('DELETE FROM dhcp_custom_options WHERE code = ?').run(codeNum);
    db.prepare('DELETE FROM dhcp_option_defaults WHERE option_code = ?').run(codeNum);
    db.prepare('DELETE FROM dhcp_scope_options WHERE option_code = ?').run(codeNum);
  })();

  audit(req.user.id, 'delete', 'dhcp_custom_option', entry.id, { code: codeNum, label: entry.label });
  res.json({ ok: true });
});

// PUT /api/dhcp/options/defaults — set global defaults
router.put('/options/defaults', requirePerm('dhcp:write'), (req, res) => {
  const { options, enabledDefaults } = req.body;
  if (!Array.isArray(options)) {
    return res.status(400).json({ error: 'options must be an array of { code, value }' });
  }
  const enabledSet = new Set((enabledDefaults || []).map(Number));

  const db = getDb();
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM dhcp_option_defaults').run();
    const insert = db.prepare(`
      INSERT INTO dhcp_option_defaults (option_code, value, enabled_by_default, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `);
    // Insert options that have a value
    const inserted = new Set();
    for (const opt of options) {
      if (opt.code && opt.value != null && opt.value !== '') {
        insert.run(opt.code, String(opt.value), enabledSet.has(Number(opt.code)) ? 1 : 0);
        inserted.add(Number(opt.code));
      }
    }
    // Insert enabled-only entries (no value but enabled by default)
    for (const code of enabledSet) {
      if (!inserted.has(code)) {
        insert.run(code, null, 1);
      }
    }
  });

  txn();
  audit(req.user.id, 'dhcp_option_defaults_updated', 'dhcp', null, { count: options.length });
  req.afterCommit('regenerate_dhcp');

  const rows = db.prepare('SELECT option_code, value, enabled_by_default FROM dhcp_option_defaults').all();
  const defaults = Object.fromEntries(rows.filter(r => r.value != null).map(r => [r.option_code, r.value]));
  const returnedEnabled = rows.filter(r => r.enabled_by_default).map(r => r.option_code);
  res.json({ defaults, enabledDefaults: returnedEnabled });
});

/**
 * Remove redundant option 3 (gateway) entries from dhcp_scope_options
 * when they match the subnet's gateway_address. These are inherited
 * dynamically by the config generator and should not be stored.
 */
export function cleanupRedundantGatewayOptions(db) {
  const result = db.prepare(`
    DELETE FROM dhcp_scope_options
    WHERE option_code = 3
      AND scope_id IN (
        SELECT s.id FROM dhcp_scopes s
        JOIN subnets sub ON s.subnet_id = sub.id
        WHERE sub.gateway_address IS NOT NULL
          AND sub.gateway_address != ''
      )
      AND value = (
        SELECT sub.gateway_address FROM dhcp_scopes s
        JOIN subnets sub ON s.subnet_id = sub.id
        WHERE s.id = dhcp_scope_options.scope_id
      )
  `).run();
  if (result.changes > 0) {
    console.log(`Cleaned up ${result.changes} redundant gateway option(s) from DHCP scopes`);
  }
}

// One-time migration: copy legacy column values to dhcp_scope_options
export function migrateLegacyScopeOptions(db) {
  const scopes = db.prepare('SELECT * FROM dhcp_scopes').all();
  const hasAny = db.prepare('SELECT COUNT(*) as c FROM dhcp_scope_options').get();
  if (hasAny.c > 0) return; // Already migrated

  const insert = db.prepare('INSERT OR IGNORE INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)');
  const txn = db.transaction(() => {
    for (const scope of scopes) {
      // gateway → option 3
      if (scope.gateway) {
        insert.run(scope.id, 3, scope.gateway);
      }
      // dns_servers → option 6
      if (scope.dns_servers) {
        try {
          const servers = JSON.parse(scope.dns_servers);
          if (Array.isArray(servers) && servers.length > 0) {
            insert.run(scope.id, 6, servers.join(','));
          }
        } catch { /* skip */ }
      }
      // domain_name → option 15
      if (scope.domain_name) {
        insert.run(scope.id, 15, scope.domain_name);
      }
      // ntp_servers → option 42
      if (scope.ntp_servers) {
        try {
          const servers = JSON.parse(scope.ntp_servers);
          if (Array.isArray(servers) && servers.length > 0) {
            insert.run(scope.id, 42, servers.join(','));
          }
        } catch { /* skip */ }
      }
      // domain_search → option 119
      if (scope.domain_search) {
        insert.run(scope.id, 119, scope.domain_search);
      }
    }
  });
  txn();
  if (scopes.length > 0) {
    console.log(`Migrated legacy DHCP options for ${scopes.length} scopes`);
  }
}

export default router;
