import dgram from 'dgram';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import dnsPacket from 'dns-packet';
import maxmind from 'maxmind';
import { LRUCache } from 'lru-cache';
import { getDb, getSetting } from '../db/init.js';
import { logDnsQuery } from '../db/duckdb.js';
import { applyInterfaceConfig, restartDnsmasq } from './dnsmasq.js';
import {
  DATA_DIR,
  GEOIP_CACHE_MAX, GEOIP_CACHE_TTL_MS, GEOIP_QUERY_TIMEOUT_MS,
  GEOIP_DOWNLOAD_TIMEOUT_MS, GEOIP_CHECK_INTERVAL_MS, GEOIP_STARTUP_DELAY_MS,
  PROXY_HEALTH_CHECK_MS, PROXY_MAX_RESTART_ATTEMPTS, PROXY_RESTART_DELAY_MS,
  DNSMASQ_INTERNAL_PORT,
} from '../config/defaults.js';
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
let proxyServers = [];         // Array of { socket, address } — one per LAN address on port 53
let mmdbReader = null;
let geoCache = null;
let statsTotal = 0;
let statsBlocked = 0;
let statsAllowed = 0;
let blockedDelta = 0;
let countryHits = new Map();
let updateTimer = null;

// Bypass mode — when proxy dies and can't restart, dnsmasq takes over port 53
let bypassMode = false;
let healthTimer = null;

// GeoIP rule cache — reloaded on settings change, avoids per-query DB hits
let geoipRuleSet = null;            // Set<string> — enabled country codes
let geoipMode = 'blocklist';        // 'blocklist' or 'allowlist'

// Blocklist state — domains loaded from DB for in-proxy blocking
let blocklistSet = null;            // Set<string> — blocked domains (lowercase)
let blocklistCategoryMap = null;    // Map<string, string> — domain → category_slug
let blocklistEnabled = false;
let blocklistRedirectIp = '';
let blocklistBlockedDelta = 0;
let blocklistCategoryHits = new Map();

// Performance instrumentation
const MAX_LATENCY_SAMPLES = 60000;  // Cap at ~1 minute of 1K qps
let latencySamples = [];
function recordLatency(us) { if (latencySamples.length < MAX_LATENCY_SAMPLES) latencySamples.push(us); }
let cacheHits = 0;
let cacheMisses = 0;
let timeoutCount = 0;
let proxyStartedAt = null;
let proxyStartupMs = null;

// Pending queries: maps internal ID -> { address, port, originalId, timer, socket }
const MAX_PENDING_QUERIES = 10000;
let pendingQueries = new Map();
let dnsmasqSocket = null;      // UDP socket for forwarding to dnsmasq on 127.0.0.1:5353
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

// Load GeoIP rules into memory (call on startup and settings change)
export function loadGeoipRules() {
  const db = getDb();
  geoipMode = getSetting('geoip_mode') || 'blocklist';
  const enabledRules = db.prepare('SELECT country_code FROM geoip_rules WHERE enabled = 1').all();
  geoipRuleSet = new Set(enabledRules.map(r => r.country_code));
  proxyLog('info', 'GeoIP rules loaded', { count: geoipRuleSet.size, mode: geoipMode });
}

// Check if query should be blocked based on resolved country codes (uses cached rules)
function shouldBlock(countryCodes) {
  if (!geoipRuleSet) return false;

  if (geoipRuleSet.size === 0) {
    return geoipMode === 'allowlist';
  }

  if (geoipMode === 'blocklist') {
    return countryCodes.some(cc => geoipRuleSet.has(cc));
  } else {
    return countryCodes.some(cc => !geoipRuleSet.has(cc));
  }
}

// Get LAN IPv4 addresses to bind proxy sockets on port 53
function getListenAddresses() {
  const db = getDb();
  let ifaceConfig = {};
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'interface_config'").get();
    if (row?.value) ifaceConfig = JSON.parse(row.value);
  } catch { /* use default */ }

  const sysIfaces = os.networkInterfaces();
  const addresses = [];

  if (Object.keys(ifaceConfig).length > 0) {
    // Explicit config — bind to IPs on configured interfaces
    for (const [ifName, cfg] of Object.entries(ifaceConfig)) {
      if (!cfg.dns) continue;
      const addrs = sysIfaces[ifName];
      if (!addrs) continue;
      for (const a of addrs) {
        if (a.family === 'IPv4') addresses.push(a.address);
      }
    }
  } else {
    // No explicit config — bind to all non-loopback IPv4 addresses
    for (const [ifName, addrs] of Object.entries(sysIfaces)) {
      if (ifName === 'lo') continue;
      for (const a of addrs) {
        if (a.family === 'IPv4') addresses.push(a.address);
      }
    }
  }

  return addresses;
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

