import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import { ipToLong, isIpInSubnet, rangesOverlap } from '../utils/ip.js';
import { regenerateDhcpConfigs } from '../utils/dhcp.js';

const router = Router({ mergeParams: true });

function requirePerm(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// GET /api/subnets/:subnetId/ranges
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const ranges = db.prepare(`
    SELECT r.*, rt.name as range_type_name, rt.color as range_type_color, rt.is_system as range_type_is_system
    FROM ranges r
    JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.subnet_id = ?
    ORDER BY r.start_ip
  `).all(req.params.subnetId);
  res.json(ranges);
});

// POST /api/subnets/:subnetId/ranges
router.post('/', requirePerm('subnets:write'), (req, res) => {
  const { range_type_id, start_ip, end_ip, description, force } = req.body;
  const subnetId = req.params.subnetId;

  if (!range_type_id || !start_ip || !end_ip) {
    return res.status(400).json({ error: 'range_type_id, start_ip, and end_ip are required' });
  }

  const db = getDb();
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  // Validate IPs are within subnet
  if (!isIpInSubnet(start_ip, subnet.cidr) || !isIpInSubnet(end_ip, subnet.cidr)) {
    return res.status(400).json({ error: 'IP range must be within the subnet' });
  }

  // Validate start <= end
  if (ipToLong(start_ip) > ipToLong(end_ip)) {
    return res.status(400).json({ error: 'Start IP must be less than or equal to end IP' });
  }

  // Validate range type exists
  const rangeType = db.prepare('SELECT * FROM range_types WHERE id = ?').get(range_type_id);
  if (!rangeType) return res.status(404).json({ error: 'Range type not found' });

  // Check for locked IPs in the range (for DHCP Scope ranges)
  if (rangeType.name === 'DHCP Scope') {
    const startLong = ipToLong(start_ip);
    const endLong = ipToLong(end_ip);
    const reservedIps = db.prepare(
      `SELECT ip_address FROM ip_addresses WHERE subnet_id = ? AND status = 'locked'`
    ).all(subnetId).filter(r => {
      const l = ipToLong(r.ip_address);
      return l >= startLong && l <= endLong;
    });

    if (reservedIps.length > 0) {
      return res.status(400).json({
        error: `Range contains ${reservedIps.length} reserved IP(s): ${reservedIps.slice(0, 5).map(r => r.ip_address).join(', ')}${reservedIps.length > 5 ? '...' : ''}`
      });
    }
  }

  // Check for overlapping ranges (warn unless force=true)
  const existingRanges = db.prepare('SELECT * FROM ranges WHERE subnet_id = ?').all(subnetId);
  const overlaps = existingRanges.filter(r => rangesOverlap(start_ip, end_ip, r.start_ip, r.end_ip));

  if (overlaps.length > 0 && !force) {
    const overlapDetails = overlaps.map(r => {
      const rt = db.prepare('SELECT name FROM range_types WHERE id = ?').get(r.range_type_id);
      return { id: r.id, type: rt?.name, start_ip: r.start_ip, end_ip: r.end_ip };
    });
    return res.status(409).json({
      error: 'Range overlaps with existing ranges',
      overlaps: overlapDetails,
      can_force: true
    });
  }

  const result = db.prepare(
    'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)'
  ).run(subnetId, range_type_id, start_ip, end_ip, description || null);

  const range = db.prepare(`
    SELECT r.*, rt.name as range_type_name, rt.color as range_type_color
    FROM ranges r JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.id = ?
  `).get(result.lastInsertRowid);

  audit(req.user.id, 'range_created', 'range', range.id, { subnet_id: subnetId, start_ip, end_ip, type: rangeType.name });
  res.status(201).json(range);
});

// PUT /api/subnets/:subnetId/ranges/:id
router.put('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const range = db.prepare('SELECT * FROM ranges WHERE id = ? AND subnet_id = ?').get(req.params.id, req.params.subnetId);
  if (!range) return res.status(404).json({ error: 'Range not found' });

  // Check if this is an auto-created system range
  const rangeType = db.prepare('SELECT * FROM range_types WHERE id = ?').get(range.range_type_id);
  if (rangeType?.is_system && ['Network', 'Broadcast'].includes(rangeType.name)) {
    return res.status(403).json({ error: 'Cannot modify Network or Broadcast ranges' });
  }

  const { range_type_id, start_ip, end_ip, description, force } = req.body;
  const newStart = start_ip ?? range.start_ip;
  const newEnd = end_ip ?? range.end_ip;

  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.subnetId);

  // Validate IPs within subnet
  if (!isIpInSubnet(newStart, subnet.cidr) || !isIpInSubnet(newEnd, subnet.cidr)) {
    return res.status(400).json({ error: 'IP range must be within the subnet' });
  }

  if (ipToLong(newStart) > ipToLong(newEnd)) {
    return res.status(400).json({ error: 'Start IP must be less than or equal to end IP' });
  }

  // Check overlaps excluding self
  const existingRanges = db.prepare('SELECT * FROM ranges WHERE subnet_id = ? AND id != ?').all(req.params.subnetId, range.id);
  const overlaps = existingRanges.filter(r => rangesOverlap(newStart, newEnd, r.start_ip, r.end_ip));

  if (overlaps.length > 0 && !force) {
    const overlapDetails = overlaps.map(r => {
      const rt = db.prepare('SELECT name FROM range_types WHERE id = ?').get(r.range_type_id);
      return { id: r.id, type: rt?.name, start_ip: r.start_ip, end_ip: r.end_ip };
    });
    return res.status(409).json({
      error: 'Range overlaps with existing ranges',
      overlaps: overlapDetails,
      can_force: true
    });
  }

  db.prepare(`
    UPDATE ranges SET range_type_id = ?, start_ip = ?, end_ip = ?, description = ?, updated_at = datetime('now') WHERE id = ?
  `).run(range_type_id ?? range.range_type_id, newStart, newEnd, description !== undefined ? description : range.description, range.id);

  const updated = db.prepare(`
    SELECT r.*, rt.name as range_type_name, rt.color as range_type_color
    FROM ranges r JOIN range_types rt ON r.range_type_id = rt.id WHERE r.id = ?
  `).get(range.id);

  audit(req.user.id, 'range_updated', 'range', range.id, { changes: req.body });
  res.json(updated);
});

// DELETE /api/subnets/:subnetId/ranges/:id
router.delete('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const range = db.prepare('SELECT * FROM ranges WHERE id = ? AND subnet_id = ?').get(req.params.id, req.params.subnetId);
  if (!range) return res.status(404).json({ error: 'Range not found' });

  const rangeType = db.prepare('SELECT * FROM range_types WHERE id = ?').get(range.range_type_id);
  if (rangeType?.is_system && ['Network', 'Broadcast'].includes(rangeType.name)) {
    return res.status(403).json({ error: 'Cannot delete Network or Broadcast ranges' });
  }

  const hasDhcpScope = db.prepare('SELECT id FROM dhcp_scopes WHERE range_id = ?').get(range.id);
  db.prepare('DELETE FROM ranges WHERE id = ?').run(range.id);
  if (hasDhcpScope) regenerateDhcpConfigs(db);
  audit(req.user.id, 'range_deleted', 'range', range.id, { subnet_id: req.params.subnetId, type: rangeType?.name });
  res.json({ message: 'Range deleted' });
});

export default router;
