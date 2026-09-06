import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { validateDisplayString } from '../utils/ip.js';
import * as RangeType from '../models/range-type.js';

const router = Router();

// Hex color regex, #RGB or #RRGGBB. Refuses arbitrary strings like
// "red; background: url(javascript:...)" that could leak into inline
// style attributes in the UI (no v-html exists today, but keep it clean).
const COLOR_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

// GET /api/range-types
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const types = db.prepare('SELECT * FROM range_types ORDER BY is_system DESC, name').all();
  res.json(types);
});

// POST /api/range-types
router.post('/', requirePerm('subnets:write'), (req, res) => {
  const body = req.body || {};
  const { name, color, description } = body;

  if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'Name is required' });
  const nameErr = validateDisplayString(name, { maxLength: 64, allowEmpty: false });
  if (nameErr) return res.status(400).json({ error: `name ${nameErr}` });
  if (color !== undefined && color !== null) {
    if (typeof color !== 'string' || !COLOR_RE.test(color)) {
      return res.status(400).json({ error: 'color must be a hex code like "#aabbcc"' });
    }
  }
  if (description !== undefined) {
    const derr = validateDisplayString(description, { maxLength: 1024 });
    if (derr) return res.status(400).json({ error: `description ${derr}` });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM range_types WHERE name = ?').get(name);
  if (existing) return res.status(409).json({ error: 'Network Range Type already exists' });

  const type = RangeType.createRangeType(db, {
    name,
    color,
    description,
    isSystem: false
  });
  audit(req.user.id, 'range_type_created', 'range_type', type.id, { name });
  res.status(201).json(type);
});

// PUT /api/range-types/:id
router.put('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const type = db.prepare('SELECT * FROM range_types WHERE id = ?').get(req.params.id);
  if (!type) return res.status(404).json({ error: 'Range type not found' });
  if (type.is_system) return res.status(403).json({ error: 'Cannot modify functional system range types' });

  const body = req.body || {};
  const { name, color, description } = body;

  if (name !== undefined) {
    if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'Name must be a non-empty string' });
    const nameErr = validateDisplayString(name, { maxLength: 64, allowEmpty: false });
    if (nameErr) return res.status(400).json({ error: `name ${nameErr}` });
  }
  if (color !== undefined && color !== null) {
    if (typeof color !== 'string' || !COLOR_RE.test(color)) {
      return res.status(400).json({ error: 'color must be a hex code like "#aabbcc"' });
    }
  }
  if (description !== undefined) {
    const derr = validateDisplayString(description, { maxLength: 1024 });
    if (derr) return res.status(400).json({ error: `description ${derr}` });
  }

  if (name && name !== type.name) {
    const dup = db.prepare('SELECT id FROM range_types WHERE name = ? AND id != ?').get(name, type.id);
    if (dup) return res.status(409).json({ error: 'Network Range Type name already exists' });
  }

  const updated = RangeType.updateRangeType(db, type, { name, color, description });
  audit(req.user.id, 'range_type_updated', 'range_type', type.id, { changes: req.body });
  res.json(updated);
});

// DELETE /api/range-types/:id
router.delete('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const type = db.prepare('SELECT * FROM range_types WHERE id = ?').get(req.params.id);
  if (!type) return res.status(404).json({ error: 'Network Range Type not found' });
  if (type.is_system) return res.status(403).json({ error: 'Cannot delete functional system range types' });

  // Check if in use
  const usageCount = db.prepare('SELECT COUNT(*) as count FROM ranges WHERE range_type_id = ?').get(type.id);
  if (usageCount.count > 0) {
    return res.status(409).json({ error: `Network Range Type is in use by ${usageCount.count} range(s)` });
  }

  RangeType.deleteRangeType(db, type.id);
  audit(req.user.id, 'range_type_deleted', 'range_type', type.id, { name: type.name });
  res.json({ message: 'Range type deleted' });
});

export default router;
