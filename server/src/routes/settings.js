import { Router } from 'express';
import { getDb, setSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
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
    pruneEvents(db);
  }

  audit(req.user.id, 'setting_updated', 'setting', null, { key, value: String(value) });
  res.json({ key, value: String(value) });
});

export default router;
