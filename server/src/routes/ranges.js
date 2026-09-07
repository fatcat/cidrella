import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { ipToLong, isIpInSubnet, isValidIpv4, rangesOverlap, validateDisplayString } from '../utils/ip.js';
import * as Range from '../models/range.js';
import { dynamicPoolConflict } from '../models/dhcp-scope.js';

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

  // v0.4.15: type-guard before any string operation, non-string IPs caused
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

  if (rangeType.name === 'DHCP Scope') {
    const conflict = dynamicPoolConflict(db, subnet, start_ip, end_ip);
    if (conflict) {
      return res.status(409).json({
        error: conflict.error,
        conflict_type: conflict.type,
        ip_address: conflict.ip_address
      });
    }
  }

  // Custom Network Range Types are an organizational layer. They cannot
  // overlap each other, but they may coexist with functional system ranges
  // such as DHCP scopes and gateway markers.
  const selection = [{ start: ipToLong(start_ip), end: ipToLong(end_ip) }];
  const existingRanges = rangeType.is_system
    ? db.prepare(`
        SELECT r.* FROM ranges r
        JOIN range_types rt ON rt.id = r.range_type_id
        WHERE r.subnet_id = ? AND rt.is_system = 1
      `).all(subnetId)
    : Range.listCustomRangeOverlaps(db, subnetId, selection);
  const overlaps = rangeType.is_system
    ? existingRanges.filter(r => rangesOverlap(start_ip, end_ip, r.start_ip, r.end_ip))
    : existingRanges;

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

  const range = !rangeType.is_system && overlaps.length > 0
    ? Range.assignCustomRangeType(db, {
        subnetId,
        rangeTypeId: range_type_id,
        selections: selection,
        description
      }).created[0]
    : Range.createRange(db, {
        subnetId,
        rangeTypeId: range_type_id,
        startIp: start_ip,
        endIp: end_ip,
        description
      });

  audit(req.user.id, 'range_created', 'range', range.id, { subnet_id: subnetId, start_ip, end_ip, type: rangeType.name });
  res.status(201).json(range);
});

