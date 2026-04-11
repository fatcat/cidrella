import { Router } from 'express';
import { requirePerm } from '../auth/require-perm.js';
import { getDb } from '../db/init.js';
import {
  queryTopClients, queryTopDomains, queryTopBlocked,
  queryTopClientsByAction, queryTopDomainsByAction, queryTopBlockReasons,
  queryVolume, queryActionBreakdown,
  queryClientDomains, queryDomainClients,
} from '../db/duckdb.js';

const router = Router();

const VALID_RANGES = ['1h', '4h', '12h', '24h', '2d', '7d', '1w', '30d'];

// Look up hostnames for a list of IPs from SQLite (ip_addresses + dhcp_leases)
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

/**
 * Factory for standard analytics route handlers.
 *
 * @param {Function} queryFn      - The duckdb query function to call
 * @param {Object}   opts
 * @param {boolean}  opts.enrich  - Enrich rows with hostnames (default false)
 * @param {string}   opts.fixedAction - If set, pass this as the second arg to queryFn (action-filtered queries)
 * @param {string}   opts.defaultLimit - Default limit value (default '20')
 */
function analyticsRoute(queryFn, { enrich = false, fixedAction = null, defaultLimit = '20' } = {}) {
  return async (req, res) => {
    try {
      const { range = '24h', limit = defaultLimit } = req.query;
      if (!VALID_RANGES.includes(range)) {
        return res.status(400).json({ error: `Invalid range. Must be one of: ${VALID_RANGES.join(', ')}` });
      }
      const parsedLimit = parseInt(limit, 10) || parseInt(defaultLimit, 10);
      let rows = fixedAction
        ? await queryFn(range, fixedAction, parsedLimit)
        : await queryFn(range, parsedLimit);
      if (enrich) rows = enrichWithHostnames(rows);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

function parseRangeAndLimit(req, res) {
  const { range = '24h', limit = '50' } = req.query;
  if (!VALID_RANGES.includes(range)) {
    res.status(400).json({ error: `Invalid range. Must be one of: ${VALID_RANGES.join(', ')}` });
    return null;
  }
  return { range, limit: parseInt(limit, 10) || 50 };
}

const auth = requirePerm('analytics:read');

// GET /api/analytics/top-clients?range=24h&limit=20
router.get('/top-clients', auth, analyticsRoute(queryTopClients, { enrich: true }));

// GET /api/analytics/top-domains?range=24h&limit=20
router.get('/top-domains', auth, analyticsRoute(queryTopDomains));

// GET /api/analytics/top-blocked?range=24h&limit=20
router.get('/top-blocked', auth, analyticsRoute(queryTopBlocked));

// GET /api/analytics/query-volume?range=24h&interval=5m
// queryVolume takes (range, interval) — not a standard (range, limit) shape, keep inline
router.get('/query-volume', auth, async (req, res) => {
  try {
    const { range = '24h', interval = '5m' } = req.query;
    if (!VALID_RANGES.includes(range)) {
      return res.status(400).json({ error: `Invalid range. Must be one of: ${VALID_RANGES.join(', ')}` });
    }
    const rows = await queryVolume(range, interval);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/action-breakdown?range=24h
// queryActionBreakdown takes only (range) — no limit param
router.get('/action-breakdown', auth, async (req, res) => {
  try {
    const { range = '24h' } = req.query;
    if (!VALID_RANGES.includes(range)) {
      return res.status(400).json({ error: `Invalid range. Must be one of: ${VALID_RANGES.join(', ')}` });
    }
    const rows = await queryActionBreakdown(range);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/client/:ip/domains?range=24h&limit=50
// queryClientDomains takes (clientIp, range, limit) — different first arg
router.get('/client/:ip/domains', auth, async (req, res) => {
  try {
    const parsed = parseRangeAndLimit(req, res);
    if (!parsed) return;
    const rows = await queryClientDomains(req.params.ip, parsed.range, parsed.limit);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/domain/:name/clients?range=24h&limit=50
// queryDomainClients takes (domain, range, limit) — different first arg
router.get('/domain/:name/clients', auth, async (req, res) => {
  try {
    const parsed = parseRangeAndLimit(req, res);
    if (!parsed) return;
    const rows = await queryDomainClients(req.params.name, parsed.range, parsed.limit);
    res.json(enrichWithHostnames(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/blocklist/top-clients?range=24h&limit=10
router.get('/blocklist/top-clients', auth, analyticsRoute(queryTopClientsByAction, { enrich: true, fixedAction: 'blocked_blocklist', defaultLimit: '10' }));

// GET /api/analytics/blocklist/top-domains?range=24h&limit=10
router.get('/blocklist/top-domains', auth, analyticsRoute(queryTopDomainsByAction, { fixedAction: 'blocked_blocklist', defaultLimit: '10' }));

// GET /api/analytics/blocklist/top-categories?range=24h&limit=10
router.get('/blocklist/top-categories', auth, analyticsRoute(queryTopBlockReasons, { fixedAction: 'blocked_blocklist', defaultLimit: '10' }));

// GET /api/analytics/geoip/top-clients?range=24h&limit=10
router.get('/geoip/top-clients', auth, analyticsRoute(queryTopClientsByAction, { enrich: true, fixedAction: 'blocked_geoip', defaultLimit: '10' }));

// GET /api/analytics/geoip/top-domains?range=24h&limit=10
router.get('/geoip/top-domains', auth, analyticsRoute(queryTopDomainsByAction, { fixedAction: 'blocked_geoip', defaultLimit: '10' }));

export default router;
