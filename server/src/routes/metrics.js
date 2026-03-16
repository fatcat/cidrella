import { Router } from 'express';
import { execSync } from 'child_process';
import { getDb, getSetting } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { getProxyStatus } from '../utils/dns-proxy.js';
import { testDnsForwarder } from '../utils/dns-test.js';
import { VALID_RANGE_KEYS } from '../config/defaults.js';

const router = Router();

// Range string to seconds — derived from VALID_RANGE_KEYS
const RANGE_MAP = {};
for (const key of VALID_RANGE_KEYS) {
  const m = key.match(/^(\d+)(h|d|w)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    RANGE_MAP[key] = n * (unit === 'h' ? 3600 : unit === 'd' ? 86400 : 604800);
  }
}

function parseCutoff(range) {
  const seconds = RANGE_MAP[range] || RANGE_MAP['24h'];
  return Math.floor(Date.now() / 1000) - seconds;
}

// GET /api/metrics/timeseries?range=24h
router.get('/timeseries', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();
  const cutoff = parseCutoff(req.query.range);
  const rows = db.prepare(
    'SELECT ts, dns_queries, dhcp_requests, blocklist_blocks, geoip_blocks FROM metrics WHERE ts >= ? ORDER BY ts'
  ).all(cutoff);
  res.json(rows);
});

// GET /api/metrics/blocklist-hits?range=24h
router.get('/blocklist-hits', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();
  const cutoff = parseCutoff(req.query.range);
  const rows = db.prepare(
    'SELECT category, SUM(count) as count FROM metrics_blocklist_hits WHERE ts >= ? GROUP BY category ORDER BY count DESC'
  ).all(cutoff);
  res.json(rows);
});

// GET /api/metrics/geoip-hits?range=24h
router.get('/geoip-hits', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();
  const cutoff = parseCutoff(req.query.range);
  const rows = db.prepare(
    'SELECT country, SUM(count) as count FROM metrics_geoip_hits WHERE ts >= ? GROUP BY country ORDER BY count DESC'
  ).all(cutoff);
  res.json(rows);
});

// GET /api/metrics/proxy-perf?range=24h
router.get('/proxy-perf', requirePerm('analytics:read'), (req, res) => {
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
router.get('/services', requirePerm('analytics:read'), async (req, res) => {
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
    const result = await testDnsForwarder(ip);
    forwarders.push({ ip, reachable: result.reachable });
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

export default router;
