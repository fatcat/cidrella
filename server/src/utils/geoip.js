import dgram from 'dgram';
import fs from 'fs';
import path from 'path';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import dnsPacket from 'dns-packet';
import maxmind from 'maxmind';
import { LRUCache } from 'lru-cache';
import { getDb, getSetting } from '../db/init.js';
import { regenerateDnsmasqConf, signalDnsmasq } from './dnsmasq.js';
import {
  GEOIP_CACHE_MAX, GEOIP_CACHE_TTL_MS, GEOIP_QUERY_TIMEOUT_MS,
  GEOIP_DOWNLOAD_TIMEOUT_MS, GEOIP_CHECK_INTERVAL_MS, GEOIP_STARTUP_DELAY_MS,
  PROXY_HEALTH_CHECK_MS, PROXY_MAX_RESTART_ATTEMPTS, PROXY_RESTART_DELAY_MS,
} from '../config/defaults.js';

const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data');
const GEOIP_DIR = path.join(DATA_DIR, 'geoip');
const DEFAULT_MMDB = path.join(GEOIP_DIR, 'dbip-country-lite.mmdb');

function resolveDbPath() {
  const p = getSetting('geoip_db_path');
  return (!p || p === 'auto') ? DEFAULT_MMDB : p;
}

// Structured logging helper
function proxyLog(level, msg, extra) {
  const ts = new Date().toISOString();
  const prefix = `[dns-proxy] ${ts}`;
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  if (level === 'error') console.error(`${prefix} ERROR: ${msg}${suffix}`);
  else if (level === 'warn') console.warn(`${prefix} WARN: ${msg}${suffix}`);
  else console.log(`${prefix} ${msg}${suffix}`);
}

// Module state
let proxyServer = null;
let mmdbReader = null;
let geoCache = null;
let proxyPort = 0;
let statsTotal = 0;
let statsBlocked = 0;
let statsAllowed = 0;
let blockedDelta = 0;
let countryHits = new Map();
let updateTimer = null;

// Bypass mode — when proxy dies and can't restart, DNS goes direct to upstream
let bypassMode = false;
let healthTimer = null;

// Performance instrumentation
let latencySamples = [];
let cacheHits = 0;
let cacheMisses = 0;
let timeoutCount = 0;
let proxyStartedAt = null;
let proxyStartupMs = null;

// Pending queries: maps internal ID -> { address, port, originalId, timer }
let pendingQueries = new Map();
let upstreamSocket = null;
let nextQueryId = 1;

function setSetting(key, value) {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
}

// Load MMDB database file
export async function loadMmdb() {
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) {
    proxyLog('warn', 'MMDB file not found', { path: dbPath });
    mmdbReader = null;
    return false;
  }
  try {
    mmdbReader = await maxmind.open(dbPath);
    geoCache = new LRUCache({ max: GEOIP_CACHE_MAX, ttl: GEOIP_CACHE_TTL_MS });
    proxyLog('info', 'MMDB loaded', { path: dbPath });
    return true;
  } catch (err) {
    proxyLog('error', 'Failed to load MMDB', { error: err.message });
    mmdbReader = null;
    return false;
  }
}

// Lookup country code for an IP
export function lookupCountry(ip) {
  if (!mmdbReader) return null;

  const cached = geoCache?.get(ip);
  if (cached !== undefined) { cacheHits++; return cached; }

  try {
    const result = mmdbReader.get(ip);
    const code = result?.country?.iso_code || null;
    geoCache?.set(ip, code);
    cacheMisses++;
    return code;
  } catch {
    return null;
  }
}

// Check if query should be blocked based on resolved country codes
function shouldBlock(countryCodes) {
  const db = getDb();
  const mode = getSetting('geoip_mode') || 'blocklist';
  const enabledRules = db.prepare('SELECT country_code FROM geoip_rules WHERE enabled = 1').all();
  const ruleSet = new Set(enabledRules.map(r => r.country_code));

  if (ruleSet.size === 0) {
    // No rules configured — blocklist blocks nothing, allowlist blocks everything
    return mode === 'allowlist';
  }

  if (mode === 'blocklist') {
    // Block if any resolved IP is in a blocked country
    return countryCodes.some(cc => ruleSet.has(cc));
  } else {
    // Allowlist: block if any resolved IP is NOT in an allowed country
    return countryCodes.some(cc => !ruleSet.has(cc));
  }
}

function getUpstreamServers() {
  return getSetting('dns_upstream_servers');
}

