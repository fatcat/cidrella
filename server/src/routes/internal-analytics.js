import { Router } from 'express';
import { queryRaw } from '../db/duckdb.js';

const router = Router();

// Localhost-only guard — this endpoint has no auth, so restrict to loopback
router.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    return next();
  }
  res.status(403).json({ error: 'Localhost only' });
});

// POST /api/internal/analytics/query
// Accepts { sql, params } — SELECT queries only
router.post('/query', async (req, res) => {
  const { sql, params = [] } = req.body;

  if (!sql || typeof sql !== 'string') {
    return res.status(400).json({ error: 'SQL query required' });
  }

  // Only allow SELECT statements
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT')) {
    return res.status(403).json({ error: 'Only SELECT queries allowed' });
  }

  try {
    const rows = await queryRaw(sql, params);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
