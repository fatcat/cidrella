import dgram from 'dgram';
import fs from 'fs';
import path from 'path';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import dnsPacket from 'dns-packet';
import maxmind from 'maxmind';
import { LRUCache } from 'lru-cache';
import { getDb } from '../db/init.js';
import { regenerateDnsmasqConf, signalDnsmasq } from './dnsmasq.js';

const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data');
const GEOIP_DIR = path.join(DATA_DIR, 'geoip');

// Module state
let proxyServer = null;
let mmdbReader = null;
let geoCache = null;
let proxyPort = 5353;
let statsTotal = 0;
let statsBlocked = 0;
let statsAllowed = 0;
let updateTimer = null;

// Pending queries: maps internal ID -> { address, port, originalId, timer }
let pendingQueries = new Map();
let upstreamSocket = null;
let nextQueryId = 1;

function getSetting(key) {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value || null;
}

function setSetting(key, value) {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
}

// Load MMDB database file
export async function loadMmdb() {
  const dbPath = getSetting('geoip_db_path') || path.join(GEOIP_DIR, 'dbip-country-lite.mmdb');
  if (!fs.existsSync(dbPath)) {
    console.warn('GeoIP MMDB file not found:', dbPath);
    mmdbReader = null;
    return false;
  }
  try {
    mmdbReader = await maxmind.open(dbPath);
    geoCache = new LRUCache({ max: 10000, ttl: 60 * 60 * 1000 });
    console.log('GeoIP MMDB loaded:', dbPath);
    return true;
  } catch (err) {
    console.error('Failed to load MMDB:', err.message);
    mmdbReader = null;
    return false;
  }
}

// Lookup country code for an IP
export function lookupCountry(ip) {
  if (!mmdbReader) return null;

  const cached = geoCache?.get(ip);
  if (cached !== undefined) return cached;

  try {
    const result = mmdbReader.get(ip);
    const code = result?.country?.iso_code || null;
    geoCache?.set(ip, code);
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
  const raw = getSetting('dns_upstream_servers');
  try {
    return raw ? JSON.parse(raw) : ['8.8.8.8', '1.1.1.1'];
  } catch {
    return ['8.8.8.8', '1.1.1.1'];
  }
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
    console.warn('GeoIP proxy already running');
    return;
  }

  proxyPort = port || parseInt(getSetting('geoip_proxy_port') || '5353', 10);

  // Create upstream socket for forwarding
  upstreamSocket = dgram.createSocket('udp4');
  upstreamSocket.on('error', (err) => {
    console.error('GeoIP upstream socket error:', err.message);
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
          statsTotal++;
          const nxResponse = createNxdomainResponse({ id: pending.originalId, questions: response.questions });
          proxyServer.send(nxResponse, pending.port, pending.address);
          return;
        }
      }

      // Allowed — forward original response (restore original query ID)
      statsAllowed++;
      statsTotal++;
      const buf = Buffer.from(msg);
      buf.writeUInt16BE(pending.originalId, 0);
      proxyServer.send(buf, pending.port, pending.address);
    } catch (err) {
      console.error('GeoIP response processing error:', err.message);
    }
  });

  // Create proxy server
  proxyServer = dgram.createSocket('udp4');

  proxyServer.on('message', (msg, rinfo) => {
    try {
      const query = dnsPacket.decode(msg);
      const upstreams = getUpstreamServers();
      if (upstreams.length === 0) return;

      // Assign internal query ID to track pending responses
      const internalId = nextQueryId++ & 0xFFFF;
      if (nextQueryId > 0xFFFF) nextQueryId = 1;

      // Store pending query mapping
      const timer = setTimeout(() => {
        // Timeout — forward query directly as fallback (fail-open)
        const p = pendingQueries.get(internalId);
        if (p) {
          pendingQueries.delete(internalId);
          statsAllowed++;
          statsTotal++;
        }
      }, 5000);

      pendingQueries.set(internalId, {
        address: rinfo.address,
        port: rinfo.port,
        originalId: query.id,
        timer
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
      console.error('GeoIP query processing error:', err.message);
    }
  });

  proxyServer.on('error', (err) => {
    console.error('GeoIP proxy error:', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${proxyPort} is already in use`);
      stopProxy();
    }
  });

  proxyServer.bind(proxyPort, '127.0.0.1', () => {
    console.log(`GeoIP DNS proxy listening on 127.0.0.1:${proxyPort}`);
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
  console.log('GeoIP DNS proxy stopped');
}

// Start proxy if geoip_enabled=true (called on server startup)
export async function startProxyIfEnabled() {
  const enabled = getSetting('geoip_enabled');
  if (enabled !== 'true') return;

  const loaded = await loadMmdb();
  if (!loaded) {
    console.warn('GeoIP enabled but MMDB not available — proxy will start without filtering');
  }

  const port = parseInt(getSetting('geoip_proxy_port') || '5353', 10);
  startProxy(port);
}

// Download DB-IP Lite MMDB
export async function downloadMmdb() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const url = `https://download.db-ip.com/free/dbip-country-lite-${year}-${month}.mmdb.gz`;

  fs.mkdirSync(GEOIP_DIR, { recursive: true });

  const dbPath = getSetting('geoip_db_path') || path.join(GEOIP_DIR, 'dbip-country-lite.mmdb');
  const tmpPath = dbPath + '.tmp.' + process.pid;

  console.log('Downloading GeoIP database from:', url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'IPAM-GeoIP/1.0' }
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
    console.log('GeoIP database downloaded successfully');

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
  const dbPath = getSetting('geoip_db_path') || path.join(GEOIP_DIR, 'dbip-country-lite.mmdb');
  const dbExists = fs.existsSync(dbPath);

  return {
    running: proxyServer !== null,
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

// Auto-update scheduler
export function startGeoipScheduler() {
  // Check every 6 hours if MMDB needs updating
  updateTimer = setInterval(async () => {
    const enabled = getSetting('geoip_enabled');
    if (enabled !== 'true') return;

    const lastUpdated = getSetting('geoip_last_updated');
    if (!lastUpdated) return;

    const lastDate = new Date(lastUpdated);
    const daysSinceUpdate = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceUpdate >= 30) {
      console.log('GeoIP database is older than 30 days, downloading update...');
      try {
        await downloadMmdb();
      } catch (err) {
        console.error('GeoIP auto-update failed:', err.message);
      }
    }
  }, 6 * 60 * 60 * 1000);

  // Initial check 15s after startup
  setTimeout(async () => {
    const enabled = getSetting('geoip_enabled');
    if (enabled !== 'true') return;

    const dbPath = getSetting('geoip_db_path') || path.join(GEOIP_DIR, 'dbip-country-lite.mmdb');
    if (!fs.existsSync(dbPath)) {
      console.log('GeoIP enabled but no MMDB found, downloading...');
      try {
        await downloadMmdb();
      } catch (err) {
        console.error('GeoIP initial download failed:', err.message);
      }
    }
  }, 15000);
}
