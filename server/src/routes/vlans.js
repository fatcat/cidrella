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

// GET /api/vlans — list all VLANs
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const vlans = db.prepare(`
    SELECT v.*,
      (SELECT COUNT(*) FROM subnets WHERE vlan_id = v.vlan_id) as subnet_count,
      (SELECT GROUP_CONCAT(COALESCE(name, cidr), ', ') FROM subnets WHERE vlan_id = v.vlan_id AND status = 'allocated') as subnet_names
    FROM vlans v
    ORDER BY v.vlan_id
  `).all();
  res.json(vlans);
});

// GET /api/vlans/search — search VLANs for autocomplete
router.get('/search', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const { q } = req.query;

  const escaped = (q || '').trim().replace(/[%_]/g, '\\$&');
  const term = `%${escaped}%`;
  const vlans = db.prepare(`
    SELECT v.*,
      (SELECT COUNT(*) FROM subnets WHERE vlan_id = v.vlan_id) as subnet_count
    FROM vlans v
    WHERE v.name LIKE ? ESCAPE '\\' OR CAST(v.vlan_id AS TEXT) LIKE ? ESCAPE '\\'
    ORDER BY v.vlan_id
    LIMIT 20
  `).all(term, term);

  res.json(vlans);
});

// POST /api/vlans — create VLAN
router.post('/', requirePerm('subnets:write'), (req, res) => {
  const { vlan_id, name, subnet_id } = req.body;
  if (!vlan_id || vlan_id < 1 || vlan_id > 4094) return res.status(400).json({ error: 'VLAN ID must be between 1 and 4094' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const db = getDb();

  const existing = db.prepare('SELECT id FROM vlans WHERE vlan_id = ?').get(vlan_id);
  if (existing) return res.status(409).json({ error: `VLAN ${vlan_id} already exists` });

  if (subnet_id) {
    const subnet = db.prepare('SELECT id, vlan_id FROM subnets WHERE id = ? AND status = ?').get(subnet_id, 'allocated');
    if (!subnet) return res.status(404).json({ error: 'Network not found' });
    if (subnet.vlan_id) return res.status(409).json({ error: 'Network already has a VLAN assigned' });
  }

  try {
    const create = db.transaction(() => {
      if (subnet_id) {
        const fresh = db.prepare('SELECT vlan_id FROM subnets WHERE id = ?').get(subnet_id);
        if (fresh?.vlan_id) throw new Error('Network already has a VLAN assigned');
      }

      const result = db.prepare(
        'INSERT INTO vlans (vlan_id, name) VALUES (?, ?)'
      ).run(vlan_id, name.trim());

      if (subnet_id) {
        db.prepare('UPDATE subnets SET vlan_id = ? WHERE id = ?').run(vlan_id, subnet_id);
      }

      return result;
    });
    const result = create();

    audit(req.user.id, 'vlan_created', 'vlan', result.lastInsertRowid, { vlan_id, name: name.trim(), subnet_id });
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
    const dup = db.prepare('SELECT id FROM vlans WHERE vlan_id = ? AND id != ?').get(newVlanId, vlan.id);
    if (dup) return res.status(409).json({ error: `VLAN ${newVlanId} already exists` });
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

  // Clear dangling vlan_id references in subnets
  db.prepare('UPDATE subnets SET vlan_id = NULL WHERE vlan_id = ?').run(vlan.vlan_id);
  db.prepare('DELETE FROM vlans WHERE id = ?').run(vlan.id);
  audit(req.user.id, 'vlan_deleted', 'vlan', vlan.id, { vlan_id: vlan.vlan_id, name: vlan.name });
  res.json({ ok: true });
});

export default router;
