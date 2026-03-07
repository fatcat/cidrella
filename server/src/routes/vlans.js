import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';

const router = Router();

function requirePerm(permission) {
  return (req, res, next) => {
    if (!req.user || !hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// GET /api/vlans — list VLANs, optionally filtered by folder_id
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const { folder_id } = req.query;

  let sql = `
    SELECT v.*, f.name as folder_name,
      (SELECT COUNT(*) FROM subnets WHERE vlan_id = v.vlan_id AND folder_id = v.folder_id) as subnet_count
    FROM vlans v
    JOIN folders f ON f.id = v.folder_id
  `;
  const params = [];
  if (folder_id) {
    sql += ' WHERE v.folder_id = ?';
    params.push(folder_id);
  }
  sql += ' ORDER BY v.folder_id, v.vlan_id';

  res.json(db.prepare(sql).all(...params));
});

// GET /api/vlans/search — search VLANs for autocomplete
router.get('/search', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const { folder_id, q } = req.query;
  if (!folder_id) return res.status(400).json({ error: 'folder_id is required' });

  const escaped = (q || '').trim().replace(/[%_]/g, '\\$&');
  const term = `%${escaped}%`;
  const vlans = db.prepare(`
    SELECT v.*, f.name as folder_name,
      (SELECT COUNT(*) FROM subnets WHERE vlan_id = v.vlan_id AND folder_id = v.folder_id) as subnet_count
    FROM vlans v
    JOIN folders f ON f.id = v.folder_id
    WHERE v.folder_id = ? AND (v.name LIKE ? ESCAPE '\\' OR CAST(v.vlan_id AS TEXT) LIKE ? ESCAPE '\\')
    ORDER BY v.vlan_id
    LIMIT 20
  `).all(folder_id, term, term);

  res.json(vlans);
});

// POST /api/vlans — create VLAN
router.post('/', requirePerm('subnets:write'), (req, res) => {
  const { folder_id, vlan_id, name } = req.body;
  if (!folder_id) return res.status(400).json({ error: 'Organization is required' });
  if (!vlan_id || vlan_id < 1 || vlan_id > 4094) return res.status(400).json({ error: 'VLAN ID must be between 1 and 4094' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const db = getDb();
  const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folder_id);
  if (!folder) return res.status(404).json({ error: 'Organization not found' });

  const existing = db.prepare('SELECT id FROM vlans WHERE folder_id = ? AND vlan_id = ?').get(folder_id, vlan_id);
  if (existing) return res.status(409).json({ error: `VLAN ${vlan_id} already exists in this organization` });

  try {
    const result = db.prepare(
      'INSERT INTO vlans (folder_id, vlan_id, name) VALUES (?, ?, ?)'
    ).run(folder_id, vlan_id, name.trim());

    audit(req.user.id, 'vlan_created', 'vlan', result.lastInsertRowid, { folder_id, vlan_id, name: name.trim() });
    const vlan = db.prepare('SELECT * FROM vlans WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(vlan);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// PUT /api/vlans/:id — update VLAN
router.put('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const vlan = db.prepare('SELECT * FROM vlans WHERE id = ?').get(req.params.id);
  if (!vlan) return res.status(404).json({ error: 'VLAN not found' });

  const { vlan_id, name } = req.body;
  if (vlan_id !== undefined && (vlan_id < 1 || vlan_id > 4094)) {
    return res.status(400).json({ error: 'VLAN ID must be between 1 and 4094' });
  }

  const newVlanId = vlan_id !== undefined ? vlan_id : vlan.vlan_id;
  const newName = name !== undefined ? name.trim() : vlan.name;

  if (newVlanId !== vlan.vlan_id) {
    const dup = db.prepare('SELECT id FROM vlans WHERE folder_id = ? AND vlan_id = ? AND id != ?').get(vlan.folder_id, newVlanId, vlan.id);
    if (dup) return res.status(409).json({ error: `VLAN ${newVlanId} already exists in this organization` });
  }

  db.prepare('UPDATE vlans SET vlan_id = ?, name = ? WHERE id = ?').run(newVlanId, newName, vlan.id);
  audit(req.user.id, 'vlan_updated', 'vlan', vlan.id, { vlan_id: newVlanId, name: newName });
  const updated = db.prepare('SELECT * FROM vlans WHERE id = ?').get(vlan.id);
  res.json(updated);
});

// DELETE /api/vlans/:id — delete VLAN
router.delete('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const vlan = db.prepare('SELECT * FROM vlans WHERE id = ?').get(req.params.id);
  if (!vlan) return res.status(404).json({ error: 'VLAN not found' });

  db.prepare('DELETE FROM vlans WHERE id = ?').run(vlan.id);
  audit(req.user.id, 'vlan_deleted', 'vlan', vlan.id, { vlan_id: vlan.vlan_id, name: vlan.name });
  res.json({ ok: true });
});

export default router;
