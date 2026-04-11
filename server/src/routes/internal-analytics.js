import { Router } from 'express';
import { queryRaw } from '../db/duckdb.js';

const router = Router();

// Pre-defined named queries — no arbitrary SQL accepted.
// Each entry: { sql, paramMap } where paramMap transforms the request body into ordered params.
const ALLOWED_QUERIES = {
  // ─── Dashboard queries ────────────────────────────────
  'top-clients': {
    sql: `SELECT client_ip, COUNT(*) AS query_count
          FROM dns_queries
          WHERE ts >= NOW() - INTERVAL (CAST(? AS INTEGER) || ' hours')
          GROUP BY client_ip ORDER BY query_count DESC LIMIT ?`,
    paramMap: (b) => [b.hours ?? 24, b.limit ?? 20],
  },
  'top-domains': {
    sql: `SELECT domain, COUNT(*) AS query_count
          FROM dns_queries
          WHERE ts >= NOW() - INTERVAL (CAST(? AS INTEGER) || ' hours')
          GROUP BY domain ORDER BY query_count DESC LIMIT ?`,
    paramMap: (b) => [b.hours ?? 24, b.limit ?? 20],
  },
  'query-volume': {
    sql: `SELECT time_bucket(INTERVAL '5 minutes', ts) AS bucket, COUNT(*) AS query_count
          FROM dns_queries
          WHERE ts >= NOW() - INTERVAL (CAST(? AS INTEGER) || ' hours')
          GROUP BY bucket ORDER BY bucket`,
    paramMap: (b) => [b.hours ?? 24],
  },
  'action-breakdown': {
    sql: `SELECT action, COUNT(*) AS count
          FROM dns_queries
          WHERE ts >= NOW() - INTERVAL (CAST(? AS INTEGER) || ' hours')
          GROUP BY action ORDER BY count DESC`,
    paramMap: (b) => [b.hours ?? 24],
  },
  'top-blocked': {
    sql: `SELECT domain, COUNT(*) AS block_count
          FROM dns_queries
          WHERE action LIKE 'blocked%'
            AND ts >= NOW() - INTERVAL (CAST(? AS INTEGER) || ' hours')
          GROUP BY domain ORDER BY block_count DESC LIMIT ?`,
    paramMap: (b) => [b.hours ?? 24, b.limit ?? 20],
  },

  // ─── Anomaly detection queries ────────────────────────
  'anomaly-active-clients': {
    sql: `SELECT DISTINCT client_ip
          FROM dns_queries
          WHERE ts >= NOW() - INTERVAL (CAST(? AS INTEGER) || ' hours')`,
    paramMap: (b) => [b.hours ?? 24],
  },
  'anomaly-client-history-hours': {
    sql: `SELECT EXTRACT(EPOCH FROM (MAX(ts) - MIN(ts))) / 3600.0 AS hours
          FROM dns_queries WHERE client_ip = ?`,
    paramMap: (b) => [b.client_ip],
  },
  'anomaly-client-window-events': {
    sql: `SELECT ts, domain, query_type, response_code, action, resolved_ip
          FROM dns_queries
          WHERE client_ip = ? AND ts >= CAST(? AS TIMESTAMP) AND ts < CAST(? AS TIMESTAMP)
          ORDER BY ts`,
    paramMap: (b) => [b.client_ip, b.window_start, b.window_end],
  },
  'anomaly-client-window-domains': {
    sql: `SELECT DISTINCT domain
          FROM dns_queries
          WHERE client_ip = ? AND ts >= CAST(? AS TIMESTAMP) AND ts < CAST(? AS TIMESTAMP)`,
    paramMap: (b) => [b.client_ip, b.window_start, b.window_end],
  },
  'anomaly-client-historical-domains': {
    sql: `SELECT DISTINCT domain
          FROM dns_queries
          WHERE client_ip = ? AND ts >= CAST(? AS TIMESTAMP) - INTERVAL (CAST(? AS INTEGER) || ' days') AND ts < CAST(? AS TIMESTAMP)`,
    paramMap: (b) => [b.client_ip, b.window_start, b.lookback_days ?? 7, b.window_start],
  },
  'anomaly-client-training-range': {
    sql: `SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts
          FROM dns_queries
          WHERE client_ip = ? AND ts >= NOW() - INTERVAL (CAST(? AS INTEGER) || ' days')`,
    paramMap: (b) => [b.client_ip, b.lookback_days ?? 7],
  },
  'anomaly-client-domain-first-seen': {
    sql: `SELECT DISTINCT domain, MIN(ts) AS first_seen
          FROM dns_queries
          WHERE client_ip = ? AND ts >= NOW() - INTERVAL (CAST(? AS INTEGER) || ' days')
          GROUP BY domain`,
    paramMap: (b) => [b.client_ip, b.lookback_days ?? 7],
  },
};

// Localhost-only guard — use socket address, not req.ip, to prevent X-Forwarded-For spoofing
router.use((req, res, next) => {
  const ip = req.socket.remoteAddress;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return next();
  }
  res.status(403).json({ error: 'Localhost only' });
});

// POST /api/internal/analytics/query
// Accepts { query, ...params } — looks up pre-defined SQL from ALLOWED_QUERIES
router.post('/query', async (req, res) => {
  const { query } = req.body;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query name required' });
  }

  const entry = ALLOWED_QUERIES[query];
  if (!entry) {
    return res.status(400).json({
      error: `Unknown query '${query}'. Allowed: ${Object.keys(ALLOWED_QUERIES).join(', ')}`
    });
  }

  try {
    const params = entry.paramMap(req.body);
    const rows = await queryRaw(entry.sql, params);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
