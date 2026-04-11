import { Router } from 'express';
import { queryRaw } from '../db/duckdb.js';

const router = Router();

// Pre-defined named queries — no arbitrary SQL accepted
const ALLOWED_QUERIES = {
  'top-clients': `
    SELECT client_ip, COUNT(*) AS query_count
    FROM dns_events
    WHERE ts >= now() - INTERVAL (CAST(? AS INTEGER) || ' hours')
    GROUP BY client_ip
    ORDER BY query_count DESC
    LIMIT ?
  `,
  'top-domains': `
    SELECT domain, COUNT(*) AS query_count
    FROM dns_events
    WHERE ts >= now() - INTERVAL (CAST(? AS INTEGER) || ' hours')
    GROUP BY domain
    ORDER BY query_count DESC
    LIMIT ?
  `,
  'query-volume': `
    SELECT time_bucket(INTERVAL '5 minutes', ts) AS bucket, COUNT(*) AS query_count
    FROM dns_events
    WHERE ts >= now() - INTERVAL (CAST(? AS INTEGER) || ' hours')
    GROUP BY bucket
    ORDER BY bucket
  `,
  'action-breakdown': `
    SELECT action, COUNT(*) AS count
    FROM dns_events
    WHERE ts >= now() - INTERVAL (CAST(? AS INTEGER) || ' hours')
    GROUP BY action
    ORDER BY count DESC
  `,
  'top-blocked': `
    SELECT domain, COUNT(*) AS block_count
    FROM dns_events
    WHERE action LIKE 'blocked%'
      AND ts >= now() - INTERVAL (CAST(? AS INTEGER) || ' hours')
    GROUP BY domain
    ORDER BY block_count DESC
    LIMIT ?
  `,
};

// Range string → hours integer
const RANGE_HOURS = { '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720 };

// Localhost-only guard — use socket address, not req.ip, to prevent X-Forwarded-For spoofing
router.use((req, res, next) => {
  const ip = req.socket.remoteAddress;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return next();
  }
  res.status(403).json({ error: 'Localhost only' });
});

// POST /api/internal/analytics/query
// Accepts { query, range, limit } — looks up pre-defined SQL from ALLOWED_QUERIES
router.post('/query', async (req, res) => {
  const { query, range = '24h', limit = '20' } = req.body;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query name required' });
  }

  const sql = ALLOWED_QUERIES[query];
  if (!sql) {
    return res.status(400).json({
      error: `Unknown query '${query}'. Allowed: ${Object.keys(ALLOWED_QUERIES).join(', ')}`
    });
  }

  const hours = RANGE_HOURS[range] ?? 24;
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);

  try {
    const rows = await queryRaw(sql, [hours, parsedLimit]);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
