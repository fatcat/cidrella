import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';

const router = Router();

function requirePerm(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// GET /api/range-types
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const types = db.prepare('SELECT * FROM range_types ORDER BY is_system DESC, name').all();
  res.json(types);
});

// POST /api/range-types
router.post('/', requirePerm('subnets:write'), (req, res) => {
  const { name, color, description } = req.body;

  if (!name) return res.status(400).json({ error: 'Name is required' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM range_types WHERE name = ?').get(name);
  if (existing) return res.status(409).json({ error: 'Range type already exists' });

  const result = db.prepare(
    'INSERT INTO range_types (name, color, is_system, description) VALUES (?, ?, 0, ?)'
  ).run(name, color || '#6b7280', description || null);

  const type = db.prepare('SELECT * FROM range_types WHERE id = ?').get(result.lastInsertRowid);
  audit(req.user.id, 'range_type_created', 'range_type', type.id, { name });
  res.status(201).json(type);
});

// PUT /api/range-types/:id
router.put('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const type = db.prepare('SELECT * FROM range_types WHERE id = ?').get(req.params.id);
  if (!type) return res.status(404).json({ error: 'Range type not found' });
  if (type.is_system) return res.status(403).json({ error: 'Cannot modify system address types' });

  const { name, color, description } = req.body;

  if (name && name !== type.name) {
    const dup = db.prepare('SELECT id FROM range_types WHERE name = ? AND id != ?').get(name, type.id);
    if (dup) return res.status(409).json({ error: 'Address type name already exists' });
  }

  db.prepare(`
    UPDATE range_types SET name = ?, color = ?, description = ?, updated_at = datetime('now') WHERE id = ?
  `).run(name ?? type.name, color ?? type.color, description !== undefined ? description : type.description, type.id);

  const updated = db.prepare('SELECT * FROM range_types WHERE id = ?').get(type.id);
  audit(req.user.id, 'range_type_updated', 'range_type', type.id, { changes: req.body });
  res.json(updated);
});

// DELETE /api/range-types/:id
router.delete('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const type = db.prepare('SELECT * FROM range_types WHERE id = ?').get(req.params.id);
  if (!type) return res.status(404).json({ error: 'Address type not found' });
  if (type.is_system) return res.status(403).json({ error: 'Cannot delete system address types' });

  // Check if in use
  const usageCount = db.prepare('SELECT COUNT(*) as count FROM ranges WHERE range_type_id = ?').get(type.id);
  if (usageCount.count > 0) {
    return res.status(409).json({ error: `Address type is in use by ${usageCount.count} range(s)` });
  }

  db.prepare('DELETE FROM range_types WHERE id = ?').run(type.id);
  audit(req.user.id, 'range_type_deleted', 'range_type', type.id, { name: type.name });
  res.json({ message: 'Range type deleted' });
});

export default router;
