import { Router } from 'express';
import { getDb } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';

const router = Router();

// GET /api/audit — paginated audit log (admin only)
router.get('/', (req, res) => {
  if (!hasPermission(req.user.role, '*')) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const offset = (page - 1) * limit;

  let where = [];
  let params = [];

  if (req.query.action) {
    const actions = req.query.action.split(',').map(a => a.trim()).filter(Boolean);
    if (actions.length === 1) {
      where.push('a.action = ?');
      params.push(actions[0]);
    } else if (actions.length > 1) {
      where.push(`a.action IN (${actions.map(() => '?').join(',')})`);
      params.push(...actions);
    }
  }
  if (req.query.entity_type) {
    const entities = req.query.entity_type.split(',').map(e => e.trim()).filter(Boolean);
    if (entities.length === 1) {
      where.push('a.entity_type = ?');
      params.push(entities[0]);
    } else if (entities.length > 1) {
      where.push(`a.entity_type IN (${entities.map(() => '?').join(',')})`);
      params.push(...entities);
    }
  }
  if (req.query.user_id) {
    const userId = parseInt(req.query.user_id, 10);
    if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user_id' });
    where.push('a.user_id = ?');
    params.push(userId);
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as c FROM audit_log a ${whereClause}`).get(...params).c;

  const items = db.prepare(`
    SELECT a.*, u.username
    FROM audit_log a
    LEFT JOIN users u ON a.user_id = u.id
    ${whereClause}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  // Parse details JSON
  for (const item of items) {
    if (item.details) {
      try { item.details = JSON.parse(item.details); } catch { /* keep as string */ }
    }
  }

  res.json({ items, total, page, limit });
});

// GET /api/audit/actions — list distinct action types
router.get('/actions', (req, res) => {
  if (!hasPermission(req.user.role, '*')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const actions = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all();
  res.json(actions.map(a => a.action));
});

// GET /api/audit/entities — list distinct entity types
router.get('/entities', (req, res) => {
  if (!hasPermission(req.user.role, '*')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const db = getDb();
  const entities = db.prepare('SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type').all();
  res.json(entities.map(e => e.entity_type));
});

export default router;
