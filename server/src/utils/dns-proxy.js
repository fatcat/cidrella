import dgram from 'dgram';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import dnsPacket from 'dns-packet';
import maxmind from 'maxmind';
import { LRUCache } from 'lru-cache';
import { getDb, getSetting, setSetting } from '../db/init.js';
import { selectInterfaceNames } from './interface-config.js';
import * as Setting from '../models/setting.js';
import { logDnsQuery } from '../db/duckdb.js';
import { applyInterfaceConfig, restartDnsmasq } from './dnsmasq.js';
import { recordDnsQueryLiveness } from './ip-liveness.js';
import { parseCidrEntry, ipInAny } from './cidr-match.js';
import { frameTcpMessage, extractTcpMessages } from './dns-wire.js';
import {
  DATA_DIR,
  GEOIP_CACHE_MAX, GEOIP_CACHE_TTL_MS, GEOIP_QUERY_TIMEOUT_MS,
  GEOIP_DOWNLOAD_TIMEOUT_MS, GEOIP_CHECK_INTERVAL_MS, GEOIP_STARTUP_DELAY_MS,
  PROXY_HEALTH_CHECK_MS, PROXY_MAX_RESTART_ATTEMPTS, PROXY_RESTART_DELAY_MS,
  PROXY_TCP_IDLE_TIMEOUT_MS, PROXY_MAX_TCP_CONNECTIONS, PROXY_TCP_RELAY_TIMEOUT_MS,
  resolveDnsmasqInternalPort, resolveDnsListenPort,
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
let proxyServers = [];         // Array of { socket, address }, one per LAN address on port 53 (UDP)
let tcpServers = [];           // Array of { server, address }, TCP listener per LAN address (DNS-over-TCP)
let activeTcpConnections = 0;  // concurrent client TCP connections (capped at PROXY_MAX_TCP_CONNECTIONS)
let mmdbReader = null;
let geoCache = null;
let statsTotal = 0;
let statsBlocked = 0;
let statsAllowed = 0;
let blockedDelta = 0;
let countryHits = new Map();

// Bypass mode, when proxy dies and can't restart, dnsmasq takes over port 53
let bypassMode = false;
let healthTimer = null;

// GeoIP rule cache, reloaded on settings change, avoids per-query DB hits
let geoipRuleSet = null;            // Set<string>, enabled country codes
let geoipMode = 'blocklist';        // 'blocklist' or 'allowlist'
let geoipAllowEntries = [];         // parsed IP/CIDR entries never GeoIP-blocked
let whitelistSet = null;            // Set<string>, single global allowlist (blocklist_whitelist), exempts from GeoIP + category blocking

// Blocklist state. Domains are NOT held in memory: they are looked up per
// query against blocklist_domains, which is a WITHOUT ROWID table keyed on
// (domain, category_slug), so the table is its own index.
//
// This used to be a Map of every enabled domain. That had a hard V8 ceiling of
// 16,777,216 entries ("Map maximum size exceeded"), cost several hundred MB
// resident, and had to be rebuilt from scratch on every whitelist edit and
// category toggle, which took about 2.8s at 2.65M domains and blocked DNS for
// all of it. Measured against that same list, the SQLite lookup costs 8.1us
// per query including the full label walk (~124k q/s), and there is no reload.
// The hot path already does synchronous SQLite per query via
// recordDnsQueryLiveness, so this is not a new class of work.
let blocklistLookupStmt = null;     // cached prepared statement, see getLookupStmt
let blocklistCategories = null;     // Set<string>, enabled category slugs
let blocklistEnabled = false;
let blocklistRedirectIp = '';
let blocklistBlockedDelta = 0;
let blocklistCategoryHits = new Map();

// Performance instrumentation, reservoir sampling caps memory at 1000 samples
const RESERVOIR_SIZE = 1000;
let latencySamples = [];
let latencySampleCount = 0;
function recordLatency(us) {
  latencySampleCount++;
  if (latencySamples.length < RESERVOIR_SIZE) {
    latencySamples.push(us);
  } else {
    const j = Math.floor(Math.random() * latencySampleCount);
    if (j < RESERVOIR_SIZE) latencySamples[j] = us;
  }
}
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

// Linear scan of full 16-bit ID space for a free slot.
// Returns null if all IDs are in-flight (caller should SERVFAIL).
function allocateQueryId() {
  const startId = nextQueryId;
  do {
    nextQueryId = (nextQueryId + 1) & 0xFFFF;
    if (!pendingQueries.has(nextQueryId)) return nextQueryId;
  } while (nextQueryId !== startId);
  return null; // all 65536 IDs in-flight
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

// Load the GeoIP IP/CIDR allowlist into memory. Resolved answer IPs matching any
// of these are exempt from country-based blocking (the correct-granularity GeoIP
// exception). Reloaded on any allowlist change via the /geoip/allowlist routes.
export function loadGeoipAllowlist() {
  const db = getDb();
  const rows = db.prepare('SELECT value FROM geoip_ip_allowlist').all();
  geoipAllowEntries = rows.map(r => parseCidrEntry(r.value)).filter(Boolean);
  proxyLog('info', 'GeoIP IP allowlist loaded', { count: geoipAllowEntries.length });
}

// Is this resolved IP exempt from GeoIP blocking?
function isGeoipAllowed(ip) {
  return ipInAny(ip, geoipAllowEntries);
}

// Load the single global allowlist (blocklist_whitelist) into memory. This one
// list applies everywhere: the category blocklist already excludes these domains
// at load time (SQL), and the GeoIP path consults this set too. Reloaded on any
// whitelist change via generateBlocklistConfig().
export function loadWhitelist() {
  const db = getDb();
  const rows = db.prepare('SELECT domain FROM blocklist_whitelist').all();
  whitelistSet = new Set(rows.map(r => r.domain.toLowerCase()));
  proxyLog('info', 'Whitelist loaded', { count: whitelistSet.size });
}

/**
 * Walk a name from most to least specific, stopping before the bare TLD:
 * 'a.b.example.com' yields 'a.b.example.com', then 'b.example.com', then
 * 'example.com'. Input is lowercased here so callers do not each have to.
 *
 * The allowlist and the blocklist both match this way and used to carry
 * separate copies of the loop (duplicate-logic audit #12). That is worse than
 * ordinary duplication: if the allowlist ever stopped one level earlier than
 * the blocklist, a domain the operator explicitly permitted would be silently
 * blocked, and nothing would report it. One walk means the two cannot disagree
 * about what "example.com covers sub.example.com" means.
 */
export function* domainSuffixes(name) {
  if (!name) return;
  const labels = String(name).toLowerCase().split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    yield labels.slice(i).join('.');
  }
}

// Is this query domain on the global allowlist? Returns false when nothing is
// whitelisted.
function isWhitelisted(queryName) {
  if (!whitelistSet || whitelistSet.size === 0 || !queryName) return false;
  for (const candidate of domainSuffixes(queryName)) {
    if (whitelistSet.has(candidate)) return true;
  }
  return false;
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
  let ifaceConfig = {};
  try {
    const raw = getSetting('interface_config');
    if (raw) ifaceConfig = JSON.parse(raw);
  } catch { /* use default */ }

  const sysIfaces = os.networkInterfaces();
  const addresses = [];

  // Interface selection is shared with dnsmasq.js and dhcp-probe.js so the
  // three cannot drift about which interfaces are in play (audit #9). What we
  // do with them, collecting IPv4 bind addresses, stays here.
  const { names } = selectInterfaceNames('dns', { config: ifaceConfig, sysIfaces });
  for (const ifName of names) {
    for (const a of sysIfaces[ifName] || []) {
      if (a.family === 'IPv4') addresses.push(a.address);
    }
  }

  return addresses;
}

// dns-packet's encoder takes the on-the-wire rcode from the low 4 bits of the
// `flags` field and IGNORES the convenience `rcode` string, so a response must
// fold its rcode into flags or it silently encodes as NOERROR. (This was a
// latent bug: synthesized NXDOMAIN/SERVFAIL replies were going out as NOERROR.)
const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };
function responseFlags(rcodeName) {
  return (dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE) | (RCODE[rcodeName] || 0);
}

