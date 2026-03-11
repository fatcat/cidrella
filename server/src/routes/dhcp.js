import { Router } from 'express';
import { getDb, getSetting, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import { isIpInSubnet, ipToLong, getServerIpForSubnet } from '../utils/ip.js';
import { regenerateDhcpConfigs, syncLeases } from '../utils/dhcp.js';
import { DHCP_OPTIONS, DHCP_OPTION_GROUPS, LEGACY_COLUMN_MAP } from '../utils/dhcp-options.js';
import { syncDhcpReservationToIp, clearDhcpReservationFromIp } from '../utils/ip-sync.js';
import { lookupVendorBatch } from '../utils/mac-vendor.js';

const router = Router();

function requirePerm(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

const MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const LEASE_TIME_RE = /^\d+[smhd]?$/;

function isValidMac(mac) {
  return MAC_RE.test(mac);
}

function isValidIpv4(ip) {
  if (!IPV4_RE.test(ip)) return false;
  return ip.split('.').every(o => { const n = parseInt(o, 10); return n >= 0 && n <= 255; });
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
  const { range_id, subnet_id, lease_time, dns_servers, domain_name, gateway, ntp_servers, domain_search, description } = req.body;
  const db = getDb();

  if (!range_id || !subnet_id) {
    return res.status(400).json({ error: 'range_id and subnet_id are required' });
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
    try {
      const servers = JSON.parse(dns_servers);
      if (!Array.isArray(servers) || !servers.every(isValidIpv4)) {
        return res.status(400).json({ error: 'dns_servers must be a JSON array of valid IPs' });
      }
    } catch {
      return res.status(400).json({ error: 'dns_servers must be a valid JSON array' });
    }
  }

  // Validate gateway
  if (gateway && !isValidIpv4(gateway)) {
    return res.status(400).json({ error: 'Invalid gateway IP address' });
  }

  // Validate NTP servers
  if (ntp_servers) {
    try {
      const servers = JSON.parse(ntp_servers);
      if (!Array.isArray(servers) || !servers.every(isValidIpv4)) {
        return res.status(400).json({ error: 'ntp_servers must be a JSON array of valid IPs' });
      }
    } catch {
      return res.status(400).json({ error: 'ntp_servers must be a valid JSON array' });
    }
  }

  const { options } = req.body;

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
      const inherited = {};
      if (subnet.gateway_address) inherited[3] = subnet.gateway_address;
      if (subnet.cidr) {
        const pfx = parseInt(subnet.cidr.split('/')[1], 10);
        if (pfx >= 0 && pfx <= 32) {
          const m = pfx === 0 ? 0 : (0xFFFFFFFF << (32 - pfx)) >>> 0;
          inherited[1] = [(m >>> 24) & 255, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join('.');
        }
      }
      if (subnet.domain_name) {
        inherited[15] = subnet.domain_name;
        inherited[119] = subnet.domain_name;
      }

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
  regenerateDhcpConfigs(db);
  res.status(201).json(scope);
});

// PUT /api/dhcp/scopes/:id
router.put('/scopes/:id', requirePerm('dhcp:write'), (req, res) => {
  const { lease_time, dns_servers, domain_name, gateway, ntp_servers, domain_search, enabled, description, start_ip, end_ip } = req.body;
  const db = getDb();

  const scope = db.prepare('SELECT * FROM dhcp_scopes WHERE id = ?').get(req.params.id);
  if (!scope) return res.status(404).json({ error: 'Scope not found' });

  if (lease_time && !LEASE_TIME_RE.test(lease_time)) {
    return res.status(400).json({ error: 'Invalid lease time format' });
  }

  if (dns_servers !== undefined && dns_servers !== null) {
    try {
      const servers = JSON.parse(dns_servers);
      if (!Array.isArray(servers) || !servers.every(isValidIpv4)) {
        return res.status(400).json({ error: 'dns_servers must be a JSON array of valid IPs' });
      }
    } catch {
      return res.status(400).json({ error: 'dns_servers must be a valid JSON array' });
    }
  }

  if (gateway !== undefined && gateway !== null && gateway !== '' && !isValidIpv4(gateway)) {
    return res.status(400).json({ error: 'Invalid gateway IP address' });
  }

  if (ntp_servers !== undefined && ntp_servers !== null) {
    try {
      const servers = JSON.parse(ntp_servers);
      if (!Array.isArray(servers) || !servers.every(isValidIpv4)) {
        return res.status(400).json({ error: 'ntp_servers must be a JSON array of valid IPs' });
      }
    } catch {
      return res.status(400).json({ error: 'ntp_servers must be a valid JSON array' });
    }
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
  }

  const { options } = req.body;

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

      // Compute inherited values from subnet
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
  regenerateDhcpConfigs(db);
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
  regenerateDhcpConfigs(db);
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

// POST /api/dhcp/reservations
router.post('/reservations', requirePerm('dhcp:write'), (req, res) => {
  const { subnet_id, mac_address, ip_address, hostname, description } = req.body;
  const db = getDb();

  if (!subnet_id || !mac_address || !ip_address) {
    return res.status(400).json({ error: 'subnet_id, mac_address, and ip_address are required' });
  }

  const mac = mac_address.toLowerCase();
  if (!isValidMac(mac)) {
    return res.status(400).json({ error: 'Invalid MAC address format (expected XX:XX:XX:XX:XX:XX)' });
  }

  if (!isValidIpv4(ip_address)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }

  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnet_id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  if (!isIpInSubnet(ip_address, subnet.cidr)) {
    return res.status(400).json({ error: 'IP address is not within the selected subnet' });
  }

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
  audit(req.user.id, 'dhcp_reservation_created', 'dhcp_reservation', reservation.id, { mac, ip: ip_address, subnet: subnet.cidr });
  regenerateDhcpConfigs(db);
  res.status(201).json(reservation);
});

// PUT /api/dhcp/reservations/:id
router.put('/reservations/:id', requirePerm('dhcp:write'), (req, res) => {
  const { mac_address, ip_address, hostname, description, enabled } = req.body;
  const db = getDb();

  const reservation = db.prepare('SELECT * FROM dhcp_reservations WHERE id = ?').get(req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(reservation.subnet_id);

  const newMac = mac_address ? mac_address.toLowerCase() : reservation.mac_address;
  const newIp = ip_address ?? reservation.ip_address;

  if (mac_address && !isValidMac(newMac)) {
    return res.status(400).json({ error: 'Invalid MAC address format' });
  }

  if (ip_address && !isValidIpv4(ip_address)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }

  if (ip_address && !isIpInSubnet(ip_address, subnet.cidr)) {
    return res.status(400).json({ error: 'IP address is not within the subnet' });
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

  // If IP changed, clear old IP's DHCP metadata
  if (newIp !== reservation.ip_address) {
    clearDhcpReservationFromIp(db, reservation.subnet_id, reservation.ip_address, reservation.mac_address);
  }
  syncDhcpReservationToIp(db, reservation.subnet_id, newIp, {
    hostname: hostname !== undefined ? (hostname || null) : reservation.hostname,
    mac_address: newMac
  });
  audit(req.user.id, 'dhcp_reservation_updated', 'dhcp_reservation', reservation.id, { changes: req.body });
  regenerateDhcpConfigs(db);
  res.json(updated);
});

// DELETE /api/dhcp/reservations/:id
router.delete('/reservations/:id', requirePerm('dhcp:write'), (req, res) => {
  const db = getDb();
  const reservation = db.prepare('SELECT * FROM dhcp_reservations WHERE id = ?').get(req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });

  db.prepare('DELETE FROM dhcp_reservations WHERE id = ?').run(reservation.id);
  clearDhcpReservationFromIp(db, reservation.subnet_id, reservation.ip_address, reservation.mac_address);
  audit(req.user.id, 'dhcp_reservation_deleted', 'dhcp_reservation', reservation.id, {
    mac: reservation.mac_address, ip: reservation.ip_address
  });
  regenerateDhcpConfigs(db);
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
  unified.sort((a, b) => {
    const aLong = a.ip_address.split('.').reduce((acc, o) => (acc << 8) + parseInt(o), 0);
    const bLong = b.ip_address.split('.').reduce((acc, o) => (acc << 8) + parseInt(o), 0);
    return aLong - bLong;
  });

  // Vendor lookup
  const allMacs = unified.map(e => e.mac_address).filter(Boolean);
  const vendorMap = lookupVendorBatch([...new Set(allMacs)]);
  for (const entry of unified) {
    entry.vendor = entry.mac_address ? (vendorMap.get(entry.mac_address) || null) : null;
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
  regenerateDhcpConfigs(db);

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
  regenerateDhcpConfigs(db);

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
