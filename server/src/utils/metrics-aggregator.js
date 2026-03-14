/**
 * Metrics aggregator — collects DNS, DHCP, blocklist, and GeoIP stats
 * every 60 seconds and persists them to the metrics tables.
 *
 * Dnsmasq log parsing reuses the offset-tracking pattern from passive-liveness.js.
 */

import fs from 'fs';
import path from 'path';
import { getBlockedDelta, getAndResetCountryHits, getAndResetPerformanceMetrics } from './geoip.js';

const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.log');

const AGGREGATE_INTERVAL_MS = 60_000;
const MAX_READ_BYTES = 10 * 1024 * 1024; // 10MB max per cycle
const RETENTION_DAYS = 30;
const RETENTION_CLEANUP_EVERY = 100; // run cleanup every N cycles

// Matches: "query[A] example.com from 192.168.1.100"
const QUERY_RE = /\bquery\[.+?\]\s+\S+\s+from\s+/;
// Matches dnsmasq blocklist replies: "config <domain> is <ip>"
const BLOCK_RE = /\bconfig\s+(\S+)\s+is\s+/;
// Matches DHCP request events: DHCPACK, DHCPREQUEST, DHCPDISCOVER
const DHCP_RE = /\bDHCP(?:ACK|REQUEST|DISCOVER)\b/;

let db = null;
let timer = null;
let logOffset = 0;
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
let lookupCategory = null;

/**
 * Read new bytes appended to the log file since the given offset.
 */
function readNewLines() {
  let size;
  try {
    size = fs.statSync(LOG_FILE).size;
  } catch {
    return [];
  }

  if (size < logOffset) logOffset = 0; // truncated
  if (size === logOffset) return [];

  const bytesToRead = Math.min(size - logOffset, MAX_READ_BYTES);
  const buf = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(LOG_FILE, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, logOffset);
  } finally {
    fs.closeSync(fd);
  }

  logOffset = logOffset + bytesToRead;
  return buf.toString('utf-8').split('\n').filter(l => l.trim());
}

/**
 * Parse new log lines and return { dnsQueries, dhcpRequests, blockedDomains[] }
 */
function parseLogLines(lines) {
  let dnsQueries = 0;
  let dhcpRequests = 0;
  const blockedDomains = [];

  for (const line of lines) {
    if (QUERY_RE.test(line)) {
      dnsQueries++;
    }
    if (DHCP_RE.test(line)) {
      dhcpRequests++;
    }
    const blockMatch = line.match(BLOCK_RE);
    if (blockMatch) {
      blockedDomains.push(blockMatch[1]);
    }
  }

  return { dnsQueries, dhcpRequests, blockedDomains };
}

/**
 * Look up categories for blocked domains in batch.
 * Returns Map<category, count>.
 */
function categorizeBlocks(blockedDomains) {
  const categoryCounts = new Map();
  if (!blockedDomains.length || !lookupCategory) return categoryCounts;

  for (const domain of blockedDomains) {
    const row = lookupCategory.get(domain);
    if (!row?.category_slug) continue; // skip domains not in blocklist DB
    const cat = row.category_slug;
    categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
  }

  return categoryCounts;
}

/**
 * Single aggregation cycle.
 */
function aggregate() {
  try {
    const ts = Math.floor(Date.now() / 60_000) * 60; // minute-aligned epoch seconds

    // Parse dnsmasq log
    const lines = readNewLines();
    const { dnsQueries, dhcpRequests, blockedDomains } = parseLogLines(lines);

    // Blocklist blocks from log
    const blocklistBlocks = blockedDomains.length;
    const categoryCounts = categorizeBlocks(blockedDomains);

    // GeoIP blocks from in-memory counters
    const geoipBlocks = getBlockedDelta();
    const geoipCountryHits = getAndResetCountryHits();

    // Proxy performance metrics
    const perf = getAndResetPerformanceMetrics();

    // Process-level CPU (delta since last cycle)
    const now = Date.now();
    const cpu = process.cpuUsage(lastCpuUsage);
    const wallMs = now - lastCpuTs;
    const cpuPercent = wallMs > 0
      ? Math.round(((cpu.user + cpu.system) / 1000) / wallMs * 100 * 100) / 100
      : 0;
    lastCpuUsage = process.cpuUsage();
    lastCpuTs = now;

    // Process-level memory
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / 1048576 * 10) / 10;
    const heapMb = Math.round(mem.heapUsed / 1048576 * 10) / 10;

    // Record startup_ms only once
    const startupMs = (!startupRecorded && perf.startupMs != null) ? perf.startupMs : null;
    if (perf.startupMs != null) startupRecorded = true;

    // Insert all metrics in a single transaction
    const insertAll = db.transaction(() => {
      insertMetrics.run(ts, dnsQueries, dhcpRequests, blocklistBlocks, geoipBlocks);
      for (const [category, count] of categoryCounts) {
        insertBlocklistHit.run(ts, category, count);
      }
      for (const [country, count] of geoipCountryHits) {
        insertGeoipHit.run(ts, country, count);
      }
      insertProxyPerf.run(
        ts, perf.queryCount,
        perf.latencyMin, perf.latencyAvg, perf.latencyMax, perf.latencyP95,
        perf.cacheHits, perf.cacheMisses,
        perf.timeouts, perf.pendingQueries,
        cpuPercent, rssMb, heapMb, startupMs
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
    'INSERT INTO metrics (ts, dns_queries, dhcp_requests, blocklist_blocks, geoip_blocks) VALUES (?, ?, ?, ?, ?)'
  );
  insertBlocklistHit = db.prepare(
    'INSERT INTO metrics_blocklist_hits (ts, category, count) VALUES (?, ?, ?)'
  );
  insertGeoipHit = db.prepare(
    'INSERT INTO metrics_geoip_hits (ts, country, count) VALUES (?, ?, ?)'
  );
  insertProxyPerf = db.prepare(
    `INSERT INTO metrics_proxy_perf
     (ts, query_count, latency_min, latency_avg, latency_max, latency_p95,
      cache_hits, cache_misses, timeouts, pending_queries,
      cpu_percent, rss_mb, heap_mb, startup_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  deleteOldMetrics = db.prepare('DELETE FROM metrics WHERE ts < ?');
  deleteOldBlocklistHits = db.prepare('DELETE FROM metrics_blocklist_hits WHERE ts < ?');
  deleteOldGeoipHits = db.prepare('DELETE FROM metrics_geoip_hits WHERE ts < ?');
  deleteOldProxyPerf = db.prepare('DELETE FROM metrics_proxy_perf WHERE ts < ?');

  // Category lookup for blocked domains
  try {
    lookupCategory = db.prepare('SELECT category_slug FROM blocklist_domains WHERE domain = ?');
  } catch {
    // Table may not exist if blocklists aren't set up
    lookupCategory = null;
  }

  // Start from end of log file (don't process historical lines)
  try {
    logOffset = fs.statSync(LOG_FILE).size;
  } catch { /* file may not exist yet */ }

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
