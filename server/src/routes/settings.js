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

// Keys that should never be exposed via API
const SECRET_KEYS = new Set(['jwt_secret']);

// Keys that are allowed to be updated
const EDITABLE_KEYS = new Set(['default_gateway_position', 'subnet_name_template', 'dns_upstream_servers']);

// GET /api/settings — return all non-secret settings
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    if (!SECRET_KEYS.has(row.key)) {
      settings[row.key] = row.value;
    }
  }
  res.json(settings);
});

// PUT /api/settings/:key — update a setting
router.put('/:key', requirePerm('subnets:write'), (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  if (!EDITABLE_KEYS.has(key)) {
    return res.status(400).json({ error: `Setting '${key}' cannot be modified` });
  }

  if (value === undefined || value === null) {
    return res.status(400).json({ error: 'Value is required' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (existing) {
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(String(value), key);
  } else {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
  }

  audit(req.user.id, 'setting_updated', 'setting', null, { key, value: String(value) });
  res.json({ key, value: String(value) });
});

export default router;