// Create a blocked response — redirect IP (A record) or NXDOMAIN
function createBlockedResponse(query) {
  if (blocklistRedirectIp) {
    return dnsPacket.encode({
      id: query.id,
      type: 'response',
      flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
      questions: query.questions,
      answers: query.questions
        .filter(q => q.type === 'A')
        .map(q => ({ type: 'A', name: q.name, ttl: 300, data: blocklistRedirectIp })),
      authorities: [],
      additionals: []
    });
  }
  return createNxdomainResponse(query);
}

// Load blocklist domains from DB into Set + category Map
export function loadBlocklist() {
  const db = getDb();
  const enabled = getSetting('blocklist_enabled');
  blocklistEnabled = (enabled === 'true');
  blocklistRedirectIp = getSetting('blocklist_redirect_ip') || '';

  if (!blocklistEnabled) {
    blocklistSet = null;
    blocklistCategoryMap = null;
    proxyLog('info', 'Blocklist disabled — cleared in-memory set');
    return;
  }

  const rows = db.prepare(`
    SELECT DISTINCT bd.domain, bd.category_slug
    FROM blocklist_domains bd
    JOIN blocklist_categories bc ON bd.category_slug = bc.slug
    WHERE bc.enabled = 1
      AND bd.domain NOT IN (SELECT domain FROM blocklist_whitelist)
  `).all();

  const newSet = new Set();
  const newMap = new Map();
  for (const row of rows) {
    newSet.add(row.domain);
    if (!newMap.has(row.domain)) {
      newMap.set(row.domain, row.category_slug);
    }
  }

  blocklistSet = newSet;
  blocklistCategoryMap = newMap;
  proxyLog('info', 'Blocklist loaded', { domains: newSet.size });
}

// Check query domain against blocklist (walks domain hierarchy for subdomain matching)
function checkBlocklist(queryName) {
  if (!blocklistEnabled || !blocklistSet) return null;

  const name = queryName.toLowerCase();
  const labels = name.split('.');

  // Walk hierarchy: sub.evil.com → evil.com (stop before single-label TLD)
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    if (blocklistSet.has(candidate)) {
      return blocklistCategoryMap.get(candidate) || 'unknown';
    }
  }
  return null;
}

// Get and reset blocklist hit counts (for metrics aggregator)
export function getAndResetBlocklistHits() {
  const delta = blocklistBlockedDelta;
  blocklistBlockedDelta = 0;
  const cats = new Map(blocklistCategoryHits);
  blocklistCategoryHits = new Map();
  return { delta, categoryHits: cats };
}

// Handle a DNS query from any proxy socket
function handleQuery(msg, rinfo, sock) {
  try {
    const startNs = process.hrtime.bigint();
    const query = dnsPacket.decode(msg);

    // Extract query metadata for analytics
    const queryName = query.questions?.[0]?.name;
    const queryType = query.questions?.[0]?.type || 'A';

    // Blocklist check — intercept before forwarding to dnsmasq
    if (queryName) {
      const blockedCategory = checkBlocklist(queryName);
      if (blockedCategory) {
        statsBlocked++;
        statsTotal++;
        blocklistBlockedDelta++;
        blocklistCategoryHits.set(blockedCategory, (blocklistCategoryHits.get(blockedCategory) || 0) + 1);
        const response = createBlockedResponse(query);
        sock.send(response, rinfo.port, rinfo.address);
        const latencyUs = Number(process.hrtime.bigint() - startNs) / 1000;
        recordLatency(latencyUs);
        logDnsQuery({
          clientIp: rinfo.address, domain: queryName, queryType,
          responseCode: blocklistRedirectIp ? 'NOERROR' : 'NXDOMAIN',
          action: 'blocked_blocklist', blockReason: blockedCategory,
          latencyUs,
        });
        return;
      }
    }

    // Circuit breaker — reject when too many queries are pending
    if (pendingQueries.size >= MAX_PENDING_QUERIES) {
      statsTotal++;
      const servfail = dnsPacket.encode({
        id: query.id, type: 'response', rcode: 'SERVFAIL',
        questions: query.questions || [], answers: [], authorities: [], additionals: []
      });
      sock.send(servfail, rinfo.port, rinfo.address);
      return;
    }

    // Assign internal query ID to track pending responses (skip collisions)
    let internalId = nextQueryId++ & 0xFFFF;
    if (nextQueryId > 0xFFFF) nextQueryId = 1;
    let tries = 0;
    while (pendingQueries.has(internalId) && tries++ < 10) {
      internalId = nextQueryId++ & 0xFFFF;
      if (nextQueryId > 0xFFFF) nextQueryId = 1;
    }

    // Store pending query mapping (includes the socket that received the query + query metadata)
    const timer = setTimeout(() => {
      // Timeout — send SERVFAIL so client doesn't hang
      const p = pendingQueries.get(internalId);
      if (p) {
        pendingQueries.delete(internalId);
        statsAllowed++;
        statsTotal++;
        timeoutCount++;
        const latencyUs = Number(process.hrtime.bigint() - p.startNs) / 1000;
        recordLatency(latencyUs);
        logDnsQuery({
          clientIp: p.address, domain: p.queryName, queryType: p.queryType,
          responseCode: 'SERVFAIL', action: 'allowed', latencyUs,
        });
        try {
          const servfail = dnsPacket.encode({
            id: p.originalId, type: 'response', rcode: 'SERVFAIL',
            questions: [], answers: [], authorities: [], additionals: []
          });
          p.socket.send(servfail, p.port, p.address);
        } catch { /* ignore */ }
      }
    }, GEOIP_QUERY_TIMEOUT_MS);

    pendingQueries.set(internalId, {
      address: rinfo.address,
      port: rinfo.port,
      originalId: query.id,
      socket: sock,
      queryName: queryName || '',
      queryType,
      timer,
      startNs
    });

    // Rewrite query ID and forward to dnsmasq on localhost:5353
    const fwdBuf = Buffer.from(msg);
    fwdBuf.writeUInt16BE(internalId, 0);
    dnsmasqSocket.send(fwdBuf, DNSMASQ_INTERNAL_PORT, '127.0.0.1');
  } catch (err) {
    proxyLog('error', 'Query processing error', { error: err.message });
  }
}