// Pull the EDNS OPT pseudo-record (if any) from a decoded query's additionals.
export function getQueryOpt(query) {
  return query?.additionals?.find(a => a.type === 'OPT') || null;
}

// Build the additionals array for a synthesized response. When the client's
// query carried an EDNS OPT record we echo a matching one (advertised UDP
// payload size + DO bit) so DNSSEC-aware clients see a well-formed reply. We
// deliberately do NOT set the AD (authenticated-data) header flag: a locally
// blocked domain is unsigned local policy, not a validated answer.
function buildOptEcho(opt) {
  if (!opt) return [];
  // dns-packet encodes the EDNS flags field from `flags` (not `flag_do`), so
  // the DO bit must be set there; `flag_do` is set too for symmetry on decode.
  return [{
    type: 'OPT',
    name: '.',
    udpPayloadSize: opt.udpPayloadSize || 1232,
    extendedRcode: 0,
    ednsVersion: 0,
    flags: opt.flag_do ? dnsPacket.DNSSEC_OK : 0,
    flag_do: !!opt.flag_do,
    options: [],
  }];
}

// Create NXDOMAIN response for a query (echoes EDNS OPT when present)
export function createNxdomainResponse(query) {
  return dnsPacket.encode({
    id: query.id,
    type: 'response',
    flags: responseFlags('NXDOMAIN'),
    questions: query.questions,
    answers: [],
    authorities: [],
    additionals: buildOptEcho(getQueryOpt(query))
  });
}

