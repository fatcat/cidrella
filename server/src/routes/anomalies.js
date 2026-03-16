import { Router } from 'express';
import { getDb, getSetting } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { isValidIpv4 } from '../utils/ip.js';

const router = Router();

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

  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(parseScoreRow));
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

// POST /api/anomalies/:id/dismiss — mark anomaly as resolved
router.post('/:id/dismiss', requirePerm('settings:write'), (req, res) => {
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

// GET /api/anomalies/settings — anomaly detection settings
router.get('/settings', requirePerm('settings:read'), (req, res) => {
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
router.put('/settings', requirePerm('settings:write'), (req, res) => {
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

      // Validate specific fields
      if (key === 'anomaly_detection_enabled' && !['true', 'false'].includes(val)) continue;
      if (key === 'anomaly_sensitivity' && !validSensitivities.includes(val)) continue;

      // Numeric fields must be positive integers
      if (['anomaly_scoring_interval_min', 'anomaly_training_interval_hours',
           'anomaly_min_training_hours', 'anomaly_retention_days'].includes(key)) {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 1) continue;
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