// Handle a response from dnsmasq
function handleDnsmasqResponse(msg) {
  try {
    const response = dnsPacket.decode(msg);
    const pending = pendingQueries.get(response.id);
    if (!pending) return;

    pendingQueries.delete(response.id);
    clearTimeout(pending.timer);

    // GeoIP check — inspect resolved IPs
    const ips = response.answers
      .filter(a => a.type === 'A' || a.type === 'AAAA')
      .map(a => a.data);

    if (ips.length > 0) {
      const countryCodes = ips
        .map(ip => lookupCountry(ip))
        .filter(cc => cc !== null);

      if (countryCodes.length > 0 && shouldBlock(countryCodes)) {
        statsBlocked++;
        blockedDelta++;
        statsTotal++;
        for (const cc of countryCodes) {
          countryHits.set(cc, (countryHits.get(cc) || 0) + 1);
        }
        const nxResponse = createNxdomainResponse({ id: pending.originalId, questions: response.questions });
        pending.socket.send(nxResponse, pending.port, pending.address);
        const latencyUs = Number(process.hrtime.bigint() - pending.startNs) / 1000;
        recordLatency(latencyUs);
        logDnsQuery({
          clientIp: pending.address, domain: pending.queryName, queryType: pending.queryType,
          responseCode: 'NXDOMAIN', action: 'blocked_geoip',
          blockReason: countryCodes[0], latencyUs, resolvedIp: ips[0],
        });
        return;
      }
    }

    // Allowed — forward original response (restore original query ID)
    statsAllowed++;
    statsTotal++;
    const buf = Buffer.from(msg);
    buf.writeUInt16BE(pending.originalId, 0);
    pending.socket.send(buf, pending.port, pending.address);
    const latencyUs = Number(process.hrtime.bigint() - pending.startNs) / 1000;
    recordLatency(latencyUs);

    // Extract response code name and first resolved IP
    const rcodeNames = ['NOERROR','FORMERR','SERVFAIL','NXDOMAIN','NOTIMP','REFUSED'];
    const rcode = response.rcode || rcodeNames[0];
    const firstIp = ips.length > 0 ? ips[0] : null;
    logDnsQuery({
      clientIp: pending.address, domain: pending.queryName, queryType: pending.queryType,
      responseCode: rcode, action: 'allowed', latencyUs, resolvedIp: firstIp,
    });
  } catch (err) {
    proxyLog('error', 'Response processing error', { error: err.message });
  }
}