// Create a blocked response, redirect IP (A record, NOERROR) or NXDOMAIN
export function createBlockedResponse(query) {
  if (blocklistRedirectIp) {
    return dnsPacket.encode({
      id: query.id,
      type: 'response',
      flags: responseFlags('NOERROR'),
      questions: query.questions,
      answers: query.questions
        .filter(q => q.type === 'A')
        .map(q => ({ type: 'A', name: q.name, ttl: 300, data: blocklistRedirectIp })),
      authorities: [],
      additionals: buildOptEcho(getQueryOpt(query))
    });
  }
  return createNxdomainResponse(query);
}

// Encode a SERVFAIL response, echoing EDNS OPT when present.
function encodeServfail(query) {
  return dnsPacket.encode({
    id: query.id,
    type: 'response',
    flags: responseFlags('SERVFAIL'),
    questions: query.questions || [],
    answers: [],
    authorities: [],
    additionals: buildOptEcho(getQueryOpt(query))
  });
}

// Refresh the small pieces of blocklist state we do keep in memory: the two
// settings and the set of enabled category slugs. Domains stay in SQLite.
export function loadBlocklist() {
  const db = getDb();
  const enabled = getSetting('blocklist_enabled');
  blocklistEnabled = (enabled === 'true');
  blocklistRedirectIp = getSetting('blocklist_redirect_ip') || '';

  if (!blocklistEnabled) {
    blocklistCategories = null;
    proxyLog('info', 'Blocklist disabled');
    return;
  }

  const rows = db.prepare('SELECT slug FROM blocklist_categories WHERE enabled = 1').all();
  blocklistCategories = new Set(rows.map(r => r.slug));
  proxyLog('info', 'Blocklist enabled', { categories: blocklistCategories.size });
}

