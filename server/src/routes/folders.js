import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { validateDisplayString } from '../utils/ip.js';
import * as SubnetTopology from '../services/subnet-topology.js';
import * as Folder from '../models/folder.js';

const router = Router();

// GET /api/folders: list all folders with subnet counts
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  // Count every subnet explicitly tagged with this folder. Previously the
  // count only included roots (parent_id IS NULL); children with their own
  // folder_id are now first-class members of the folder in the tree view,
  // so they count too.
  const folders = db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM subnets WHERE folder_id = f.id) as subnet_count
    FROM folders f
    ORDER BY f.sort_order, f.name
  `).all();
  res.json(folders);
});

// POST /api/folders: create folder (grouping only)
router.post('/', requirePerm('subnets:write'), (req, res) => {
  const body = req.body || {};
  const { name, description } = body;
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  // v0.4.15: replace the old sanitizeName regex (which silently stripped
  // matched tag pairs but let unclosed `<` through) with explicit rejection
  // via validateDisplayString. Keeps behavior predictable and matches
  // the convention used by subnets / vlans / dns zones / dhcp scopes.
  const cleanName = name.trim();
  const nameErr = validateDisplayString(cleanName, { maxLength: 255, allowEmpty: false });
  if (nameErr) return res.status(400).json({ error: `name ${nameErr}` });

  if (description !== undefined) {
    const descErr = validateDisplayString(description, { maxLength: 1024 });
    if (descErr) return res.status(400).json({ error: `description ${descErr}` });
  }

  const db = getDb();
  // Let any DB error bubble through the asyncHandler path by returning next(err)
  // instead of a local 500 that leaked err.message, the global handler in
  // index.js collapses 5xx to a generic message.
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM folders').get();
  const sortOrder = (maxOrder?.m ?? -1) + 1;

  const folder = Folder.createFolder(db, { name: cleanName, description, sortOrder });

  audit(req.user.id, 'folder_created', 'folder', folder.id, { name: cleanName });
  res.status(201).json(folder);
});

// PUT /api/folders/:id: update folder
router.put('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });

  const body = req.body || {};
  const { name, description, sort_order } = body;

  let cleanName = folder.name;
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    cleanName = name.trim();
    const nameErr = validateDisplayString(cleanName, { maxLength: 255, allowEmpty: false });
    if (nameErr) return res.status(400).json({ error: `name ${nameErr}` });
  }

  if (description !== undefined && description !== null) {
    const descErr = validateDisplayString(description, { maxLength: 1024 });
    if (descErr) return res.status(400).json({ error: `description ${descErr}` });
  }

  if (sort_order !== undefined && !Number.isInteger(sort_order)) {
    return res.status(400).json({ error: 'sort_order must be an integer' });
  }

  const updated = Folder.updateFolder(db, folder, {
    name: cleanName,
    description,
    sortOrder: sort_order
  });

  audit(req.user.id, 'folder_updated', 'folder', folder.id, { name: cleanName });
  res.json(updated);
});

// DELETE /api/folders/:id: delete folder (ungroups children, does not delete them)
router.delete('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });

  const doDelete = db.transaction(() => {
    // Ungroup subnets, move to ungrouped
    SubnetTopology.clearFolderAssignments(db, folder.id);
    // Delete the folder itself
    Folder.deleteFolder(db, folder.id);
  });
  doDelete();

  audit(req.user.id, 'folder_deleted', 'folder', folder.id, { name: folder.name });
  res.json({ ok: true });
});

export default router;