// Create NXDOMAIN response for a query
function createNxdomainResponse(query) {
  return dnsPacket.encode({
    id: query.id,
    type: 'response',
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
    rcode: 'NXDOMAIN',
    questions: query.questions,
    answers: [],
    authorities: [],
    additionals: []
  });
}

// Start the GeoIP DNS proxy
export function startProxy(port) {
  if (proxyServer) {
    proxyLog('warn', 'Proxy already running');
    return;
  }

  proxyStartedAt = Date.now();
  proxyPort = port || parseInt(getSetting('geoip_proxy_port'), 10) || 5353;

  // Create upstream socket for forwarding
  upstreamSocket = dgram.createSocket('udp4');
  upstreamSocket.on('error', (err) => {
    proxyLog('error', 'Upstream socket error', { error: err.message });
  });

  // Handle upstream responses
  upstreamSocket.on('message', (msg, rinfo) => {
    try {
      const response = dnsPacket.decode(msg);
      const pending = pendingQueries.get(response.id);
      if (!pending) return;

      pendingQueries.delete(response.id);
      clearTimeout(pending.timer);

      // Extract A and AAAA record IPs
      const ips = response.answers
        .filter(a => a.type === 'A' || a.type === 'AAAA')
        .map(a => a.data);

      if (ips.length > 0) {
        const countryCodes = ips
          .map(ip => lookupCountry(ip))
          .filter(cc => cc !== null);

        if (countryCodes.length > 0 && shouldBlock(countryCodes)) {
          // Blocked — send NXDOMAIN back to client
          statsBlocked++;
          blockedDelta++;
          statsTotal++;
          for (const cc of countryCodes) {
            countryHits.set(cc, (countryHits.get(cc) || 0) + 1);
          }
          const nxResponse = createNxdomainResponse({ id: pending.originalId, questions: response.questions });
          proxyServer.send(nxResponse, pending.port, pending.address);
          latencySamples.push(Number(process.hrtime.bigint() - pending.startNs) / 1000);
          return;
        }
      }

      // Allowed — forward original response (restore original query ID)
      statsAllowed++;
      statsTotal++;
      const buf = Buffer.from(msg);
      buf.writeUInt16BE(pending.originalId, 0);
      proxyServer.send(buf, pending.port, pending.address);
      latencySamples.push(Number(process.hrtime.bigint() - pending.startNs) / 1000);
    } catch (err) {
      proxyLog('error', 'Response processing error', { error: err.message });
    }
  });

  // Create proxy server
  proxyServer = dgram.createSocket('udp4');

  proxyServer.on('message', (msg, rinfo) => {
    try {
      const startNs = process.hrtime.bigint();
      const query = dnsPacket.decode(msg);
      const upstreams = getUpstreamServers();
      if (upstreams.length === 0) return;

      // Assign internal query ID to track pending responses
      const internalId = nextQueryId++ & 0xFFFF;
      if (nextQueryId > 0xFFFF) nextQueryId = 1;

      // Store pending query mapping
      const timer = setTimeout(() => {
        // Timeout — send SERVFAIL so client doesn't hang
        const p = pendingQueries.get(internalId);
        if (p) {
          pendingQueries.delete(internalId);
          statsAllowed++;
          statsTotal++;
          timeoutCount++;
          latencySamples.push(Number(process.hrtime.bigint() - p.startNs) / 1000);
          try {
            const servfail = dnsPacket.encode({
              id: p.originalId, type: 'response', rcode: 'SERVFAIL',
              questions: [], answers: [], authorities: [], additionals: []
            });
            proxyServer?.send(servfail, p.port, p.address);
          } catch { /* ignore */ }
        }
      }, GEOIP_QUERY_TIMEOUT_MS);

      pendingQueries.set(internalId, {
        address: rinfo.address,
        port: rinfo.port,
        originalId: query.id,
        timer,
        startNs
      });

      // Rewrite query ID and forward to upstream
      const fwdBuf = Buffer.from(msg);
      fwdBuf.writeUInt16BE(internalId, 0);

      const upstream = upstreams[0];
      const [upstreamHost, upstreamPort] = upstream.includes('#')
        ? [upstream.split('#')[0], parseInt(upstream.split('#')[1], 10)]
        : [upstream, 53];
      upstreamSocket.send(fwdBuf, upstreamPort, upstreamHost);
    } catch (err) {
      proxyLog('error', 'Query processing error', { error: err.message });
    }
  });

  proxyServer.on('error', (err) => {
    proxyLog('error', 'Proxy socket error', { error: err.message, code: err.code });
    if (err.code === 'EADDRINUSE') {
      proxyLog('error', 'Port already in use, stopping proxy', { port: proxyPort });
      stopProxy();
    }
  });

  proxyServer.on('close', () => {
    proxyLog('warn', 'Proxy socket closed unexpectedly');
    proxyServer = null;
  });

  proxyServer.bind(proxyPort, '127.0.0.1', () => {
    proxyStartupMs = Date.now() - proxyStartedAt;
    proxyLog('info', 'Proxy listening', { address: `127.0.0.1:${proxyPort}`, startupMs: proxyStartupMs });
    startHealthMonitor();
  });
}

