import { Router } from 'express';
import { getDb, getSetting, setSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import {
  getProxyStatus, loadMmdb, loadGeoipRules,
  downloadMmdb, resetStats
} from '../utils/dns-proxy.js';

const router = Router();

// GET /api/geoip/status
router.get('/status', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const status = getProxyStatus();
  const mode = getSetting('geoip_mode');
  const enabled = getSetting('geoip_enabled');
  const updateSchedule = getSetting('geoip_update_schedule');
  const ruleCount = db.prepare('SELECT COUNT(*) as c FROM geoip_rules WHERE enabled = 1').get().c;

  res.json({
    ...status,
    enabled: enabled === 'true',
    mode: mode || 'blocklist',
    updateSchedule: updateSchedule || 'monthly',
    ruleCount
  });
});

// GET /api/geoip/rules
router.get('/rules', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const rules = db.prepare('SELECT * FROM geoip_rules ORDER BY country_name').all();
  res.json(rules);
});

// POST /api/geoip/rules — add one or more country rules
router.post('/rules', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const { countries } = req.body;

  if (!countries || !Array.isArray(countries) || countries.length === 0) {
    return res.status(400).json({ error: 'countries array is required' });
  }

  const CC_RE = /^[A-Z]{2}$/;

  // Validate all country codes before inserting
  const invalid = countries.filter(c => !c.code || !CC_RE.test(c.code));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Invalid country codes: ${invalid.map(c => c.code || '(empty)').join(', ')}` });
  }

  // Check for duplicates
  const existing = countries.filter(c => {
    return db.prepare('SELECT id FROM geoip_rules WHERE country_code = ?').get(c.code);
  });
  if (existing.length > 0 && existing.length === countries.length) {
    return res.status(409).json({ error: `All specified country rules already exist: ${existing.map(c => c.code).join(', ')}` });
  }

  const added = [];

  db.transaction(() => {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO geoip_rules (country_code, country_name) VALUES (?, ?)'
    );
    for (const c of countries) {
      const result = insert.run(c.code, c.name || c.code);
      if (result.changes > 0) {
        added.push(c.code);
      }
    }
  })();

  if (added.length > 0) {
    loadGeoipRules();
    audit(req.user.id, 'create', 'geoip_rules', null, { countries: added });
  }

  res.status(201).json({ added });
});

// PUT /api/geoip/rules/:id — toggle enabled
router.put('/rules/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const rule = db.prepare('SELECT * FROM geoip_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  const { enabled } = req.body;
  if (enabled === undefined) return res.status(400).json({ error: 'enabled field is required' });

  db.prepare('UPDATE geoip_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, rule.id);
  loadGeoipRules();
  audit(req.user.id, 'update', 'geoip_rule', rule.id, { country_code: rule.country_code, enabled });
  res.json({ ok: true });
});

// DELETE /api/geoip/rules/:id
router.delete('/rules/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const rule = db.prepare('SELECT * FROM geoip_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  db.prepare('DELETE FROM geoip_rules WHERE id = ?').run(rule.id);
  loadGeoipRules();
  audit(req.user.id, 'delete', 'geoip_rule', rule.id, { country_code: rule.country_code });
  res.json({ ok: true });
});

// PUT /api/geoip/settings — update GeoIP settings
router.put('/settings', requirePerm('dns:write'), async (req, res) => {
  const db = getDb();
  const { geoip_enabled, geoip_mode, geoip_update_schedule } = req.body;

  if (geoip_enabled !== undefined && typeof geoip_enabled !== 'boolean') {
    return res.status(400).json({ error: 'geoip_enabled must be a boolean' });
  }

  if (geoip_mode !== undefined && !['blocklist', 'allowlist'].includes(geoip_mode)) {
    return res.status(400).json({ error: 'Mode must be blocklist or allowlist' });
  }

  if (geoip_update_schedule !== undefined && !['off', 'weekly', 'biweekly', 'monthly'].includes(geoip_update_schedule)) {
    return res.status(400).json({ error: 'Update schedule must be off, weekly, biweekly, or monthly' });
  }

  const wasEnabled = getSetting('geoip_enabled') === 'true';

  // Update settings
  if (geoip_mode !== undefined) {
    setSetting('geoip_mode', geoip_mode);
  }
  if (geoip_update_schedule !== undefined) {
    setSetting('geoip_update_schedule', geoip_update_schedule);
  }

  const nowEnabled = geoip_enabled !== undefined ? geoip_enabled : wasEnabled;
  if (geoip_enabled !== undefined) {
    setSetting('geoip_enabled', nowEnabled ? 'true' : 'false');
  }

  // Proxy always runs — just load/unload MMDB data and refresh rule cache
  try {
    loadGeoipRules();
    if (nowEnabled && !wasEnabled) {
      await loadMmdb();
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load GeoIP database: ' + err.message });
  }

  audit(req.user.id, 'update', 'geoip_settings', null, {
    geoip_enabled: nowEnabled, geoip_mode
  });

  res.json({ ok: true });
});

// POST /api/geoip/db/refresh — manual MMDB download
router.post('/db/refresh', requirePerm('dns:write'), async (req, res) => {
  try {
    await downloadMmdb();
    const status = getProxyStatus();
    audit(req.user.id, 'update', 'geoip_db', null, { action: 'refresh' });
    res.json({ ok: true, dbLastUpdated: status.dbLastUpdated, dbLoaded: status.dbLoaded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/geoip/stats
router.get('/stats', requirePerm('dns:read'), (req, res) => {
  const status = getProxyStatus();
  res.json({
    total: status.statsTotal,
    blocked: status.statsBlocked,
    allowed: status.statsAllowed
  });
});

// POST /api/geoip/stats/reset
router.post('/stats/reset', requirePerm('dns:write'), (req, res) => {
  resetStats();
  res.json({ ok: true });
});

export default router;
