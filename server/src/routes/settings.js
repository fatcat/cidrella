import { Router } from 'express';
import { getDb, setSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { requireRole } from '../auth/roles.js';
import { pruneEvents } from '../models/ip-address.js';

const router = Router();

// Keys that should never be exposed via API
const SECRET_KEYS = new Set(['jwt_secret']);

// Keys that are allowed to be updated
const EDITABLE_KEYS = new Set(['default_gateway_position', 'subnet_name_template', 'dns_upstream_servers', 'backup_schedule', 'backup_retention_count', 'backup_last_run', 'geoip_enabled', 'geoip_mode', 'geoip_proxy_port', 'default_scan_interval', 'default_scan_enabled', 'setup_wizard_completed', 'interface_config', 'dns_enabled', 'dhcp_enabled', 'update_check_enabled', 'ip_history_retention_days']);

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

// PUT /api/settings/bulk — update multiple settings in one transaction (admin only)
router.put('/bulk', requireRole('admin'), (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return res.status(400).json({ error: 'settings object required' });
  }

  const entries = Object.entries(settings);
  const invalid = entries.filter(([key]) => !EDITABLE_KEYS.has(key));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Settings cannot be modified: ${invalid.map(([k]) => k).join(', ')}` });
  }

  const db = getDb();
  const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  const saveAll = db.transaction((pairs) => {
    for (const [key, value] of pairs) {
      stmt.run(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  });
  saveAll(entries);

  // Purge events if retention setting was included
  if (settings.ip_history_retention_days !== undefined) {
    pruneEvents(db);
  }

  audit(req.user.id, 'settings_bulk_updated', 'setting', null, { keys: entries.map(([k]) => k) });
  res.json({ ok: true });
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

  setSetting(key, value);

  // Immediately purge events when retention is changed
  if (key === 'ip_history_retention_days') {
    const db = getDb();
    pruneEvents(db);
  }

  audit(req.user.id, 'setting_updated', 'setting', null, { key, value: String(value) });
  res.json({ key, value: String(value) });
});

export default router;