// Stop the GeoIP DNS proxy
export function stopProxy() {
  if (proxyServer) {
    try { proxyServer.close(); } catch { /* ignore */ }
    proxyServer = null;
  }
  if (upstreamSocket) {
    try { upstreamSocket.close(); } catch { /* ignore */ }
    upstreamSocket = null;
  }
  // Clear pending queries
  for (const [, pending] of pendingQueries) {
    clearTimeout(pending.timer);
  }
  pendingQueries.clear();
  stopHealthMonitor();
  proxyLog('info', 'Proxy stopped');
}

// Health monitor — detects proxy death, attempts restart, fails open if unrecoverable
function startHealthMonitor() {
  stopHealthMonitor();
  healthTimer = setInterval(async () => {
    if (proxyServer !== null) return; // proxy is alive
    if (bypassMode) return; // already bypassed, nothing to do

    proxyLog('warn', 'Proxy appears dead, attempting restart');

    for (let attempt = 1; attempt <= PROXY_MAX_RESTART_ATTEMPTS; attempt++) {
      try {
        const port = parseInt(getSetting('geoip_proxy_port'), 10) || 5353;
        startProxy(port);
        // Give the socket a moment to bind
        await new Promise(r => setTimeout(r, 500));
        if (proxyServer !== null) {
          proxyLog('info', 'Proxy restarted successfully', { attempt });
          if (bypassMode) {
            bypassMode = false;
            proxyLog('info', 'Bypass deactivated — proxy recovered');
            regenerateDnsmasqConf(getDb());
            signalDnsmasq();
          }
          return;
        }
      } catch (err) {
        proxyLog('error', 'Restart attempt failed', { attempt, error: err.message });
      }
      if (attempt < PROXY_MAX_RESTART_ATTEMPTS) {
        await new Promise(r => setTimeout(r, PROXY_RESTART_DELAY_MS));
      }
    }

    // All restart attempts failed — activate bypass
    activateBypass();
  }, PROXY_HEALTH_CHECK_MS);
}

function stopHealthMonitor() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

function activateBypass() {
  if (bypassMode) return;
  bypassMode = true;
  proxyLog('error', 'All restart attempts failed — activating bypass mode (DNS goes direct to upstream)');
  try {
    regenerateDnsmasqConf(getDb());
    signalDnsmasq();
    proxyLog('info', 'dnsmasq reconfigured with direct upstream servers');
  } catch (err) {
    proxyLog('error', 'Failed to reconfigure dnsmasq for bypass', { error: err.message });
  }
}

// Check if proxy is in bypass mode (used by dnsmasq.js)
export function isProxyBypassed() {
  return bypassMode;
}

// Start proxy if geoip_enabled=true (called on server startup)
export async function startProxyIfEnabled() {
  const enabled = getSetting('geoip_enabled');
  if (enabled !== 'true') return;

  const loaded = await loadMmdb();
  if (!loaded) {
    proxyLog('warn', 'GeoIP enabled but MMDB not available — proxy will start without filtering');
  }

  const port = parseInt(getSetting('geoip_proxy_port'), 10) || 5353;
  startProxy(port);
}

// Download DB-IP Lite MMDB
export async function downloadMmdb() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const url = `https://download.db-ip.com/free/dbip-country-lite-${year}-${month}.mmdb.gz`;

  fs.mkdirSync(GEOIP_DIR, { recursive: true });

  const dbPath = resolveDbPath();
  const tmpPath = dbPath + '.tmp.' + process.pid;

  proxyLog('info', 'Downloading GeoIP database', { url });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEOIP_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'CIDRella-GeoIP/1.0' }
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    // Pipe gzipped response through gunzip to file
    const gunzip = createGunzip();
    const fileStream = fs.createWriteStream(tmpPath);
    const body = Readable.fromWeb(response.body);

    await pipeline(body, gunzip, fileStream);

    // Atomic rename
    fs.renameSync(tmpPath, dbPath);

    setSetting('geoip_last_updated', new Date().toISOString());
    proxyLog('info', 'GeoIP database downloaded successfully');

    // Reload the MMDB reader
    await loadMmdb();

    return true;
  } catch (err) {
    clearTimeout(timeout);
    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw new Error(`Failed to download GeoIP database: ${err.message}`);
  }
}

