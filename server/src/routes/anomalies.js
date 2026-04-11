import { Router } from 'express';
import { getDb, getSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { requireRole } from '../auth/roles.js';
import { isValidIpv4 } from '../utils/ip.js';

const router = Router();

// ─── Hostname enrichment (shared with analytics) ────────
function enrichWithHostnames(rows) {
  const db = getDb();
  const ips = rows.map(r => r.client_ip);
  if (!ips.length) return rows;

  const placeholders = ips.map(() => '?').join(',');
  const ipRows = db.prepare(
    `SELECT ip_address, hostname FROM ip_addresses WHERE ip_address IN (${placeholders}) AND hostname IS NOT NULL`
  ).all(...ips);
  const leaseRows = db.prepare(
    `SELECT ip_address, hostname FROM dhcp_leases WHERE ip_address IN (${placeholders}) AND hostname IS NOT NULL`
  ).all(...ips);

  const hostMap = new Map();
  for (const r of leaseRows) hostMap.set(r.ip_address, r.hostname);
  for (const r of ipRows) hostMap.set(r.ip_address, r.hostname); // ip_addresses takes priority

  return rows.map(r => ({
    ...r,
    hostname: hostMap.get(r.client_ip) || null,
  }));
}

// GET /api/anomalies/active — active (unresolved) anomalies
router.get('/active', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();
  const { severity } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  let sql = `SELECT * FROM anomaly_scores WHERE is_anomaly = 1 AND resolved = 0`;
  const params = [];

  if (severity && ['low', 'medium', 'high'].includes(severity)) {
    sql += ` AND severity = ?`;
    params.push(severity);
  }

  sql += ` ORDER BY scored_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params).map(parseScoreRow);
  res.json(enrichWithHostnames(rows));
});

// GET /api/anomalies/summary — dashboard summary
router.get('/summary', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();

  const active = db.prepare(
    `SELECT severity, COUNT(*) as count FROM anomaly_scores
     WHERE is_anomaly = 1 AND resolved = 0
     GROUP BY severity`
  ).all();

  const totalActive = active.reduce((sum, r) => sum + r.count, 0);
  const bySeverity = {};
  for (const r of active) {
    bySeverity[r.severity || 'unknown'] = r.count;
  }

  const clientsMonitored = db.prepare(
    `SELECT COUNT(*) as count FROM anomaly_models WHERE status = 'active'`
  ).get()?.count || 0;
  const clientsLearning = db.prepare(
    `SELECT COUNT(*) as count FROM anomaly_models WHERE status = 'learning'`
  ).get()?.count || 0;

  const enabled = getSetting('anomaly_detection_enabled') === 'true';

  let daemon = null;
  try {
    const raw = getSetting('anomaly_daemon_status');
    if (raw) daemon = JSON.parse(raw);
  } catch { /* ignore parse errors */ }

  res.json({
    enabled,
    total_active: totalActive,
    by_severity: bySeverity,
    clients_monitored: clientsMonitored,
    clients_learning: clientsLearning,
    daemon,
  });
});

// GET /api/anomalies/client/:ip — anomaly history for a client
router.get('/client/:ip', requirePerm('analytics:read'), (req, res) => {
  const { ip } = req.params;
  if (!isValidIpv4(ip)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }

  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  const rows = db.prepare(
    `SELECT * FROM anomaly_scores
     WHERE client_ip = ?
     ORDER BY window_start DESC
     LIMIT ?`
  ).all(ip, limit);
  res.json(rows.map(parseScoreRow));
});

// GET /api/anomalies/client/:ip/model — model metadata
router.get('/client/:ip/model', requirePerm('analytics:read'), (req, res) => {
  const { ip } = req.params;
  if (!isValidIpv4(ip)) {
    return res.status(400).json({ error: 'Invalid IP address' });
  }

  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM anomaly_models WHERE client_ip = ?`
  ).get(ip);
  res.json(row || null);
});

// DELETE /api/anomalies/:id — delete an anomaly score
router.delete('/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }

  const result = db.prepare(`DELETE FROM anomaly_scores WHERE id = ?`).run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Anomaly not found' });
  }
  res.json({ ok: true });
});

// POST /api/anomalies/:id/dismiss — mark anomaly as resolved (kept for backwards compat)
router.post('/:id/dismiss', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }

  const result = db.prepare(
    `UPDATE anomaly_scores SET resolved = 1, resolved_at = datetime('now')
     WHERE id = ? AND resolved = 0`
  ).run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Anomaly not found or already resolved' });
  }
  res.json({ ok: true });
});

