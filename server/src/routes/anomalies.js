import { Router } from 'express';
import { getDb, getSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { requireRole } from '../auth/roles.js';
import { isValidIpv4 } from '../utils/ip.js';
import { MAC_RE } from '../utils/mac.js';
import { enrichWithHostnames } from '../utils/hostnames.js';
import { DEFAULTS } from '../config/defaults.js';
import * as Anomaly from '../models/anomaly.js';
import * as Setting from '../models/setting.js';

const router = Router();

// GET /api/anomalies/active: active (unresolved) anomalies
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

// GET /api/anomalies/summary: dashboard summary
router.get('/summary', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();
  const acknowledgedThroughId = Math.max(0, parseInt(getSetting('anomaly_acknowledged_score_id'), 10) || 0);

  const active = db.prepare(
    `SELECT severity, COUNT(*) as count FROM anomaly_scores
     WHERE is_anomaly = 1 AND resolved = 0
     GROUP BY severity`
  ).all();

  const totalActive = active.reduce((sum, r) => sum + r.count, 0);
  const unacknowledgedActive = db.prepare(
    `SELECT COUNT(*) as count FROM anomaly_scores
     WHERE is_anomaly = 1 AND resolved = 0 AND id > ?`
  ).get(acknowledgedThroughId)?.count || 0;
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

  // Daemon status reported here is whatever the python daemon last wrote to
  // the anomaly_daemon_status setting. The daemon writes this on every scoring
  // and training cycle, so if it stops writing, we know the daemon is dead
  // even though the cached values look fine. We must NOT pass the stale
  // snapshot through to the UI as "healthy"; instead, compare the last
  // heartbeat timestamp against the expected scoring interval and mark the
  // daemon as stale when it exceeds the threshold.
  //
  // This is why the System tab's Anomaly Detection indicator stayed green on
  // prod on 2026-04-12 while the systemd service had been dead for 5h36m,   // the API was reading a six-hour-old snapshot without checking freshness.
  let daemon = null;
  try {
    const raw = getSetting('anomaly_daemon_status');
    if (raw) daemon = JSON.parse(raw);
  } catch { /* ignore parse errors */ }

  if (daemon) {
    if (!enabled) {
      daemon.stale = false;
    } else {
      // The Python sidecar refreshes last_seen on every status write. Older
      // releases did not, so fall back to score/train timestamps for restored
      // or pre-fix status snapshots.
      const heartbeats = [daemon.last_seen, daemon.last_score, daemon.last_train]
        .filter(Boolean)
        .map(s => Date.parse(s))
        .filter(n => Number.isFinite(n));

      if (heartbeats.length === 0) {
        daemon.stale = true;
        daemon.stale_reason = 'no_heartbeat';
      } else {
        const lastHeartbeatMs = Math.max(...heartbeats);
        const ageSec = Math.max(0, Math.round((Date.now() - lastHeartbeatMs) / 1000));

        // Threshold: 2× the scoring interval (min 60s floor, min 5min ceiling
        // for the "ok" window so a misconfigured interval=1min doesn't flap).
        const scoringMin = parseInt(getSetting('anomaly_scoring_interval_min'), 10);
        const defaultScoringMin = parseInt(DEFAULTS.anomaly_scoring_interval_min, 10) || 15;
        const scoringSec = Number.isFinite(scoringMin) && scoringMin > 0
          ? scoringMin * 60
          : defaultScoringMin * 60;
        const thresholdSec = Math.max(300, scoringSec * 2);

        daemon.heartbeat_age_sec = ageSec;
        daemon.heartbeat_threshold_sec = thresholdSec;
        daemon.stale = ageSec > thresholdSec;
        if (daemon.stale) daemon.stale_reason = 'heartbeat_too_old';
      }
    }
  }

  res.json({
    enabled,
    total_active: totalActive,
    unacknowledged_active: unacknowledgedActive,
    acknowledged_through_id: acknowledgedThroughId,
    by_severity: bySeverity,
    clients_monitored: clientsMonitored,
    clients_learning: clientsLearning,
    daemon,
  });
});

// POST /api/anomalies/acknowledge: clear the header notification counter.
// This does not resolve or delete anomalies; it records the highest anomaly id
// seen so older rows never contribute to the notification count again.
router.post('/acknowledge', requirePerm('analytics:write'), (req, res) => {
  const db = getDb();
  const maxId = db.prepare(
    `SELECT COALESCE(MAX(id), 0) as id FROM anomaly_scores WHERE is_anomaly = 1`
  ).get()?.id || 0;

  Setting.upsertSetting(db, 'anomaly_acknowledged_score_id', String(maxId));
  audit(req.user.id, 'anomaly_counter_acknowledged', 'anomaly_scores', null, { through_id: maxId });

  res.json({
    ok: true,
    acknowledged_through_id: maxId,
    unacknowledged_active: 0,
  });
});

