import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import { regenerateDnsmasqConf, signalDnsmasq } from '../utils/dnsmasq.js';
import {
  getProxyStatus, startProxy, stopProxy, loadMmdb,
  downloadMmdb, resetStats
} from '../utils/dns-proxy.js';

const router = Router();

function requirePerm(permission) {
  return (req, res, next) => {
    if (!req.user || !hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// GET /api/geoip/status
router.get('/status', requirePerm('dns:read'), (req, res) => {
  const db = getDb();
  const status = getProxyStatus();
  const mode = db.prepare("SELECT value FROM settings WHERE key = 'geoip_mode'").get();
  const enabled = db.prepare("SELECT value FROM settings WHERE key = 'geoip_enabled'").get();
  const updateSchedule = db.prepare("SELECT value FROM settings WHERE key = 'geoip_update_schedule'").get();
  const configuredPort = db.prepare("SELECT value FROM settings WHERE key = 'geoip_proxy_port'").get();
  const ruleCount = db.prepare('SELECT COUNT(*) as c FROM geoip_rules WHERE enabled = 1').get().c;

  res.json({
    ...status,
    port: parseInt(configuredPort?.value, 10) || status.port || 5353,
    enabled: enabled?.value === 'true',
    mode: mode?.value || 'blocklist',
    updateSchedule: updateSchedule?.value || 'monthly',
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
  const added = [];

  db.transaction(() => {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO geoip_rules (country_code, country_name) VALUES (?, ?)'
    );
    for (const c of countries) {
      if (!c.code || !CC_RE.test(c.code)) continue;
      const result = insert.run(c.code, c.name || c.code);
      if (result.changes > 0) {
        added.push(c.code);
      }
    }
  })();

  if (added.length > 0) {
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
  audit(req.user.id, 'update', 'geoip_rule', rule.id, { country_code: rule.country_code, enabled });
  res.json({ ok: true });
});

// DELETE /api/geoip/rules/:id
router.delete('/rules/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const rule = db.prepare('SELECT * FROM geoip_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  db.prepare('DELETE FROM geoip_rules WHERE id = ?').run(rule.id);
  audit(req.user.id, 'delete', 'geoip_rule', rule.id, { country_code: rule.country_code });
  res.json({ ok: true });
});

// PUT /api/geoip/settings — update GeoIP settings
router.put('/settings', requirePerm('dns:write'), async (req, res) => {
  const db = getDb();
  const { geoip_enabled, geoip_mode, geoip_proxy_port, geoip_update_schedule } = req.body;

  if (geoip_mode !== undefined && !['blocklist', 'allowlist'].includes(geoip_mode)) {
    return res.status(400).json({ error: 'Mode must be blocklist or allowlist' });
  }

  if (geoip_proxy_port !== undefined) {
    const port = parseInt(geoip_proxy_port, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      return res.status(400).json({ error: 'Port must be between 1024 and 65535' });
    }
  }

  if (geoip_update_schedule !== undefined && !['off', 'weekly', 'biweekly', 'monthly'].includes(geoip_update_schedule)) {
    return res.status(400).json({ error: 'Update schedule must be off, weekly, biweekly, or monthly' });
  }

  const wasEnabled = db.prepare("SELECT value FROM settings WHERE key = 'geoip_enabled'").get()?.value === 'true';
  const oldPort = db.prepare("SELECT value FROM settings WHERE key = 'geoip_proxy_port'").get()?.value;

  // Update settings
  if (geoip_mode !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('geoip_mode', ?)").run(geoip_mode);
  }
  if (geoip_proxy_port !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('geoip_proxy_port', ?)").run(String(geoip_proxy_port));
  }
  if (geoip_update_schedule !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('geoip_update_schedule', ?)").run(geoip_update_schedule);
  }

  const nowEnabled = geoip_enabled !== undefined ? geoip_enabled : wasEnabled;
  if (geoip_enabled !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('geoip_enabled', ?)").run(nowEnabled ? 'true' : 'false');
  }

  const newPort = geoip_proxy_port !== undefined ? String(geoip_proxy_port) : oldPort;

  // Handle proxy start/stop/restart
  try {
    if (!nowEnabled && wasEnabled) {
      // Disabling
      stopProxy();
    } else if (nowEnabled) {
      const proxyRunning = getProxyStatus().running;
      const portChanged = geoip_proxy_port !== undefined && String(geoip_proxy_port) !== oldPort;

      if (!proxyRunning || !wasEnabled || portChanged) {
        // Start or restart: enabling, recovering from crash, or port changed
        stopProxy();
        await loadMmdb();
        startProxy(parseInt(newPort, 10));
      }
    }

    // Regenerate dnsmasq config to route through proxy or direct upstream
    regenerateDnsmasqConf(db);
    signalDnsmasq();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update proxy: ' + err.message });
  }

  audit(req.user.id, 'update', 'geoip_settings', null, {
    geoip_enabled: nowEnabled, geoip_mode, geoip_proxy_port: newPort
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