// Get proxy status
export function getProxyStatus() {
  const lastUpdated = getSetting('geoip_last_updated');
  const dbPath = resolveDbPath();
  const dbExists = fs.existsSync(dbPath);

  return {
    running: proxyServer !== null,
    bypassed: bypassMode,
    port: proxyPort,
    dbLoaded: mmdbReader !== null,
    dbExists,
    dbPath,
    dbLastUpdated: lastUpdated || null,
    statsTotal,
    statsBlocked,
    statsAllowed
  };
}

// Reset stats
export function resetStats() {
  statsTotal = 0;
  statsBlocked = 0;
  statsAllowed = 0;
}

// Get and reset blocked count delta (for metrics aggregator)
export function getBlockedDelta() {
  const val = blockedDelta;
  blockedDelta = 0;
  return val;
}

// Get and reset per-country hit counts (for metrics aggregator)
export function getAndResetCountryHits() {
  const copy = new Map(countryHits);
  countryHits = new Map();
  return copy;
}

// Get and reset performance metrics (for metrics aggregator)
export function getAndResetPerformanceMetrics() {
  const samples = latencySamples;
  latencySamples = [];

  const hits = cacheHits;
  const misses = cacheMisses;
  cacheHits = 0;
  cacheMisses = 0;

  const timeouts = timeoutCount;
  timeoutCount = 0;

  const pending = pendingQueries.size;

  if (samples.length === 0) {
    return {
      queryCount: 0,
      latencyMin: null, latencyAvg: null, latencyMax: null, latencyP95: null,
      cacheHits: hits, cacheMisses: misses,
      timeouts, pendingQueries: pending, startupMs: proxyStartupMs,
    };
  }

  samples.sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  const p95Idx = Math.floor(samples.length * 0.95);

  return {
    queryCount: samples.length,
    latencyMin: Math.round(samples[0]),
    latencyAvg: Math.round(sum / samples.length),
    latencyMax: Math.round(samples[samples.length - 1]),
    latencyP95: Math.round(samples[p95Idx]),
    cacheHits: hits, cacheMisses: misses,
    timeouts, pendingQueries: pending, startupMs: proxyStartupMs,
  };
}

// Map schedule setting to interval in days
function scheduleToDays(schedule) {
  switch (schedule) {
    case 'weekly': return 7;
    case 'biweekly': return 14;
    case 'monthly': return 30;
    default: return 0; // 'off'
  }
}

// Auto-update scheduler
export function startGeoipScheduler() {
  // Check every 6 hours if MMDB needs updating
  updateTimer = setInterval(async () => {
    try {
      const enabled = getSetting('geoip_enabled');
      if (enabled !== 'true') return;

      const schedule = getSetting('geoip_update_schedule') || 'monthly';
      if (schedule === 'off') return;

      const intervalDays = scheduleToDays(schedule);
      if (intervalDays === 0) return;

      const lastUpdated = getSetting('geoip_last_updated');
      if (!lastUpdated) return;

      const lastDate = new Date(lastUpdated);
      const daysSinceUpdate = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSinceUpdate >= intervalDays) {
        proxyLog('info', `GeoIP database is older than ${intervalDays} days, downloading update`);
        try {
          await downloadMmdb();
        } catch (err) {
          proxyLog('error', 'GeoIP auto-update failed', { error: err.message });
        }
      }
    } catch (err) {
      proxyLog('error', 'GeoIP scheduler error', { error: err.message });
    }
  }, GEOIP_CHECK_INTERVAL_MS);

  // Initial check after startup
  setTimeout(async () => {
    const enabled = getSetting('geoip_enabled');
    if (enabled !== 'true') return;

    const dbPath = resolveDbPath();
    if (!fs.existsSync(dbPath)) {
      proxyLog('info', 'GeoIP enabled but no MMDB found, downloading');
      try {
        await downloadMmdb();
      } catch (err) {
        proxyLog('error', 'GeoIP initial download failed', { error: err.message });
      }
    }
  }, GEOIP_STARTUP_DELAY_MS);
}
