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
    where.push('a.action = ?');
    params.push(req.query.action);
  }
  if (req.query.entity_type) {
    where.push('a.entity_type = ?');
    params.push(req.query.entity_type);
  }
  if (req.query.user_id) {
    where.push('a.user_id = ?');
    params.push(parseInt(req.query.user_id, 10));
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

export default router;