// The lookup statement is cached across queries but re-prepared if the DB
// handle changes (tests swap it, and a restore reopens it).
let blocklistLookupDb = null;
function getLookupStmt(db) {
  if (!blocklistLookupStmt || blocklistLookupDb !== db) {
    blocklistLookupStmt = db.prepare(
      'SELECT category_slug FROM blocklist_domains WHERE domain = ?'
    ).pluck();
    blocklistLookupDb = db;
  }
  return blocklistLookupStmt;
}

// Total domains across enabled categories, for the status endpoint.
function countEnabledDomains() {
  try {
    return getDb().prepare(
      'SELECT COALESCE(SUM(domain_count), 0) AS c FROM blocklist_categories WHERE enabled = 1'
    ).pluck().get() || 0;
  } catch {
    return 0;
  }
}

// Check query domain against blocklist (walks domain hierarchy for subdomain matching)
function checkBlocklist(queryName) {
  if (!blocklistEnabled || !blocklistCategories || blocklistCategories.size === 0) return null;

  // The allowlist used to be folded into the Map at load time by a
  // "NOT IN (SELECT domain FROM blocklist_whitelist)" clause, so this function
  // never had to think about it. Now that domains are read live, the check has
  // to happen here or allowlisted domains would start getting blocked.
  if (isWhitelisted(queryName)) return null;

  const stmt = getLookupStmt(getDb());

  for (const candidate of domainSuffixes(queryName)) {
    // A domain can appear in several categories; the first enabled one wins.
    for (const slug of stmt.all(candidate)) {
      if (blocklistCategories.has(slug)) return slug || 'unknown';
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

// ─── Filtering policy (shared by the UDP and TCP paths) ─────────────────────
// The verdict logic lives here exactly once so the two transports cannot
// drift ("blocked over UDP, leaked over TCP"). The evaluators are pure.
// Transports own sockets, response synthesis, latency, and query logging.
// The record* helpers bump the shared counters on a block.

// Pre-forward verdict: does the blocklist intercept this name?
export function evaluateInboundPolicy(queryName) {
  if (!queryName) return { action: 'forward' };
  const blockedCategory = checkBlocklist(queryName);
  if (!blockedCategory) return { action: 'forward' };
  return {
    action: 'block',
    blockReason: blockedCategory,
    // With a redirect IP configured the synthesized answer resolves, so the
    // logged response code is NOERROR; otherwise the block is an NXDOMAIN.
    responseCode: blocklistRedirectIp ? 'NOERROR' : 'NXDOMAIN',
  };
}

export function recordInboundBlock(verdict) {
  statsBlocked++;
  statsTotal++;
  blocklistBlockedDelta++;
  blocklistCategoryHits.set(verdict.blockReason, (blocklistCategoryHits.get(verdict.blockReason) || 0) + 1);
}

// Post-answer verdict: do the resolved IPs trip a GeoIP country block?
// Allowlisted answer IPs are exempt before the country lookup; a whitelisted
// query name overrides a would-be block.
export function evaluateResolvedPolicy(queryName, ips, lookup = lookupCountry) {
  if (!ips || ips.length === 0) return { action: 'forward' };
  const countryCodes = ips
    .filter(ip => !isGeoipAllowed(ip))
    .map(ip => lookup(ip))
    .filter(cc => cc !== null);
  if (countryCodes.length > 0 && shouldBlock(countryCodes) && !isWhitelisted(queryName)) {
    return { action: 'block', blockReason: countryCodes[0], countryCodes };
  }
  return { action: 'forward' };
}

export function recordResolvedBlock(verdict) {
  statsBlocked++;
  blockedDelta++;
  statsTotal++;
  for (const cc of verdict.countryCodes) {
    countryHits.set(cc, (countryHits.get(cc) || 0) + 1);
  }
}

// Handle a DNS query from any proxy socket
function handleQuery(msg, rinfo, sock) {
  try {
    const startNs = process.hrtime.bigint();
    const query = dnsPacket.decode(msg);

    // Extract query metadata for analytics
    const queryName = query.questions?.[0]?.name;
    const queryType = query.questions?.[0]?.type || 'A';

    try {
      recordDnsQueryLiveness(getDb(), rinfo.address, { createRogue: true, source: 'passive' });
    } catch (err) {
      proxyLog('warn', 'Failed to record DNS-query liveness', { clientIp: rinfo.address, error: err.message });
    }

    // Blocklist check, intercept before forwarding to dnsmasq
    const inbound = evaluateInboundPolicy(queryName);
    if (inbound.action === 'block') {
      recordInboundBlock(inbound);
      const response = createBlockedResponse(query);
      sock.send(response, rinfo.port, rinfo.address);
      const latencyUs = Number(process.hrtime.bigint() - startNs) / 1000;
      recordLatency(latencyUs);
      logDnsQuery({
        clientIp: rinfo.address, domain: queryName, queryType,
        responseCode: inbound.responseCode,
        action: 'blocked_blocklist', blockReason: inbound.blockReason,
        latencyUs,
      });
      return;
    }

    // Circuit breaker, reject when too many queries are pending
    if (pendingQueries.size >= MAX_PENDING_QUERIES) {
      statsTotal++;
      sock.send(encodeServfail(query), rinfo.port, rinfo.address);
      return;
    }

    // Assign internal query ID to track pending responses
    const internalId = allocateQueryId();
    if (internalId === null) {
      // All 65536 IDs exhausted, drop query with SERVFAIL
      statsTotal++;
      sock.send(encodeServfail(query), rinfo.port, rinfo.address);
      return;
    }

    // Store pending query mapping (includes the socket that received the query + query metadata)
    const timer = setTimeout(() => {
      // Timeout, send SERVFAIL so client doesn't hang
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
          // Echo the client's EDNS OPT (stored on the pending entry) so a
          // validating stub still gets a well-formed SERVFAIL.
          const servfail = encodeServfail({ id: p.originalId, questions: [], additionals: p.opt ? [p.opt] : [] });
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
      opt: getQueryOpt(query),   // echoed on a synthesized GeoIP-block response
      timer,
      startNs
    });

    // Rewrite query ID and forward to dnsmasq on localhost:5353
    const fwdBuf = Buffer.from(msg);
    fwdBuf.writeUInt16BE(internalId, 0);
    dnsmasqSocket.send(fwdBuf, resolveDnsmasqInternalPort(getSetting('dns_listen_port')), '127.0.0.1');
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

    // GeoIP check, inspect resolved IPs
    const ips = response.answers
      .filter(a => a.type === 'A' || a.type === 'AAAA')
      .map(a => a.data);

    const resolved = evaluateResolvedPolicy(pending.queryName, ips);
    if (resolved.action === 'block') {
      recordResolvedBlock(resolved);
      const nxResponse = createNxdomainResponse({
        id: pending.originalId,
        questions: response.questions,
        additionals: pending.opt ? [pending.opt] : [],
      });
      pending.socket.send(nxResponse, pending.port, pending.address);
      const latencyUs = Number(process.hrtime.bigint() - pending.startNs) / 1000;
      recordLatency(latencyUs);
      logDnsQuery({
        clientIp: pending.address, domain: pending.queryName, queryType: pending.queryType,
        responseCode: 'NXDOMAIN', action: 'blocked_geoip',
        blockReason: resolved.blockReason, latencyUs, resolvedIp: ips[0],
      });
      return;
    }

    // Allowed, forward original response (restore original query ID)
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

// ─── DNS-over-TCP relay ──────────────────────────────────────────
// DNS-over-TCP frames each message with a 2-byte big-endian length prefix.
// Unlike the UDP path, each query gets its own independent connection to
// dnsmasq, so there's no 16-bit ID multiplexing, we relay the client's bytes
// (and dnsmasq's response bytes) verbatim, which keeps DNSSEC signatures and
// the query ID intact. TCP fallback is what validating-stub resolvers use for
// large/truncated signed answers, so this path is required for end-to-end
// DNSSEC while filtering stays in place.

function writeTcpMessage(sock, payload) {
  if (!sock.writable) return;
  try { sock.write(frameTcpMessage(payload)); } catch { /* client gone */ }
}

/**
 * Relay one DNS query to dnsmasq over TCP and resolve with the raw response
 * bytes (length prefix stripped), or null on timeout/error. Each call uses a
 * fresh connection, testable against any loopback TCP responder.
 */
export function relayQueryOverTcp(reqMsg, host, port, timeoutMs) {
  return new Promise((resolve) => {
    const upstream = net.connect(port, host);
    upstream.setTimeout(timeoutMs);
    let respBuf = Buffer.alloc(0);
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { upstream.destroy(); } catch { /* ignore */ }
      resolve(val);
    };
    upstream.on('connect', () => upstream.write(frameTcpMessage(reqMsg)));
    upstream.on('data', (chunk) => {
      respBuf = Buffer.concat([respBuf, chunk]);
      if (respBuf.length < 2) return;
      const respLen = respBuf.readUInt16BE(0);
      if (respBuf.length < 2 + respLen) return; // wait for full message
      finish(respBuf.subarray(2, 2 + respLen));
    });
    upstream.on('timeout', () => finish(null));
    upstream.on('error', () => finish(null));
    upstream.on('close', () => finish(null));
  });
}

// Handle a single framed DNS message from a client TCP connection.
async function handleTcpQuery(msg, clientSock) {
  const startNs = process.hrtime.bigint();
  let query;
  try {
    query = dnsPacket.decode(msg);
  } catch {
    return; // malformed, ignore this message, keep the connection open
  }
  const clientIp = clientSock.remoteAddress || '';
  const queryName = query.questions?.[0]?.name;
  const queryType = query.questions?.[0]?.type || 'A';

  try {
    recordDnsQueryLiveness(getDb(), clientIp, { createRogue: true, source: 'passive' });
  } catch (err) {
    proxyLog('warn', 'Failed to record DNS-query liveness (TCP)', { clientIp, error: err.message });
  }

  // Blocklist intercept, no dnsmasq round-trip. Same verdict path as UDP.
  const inbound = evaluateInboundPolicy(queryName);
  if (inbound.action === 'block') {
    recordInboundBlock(inbound);
    writeTcpMessage(clientSock, createBlockedResponse(query));
    const latencyUs = Number(process.hrtime.bigint() - startNs) / 1000;
    recordLatency(latencyUs);
    logDnsQuery({
      clientIp, domain: queryName, queryType,
      responseCode: inbound.responseCode,
      action: 'blocked_blocklist', blockReason: inbound.blockReason, latencyUs,
    });
    return;
  }

  // Relay to dnsmasq over TCP (same internal port it serves UDP on).
  const internalPort = resolveDnsmasqInternalPort(getSetting('dns_listen_port'));
  const respMsg = await relayQueryOverTcp(msg, '127.0.0.1', internalPort, PROXY_TCP_RELAY_TIMEOUT_MS);
  const latencyUs = Number(process.hrtime.bigint() - startNs) / 1000;
  recordLatency(latencyUs);

  if (!respMsg) {
    timeoutCount++;
    statsTotal++;
    writeTcpMessage(clientSock, encodeServfail(query));
    logDnsQuery({ clientIp, domain: queryName || '', queryType, responseCode: 'SERVFAIL', action: 'allowed', latencyUs });
    return;
  }

  // GeoIP check on the resolved answers, same policy as the UDP path.
  let response = null;
  try { response = dnsPacket.decode(respMsg); } catch { /* relay raw below */ }

  const ips = response
    ? response.answers.filter(a => a.type === 'A' || a.type === 'AAAA').map(a => a.data)
    : [];

  // Same verdict path as UDP's handleDnsmasqResponse.
  const resolved = evaluateResolvedPolicy(queryName, ips);
  if (resolved.action === 'block') {
    recordResolvedBlock(resolved);
    writeTcpMessage(clientSock, createNxdomainResponse(query));
    logDnsQuery({
      clientIp, domain: queryName || '', queryType,
      responseCode: 'NXDOMAIN', action: 'blocked_geoip',
      blockReason: resolved.blockReason, latencyUs, resolvedIp: ips[0],
    });
    return;
  }

  // Allowed, relay dnsmasq's raw bytes verbatim (preserves signatures + ID).
  statsAllowed++;
  statsTotal++;
  writeTcpMessage(clientSock, respMsg);
  logDnsQuery({
    clientIp, domain: queryName || '', queryType,
    // response is null when decode failed and we relayed raw bytes, don't claim NOERROR.
    responseCode: response?.rcode || 'UNKNOWN', action: 'allowed',
    latencyUs, resolvedIp: ips[0] || null,
  });
}

// Accept a client TCP connection: buffer, deframe, dispatch each message.
function onTcpConnection(clientSock) {
  if (activeTcpConnections >= PROXY_MAX_TCP_CONNECTIONS) {
    try { clientSock.destroy(); } catch { /* ignore */ }
    return;
  }
  activeTcpConnections++;
  clientSock.setTimeout(PROXY_TCP_IDLE_TIMEOUT_MS);

  let buf = Buffer.alloc(0);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    activeTcpConnections--;
    try { clientSock.destroy(); } catch { /* ignore */ }
  };

  clientSock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, rest } = extractTcpMessages(buf);
    buf = rest;
    for (const m of messages) handleTcpQuery(m, clientSock);
    // Guard against a peer that sends a huge length prefix but never the body.
    if (buf.length > 0xFFFF + 2) cleanup();
  });
  clientSock.on('timeout', cleanup);
  clientSock.on('error', cleanup);
  clientSock.on('close', cleanup);
}