// ─── Whitelist CRUD ─────────────────────────────────────

// GET /api/anomalies/whitelist — list whitelisted clients
router.get('/whitelist', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM anomaly_whitelist ORDER BY whitelisted_at DESC').all();
  res.json(enrichWithHostnames(rows));
});

// POST /api/anomalies/whitelist — whitelist a client IP
router.post('/whitelist', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const { client_ip, reason } = req.body;

  if (!client_ip) return res.status(400).json({ error: 'client_ip is required' });
  if (!isValidIpv4(client_ip)) return res.status(400).json({ error: 'Invalid IP address' });

  const existing = db.prepare('SELECT id FROM anomaly_whitelist WHERE client_ip = ?').get(client_ip);
  if (existing) return res.status(409).json({ error: 'Already whitelisted' });

  const result = db.transaction(() => {
    const ins = db.prepare(
      'INSERT INTO anomaly_whitelist (client_ip, reason) VALUES (?, ?)'
    ).run(client_ip, reason || null);

    // Clean up: delete model and scores for this client
    db.prepare('DELETE FROM anomaly_models WHERE client_ip = ?').run(client_ip);
    db.prepare('DELETE FROM anomaly_scores WHERE client_ip = ?').run(client_ip);

    return ins;
  })();

  audit(req.user.id, 'anomaly_whitelist_add', 'anomaly_whitelist', result.lastInsertRowid, { client_ip, reason });
  res.status(201).json({ id: result.lastInsertRowid, ok: true });
});

// DELETE /api/anomalies/whitelist/:id — remove from whitelist
router.delete('/whitelist/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  const entry = db.prepare('SELECT * FROM anomaly_whitelist WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'Not found' });

  db.prepare('DELETE FROM anomaly_whitelist WHERE id = ?').run(id);
  audit(req.user.id, 'anomaly_whitelist_remove', 'anomaly_whitelist', id, { client_ip: entry.client_ip });
  res.json({ ok: true });
});

// GET /api/anomalies/settings — anomaly detection settings
router.get('/settings', requirePerm('analytics:read'), (req, res) => {
  res.json({
    anomaly_detection_enabled: getSetting('anomaly_detection_enabled') || 'false',
    anomaly_scoring_interval_min: getSetting('anomaly_scoring_interval_min') || '15',
    anomaly_training_interval_hours: getSetting('anomaly_training_interval_hours') || '6',
    anomaly_min_training_hours: getSetting('anomaly_min_training_hours') || '48',
    anomaly_sensitivity: getSetting('anomaly_sensitivity') || 'medium',
    anomaly_retention_days: getSetting('anomaly_retention_days') || '30',
  });
});

// PUT /api/anomalies/settings — update anomaly detection settings
router.put('/settings', requireRole('admin'), (req, res) => {
  const db = getDb();
  const allowedKeys = [
    'anomaly_detection_enabled',
    'anomaly_scoring_interval_min',
    'anomaly_training_interval_hours',
    'anomaly_min_training_hours',
    'anomaly_sensitivity',
    'anomaly_retention_days',
  ];

  const validSensitivities = ['low', 'medium', 'high'];
  const updates = {};

  for (const key of allowedKeys) {
    if (req.body[key] !== undefined) {
      const val = String(req.body[key]);

      if (key === 'anomaly_detection_enabled' && !['true', 'false'].includes(val)) {
        return res.status(400).json({ error: 'anomaly_detection_enabled must be a boolean (true or false)' });
      }
      if (key === 'anomaly_sensitivity' && !validSensitivities.includes(val)) {
        return res.status(400).json({ error: `anomaly_sensitivity must be one of: ${validSensitivities.join(', ')}` });
      }

      if (['anomaly_scoring_interval_min', 'anomaly_training_interval_hours',
           'anomaly_min_training_hours', 'anomaly_retention_days'].includes(key)) {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1) {
          return res.status(400).json({ error: `${key} must be a positive integer` });
        }
      }

      updates[key] = val;
    }
  }

  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );

  const transaction = db.transaction(() => {
    for (const [key, val] of Object.entries(updates)) {
      upsert.run(key, val);
    }
  });
  transaction();

  res.json({ ok: true, updated: Object.keys(updates) });
});

function parseScoreRow(row) {
  return {
    ...row,
    top_features: row.top_features ? JSON.parse(row.top_features) : null,
  };
}

export default router;
