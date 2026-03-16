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

// GET /api/analytics/top-clients?range=24h&limit=20
router.get('/top-clients', requirePerm('analytics:read'), async (req, res) => {
  try {
    const { range = '24h', limit = '20' } = req.query;
    const rows = await queryTopClients(range, parseInt(limit, 10));
    res.json(enrichWithHostnames(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/top-domains?range=24h&limit=20
router.get('/top-domains', requirePerm('analytics:read'), async (req, res) => {
  try {
    const { range = '24h', limit = '20' } = req.query;
    const rows = await queryTopDomains(range, parseInt(limit, 10));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/top-blocked?range=24h&limit=20
router.get('/top-blocked', requirePerm('analytics:read'), async (req, res) => {
  try {
    const { range = '24h', limit = '20' } = req.query;
    const rows = await queryTopBlocked(range, parseInt(limit, 10));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/query-volume?range=24h&interval=5m
router.get('/query-volume', requirePerm('analytics:read'), async (req, res) => {
  try {
    const { range = '24h', interval = '5m' } = req.query;
    const rows = await queryVolume(range, interval);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/action-breakdown?range=24h
router.get('/action-breakdown', requirePerm('analytics:read'), async (req, res) => {
  try {
    const { range = '24h' } = req.query;
    const rows = await queryActionBreakdown(range);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/client/:ip/domains?range=24h&limit=50
router.get('/client/:ip/domains', requirePerm('analytics:read'), async (req, res) => {
  try {
    const { range = '24h', limit = '50' } = req.query;
    const rows = await queryClientDomains(req.params.ip, range, parseInt(limit, 10));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/domain/:name/clients?range=24h&limit=50
router.get('/domain/:name/clients', requirePerm('analytics:read'), async (req, res) => {
  try {
    const { range = '24h', limit = '50' } = req.query;
    const rows = await queryDomainClients(req.params.name, range, parseInt(limit, 10));
    res.json(enrichWithHostnames(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/blocklist/top-clients?range=24h&limit=10
router.get('/blocklist/top-clients', requirePerm('analytics:read'), async (req, res) => {
  try {
    const { range = '24h', limit = '10' } = req.query;
    const rows = await queryTopClientsByAction(range, 'blocked_blocklist', parseInt(limit, 10));
    res.json(enrichWithHostnames(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/blocklist/top-domains?range=24h&limit=10
router.get('/blocklist/top-domains', requirePerm('analytics:read'), async (req, res) => {
  try {
    const { range = '24h', limit = '10' } = req.query;
    const rows = await queryTopDomainsByAction(range, 'blocked_blocklist', parseInt(limit, 10));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/blocklist/top-categories?range=24h&limit=10
router.get('/blocklist/top-categories', requirePerm('analytics:read'), async (req, res) => {
  try {
    const { range = '24h', limit = '10' } = req.query;
    const rows = await queryTopBlockReasons(range, 'blocked_blocklist', parseInt(limit, 10));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/geoip/top-clients?range=24h&limit=10
router.get('/geoip/top-clients', requirePerm('analytics:read'), async (req, res) => {
  try {
    const { range = '24h', limit = '10' } = req.query;
    const rows = await queryTopClientsByAction(range, 'blocked_geoip', parseInt(limit, 10));
    res.json(enrichWithHostnames(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/geoip/top-domains?range=24h&limit=10
router.get('/geoip/top-domains', requirePerm('analytics:read'), async (req, res) => {
  try {
    const { range = '24h', limit = '10' } = req.query;
    const rows = await queryTopDomainsByAction(range, 'blocked_geoip', parseInt(limit, 10));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
