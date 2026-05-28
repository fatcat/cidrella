import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { ipToLong, isIpInSubnet, isValidIpv4, rangesOverlap, validateDisplayString } from '../utils/ip.js';
import * as Range from '../models/range.js';

const router = Router({ mergeParams: true });

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
  const body = req.body || {};
  const { range_type_id, start_ip, end_ip, description, force } = body;
  const subnetId = req.params.subnetId;

  if (!range_type_id || !start_ip || !end_ip) {
    return res.status(400).json({ error: 'range_type_id, start_ip, and end_ip are required' });
  }

  // v0.4.15: type-guard before any string operation — non-string IPs caused
  // ipToLong to throw 500s that the generic handler then masked as
  // "Internal server error". A 400 with the root cause is kinder.
  if (typeof start_ip !== 'string' || typeof end_ip !== 'string') {
    return res.status(400).json({ error: 'start_ip and end_ip must be strings' });
  }
  if (!isValidIpv4(start_ip) || !isValidIpv4(end_ip)) {
    return res.status(400).json({ error: 'start_ip and end_ip must be valid IPv4 addresses' });
  }
  if (!Number.isInteger(range_type_id)) {
    return res.status(400).json({ error: 'range_type_id must be an integer' });
  }
  if (description !== undefined) {
    const derr = validateDisplayString(description, { maxLength: 1024 });
    if (derr) return res.status(400).json({ error: `description ${derr}` });
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

  const range = Range.createRange(db, {
    subnetId,
    rangeTypeId: range_type_id,
    startIp: start_ip,
    endIp: end_ip,
    description
  });

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

  const body = req.body || {};
  const { range_type_id, start_ip, end_ip, description, force } = body;

  if (start_ip !== undefined && typeof start_ip !== 'string') {
    return res.status(400).json({ error: 'start_ip must be a string' });
  }
  if (end_ip !== undefined && typeof end_ip !== 'string') {
    return res.status(400).json({ error: 'end_ip must be a string' });
  }
  if (range_type_id !== undefined && !Number.isInteger(range_type_id)) {
    return res.status(400).json({ error: 'range_type_id must be an integer' });
  }
  if (description !== undefined) {
    const derr = validateDisplayString(description, { maxLength: 1024 });
    if (derr) return res.status(400).json({ error: `description ${derr}` });
  }

  const newStart = start_ip ?? range.start_ip;
  const newEnd = end_ip ?? range.end_ip;
  if (!isValidIpv4(newStart) || !isValidIpv4(newEnd)) {
    return res.status(400).json({ error: 'start_ip and end_ip must be valid IPv4 addresses' });
  }

  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.subnetId);
  if (range_type_id !== undefined) {
    const newRangeType = db.prepare('SELECT * FROM range_types WHERE id = ?').get(range_type_id);
    if (!newRangeType) return res.status(404).json({ error: 'Range type not found' });
    if (newRangeType.is_system && ['Network', 'Broadcast', 'Gateway'].includes(newRangeType.name)) {
      return res.status(400).json({ error: `Cannot change a range to system type ${newRangeType.name}` });
    }
  }

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

  const updated = Range.updateRange(db, range, {
    rangeTypeId: range_type_id,
    startIp: newStart,
    endIp: newEnd,
    description
  });

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

  // Refuse deletion if a DHCP scope is attached to this range. The FK is
  // ON DELETE SET NULL, so a blind delete would leave dhcp_scopes with
  // range_id=NULL — a ghost row no UI surfaces but which breaks future
  // scope creation on the same subnet. Force the user to delete the scope
  // first.
  const attachedScope = db.prepare(
    'SELECT id FROM dhcp_scopes WHERE range_id = ?'
  ).get(range.id);
  if (attachedScope) {
    return res.status(409).json({
      error: 'This range has a DHCP scope attached. Delete the scope first, then remove the range.',
      dhcp_scope_id: attachedScope.id
    });
  }

  Range.deleteRange(db, range.id);
  audit(req.user.id, 'range_deleted', 'range', range.id, { subnet_id: req.params.subnetId, type: rangeType?.name });
  res.json({ message: 'Range deleted' });
});

export default router;
