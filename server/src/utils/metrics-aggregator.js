/**
 * Metrics aggregator, collects DNS, DHCP, blocklist, and GeoIP stats
 * every 60 seconds and persists them to the metrics tables.
 *
 * Blocklist and GeoIP block counts come from in-memory proxy counters.
 * DNS query counts come from the DNS backend's log (logSource()). DHCP counts
 * come from the DHCP backend's own counters when it keeps them
 * (dhcpCounters(), Kea), otherwise from its log; one file when one daemon
 * fills both roles (dnsmasq).
 */

import { createLogFollower } from './log-reader.js';
import {
  getBlockedDelta,
  getAndResetCountryHits,
  getAndResetPerformanceMetrics,
  getAndResetBlocklistHits,
} from './dns-proxy.js';
import { getDhcpBackend, getService } from '../backends/index.js';

const AGGREGATE_INTERVAL_MS = 60_000;
const RETENTION_DAYS = 30;
const RETENTION_CLEANUP_EVERY = 100; // run cleanup every N cycles

let db = null;
let timer = null;
// One follower per distinct log: { source, log, dns, dhcp }, where dns and
// dhcp say which counts that log is read for.
let logTails = [];
// The DHCP backend's last counter totals, when it keeps counters.
let lastDhcpCounters = null;
let cycleCount = 0;

// CPU tracking for delta computation
let lastCpuUsage = process.cpuUsage();
let lastCpuTs = Date.now();
let startupRecorded = false;

// Prepared statements (initialized on start)
let insertMetrics = null;
let insertBlocklistHit = null;
let insertGeoipHit = null;
let insertProxyPerf = null;
let deleteOldMetrics = null;
let deleteOldBlocklistHits = null;
let deleteOldGeoipHits = null;
let deleteOldProxyPerf = null;

/**
 * Parse new log lines and return { dnsQueries, dhcpClientMsgs, dhcpServerMsgs }.
 * The two DHCP counts are kept apart so the dashboard can show a request the
 * server never answered; dhcp_requests, the column older readers use, stays
 * as the sum. `dns` and `dhcp` say which counts this log is read for.
 */
export function parseLogLines(
  lines,
  source = getService('dns').logSource(),
  { dns = true, dhcp = true } = {},
) {
  if (!source) return { dnsQueries: 0, dhcpClientMsgs: 0, dhcpServerMsgs: 0 };
  let dnsQueries = 0;
  let dhcpClientMsgs = 0;
  let dhcpServerMsgs = 0;

  for (const line of lines) {
    if (source.querySourceIp(line)) {
      if (dns) dnsQueries++;
    } else if (dhcp) {
      const direction = source.dhcpDirection(line);
      if (direction === 'client') dhcpClientMsgs++;
      else if (direction === 'server') dhcpServerMsgs++;
    }
  }

  return { dnsQueries, dhcpClientMsgs, dhcpServerMsgs };
}

// The logs to read: the DNS backend's for queries, and the DHCP backend's
// for DHCP messages unless it counts them itself; once when they are the
// same file.
function selectLogTails(dhcpFromLog) {
  const dns = getService('dns').logSource();
  const dhcp = dhcpFromLog ? getService('dhcp').logSource() : null;
  if (dns && dhcp && dns.path === dhcp.path) return [{ source: dns, dns: true, dhcp: true }];
  return [
    dns && { source: dns, dns: true, dhcp: false },
    dhcp && { source: dhcp, dns: false, dhcp: true },
  ].filter(Boolean);
}

/**
 * DHCP messages since the last call from the backend's counters, which are
 * totals since the daemon started: a total that went down means a restart,
 * and the new total is all new. The first call sets the baseline.
 */
export function counterDelta(last, current) {
  if (!last) return { dhcpClientMsgs: 0, dhcpServerMsgs: 0 };
  const delta = (key) => (current[key] >= last[key] ? current[key] - last[key] : current[key]);
  return { dhcpClientMsgs: delta('received'), dhcpServerMsgs: delta('sent') };
}

async function dhcpCounterCounts() {
  let current;
  try {
    current = await getDhcpBackend().dhcpCounters();
  } catch (err) {
    console.warn('[metrics-aggregator] DHCP counters unavailable:', err.message);
    return { dhcpClientMsgs: 0, dhcpServerMsgs: 0 };
  }
  const counts = counterDelta(lastDhcpCounters, current);
  lastDhcpCounters = current;
  return counts;
}

const backendCountsDhcp = () => typeof getDhcpBackend().dhcpCounters === 'function';

/**
 * Single aggregation cycle.
 */
