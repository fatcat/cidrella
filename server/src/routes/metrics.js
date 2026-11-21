import { Router } from 'express';
import { getDb } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { getProxyStatus } from '../utils/dns-proxy.js';
import { backendStatuses } from '../backends/index.js';
import { forwarderHealth } from '../utils/forwarder-health.js';
import { VALID_RANGE_KEYS } from '../config/defaults.js';
import { getIpLifecycleDiagnostics } from '../utils/ip-lifecycle-diagnostics.js';
import { getNetworkDhcpDiagnostics } from '../utils/network-dhcp-diagnostics.js';
import { listGenerations } from '../models/configuration-generation.js';
import { queryFailedDomains } from '../db/duckdb.js';
import { filterableInstances, hasMemberRows, readInstanceFilter } from '../sync/instance-filter.js';

const router = Router();

// Range string to seconds, derived from VALID_RANGE_KEYS
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

// Every range read below takes ?instance= (sync/instance-filter.js): absent
// or `all` is every instance together, an instance id that instance alone.
// Counts add up across instances. What cannot be added is said where it is
// read. Until a member has sent rows up, every read here is the one a single
// box has always run.

const TIMESERIES_COLUMNS = [
  'dns_queries',
  'dhcp_requests',
  'dhcp_client_msgs',
  'dhcp_server_msgs',
  'dhcp4_client_msgs',
  'dhcp4_server_msgs',
  'dhcp6_client_msgs',
  'dhcp6_server_msgs',
  'blocklist_blocks',
  'geoip_blocks',
];

// GET /api/metrics/timeseries?range=24h
router.get('/timeseries', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();
  const instance = readInstanceFilter(req, res, db);
  if (!instance) return;
  const cutoff = parseCutoff(req.query.range);
  // Every instance: one row a minute, each count the sum of theirs.
  const merged = !instance.one && hasMemberRows(db, 'metrics');
  const columns = merged
    ? TIMESERIES_COLUMNS.map((column) => `SUM(${column}) AS ${column}`)
    : TIMESERIES_COLUMNS;
  const rows = db
    .prepare(
      `SELECT ts, ${columns.join(', ')}
       FROM metrics WHERE ts >= ?${instance.and}${merged ? ' GROUP BY ts' : ''} ORDER BY ts`,
    )
    .all(cutoff, ...instance.params);
  res.json(rows);
});

// GET /api/metrics/blocklist-hits?range=24h
router.get('/blocklist-hits', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();
  const instance = readInstanceFilter(req, res, db);
  if (!instance) return;
  const cutoff = parseCutoff(req.query.range);
  const rows = db
    .prepare(
      `SELECT category, SUM(count) as count FROM metrics_blocklist_hits
       WHERE ts >= ?${instance.and} GROUP BY category ORDER BY count DESC`,
    )
    .all(cutoff, ...instance.params);
  res.json(rows);
});

// GET /api/metrics/geoip-hits?range=24h
router.get('/geoip-hits', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();
  const instance = readInstanceFilter(req, res, db);
  if (!instance) return;
  const cutoff = parseCutoff(req.query.range);
  const rows = db
    .prepare(
      `SELECT country, SUM(count) as count FROM metrics_geoip_hits
       WHERE ts >= ?${instance.and} GROUP BY country ORDER BY count DESC`,
    )
    .all(cutoff, ...instance.params);
  res.json(rows);
});

// The proxy's minute figures, and how each reads for a minute more than one
// instance measured:
//   sum    a count, or queries waiting at once: theirs added up.
//   min, max  the fastest and slowest answer any of them gave.
//   mean   each instance's average, weighted by its queries.
//   alone  true of one proxy only: a percentile cannot be made from two
//          percentiles, and CPU and memory are one process's. NULL in a
//          merged minute; ?by=instance has each instance's own.
const PROXY_PERF_COLUMNS = [
  ['query_count', 'sum'],
  ['latency_min', 'min'],
  ['latency_avg', 'mean'],
  ['latency_max', 'max'],
  ['latency_p95', 'alone'],
  ['cache_hits', 'sum'],
  ['cache_misses', 'sum'],
  ['timeouts', 'sum'],
  ['pending_queries', 'sum'],
  ['cpu_percent', 'alone'],
  ['rss_mb', 'alone'],
  ['heap_mb', 'alone'],
  ['startup_ms', 'alone'],
  ['servfail_dnssec', 'sum'],
  ['servfail_upstream', 'sum'],
  ['servfail_timeout', 'sum'],
  ['servfail_refused', 'sum'],
  ['servfail_other', 'sum'],
  ['nxdomain', 'sum'],
];
const PROXY_PERF_NAMES = PROXY_PERF_COLUMNS.map(([column]) => column).join(', ');
const MERGED = {
  sum: (c) => `SUM(${c})`,
  min: (c) => `MIN(${c})`,
  max: (c) => `MAX(${c})`,
  mean: (c) =>
    `CAST(ROUND(SUM(${c} * 1.0 * query_count) /
       NULLIF(SUM(CASE WHEN ${c} IS NOT NULL THEN query_count END), 0)) AS INTEGER)`,
  alone: (c) => `CASE WHEN COUNT(*) = 1 THEN MAX(${c}) END`,
};
const PROXY_PERF_MERGED = PROXY_PERF_COLUMNS.map(
  ([column, how]) => `${MERGED[how](column)} AS ${column}`,
).join(', ');