// GET /api/anomalies/events: recent anomalous-window events across all clients,
// grouped-ready for the client to classify by shape (escalating / recurring /
// one-off). Unlike /active, this includes already-resolved events so a client
// that auto-resolved (e.g. a recurring nightly job that goes quiet by day) is
// not invisible between occurrences. Kept lightweight by only ever returning
// is_anomaly=1 rows, never the full per-window score history.
router.get('/events', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 30);

  const events = db.prepare(
    `SELECT * FROM anomaly_scores
     WHERE is_anomaly = 1 AND window_start >= datetime('now', '-' || ? || ' days')
     ORDER BY client_ip, window_start`
  ).all(days).map(parseScoreRow);

  const learning = db.prepare(
    `SELECT identity, client_ip, status, training_rows, trained_at FROM anomaly_models WHERE status = 'learning'`
  ).all();

  res.json({
    events: enrichWithHostnames(events),
    learning: enrichWithHostnames(learning),
  });
});

const FULL_MAC_RE = new RegExp(`^${MAC_RE.source}$`, 'i');

// An anomaly identity is either a MAC (survives an IP renewal) or, when
// CIDRella has no DHCP lease for the client, the client's IP itself.
function isValidIdentity(identity) {
  return FULL_MAC_RE.test(identity) || isValidIpv4(identity);
}

// GET /api/anomalies/client/:identity: anomaly history for a client
router.get('/client/:identity', requirePerm('analytics:read'), (req, res) => {
  const { identity } = req.params;
  if (!isValidIdentity(identity)) {
    return res.status(400).json({ error: 'Invalid identity' });
  }

  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  const rows = db.prepare(
    `SELECT * FROM anomaly_scores
     WHERE identity = ?
     ORDER BY window_start DESC
     LIMIT ?`
  ).all(identity, limit);
  res.json(rows.map(parseScoreRow));
});

// GET /api/anomalies/client/:identity/model: model metadata
router.get('/client/:identity/model', requirePerm('analytics:read'), (req, res) => {
  const { identity } = req.params;
  if (!isValidIdentity(identity)) {
    return res.status(400).json({ error: 'Invalid identity' });
  }

  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM anomaly_models WHERE identity = ?`
  ).get(identity);
  res.json(row || null);
});

// DELETE /api/anomalies/:id: delete an anomaly score
router.delete('/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }

  const result = Anomaly.deleteScore(db, id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Anomaly not found' });
  }
  res.json({ ok: true });
});

// POST /api/anomalies/:id/dismiss: mark anomaly as resolved (kept for backwards compat)
router.post('/:id/dismiss', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid ID' });
  }

  const result = Anomaly.dismissScore(db, id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Anomaly not found or already resolved' });
  }
  res.json({ ok: true });
});

// ─── Whitelist CRUD ─────────────────────────────────────

// GET /api/anomalies/whitelist: list whitelisted clients
router.get('/whitelist', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM anomaly_whitelist ORDER BY whitelisted_at DESC').all();
  res.json(enrichWithHostnames(rows));
});

// POST /api/anomalies/whitelist: whitelist a client IP
router.post('/whitelist', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const { client_ip, reason } = req.body;

  if (!client_ip) return res.status(400).json({ error: 'client_ip is required' });
  if (!isValidIpv4(client_ip)) return res.status(400).json({ error: 'Invalid IP address' });

  const identity = Anomaly.resolveIdentity(db, client_ip);
  const existing = db.prepare('SELECT id FROM anomaly_whitelist WHERE identity = ?').get(identity);
  if (existing) return res.status(409).json({ error: 'Already whitelisted' });

  const id = Anomaly.addWhitelistEntry(db, client_ip, reason);

  audit(req.user.id, 'anomaly_whitelist_add', 'anomaly_whitelist', id, { client_ip, reason });
  res.status(201).json({ id, ok: true });
});

// DELETE /api/anomalies/whitelist/:id: remove from whitelist
router.delete('/whitelist/:id', requirePerm('dns:write'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  const entry = db.prepare('SELECT * FROM anomaly_whitelist WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'Not found' });

  Anomaly.deleteWhitelistEntry(db, id);
  audit(req.user.id, 'anomaly_whitelist_remove', 'anomaly_whitelist', id, { client_ip: entry.client_ip });
  res.json({ ok: true });
});

// GET /api/anomalies/settings: anomaly detection settings
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

// PUT /api/anomalies/settings: update anomaly detection settings
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

  Setting.upsertSettings(db, Object.entries(updates));

  res.json({ ok: true, updated: Object.keys(updates) });
});

function parseScoreRow(row) {
  let topFeatures = null;
  if (row.top_features) {
    try {
      topFeatures = JSON.parse(row.top_features);
    } catch {
      topFeatures = null;
    }
  }
  return {
    ...row,
    top_features: topFeatures,
  };
}

export default router;
