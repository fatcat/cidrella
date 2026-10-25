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
import { getDhcpBackend, getService, onBackendChanged } from '../backends/index.js';
import { getAndResetForwarderMetrics } from './encrypted-forwarder.js';

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
let unsubscribeBackend = null;
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
let insertForwarder = null;
let deleteOldMetrics = null;
let deleteOldBlocklistHits = null;
let deleteOldGeoipHits = null;
let deleteOldProxyPerf = null;
let deleteOldForwarder = null;

/** DHCP message counts per family and conversation half, all zero. */
export const emptyDhcpCounts = () => ({
  4: { client: 0, server: 0 },
  6: { client: 0, server: 0 },
});

/**
 * Parse new log lines and return { dnsQueries, dhcp }, where dhcp is
 * { 4: { client, server }, 6: { client, server } }. The two halves are kept
 * apart so the dashboard can show a request the server never answered, and
 * the families so DHCPv4 and DHCPv6 draw on their own charts; dhcp_requests,
 * the column older readers use, stays as the sum of all four. `dns` and
 * `dhcp` say which counts this log is read for.
 */
export function parseLogLines(
  lines,
  source = getService('dns').logSource(),
  { dns = true, dhcp = true } = {},
) {
  const counts = { dnsQueries: 0, dhcp: emptyDhcpCounts() };
  if (!source) return counts;

  for (const line of lines) {
    if (source.querySourceIp(line)) {
      if (dns) counts.dnsQueries++;
    } else if (dhcp) {
      const message = source.dhcpMessage(line);
      if (message) counts.dhcp[message.family][message.direction]++;
    }
  }

  return counts;
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
 * DHCP messages since the last call from the backend's counters
 * ({ 4?: { received, sent }, 6?: { received, sent } }), which are totals
 * since the daemon started: a total that went down means a restart, and the
 * new total is all new. The first call sets the baseline. Returns the shape
 * of emptyDhcpCounts; a family the backend does not serve stays zero.
 */
export function counterDelta(last, current) {
  const counts = emptyDhcpCounts();
  if (!last) return counts;
  for (const family of [4, 6]) {
    const now = current[family];
    const before = last[family];
    if (!now) continue;
    const delta = (key) => (before && now[key] >= before[key] ? now[key] - before[key] : now[key]);
    counts[family] = { client: delta('received'), server: delta('sent') };
  }
  return counts;
}

async function dhcpCounterCounts() {
  let current;
  try {
    current = await getDhcpBackend().dhcpCounters();
  } catch (err) {
    console.warn('[metrics-aggregator] DHCP counters unavailable:', err.message);
    return emptyDhcpCounts();
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
    let dhcp = emptyDhcpCounts();
    for (const tail of logTails) {
      const counts = parseLogLines(tail.log.read(), tail.source, tail);
      dnsQueries += counts.dnsQueries;
      for (const family of [4, 6]) {
        dhcp[family].client += counts.dhcp[family].client;
        dhcp[family].server += counts.dhcp[family].server;
      }
    }
    if (backendCountsDhcp()) dhcp = await dhcpCounterCounts();
    const dhcpClientMsgs = dhcp[4].client + dhcp[6].client;
    const dhcpServerMsgs = dhcp[4].server + dhcp[6].server;

    // Blocklist blocks from in-memory proxy counters
    const blocklistData = getAndResetBlocklistHits();
    const blocklistBlocks = blocklistData.delta;
    const categoryCounts = blocklistData.categoryHits;

    // GeoIP blocks from in-memory counters
    const geoipBlocks = getBlockedDelta();
    const geoipCountryHits = getAndResetCountryHits();

    // Proxy performance metrics
    const perf = getAndResetPerformanceMetrics();
    const forwarderRows = getAndResetForwarderMetrics();

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
        dhcp[4].client,
        dhcp[4].server,
        dhcp[6].client,
        dhcp[6].server,
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
        perf.failures?.dnssec ?? 0,
        perf.failures?.upstream ?? 0,
        perf.failures?.timeout ?? 0,
        perf.failures?.refused ?? 0,
        perf.failures?.other ?? 0,
        perf.nxdomain ?? 0,
      );
      for (const row of forwarderRows) insertForwarder.run({ ts, ...row });
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
      deleteOldForwarder.run(cutoff);
    }
  } catch (err) {
    console.error('[metrics-aggregator] Error:', err.message);
  }
}

// Start each log from its end (don't process historical lines), and take a
// baseline of the DHCP backend's counters when it keeps them. Run again when
// a role moves to another backend.
function bindSources() {
  const countsItself = backendCountsDhcp();
  logTails = selectLogTails(!countsItself).map((tail) => ({
    ...tail,
    log: createLogFollower(tail.source),
  }));
  lastDhcpCounters = null;
  if (countsItself) dhcpCounterCounts();
}

/**
 * Start the metrics aggregator.
 */
export function startMetricsAggregator(database) {
  db = database;

  // Prepare statements
  insertMetrics = db.prepare(
    `INSERT INTO metrics
     (ts, dns_queries, dhcp_requests, dhcp_client_msgs, dhcp_server_msgs,
      dhcp4_client_msgs, dhcp4_server_msgs, dhcp6_client_msgs, dhcp6_server_msgs,
      blocklist_blocks, geoip_blocks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      cpu_percent, rss_mb, heap_mb, startup_ms,
      servfail_dnssec, servfail_upstream, servfail_timeout, servfail_refused, servfail_other,
      nxdomain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  deleteOldMetrics = db.prepare('DELETE FROM metrics WHERE ts < ?');
  deleteOldBlocklistHits = db.prepare('DELETE FROM metrics_blocklist_hits WHERE ts < ?');
  deleteOldGeoipHits = db.prepare('DELETE FROM metrics_geoip_hits WHERE ts < ?');
  deleteOldProxyPerf = db.prepare('DELETE FROM metrics_proxy_perf WHERE ts < ?');
  insertForwarder = db.prepare(
    `INSERT INTO metrics_forwarder
     (ts, provider, address, protocol, queries, answers, timeouts, drops, connect_failures,
      failovers, latency_p50_us, latency_p95_us)
     VALUES (@ts, @provider, @address, @protocol, @queries, @answers, @timeouts, @drops,
      @connect_failures, @failovers, @latency_p50_us, @latency_p95_us)`,
  );
  deleteOldForwarder = db.prepare('DELETE FROM metrics_forwarder WHERE ts < ?');

  bindSources();
  unsubscribeBackend?.();
  unsubscribeBackend = onBackendChanged(bindSources);

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
  unsubscribeBackend?.();
  unsubscribeBackend = null;
}