async function aggregate() {
  try {
    const ts = Math.floor(Date.now() / 60_000) * 60; // minute-aligned epoch seconds

    let dnsQueries = 0;
    let dhcpClientMsgs = 0;
    let dhcpServerMsgs = 0;
    for (const tail of logTails) {
      const counts = parseLogLines(tail.log.read(), tail.source, tail);
      dnsQueries += counts.dnsQueries;
      dhcpClientMsgs += counts.dhcpClientMsgs;
      dhcpServerMsgs += counts.dhcpServerMsgs;
    }
    if (backendCountsDhcp()) {
      ({ dhcpClientMsgs, dhcpServerMsgs } = await dhcpCounterCounts());
    }

    // Blocklist blocks from in-memory proxy counters
    const blocklistData = getAndResetBlocklistHits();
    const blocklistBlocks = blocklistData.delta;
    const categoryCounts = blocklistData.categoryHits;

    // GeoIP blocks from in-memory counters
    const geoipBlocks = getBlockedDelta();
    const geoipCountryHits = getAndResetCountryHits();

    // Proxy performance metrics
    const perf = getAndResetPerformanceMetrics();

    // Process-level CPU (delta since last cycle)
    const now = Date.now();
    const cpu = process.cpuUsage(lastCpuUsage);
    const wallMs = now - lastCpuTs;
    const cpuPercent =
      wallMs > 0 && cpu
        ? Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 100 * 100) / 100
        : 0;
    lastCpuUsage = process.cpuUsage();
    lastCpuTs = now;

    // Process-level memory
    const mem = process.memoryUsage();
    const rssMb = Math.round((mem.rss / 1048576) * 10) / 10;
    const heapMb = Math.round((mem.heapUsed / 1048576) * 10) / 10;

    // Record startup_ms only once
    const startupMs = !startupRecorded && perf.startupMs != null ? perf.startupMs : null;
    if (perf.startupMs != null) startupRecorded = true;

    // Insert all metrics in a single transaction
    const insertAll = db.transaction(() => {
      insertMetrics.run(
        ts,
        dnsQueries,
        dhcpClientMsgs + dhcpServerMsgs,
        dhcpClientMsgs,
        dhcpServerMsgs,
        blocklistBlocks,
        geoipBlocks,
      );
      for (const [category, count] of categoryCounts) {
        insertBlocklistHit.run(ts, category, count);
      }
      for (const [country, count] of geoipCountryHits) {
        insertGeoipHit.run(ts, country, count);
      }
      insertProxyPerf.run(
        ts,
        perf.queryCount,
        perf.latencyMin,
        perf.latencyAvg,
        perf.latencyMax,
        perf.latencyP95,
        perf.cacheHits,
        perf.cacheMisses,
        perf.timeouts,
        perf.pendingQueries,
        cpuPercent,
        rssMb,
        heapMb,
        startupMs,
      );
    });
    insertAll();

    // Periodic retention cleanup
    cycleCount++;
    if (cycleCount % RETENTION_CLEANUP_EVERY === 0) {
      const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
      deleteOldMetrics.run(cutoff);
      deleteOldBlocklistHits.run(cutoff);
      deleteOldGeoipHits.run(cutoff);
      deleteOldProxyPerf.run(cutoff);
    }
  } catch (err) {
    console.error('[metrics-aggregator] Error:', err.message);
  }
}

/**
 * Start the metrics aggregator.
 */
export function startMetricsAggregator(database) {
  db = database;

  // Prepare statements
  insertMetrics = db.prepare(
    'INSERT INTO metrics (ts, dns_queries, dhcp_requests, dhcp_client_msgs, dhcp_server_msgs, blocklist_blocks, geoip_blocks) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insertBlocklistHit = db.prepare(
    'INSERT INTO metrics_blocklist_hits (ts, category, count) VALUES (?, ?, ?)',
  );
  insertGeoipHit = db.prepare(
    'INSERT INTO metrics_geoip_hits (ts, country, count) VALUES (?, ?, ?)',
  );
  insertProxyPerf = db.prepare(
    `INSERT INTO metrics_proxy_perf
     (ts, query_count, latency_min, latency_avg, latency_max, latency_p95,
      cache_hits, cache_misses, timeouts, pending_queries,
      cpu_percent, rss_mb, heap_mb, startup_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  deleteOldMetrics = db.prepare('DELETE FROM metrics WHERE ts < ?');
  deleteOldBlocklistHits = db.prepare('DELETE FROM metrics_blocklist_hits WHERE ts < ?');
  deleteOldGeoipHits = db.prepare('DELETE FROM metrics_geoip_hits WHERE ts < ?');
  deleteOldProxyPerf = db.prepare('DELETE FROM metrics_proxy_perf WHERE ts < ?');

  // Start each log from its end (don't process historical lines)
  const countsItself = backendCountsDhcp();
  logTails = selectLogTails(!countsItself).map((tail) => ({
    ...tail,
    log: createLogFollower(tail.source),
  }));
  lastDhcpCounters = null;
  if (countsItself) dhcpCounterCounts();

  timer = setInterval(aggregate, AGGREGATE_INTERVAL_MS);
  console.log('[metrics-aggregator] Started (interval: 60s, retention: 30d)');

  return timer;
}

/**
 * Stop the metrics aggregator.
 */
export function stopMetricsAggregator() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
