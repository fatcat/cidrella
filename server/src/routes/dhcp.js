import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import { isIpInSubnet, ipToLong } from '../utils/ip.js';
import { regenerateDhcpConfigs, syncLeases } from '../utils/dhcp.js';

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
      sub.cidr as subnet_cidr, sub.name as subnet_name, sub.gateway_address as subnet_gateway
    FROM dhcp_scopes s
    JOIN ranges r ON s.range_id = r.id
    JOIN subnets sub ON s.subnet_id = sub.id
    ORDER BY sub.network_address
  `).all();
  res.json(scopes);
});

// POST /api/dhcp/scopes
router.post('/scopes', requirePerm('dhcp:write'), (req, res) => {
  const { range_id, subnet_id, lease_time, dns_servers, domain_name, gateway, description } = req.body;
  const db = getDb();

  if (!range_id || !subnet_id) {
    return res.status(400).json({ error: 'range_id and subnet_id are required' });
  }

  // Validate range exists and is a DHCP Pool type
  const range = db.prepare(`
    SELECT r.*, rt.name as range_type_name FROM ranges r
    JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.id = ?
  `).get(range_id);
  if (!range) return res.status(404).json({ error: 'Range not found' });
  if (range.range_type_name !== 'DHCP Pool') {
    return res.status(400).json({ error: 'Range must be of type DHCP Pool' });
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

  const result = db.prepare(`
    INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, dns_servers, domain_name, gateway, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    range_id, subnet_id,
    lease_time || '24h',
    dns_servers || null,
    domain_name || null,
    gateway || null,
    description || null
  );

  const scope = db.prepare(`
    SELECT s.*, r.start_ip, r.end_ip,
      sub.cidr as subnet_cidr, sub.name as subnet_name, sub.gateway_address as subnet_gateway
    FROM dhcp_scopes s
    JOIN ranges r ON s.range_id = r.id
    JOIN subnets sub ON s.subnet_id = sub.id
    WHERE s.id = ?
  `).get(result.lastInsertRowid);

  audit(req.user.id, 'dhcp_scope_created', 'dhcp_scope', scope.id, { subnet: subnet.cidr, range_id });
  regenerateDhcpConfigs(db);
  res.status(201).json(scope);
});

// PUT /api/dhcp/scopes/:id
router.put('/scopes/:id', requirePerm('dhcp:write'), (req, res) => {
  const { lease_time, dns_servers, domain_name, gateway, enabled, description } = req.body;
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

  db.prepare(`
    UPDATE dhcp_scopes SET lease_time = ?, dns_servers = ?, domain_name = ?,
      gateway = ?, enabled = ?, description = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    lease_time ?? scope.lease_time,
    dns_servers !== undefined ? dns_servers : scope.dns_servers,
    domain_name !== undefined ? domain_name : scope.domain_name,
    gateway !== undefined ? (gateway || null) : scope.gateway,
    enabled !== undefined ? (enabled ? 1 : 0) : scope.enabled,
    description !== undefined ? description : scope.description,
    scope.id
  );

  const updated = db.prepare(`
    SELECT s.*, r.start_ip, r.end_ip,
      sub.cidr as subnet_cidr, sub.name as subnet_name, sub.gateway_address as subnet_gateway
    FROM dhcp_scopes s
    JOIN ranges r ON s.range_id = r.id
    JOIN subnets sub ON s.subnet_id = sub.id
    WHERE s.id = ?
  `).get(scope.id);

  audit(req.user.id, 'dhcp_scope_updated', 'dhcp_scope', scope.id, { changes: req.body });
  regenerateDhcpConfigs(db);
  res.json(updated);
});

// DELETE /api/dhcp/scopes/:id
router.delete('/scopes/:id', requirePerm('dhcp:write'), (req, res) => {
  const db = getDb();
  const scope = db.prepare('SELECT * FROM dhcp_scopes WHERE id = ?').get(req.params.id);
  if (!scope) return res.status(404).json({ error: 'Scope not found' });

  db.prepare('DELETE FROM dhcp_scopes WHERE id = ?').run(scope.id);
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
  audit(req.user.id, 'dhcp_reservation_deleted', 'dhcp_reservation', reservation.id, {
    mac: reservation.mac_address, ip: reservation.ip_address
  });
  regenerateDhcpConfigs(db);
  res.json({ message: 'Reservation deleted' });
});

// ─── Leases ──────────────────────────────────────────────

// GET /api/dhcp/leases
router.get('/leases', requirePerm('dhcp:read'), (req, res) => {
  const db = getDb();
  const leases = db.prepare(`
    SELECT dl.*, sub.cidr as subnet_cidr, sub.name as subnet_name
    FROM dhcp_leases dl
    LEFT JOIN subnets sub ON dl.subnet_id = sub.id
    ORDER BY dl.ip_address
  `).all();
  res.json(leases);
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
      sub.gateway_address as subnet_gateway
    FROM ranges r
    JOIN range_types rt ON r.range_type_id = rt.id
    JOIN subnets sub ON r.subnet_id = sub.id
    WHERE rt.name = 'DHCP Pool'
      AND r.id NOT IN (SELECT range_id FROM dhcp_scopes)
    ORDER BY sub.network_address, r.start_ip
  `).all();
  res.json(ranges);
});

export default router;