// PUT /api/subnets/:subnetId/ranges/set-type
// Assign a custom Network Range Type to one or more grid selections. Custom
// classifications are non-overlapping; accepting a conflict replaces only the
// selected portion and preserves the unaffected fragments on either side.
router.put('/set-type', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const subnetId = req.params.subnetId;
  const body = req.body || {};
  const { range_type_id, ranges: requestedRanges, accept_overlaps = false } = body;

  if (!Number.isInteger(range_type_id)) {
    return res.status(400).json({ error: 'range_type_id must be an integer' });
  }
  if (!Array.isArray(requestedRanges) || requestedRanges.length === 0) {
    return res.status(400).json({ error: 'ranges must be a non-empty array' });
  }
  if (requestedRanges.length > 1024) {
    return res.status(400).json({ error: 'ranges cannot contain more than 1024 selections' });
  }
  if (typeof accept_overlaps !== 'boolean') {
    return res.status(400).json({ error: 'accept_overlaps must be a boolean' });
  }

  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const rangeType = db.prepare('SELECT * FROM range_types WHERE id = ?').get(range_type_id);
  if (!rangeType) return res.status(404).json({ error: 'Network range type not found' });
  if (rangeType.is_system) {
    return res.status(400).json({ error: 'Set Range Type accepts custom Network Range Types only' });
  }

  const selections = [];
  for (const requested of requestedRanges) {
    const startIp = requested?.start_ip;
    const endIp = requested?.end_ip;
    if (typeof startIp !== 'string' || typeof endIp !== 'string'
        || !isValidIpv4(startIp) || !isValidIpv4(endIp)) {
      return res.status(400).json({ error: 'Every range needs valid IPv4 start_ip and end_ip values' });
    }
    if (!isIpInSubnet(startIp, subnet.cidr) || !isIpInSubnet(endIp, subnet.cidr)) {
      return res.status(400).json({ error: 'Every IP range must be within the subnet' });
    }
    const start = ipToLong(startIp);
    const end = ipToLong(endIp);
    if (start > end) {
      return res.status(400).json({ error: 'Every Start IP must be less than or equal to its End IP' });
    }
    selections.push({ start, end });
  }

  // Merge touching selections from Ctrl/Command multi-select into the smallest
  // possible set of stored rows.
  selections.sort((a, b) => a.start - b.start || a.end - b.end);
  const mergedSelections = [];
  for (const selection of selections) {
    const previous = mergedSelections.at(-1);
    if (previous && selection.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, selection.end);
    } else {
      mergedSelections.push({ ...selection });
    }
  }

  const overlaps = Range.listCustomRangeOverlaps(db, subnetId, mergedSelections);
  if (overlaps.length > 0 && !accept_overlaps) {
    return res.status(409).json({
      error: 'Selection overlaps existing Network Range Types',
      overlaps: overlaps.map(range => ({
        id: range.id,
        type: range.range_type_name,
        start_ip: range.start_ip,
        end_ip: range.end_ip
      })),
      can_accept: true
    });
  }

  const result = Range.assignCustomRangeType(db, {
    subnetId,
    rangeTypeId: range_type_id,
    selections: mergedSelections
  });

  audit(req.user.id, 'network_range_type_set', 'subnet', Number(subnetId), {
    range_type_id,
    ranges: requestedRanges,
    replaced_range_ids: result.replaced.map(range => range.id)
  });
  return res.json(result);
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
  let newRangeType = null;
  if (range_type_id !== undefined) {
    newRangeType = db.prepare('SELECT * FROM range_types WHERE id = ?').get(range_type_id);
    if (!newRangeType) return res.status(404).json({ error: 'Range type not found' });
    if (newRangeType.is_system && ['Network', 'Broadcast', 'Gateway'].includes(newRangeType.name)) {
      return res.status(400).json({ error: `Cannot change a range to system type ${newRangeType.name}` });
    }
    if (!!newRangeType.is_system !== !!rangeType?.is_system) {
      return res.status(400).json({
        error: 'Cannot change between functional system ranges and organizational Network Range Types'
      });
    }
  }
  const effectiveRangeType = newRangeType || rangeType;

  // Validate IPs within subnet
  if (!isIpInSubnet(newStart, subnet.cidr) || !isIpInSubnet(newEnd, subnet.cidr)) {
    return res.status(400).json({ error: 'IP range must be within the subnet' });
  }

  if (ipToLong(newStart) > ipToLong(newEnd)) {
    return res.status(400).json({ error: 'Start IP must be less than or equal to end IP' });
  }

  // This row may be what dnsmasq serves as a dhcp-range. Guard on the
  // authoritative signal, an attached scope, rather than only on the type
  // name, plus the effective type for a range being retyped into a pool.
  const attachedScope = db.prepare('SELECT id, enabled FROM dhcp_scopes WHERE range_id = ?').get(range.id);
  const effectiveTypeId = range_type_id ?? range.range_type_id;
  const effectiveType = db.prepare('SELECT name FROM range_types WHERE id = ?').get(effectiveTypeId);
  if ((attachedScope?.enabled) || (!attachedScope && effectiveType?.name === 'DHCP Scope')) {
    const conflict = dynamicPoolConflict(db, subnet, newStart, newEnd);
    if (conflict) {
      return res.status(409).json({
        error: conflict.error,
        conflict_type: conflict.type,
        ip_address: conflict.ip_address
      });
    }
  }

  // Custom classifications only conflict with other custom classifications.
  // Functional system ranges are a separate layer and do not affect the tag.
  const selection = [{ start: ipToLong(newStart), end: ipToLong(newEnd) }];
  const existingRanges = effectiveRangeType.is_system
    ? db.prepare(`
        SELECT r.* FROM ranges r
        JOIN range_types rt ON rt.id = r.range_type_id
        WHERE r.subnet_id = ? AND r.id != ? AND rt.is_system = 1
      `).all(req.params.subnetId, range.id)
    : Range.listCustomRangeOverlaps(db, req.params.subnetId, selection, { excludeRangeId: range.id });
  const overlaps = effectiveRangeType.is_system
    ? existingRanges.filter(r => rangesOverlap(newStart, newEnd, r.start_ip, r.end_ip))
    : existingRanges;

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

  const updated = !effectiveRangeType.is_system && overlaps.length > 0
    ? Range.assignCustomRangeType(db, {
        subnetId: req.params.subnetId,
        rangeTypeId: effectiveTypeId,
        selections: selection,
        description: description !== undefined ? description : range.description,
        excludeRangeId: range.id
      }).created[0]
    : Range.updateRange(db, range, {
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
  // range_id=NULL, a ghost row no UI surfaces but which breaks future
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