// Start the DNS proxy — binds one UDP socket per LAN address on port 53
export function startProxy() {
  if (proxyServers.length > 0) {
    proxyLog('warn', 'Proxy already running');
    return;
  }

  proxyStartedAt = Date.now();

  // Create socket for forwarding to dnsmasq
  dnsmasqSocket = dgram.createSocket('udp4');
  dnsmasqSocket.on('error', (err) => {
    proxyLog('error', 'dnsmasq socket error', { error: err.message });
  });
  dnsmasqSocket.on('message', (msg) => handleDnsmasqResponse(msg));

  // Bind one socket per LAN address on port 53
  const addresses = getListenAddresses();
  if (addresses.length === 0) {
    proxyLog('warn', 'No LAN addresses found — proxy has nothing to bind to');
    return;
  }

  let bindCount = 0;
  for (const addr of addresses) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('message', (msg, rinfo) => handleQuery(msg, rinfo, sock));

    sock.on('error', (err) => {
      proxyLog('error', 'Proxy socket error', { address: addr, error: err.message, code: err.code });
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        proxyLog('error', 'Cannot bind port 53', { address: addr });
      }
    });

    sock.on('close', () => {
      // Remove from proxyServers array
      const idx = proxyServers.findIndex(s => s.socket === sock);
      if (idx >= 0) proxyServers.splice(idx, 1);
      if (proxyServers.length === 0) {
        proxyLog('warn', 'All proxy sockets closed');
      }
    });

    sock.bind(53, addr, () => {
      bindCount++;
      proxyLog('info', 'Proxy socket bound', { address: `${addr}:53` });
      if (bindCount === addresses.length) {
        proxyStartupMs = Date.now() - proxyStartedAt;
        proxyLog('info', 'Proxy fully started', { sockets: bindCount, startupMs: proxyStartupMs });
        if (!healthTimer) startHealthMonitor();
      }
    });

    proxyServers.push({ socket: sock, address: addr });
  }
}

// Stop the DNS proxy
export function stopProxy() {
  for (const { socket } of proxyServers) {
    try { socket.close(); } catch { /* ignore */ }
  }
  proxyServers = [];

  if (dnsmasqSocket) {
    try { dnsmasqSocket.close(); } catch { /* ignore */ }
    dnsmasqSocket = null;
  }

  // Clear pending queries
  for (const [, pending] of pendingQueries) {
    clearTimeout(pending.timer);
  }
  pendingQueries.clear();
  stopHealthMonitor();
  proxyLog('info', 'Proxy stopped');
}

// Rebind proxy sockets (called when interface config changes)
export function rebindProxy() {
  proxyLog('info', 'Rebinding proxy to updated interface config');
  stopProxy();
  startProxy();
}

// Health monitor — detects proxy death, attempts restart, fails open if unrecoverable
function startHealthMonitor() {
  stopHealthMonitor();
  healthTimer = setInterval(async () => {
    if (proxyServers.length > 0) return; // proxy is alive
    if (bypassMode) return; // already bypassed, nothing to do

    proxyLog('warn', 'Proxy appears dead, attempting restart');

    for (let attempt = 1; attempt <= PROXY_MAX_RESTART_ATTEMPTS; attempt++) {
      try {
        startProxy();
        // Give sockets a moment to bind
        await new Promise(r => setTimeout(r, 500));
        if (proxyServers.length > 0) {
          proxyLog('info', 'Proxy restarted successfully', { attempt });
          if (bypassMode) deactivateBypass();
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

// Bypass: dnsmasq takes over port 53 on LAN IPs directly (requires full restart for port change)
function activateBypass() {
  if (bypassMode) return;
  bypassMode = true;
  proxyLog('error', 'All restart attempts failed — activating bypass mode (dnsmasq takes port 53)');
  try {
    const db = getDb();
    // Temporarily override: dnsmasq listens on port 53 + LAN IPs
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dns_proxy_bypass', 'true')").run();
    applyInterfaceConfig(db);
    restartDnsmasq();
    proxyLog('info', 'dnsmasq reconfigured for bypass mode (port 53 on LAN)');
  } catch (err) {
    proxyLog('error', 'Failed to reconfigure dnsmasq for bypass', { error: err.message });
  }
}

function deactivateBypass() {
  bypassMode = false;
  proxyLog('info', 'Bypass deactivated — proxy recovered');
  try {
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key = 'dns_proxy_bypass'").run();
    applyInterfaceConfig(db);
    restartDnsmasq();
  } catch (err) {
    proxyLog('error', 'Failed to deactivate bypass', { error: err.message });
  }
}

// Check if proxy is in bypass mode
export function isProxyBypassed() {
  return bypassMode;
}

// Start proxy (always-on — called on server startup)
export async function startProxyIfEnabled() {
  const geoipOn = getSetting('geoip_enabled') === 'true';
  const blocklistOn = getSetting('blocklist_enabled') === 'true';

  if (geoipOn) {
    loadGeoipRules();
    const loaded = await loadMmdb();
    if (!loaded) {
      proxyLog('warn', 'GeoIP enabled but MMDB not available — proxy will start without GeoIP filtering');
    }
  }

  if (blocklistOn) {
    loadBlocklist();
  }

  startProxy();
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
    running: proxyServers.length > 0,
    bypassed: bypassMode,
    port: 53,
    listenAddresses: proxyServers.map(s => s.address),
    dbLoaded: mmdbReader !== null,
    dbExists,
    dbPath,
    dbLastUpdated: lastUpdated || null,
    statsTotal,
    statsBlocked,
    statsAllowed,
    blocklistLoaded: blocklistSet !== null,
    blocklistDomainCount: blocklistSet?.size || 0,
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