// Start the DNS proxy, binds one UDP socket per LAN address on port 53
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

  // Bind one socket per LAN address on the configured DNS listen port (default 53).
  const addresses = getListenAddresses();
  if (addresses.length === 0) {
    proxyLog('warn', 'No LAN addresses found, proxy has nothing to bind to');
    return;
  }
  // Shared with the dnsmasq config writer. `Number(x) || 53` used to live here,
  // which accepted any non-zero number, so a stored 70000 became a bind attempt
  // on 70000 while dnsmasq stayed on 53.
  // See REVIEW.md, duplicate-logic audit #10.
  const listenPort = resolveDnsListenPort(getSetting('dns_listen_port'));

  let bindCount = 0;
  for (const addr of addresses) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('message', (msg, rinfo) => handleQuery(msg, rinfo, sock));

    sock.on('error', (err) => {
      proxyLog('error', 'Proxy socket error', { address: addr, error: err.message, code: err.code });
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        proxyLog('error', `Cannot bind port ${listenPort}`, { address: addr });
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

    sock.bind(listenPort, addr, () => {
      bindCount++;
      proxyLog('info', 'Proxy socket bound', { address: `${addr}:${listenPort}` });
      if (bindCount === addresses.length) {
        proxyStartupMs = Date.now() - proxyStartedAt;
        proxyLog('info', 'Proxy fully started', { sockets: bindCount, startupMs: proxyStartupMs });
        if (!healthTimer) startHealthMonitor();
      }
    });

    proxyServers.push({ socket: sock, address: addr });
  }

  // Bind a TCP listener per LAN address on the same port. TCP is additive and
  // best-effort: a TCP bind failure is logged but does NOT tear down the UDP
  // path or trip the bypass health monitor (which tracks UDP sockets), UDP
  // DNS keeps working even if TCP can't bind. In practice they bind or fail
  // together since they share the address/port.
  for (const addr of addresses) {
    const tcpServer = net.createServer(onTcpConnection);
    tcpServer.on('error', (err) => {
      proxyLog('error', 'Proxy TCP server error', { address: addr, error: err.message, code: err.code });
    });
    tcpServer.listen(listenPort, addr, () => {
      proxyLog('info', 'Proxy TCP listener bound', { address: `${addr}:${listenPort}` });
    });
    tcpServers.push({ server: tcpServer, address: addr });
  }
}

