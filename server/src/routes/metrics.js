import { Router } from 'express';
import { execSync } from 'child_process';
import { getDb, getSetting } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import { getProxyStatus } from '../utils/dns-proxy.js';
import { DNS_TEST_TIMEOUT_MS, DNS_TEST_RETRY_DELAY_MS } from '../config/defaults.js';

const router = Router();

function requirePerm(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Range string to seconds
const RANGE_MAP = {
  '1h': 3600,
  '4h': 4 * 3600,
  '12h': 12 * 3600,
  '24h': 24 * 3600,
  '2d': 2 * 86400,
  '1w': 7 * 86400,
};

function parseCutoff(range) {
  const seconds = RANGE_MAP[range] || RANGE_MAP['24h'];
  return Math.floor(Date.now() / 1000) - seconds;
}

// GET /api/metrics/timeseries?range=24h
router.get('/timeseries', requirePerm('settings:read'), (req, res) => {
  const db = getDb();
  const cutoff = parseCutoff(req.query.range);
  const rows = db.prepare(
    'SELECT ts, dns_queries, dhcp_requests, blocklist_blocks, geoip_blocks FROM metrics WHERE ts >= ? ORDER BY ts'
  ).all(cutoff);
  res.json(rows);
});

// GET /api/metrics/blocklist-hits?range=24h
router.get('/blocklist-hits', requirePerm('settings:read'), (req, res) => {
  const db = getDb();
  const cutoff = parseCutoff(req.query.range);
  const rows = db.prepare(
    'SELECT category, SUM(count) as count FROM metrics_blocklist_hits WHERE ts >= ? GROUP BY category ORDER BY count DESC'
  ).all(cutoff);
  res.json(rows);
});

// GET /api/metrics/geoip-hits?range=24h
router.get('/geoip-hits', requirePerm('settings:read'), (req, res) => {
  const db = getDb();
  const cutoff = parseCutoff(req.query.range);
  const rows = db.prepare(
    'SELECT country, SUM(count) as count FROM metrics_geoip_hits WHERE ts >= ? GROUP BY country ORDER BY count DESC'
  ).all(cutoff);
  res.json(rows);
});

// GET /api/metrics/proxy-perf?range=24h
router.get('/proxy-perf', requirePerm('settings:read'), (req, res) => {
  const db = getDb();
  const cutoff = parseCutoff(req.query.range);
  const rows = db.prepare(
    `SELECT ts, query_count, latency_min, latency_avg, latency_max, latency_p95,
            cache_hits, cache_misses, timeouts, pending_queries,
            cpu_percent, rss_mb, heap_mb, startup_ms
     FROM metrics_proxy_perf WHERE ts >= ? ORDER BY ts`
  ).all(cutoff);
  res.json(rows);
});

// GET /api/metrics/services
router.get('/services', requirePerm('settings:read'), async (req, res) => {
  // dnsmasq status
  let dnsmasq = false;
  try {
    execSync('pidof dnsmasq', { stdio: 'ignore' });
    dnsmasq = true;
  } catch { /* not running */ }

  // GeoIP proxy status
  const geoipStatus = getProxyStatus();

  // Forwarder liveness
  const upstreamRaw = getSetting('dns_upstream_servers');
  let upstreams = [];
  try {
    upstreams = typeof upstreamRaw === 'string' ? JSON.parse(upstreamRaw) : (upstreamRaw || []);
  } catch { upstreams = []; }

  const forwarders = [];
  for (const ip of upstreams) {
    const reachable = await testForwarder(ip);
    forwarders.push({ ip, reachable });
  }

  res.json({
    dnsmasq,
    geoip_proxy: geoipStatus.running,
    geoip_bypassed: geoipStatus.bypassed,
    geoip_port: geoipStatus.port,
    geoip_db_loaded: geoipStatus.dbLoaded,
    geoip_db_last_updated: geoipStatus.dbLastUpdated,
    geoip_stats_total: geoipStatus.statsTotal,
    geoip_stats_blocked: geoipStatus.statsBlocked,
    geoip_stats_allowed: geoipStatus.statsAllowed,
    forwarders,
  });
});

async function testForwarder(ip) {
  const dns = await import('dns');
  const resolver = new dns.Resolver();
  resolver.setServers([ip]);

  function tryResolve() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), DNS_TEST_TIMEOUT_MS);
      resolver.resolve4('google.com', (err) => {
        clearTimeout(timeout);
        resolve(!err);
      });
    });
  }

  let ok = await tryResolve();
  if (!ok) {
    await new Promise(r => setTimeout(r, DNS_TEST_RETRY_DELAY_MS));
    ok = await tryResolve();
  }
  return ok;
}

export default router;
