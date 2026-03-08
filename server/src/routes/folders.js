import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import {
  isValidCidr, normalizeCidr, validateSupernet, cidrsOverlap, parseCidr, applyNameTemplate
} from '../utils/ip.js';
import { regenerateConfigs } from '../utils/dnsmasq.js';

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

// POST /api/folders — create organization (folder + optional supernet)
router.post('/', requirePerm('subnets:write'), (req, res) => {
  const { name, description, cidr } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const db = getDb();

  // Validate CIDR if provided
  let normalized = null;
  if (cidr) {
    if (!isValidCidr(cidr)) return res.status(400).json({ error: 'Invalid CIDR notation' });
    normalized = normalizeCidr(cidr);

    const existing = db.prepare('SELECT id FROM subnets WHERE cidr = ?').get(normalized);
    if (existing) return res.status(409).json({ error: 'Subnet already exists' });

    const validation = validateSupernet(normalized);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    const roots = db.prepare('SELECT cidr FROM subnets WHERE parent_id IS NULL').all();
    for (const root of roots) {
      if (cidrsOverlap(normalized, root.cidr)) {
        return res.status(409).json({ error: `Overlaps with existing supernet ${root.cidr}` });
      }
    }
  }

  try {
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM folders').get();
  const sortOrder = (maxOrder?.m ?? -1) + 1;

  const txn = db.transaction(() => {
    const folderResult = db.prepare(
      'INSERT INTO folders (name, description, sort_order) VALUES (?, ?, ?)'
    ).run(name.trim(), description || null, sortOrder);
    const folderId = folderResult.lastInsertRowid;

    let subnet = null;
    if (normalized) {
      const templateRow = db.prepare("SELECT value FROM settings WHERE key = 'subnet_name_template'").get();
      const template = templateRow?.value || '%1.%2.%3.%4/%bitmask';
      const subnetName = applyNameTemplate(template, normalized);
      const parsed = parseCidr(normalized);

      const subnetResult = db.prepare(`
        INSERT INTO subnets (cidr, network_address, broadcast_address, prefix_length, total_addresses, name,
          parent_id, folder_id, status, depth)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'unallocated', 0)
      `).run(normalized, parsed.network, parsed.broadcast, parsed.prefix, parsed.totalAddresses, subnetName, folderId);

      subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetResult.lastInsertRowid);
      audit(req.user.id, 'subnet_created', 'subnet', subnet.id, { cidr: normalized });
    }

    audit(req.user.id, 'folder_created', 'folder', folderId, { name: name.trim(), cidr: normalized });
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
    return { folder, subnet };
  });

  const result = txn();
  res.status(201).json(result.folder);
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

// DELETE /api/folders/:id — delete folder (cascade with ?force=true)
router.delete('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });

  const subnetCount = db.prepare('SELECT COUNT(*) as c FROM subnets WHERE folder_id = ? AND parent_id IS NULL').get(folder.id).c;
  const zoneCount = db.prepare('SELECT COUNT(*) as c FROM dns_zones WHERE folder_id = ?').get(folder.id).c;

  if ((subnetCount > 0 || zoneCount > 0) && req.query.force !== 'true') {
    return res.status(400).json({
      error: 'Organization contains child resources. Use force delete to remove.',
      children: { subnets: subnetCount, zones: zoneCount }
    });
  }

  const doDelete = db.transaction(() => {
    // Delete subnets (children cascade via FK: ranges, IPs, DHCP, scans)
    if (subnetCount > 0) {
      db.prepare('DELETE FROM subnets WHERE folder_id = ? AND parent_id IS NULL').run(folder.id);
    }
    // Delete DNS zones (records cascade via FK)
    if (zoneCount > 0) {
      db.prepare('DELETE FROM dns_zones WHERE folder_id = ?').run(folder.id);
    }
    // VLANs cascade via FK ON DELETE CASCADE
    db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
  });
  doDelete();

  audit(req.user.id, 'folder_deleted', 'folder', folder.id, {
    name: folder.name, force: subnetCount > 0 || zoneCount > 0,
    deleted_subnets: subnetCount, deleted_zones: zoneCount
  });

  regenerateConfigs(db);
  res.json({ ok: true });
});

export default router;