// Stop the DNS proxy
export function stopProxy() {
  for (const { socket } of proxyServers) {
    try { socket.close(); } catch { /* ignore */ }
  }
  proxyServers = [];

  for (const { server } of tcpServers) {
    try { server.close(); } catch { /* ignore */ }
  }
  tcpServers = [];
  activeTcpConnections = 0;

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

// Health monitor, detects proxy death, attempts restart, fails open if unrecoverable
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

    // All restart attempts failed, activate bypass
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
//
// These two writers deliberately call applyInterfaceConfig + restartDnsmasq
// inline, OUTSIDE the after-commit single-flight that serializes the
// request-driven regen hooks. Bypass needs the conf written and dnsmasq
// restarted synchronously (queueRegen defers into a microtask that would
// fire after the restart). The cost is a small last-writer-wins window: a
// concurrent request-triggered regen that read dns_proxy_bypass before the
// flip can clobber the bypass directives. Accepted (2026-07-23 review):
// bypass only runs when the proxy is already dead, atomicWrite prevents torn
// files, and the health monitor re-runs activateBypass on the next tick if
// DNS still isn't answering, the window self-heals. Don't route these
// through queueRegen without solving the synchrony requirement first.
function activateBypass() {
  if (bypassMode) return;
  bypassMode = true;
  proxyLog('error', 'All restart attempts failed, activating bypass mode (dnsmasq takes port 53)');
  try {
    // Temporarily override: dnsmasq listens on port 53 + LAN IPs.
    // Must be synchronous before restartDnsmasq, queueRegen would defer
    // the conf write into a microtask that fires AFTER the restart.
    setSetting('dns_proxy_bypass', 'true');
    applyInterfaceConfig(getDb());
    restartDnsmasq();
    proxyLog('info', 'dnsmasq reconfigured for bypass mode (port 53 on LAN)');
  } catch (err) {
    proxyLog('error', 'Failed to reconfigure dnsmasq for bypass', { error: err.message });
  }
}

function deactivateBypass() {
  bypassMode = false;
  proxyLog('info', 'Bypass deactivated, proxy recovered');
  try {
    const db = getDb();
    Setting.deleteSetting(db, 'dns_proxy_bypass');
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

// Start proxy (always-on, called on server startup)
export async function startProxyIfEnabled() {
  const geoipOn = getSetting('geoip_enabled') === 'true';
  const blocklistOn = getSetting('blocklist_enabled') === 'true';

  if (geoipOn) {
    loadGeoipRules();
    loadGeoipAllowlist();
    const loaded = await loadMmdb();
    if (!loaded) {
      proxyLog('warn', 'GeoIP enabled but MMDB not available, starting without GeoIP filtering');
    }
  }

  if (blocklistOn) {
    loadBlocklist();
  }

  // Single global allowlist, used by the GeoIP path (the blocklist path also
  // excludes these at load time). Loaded regardless of which features are on.
  loadWhitelist();

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
    tcpListeners: tcpServers.length,
    activeTcpConnections,
    dbLoaded: mmdbReader !== null,
    dbExists,
    dbPath,
    dbLastUpdated: lastUpdated || null,
    statsTotal,
    statsBlocked,
    statsAllowed,
    blocklistLoaded: blocklistCategories !== null,
    // Summed from the per-category counters the refresh already maintains.
    // A COUNT(*) here would scan the whole domains table on every status poll.
    blocklistDomainCount: blocklistCategories === null ? 0 : countEnabledDomains(),
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
  latencySampleCount = 0;

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
  setInterval(async () => {
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
