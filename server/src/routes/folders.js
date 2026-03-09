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

// GET /api/folders — list all folders with subnet counts
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const folders = db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM subnets WHERE folder_id = f.id AND parent_id IS NULL) as subnet_count
    FROM folders f
    ORDER BY f.sort_order, f.name
  `).all();
  res.json(folders);
});

// POST /api/folders — create folder (grouping only)
router.post('/', requirePerm('subnets:write'), (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const db = getDb();

  try {
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM folders').get();
    const sortOrder = (maxOrder?.m ?? -1) + 1;

    const result = db.prepare(
      'INSERT INTO folders (name, description, sort_order) VALUES (?, ?, ?)'
    ).run(name.trim(), description || null, sortOrder);

    audit(req.user.id, 'folder_created', 'folder', result.lastInsertRowid, { name: name.trim() });
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(folder);
  } catch (err) {
    console.error('Create folder error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// PUT /api/folders/:id — update folder
router.put('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });

  const { name, description, sort_order } = req.body;

  db.prepare(`
    UPDATE folders SET name = ?, description = ?, sort_order = ? WHERE id = ?
  `).run(
    name ?? folder.name,
    description !== undefined ? description : folder.description,
    sort_order !== undefined ? sort_order : folder.sort_order,
    folder.id
  );

  audit(req.user.id, 'folder_updated', 'folder', folder.id, { name: name ?? folder.name });
  const updated = db.prepare('SELECT * FROM folders WHERE id = ?').get(folder.id);
  res.json(updated);
});

// DELETE /api/folders/:id — delete folder (ungroups children, does not delete them)
router.delete('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });

  const doDelete = db.transaction(() => {
    // Ungroup subnets — move to ungrouped
    db.prepare('UPDATE subnets SET folder_id = NULL WHERE folder_id = ?').run(folder.id);
    // Ungroup DNS zones
    db.prepare('UPDATE dns_zones SET folder_id = NULL WHERE folder_id = ?').run(folder.id);
    // Ungroup VLANs
    db.prepare('UPDATE vlans SET folder_id = NULL WHERE folder_id = ?').run(folder.id);
    // Delete the folder itself
    db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
  });
  doDelete();

  audit(req.user.id, 'folder_deleted', 'folder', folder.id, { name: folder.name });
  res.json({ ok: true });
});

export default router;