// GET /api/metrics/proxy-perf?range=24h[&by=instance]
// With by=instance the answer is [{ instance_id, name, rows }], each
// instance's own minute rows, nothing merged: where the figures marked
// `alone` above are read when every instance is selected.
router.get('/proxy-perf', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();
  const instance = readInstanceFilter(req, res, db);
  if (!instance) return;
  const cutoff = parseCutoff(req.query.range);
  if (req.query.by === 'instance') {
    const instances = filterableInstances(db);
    const self = instances.find((row) => row.is_self);
    const groups = new Map();
    const rows = db
      .prepare(
        `SELECT instance_id, ts, ${PROXY_PERF_NAMES}
         FROM metrics_proxy_perf WHERE ts >= ?${instance.and} ORDER BY ts`,
      )
      .all(cutoff, ...instance.params);
    for (const { instance_id: id, ...row } of rows) {
      const key = id ?? self.instance_id;
      if (!groups.has(key)) {
        groups.set(key, {
          instance_id: key,
          // Rows outlive the instance that sent them, until they age out.
          name: instances.find((i) => i.instance_id === key)?.name ?? 'Removed instance',
          rows: [],
        });
      }
      groups.get(key).rows.push(row);
    }
    return res.json([...groups.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }
  const merged = !instance.one && hasMemberRows(db, 'metrics_proxy_perf');
  const rows = db
    .prepare(
      `SELECT ts, ${merged ? PROXY_PERF_MERGED : PROXY_PERF_NAMES}
       FROM metrics_proxy_perf
       WHERE ts >= ?${instance.and}${merged ? ' GROUP BY ts' : ''} ORDER BY ts`,
    )
    .all(cutoff, ...instance.params);
  res.json(rows);
});

// GET /api/metrics/forwarder?range=24h: each encrypted-forwarding upstream
// address's minute rows. Every instance together is every instance's rows,
// unmerged: an upstream two instances use has a row from each for the minute.
// Their counts add up, and the p50 and p95 stay each row's own (the reader
// takes a provider's slowest, utils/forwarder-perf.js in the client).
router.get('/forwarder', requirePerm('analytics:read'), (req, res) => {
  const db = getDb();
  const instance = readInstanceFilter(req, res, db);
  if (!instance) return;
  const cutoff = parseCutoff(req.query.range);
  const rows = db
    .prepare(
      `SELECT ts, provider, address, protocol, queries, answers, timeouts, drops,
            connect_failures, failovers, latency_p50_us, latency_p95_us
     FROM metrics_forwarder WHERE ts >= ?${instance.and} ORDER BY ts, provider, address`,
    )
    .all(cutoff, ...instance.params);
  res.json(rows);
});

// GET /api/metrics/dns-failures?range=24h: the names whose answers failed
// most, with their cause (utils/dns-ede.js) and EDE code.
router.get('/dns-failures', requirePerm('analytics:read'), async (req, res) => {
  const instance = readInstanceFilter(req, res);
  if (!instance) return;
  const range = RANGE_MAP[req.query.range] ? req.query.range : '24h';
  res.json(await queryFailedDomains(range, 10, instance));
});

// GET /api/metrics/ip-lifecycle
router.get('/ip-lifecycle', requirePerm('analytics:read'), (req, res) => {
  res.json(getIpLifecycleDiagnostics(getDb()));
});

router.get('/network-dhcp', requirePerm('analytics:read'), (req, res) => {
  res.json(getNetworkDhcpDiagnostics(getDb()));
});

router.get('/configuration-generation', requirePerm('analytics:read'), (req, res) => {
  res.json(listGenerations(getDb()));
});

// GET /api/metrics/services
router.get('/services', requirePerm('analytics:read'), async (req, res) => {
  const backends = await backendStatuses();

  // GeoIP proxy status
  const geoipStatus = getProxyStatus();

  // The upstreams DNS is forwarded to, encrypted or plain (probed together,
  // kept 30 s).
  const forwarders = await forwarderHealth();

  res.json({
    backends,
    geoip_proxy: geoipStatus.running,
    geoip_bypassed: geoipStatus.bypassed,
    geoip_switched_off: geoipStatus.switchedOff,
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
