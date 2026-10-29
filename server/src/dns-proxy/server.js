import dgram from 'dgram';
import net from 'net';
import fs from 'fs';
import dnsPacket from 'dns-packet';
import maxmind from 'maxmind';
import { LRUCache } from 'lru-cache';
import { canonicalizeIp } from '../utils/address.js';
import { exemptAddressSet } from '../models/filtering-exemption-read.js';
import { parseCidrEntry, ipInAny } from '../utils/cidr-match.js';
import { frameTcpMessage, extractTcpMessages } from '../utils/dns-wire.js';
import { extractEde, failureCause, FAILURE_CAUSES } from '../utils/dns-ede.js';
import { createReservoir, quantileOfSorted } from '../utils/samples.js';
import { loadCityTable, unloadCityTable, cityPlace } from '../utils/geo-cities.js';
import { writeQueryLine, setQueryLogPath } from '../utils/query-log-writer.js';
import { plainUdpQuery } from '../utils/plain-dns.js';
import {
  GEOIP_CACHE_MAX,
  GEOIP_CACHE_TTL_MS,
  PROXY_UDP_TIMEOUT_MS,
  PROXY_TCP_IDLE_TIMEOUT_MS,
  PROXY_MAX_TCP_CONNECTIONS,
  PROXY_TCP_RELAY_TIMEOUT_MS,
  ENCRYPTED_FORWARDER_PORT,
} from './constants.js';
import { proxyLog } from './log.js';

// What the proxy needs from its host, given by whoever runs it: the web app
// today, the proxy process's own entry point later. `setting` reads one
// stored setting, `db` is a connection for reads, and the three sinks take
// what the proxy reports: an answered query's analytics row, a client seen
// (passive liveness) and a Resolution Map event.
let deps = {
  setting: () => null,
  db: () => {
    throw new Error('the DNS proxy has no database');
  },
  queryRow: () => {},
  liveness: () => {},
  resolution: () => {},
};
export function configureProxyServer(next) {
  deps = { ...deps, ...next };
}

// Where it listens and forwards, worked out by the web app (it knows the
// interfaces and the DNS backend): the LAN addresses and port, the backend's
// internal port, whether the backend forwards a forward-unknown zone's
// unknown names itself, the query log to write (or none), whether DNS is
// switched off, and the GeoIP database file.
let config = {
  listenAddresses: [],
  listenPort: 53,
  internalPort: 5353,
  forwardsUnknownItself: true,
  queryLogPath: null,
  dnsOff: false,
  geoipDbPath: null,
};
export function setProxyConfig(next) {
  config = { ...config, ...next };
  setQueryLogPath(config.queryLogPath);
}
export const proxyConfig = () => config;


// Module state
let proxyServers = []; // Array of { socket, address }, one per LAN address on port 53 (UDP)
let tcpServers = []; // Array of { server, address }, TCP listener per LAN address (DNS-over-TCP)
let activeTcpConnections = 0; // concurrent client TCP connections (capped at PROXY_MAX_TCP_CONNECTIONS)
let mmdbReader = null;
let geoCache = null;
let statsTotal = 0;
let statsBlocked = 0;
let statsAllowed = 0;
let blockedDelta = 0;
let countryHits = new Map();

// GeoIP rule cache, reloaded on settings change, avoids per-query DB hits
let geoipRuleSet = null; // Set<string>, enabled country codes
let geoipMode = 'blocklist'; // 'blocklist' or 'allowlist'
let geoipAllowEntries = []; // parsed IP/CIDR entries never GeoIP-blocked
let allowlistSet = null; // Set<string>, single global allowlist (blocklist_allowlist), exempts from GeoIP + category blocking

// Blocklist state. Domains are NOT held in memory: they are looked up per
// query against blocklist_domains, which is a WITHOUT ROWID table keyed on
// (domain, category_slug), so the table is its own index.
//
// This used to be a Map of every enabled domain. That had a hard V8 ceiling of
// 16,777,216 entries ("Map maximum size exceeded"), cost several hundred MB
// resident, and had to be rebuilt from scratch on every allowlist edit and
// category toggle, which took about 2.8s at 2.65M domains and blocked DNS for
// all of it. Measured against that same list, the SQLite lookup costs 8.1us
// per query including the full label walk (~124k q/s), and there is no reload.
// The connection is read-only in the proxy process, and a read under WAL
// never waits on the web app's writes.
let blocklistLookupStmt = null; // cached prepared statement, see getLookupStmt
let blocklistCategories = null; // Set<string>, enabled category slugs
let blocklistEnabled = false;
let blocklistRedirectIp = '';
let blocklistRedirectIp6 = '';
let blocklistBlockedDelta = 0;
let blocklistCategoryHits = new Map();

// Filtering overrides (blocklists and GeoIP alike). A pause is a deadline, not
// a timer: it ends by itself, and a restart mid-pause keeps the stored time.
// Exempt clients are the addresses models/filtering-exemption.js says have
// filtering off; it keys hosts by MAC, so the set is rebuilt when an exemption
// or a lease changes, and every minute for a MAC a scan learned (the
// facade's timer).
let filteringPausedUntil = 0;
let exemptClients = new Set();

// Performance instrumentation, reservoir sampling caps memory at 1000 samples
const latency = createReservoir(1000);
function recordLatency(us) {
  latency.add(us);
}
let cacheHits = 0;
let cacheMisses = 0;
let timeoutCount = 0;
// Failed answers this minute, by cause (utils/dns-ede.js), and NXDOMAINs.
const noFailures = () => Object.fromEntries(FAILURE_CAUSES.map((cause) => [cause, 0]));
let failureCounts = noFailures();
let nxdomainCount = 0;
let proxyStartedAt = null;
let proxyStartupMs = null;

// Pending queries: maps internal ID -> { address, port, originalId, timer, socket }
const MAX_PENDING_QUERIES = 10000;
let pendingQueries = new Map();
let dnsmasqSocket = null; // UDP socket for forwarding to dnsmasq on 127.0.0.1:5353
let nextQueryId = 1;

// Linear scan of full 16-bit ID space for a free slot.
// Returns null if all IDs are in-flight (caller should SERVFAIL).
function allocateQueryId() {
  const startId = nextQueryId;
  do {
    nextQueryId = (nextQueryId + 1) & 0xffff;
    if (!pendingQueries.has(nextQueryId)) return nextQueryId;
  } while (nextQueryId !== startId);
  return null; // all 65536 IDs in-flight
}

// Load MMDB database file
/** Load the GeoIP database at `dbPath` (the configured one by default). */
export async function loadMmdbFrom(dbPath = config.geoipDbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    proxyLog('warn', 'MMDB file not found', { path: dbPath });
    mmdbReader = null;
    return false;
  }
  try {
    mmdbReader = await maxmind.open(dbPath);
    geoCache = new LRUCache({ max: GEOIP_CACHE_MAX, ttl: GEOIP_CACHE_TTL_MS });
    // City points for the Resolution Map ship with the release; without the
    // file the map lands answers at their country's middle.
    const cities = loadCityTable();
    proxyLog('info', 'MMDB loaded', { path: dbPath, cities });
    return true;
  } catch (err) {
    proxyLog('error', 'Failed to load MMDB', { error: err.message });
    mmdbReader = null;
    unloadCityTable();
    return false;
  }
}

// Drop the reader and everything derived from it. With no reader no answer
// gets a country, so nothing is GeoIP-blocked: this is what turning GeoIP off
// means, at once rather than at the next restart.
export function unloadMmdb() {
  mmdbReader = null;
  geoCache = null;
  unloadCityTable();
}

// Lookup country code for an IP. The cache keeps the city point beside the
// country, found on the same miss, so the map costs a hit nothing.
export function lookupCountry(ip) {
  if (!mmdbReader) return null;

  const cached = geoCache?.get(ip);
  if (cached !== undefined) {
    cacheHits++;
    return cached.country;
  }

  try {
    const result = mmdbReader.get(ip);
    const country = result?.country?.iso_code || null;
    // The city table is coarser than the country database: a cell that names
    // another country is a neighbor's, so the answer lands at its country's
    // middle instead.
    const city = country ? cityPlace(ip) : null;
    const point = city && city.country === country ? [city.lon, city.lat] : null;
    geoCache?.set(ip, { country, point });
    cacheMisses++;
    return country;
  } catch {
    return null;
  }
}

/** The city point lookupCountry cached for an address, as [lon, lat], or null. */
export function cachedPoint(ip) {
  return geoCache?.get(ip)?.point || null;
}

/** Whether answers get a country now (GeoIP on and its database loaded). */
export function isGeoipLoaded() {
  return mmdbReader !== null;
}

// Load GeoIP rules into memory (call on startup and settings change)
export function loadGeoipRules() {
  const db = deps.db();
  geoipMode = deps.setting('geoip_mode') || 'blocklist';
  const enabledRules = db.prepare('SELECT country_code FROM geoip_rules WHERE enabled = 1').all();
  geoipRuleSet = new Set(enabledRules.map((r) => r.country_code));
  proxyLog('info', 'GeoIP rules loaded', { count: geoipRuleSet.size, mode: geoipMode });
}

// Load the GeoIP IP/CIDR allowlist into memory. Resolved answer IPs matching any
// of these are exempt from country-based blocking (the correct-granularity GeoIP
// exception). Reloaded on any allowlist change via the /geoip/allowlist routes.
export function loadGeoipAllowlist() {
  const db = deps.db();
  const rows = db.prepare('SELECT value FROM geoip_ip_allowlist').all();
  geoipAllowEntries = rows.map((r) => parseCidrEntry(r.value)).filter(Boolean);
  proxyLog('info', 'GeoIP IP allowlist loaded', { count: geoipAllowEntries.length });
}

// Is this resolved IP exempt from GeoIP blocking?
function isGeoipAllowed(ip) {
  return ipInAny(ip, geoipAllowEntries);
}

// Load the single global allowlist (blocklist_allowlist) into memory. This one
// list applies everywhere: the category blocklist already excludes these domains
// at load time (SQL), and the GeoIP path consults this set too. Reloaded on any
// allowlist change via generateBlocklistConfig().
export function loadAllowlist() {
  const db = deps.db();
  const rows = db.prepare('SELECT domain FROM blocklist_allowlist').all();
  allowlistSet = new Set(rows.map((r) => r.domain.toLowerCase()));
  proxyLog('info', 'Allowlist loaded', { count: allowlistSet.size });
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
// allowlisted.
function isAllowlisted(queryName) {
  if (!allowlistSet || allowlistSet.size === 0 || !queryName) return false;
  for (const candidate of domainSuffixes(queryName)) {
    if (allowlistSet.has(candidate)) return true;
  }
  return false;
}

// Check if query should be blocked based on resolved country codes (uses cached rules)
// Which of these codes actually violate the policy. Returns the subset, not a
// boolean, because the caller needs to know WHICH country tripped the block:
// reporting every code in a mixed answer set charges innocent countries in the
// hit counters and can log one of them as the reason.
//
// The empty-ruleset case falls out rather than being special-cased. An empty
// allowlist permits nothing, so every code violates it; an empty blocklist
// blocks nothing, so none do. Callers pass a non-empty list.
function blockingCountryCodes(countryCodes) {
  if (!geoipRuleSet) return [];
  if (geoipMode === 'blocklist') {
    return countryCodes.filter((cc) => geoipRuleSet.has(cc));
  }
  return countryCodes.filter((cc) => !geoipRuleSet.has(cc));
}

// dns-packet's encoder takes the on-the-wire rcode from the low 4 bits of the
// `flags` field and IGNORES the convenience `rcode` string, so a response must
// fold its rcode into flags or it silently encodes as NOERROR. (This was a
// latent bug: synthesized NXDOMAIN/SERVFAIL replies were going out as NOERROR.)
const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };
function responseFlags(rcodeName) {
  return dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE | (RCODE[rcodeName] || 0);
}

// Pull the EDNS OPT pseudo-record (if any) from a decoded query's additionals.
export function getQueryOpt(query) {
  return query?.additionals?.find((a) => a.type === 'OPT') || null;
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
  return [
    {
      type: 'OPT',
      name: '.',
      udpPayloadSize: opt.udpPayloadSize || 1232,
      extendedRcode: 0,
      ednsVersion: 0,
      flags: opt.flag_do ? dnsPacket.DNSSEC_OK : 0,
      flag_do: !!opt.flag_do,
      options: [],
    },
  ];
}

// Every answered query, once: the analytics row and, for a DNS backend that
// keeps no query log of its own, a line in its log (utils/query-log.js).
function noteQuery(entry) {
  deps.queryRow(entry);
  writeQueryLine(entry);
}

// DNSSEC validation produces three states for analytics: secure, insecure,
// and unknown. AD is meaningful only when validation is enabled and the
// client did not ask dnsmasq to skip checking. Failed responses are not proof
// that a queried domain lacks DNSSEC support.
export function classifyDnssecSupport(response, { enabled, checkingDisabled = false } = {}) {
  if (!enabled || checkingDisabled || response?.rcode !== 'NOERROR') return null;
  return Boolean(response.flags & dnsPacket.AUTHENTIC_DATA);
}

// The EDE and cause of one answer the client got, counted for the minute.
// `response` is the decoded answer, or null when there was none.
export function noteAnswer(response, { timedOut = false } = {}) {
  const rcode = timedOut ? 'SERVFAIL' : response?.rcode;
  const ede = extractEde(response)?.code ?? null;
  const failure = failureCause(rcode, ede, { timedOut });
  if (failure) failureCounts[failure]++;
  if (rcode === 'NXDOMAIN') nxdomainCount++;
  return { ede, failure };
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
    additionals: buildOptEcho(getQueryOpt(query)),
  });
}

// Create a blocked response: the redirect address for the question's family
// (A or AAAA, NOERROR) or NXDOMAIN when no redirect is configured. With a
// redirect set for one family only, the other family gets an empty NOERROR
// answer, so a blocked name never resolves over the family that has no
// sinkhole either.
export function createBlockedResponse(query) {
  if (blocklistRedirectIp || blocklistRedirectIp6) {
    const answers = [];
    for (const q of query.questions) {
      if (q.type === 'A' && blocklistRedirectIp) {
        answers.push({ type: 'A', name: q.name, ttl: 300, data: blocklistRedirectIp });
      } else if (q.type === 'AAAA' && blocklistRedirectIp6) {
        answers.push({ type: 'AAAA', name: q.name, ttl: 300, data: blocklistRedirectIp6 });
      }
    }
    return dnsPacket.encode({
      id: query.id,
      type: 'response',
      flags: responseFlags('NOERROR'),
      questions: query.questions,
      answers,
      authorities: [],
      additionals: buildOptEcho(getQueryOpt(query)),
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
    additionals: buildOptEcho(getQueryOpt(query)),
  });
}

// Refresh the small pieces of blocklist state we do keep in memory: the two
// settings and the set of enabled category slugs. Domains stay in SQLite.
export function loadBlocklist() {
  const db = deps.db();
  const enabled = deps.setting('blocklist_enabled');
  blocklistEnabled = enabled === 'true';
  blocklistRedirectIp = deps.setting('blocklist_redirect_ip') || '';
  blocklistRedirectIp6 = deps.setting('blocklist_redirect_ip6') || '';

  if (!blocklistEnabled) {
    blocklistCategories = null;
    proxyLog('info', 'Blocklist disabled');
    return;
  }

  const rows = db.prepare('SELECT slug FROM blocklist_categories WHERE enabled = 1').all();
  blocklistCategories = new Set(rows.map((r) => r.slug));
  proxyLog('info', 'Blocklist enabled', { categories: blocklistCategories.size });
}

// The lookup statement is cached across queries but re-prepared if the DB
// handle changes (tests swap it, and a restore reopens it).
let blocklistLookupDb = null;
function getLookupStmt(db) {
  if (!blocklistLookupStmt || blocklistLookupDb !== db) {
    blocklistLookupStmt = db
      .prepare('SELECT category_slug FROM blocklist_domains WHERE domain = ?')
      .pluck();
    blocklistLookupDb = db;
  }
  return blocklistLookupStmt;
}

// Total domains across enabled categories, for the status endpoint.
function countEnabledDomains() {
  try {
    return (
      deps.db()
        .prepare(
          'SELECT COALESCE(SUM(domain_count), 0) AS c FROM blocklist_categories WHERE enabled = 1',
        )
        .pluck()
        .get() || 0
    );
  } catch {
    return 0;
  }
}

// Check query domain against blocklist (walks domain hierarchy for subdomain matching)
function checkBlocklist(queryName) {
  if (!blocklistEnabled || !blocklistCategories || blocklistCategories.size === 0) return null;

  // The allowlist used to be folded into the Map at load time by a
  // "NOT IN (SELECT domain FROM blocklist_allowlist)" clause, so this function
  // never had to think about it. Now that domains are read live, the check has
  // to happen here or allowlisted domains would start getting blocked.
  if (isAllowlisted(queryName)) return null;

  const stmt = getLookupStmt(deps.db());

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

/** Read the pause deadline and the exempt clients into memory. */
export function loadFilteringOverrides() {
  try {
    const until = Date.parse(deps.setting('filtering_paused_until') || '');
    filteringPausedUntil = Number.isFinite(until) ? until : 0;
    exemptClients = exemptAddressSet(deps.db());
  } catch (err) {
    proxyLog('error', 'Failed to load filtering overrides', { error: err.message });
  }
}

/** Why filtering is off for this client: 'paused', 'host', or null. */
export function filteringBypass(clientIp, now = Date.now()) {
  if (now < filteringPausedUntil) return 'paused';
  if (clientIp && exemptClients.has(clientIp)) return 'host';
  return null;
}

// Pre-forward verdict: does the blocklist intercept this name?
export function evaluateInboundPolicy(queryName, clientIp = null) {
  if (!queryName || filteringBypass(clientIp)) return { action: 'forward' };
  const blockedCategory = checkBlocklist(queryName);
  if (!blockedCategory) return { action: 'forward' };
  return {
    action: 'block',
    blockReason: blockedCategory,
    // With either redirect IP configured the synthesized answer is NOERROR
    // (createBlockedResponse's condition); otherwise the block is an NXDOMAIN.
    responseCode: blocklistRedirectIp || blocklistRedirectIp6 ? 'NOERROR' : 'NXDOMAIN',
  };
}

export function recordInboundBlock(verdict) {
  statsBlocked++;
  statsTotal++;
  blocklistBlockedDelta++;
  blocklistCategoryHits.set(
    verdict.blockReason,
    (blocklistCategoryHits.get(verdict.blockReason) || 0) + 1,
  );
}

// Post-answer verdict: do the resolved IPs trip a GeoIP country block?
// Allowlisted answer IPs are exempt before the country lookup; a allowlisted
// query name overrides a would-be block. Either way the verdict names a
// destination (the first answer GeoIP placed) for the Resolution Map, so the
// lookup runs even when filtering is paused or off for this client.
export function evaluateResolvedPolicy(
  queryName,
  ips,
  clientIp = null,
  lookup = lookupCountry,
  pointOf = cachedPoint,
) {
  if (!ips || ips.length === 0) return { action: 'forward', destination: null };
  const placed = ips
    .filter((ip) => !isGeoipAllowed(ip))
    .map((ip) => ({ ip, country: lookup(ip) }))
    .filter((p) => p.country !== null);
  const destinationOf = (p) => (p ? { country: p.country, point: pointOf(p.ip) } : null);
  if (filteringBypass(clientIp))
    return { action: 'forward', destination: destinationOf(placed[0]) };
  const blocking = blockingCountryCodes(placed.map((p) => p.country));
  if (blocking.length > 0 && !isAllowlisted(queryName)) {
    // Report only the codes that actually matched. countryCodes feeds
    // recordResolvedBlock, which increments per-country hit counters.
    return {
      action: 'block',
      blockReason: blocking[0],
      countryCodes: blocking,
      destination: destinationOf(placed.find((p) => p.country === blocking[0])),
    };
  }
  return { action: 'forward', destination: destinationOf(placed[0]) };
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
// ─── Forward-unknown zones on a backend that cannot ─────────────
// A zone with forward_unknown set sends the names CIDRella has no record for
// upstream (split horizon). dnsmasq does that itself; PowerDNS answers them
// NXDOMAIN from Authoritative, so the proxy asks the forwarder again for an
// NXDOMAIN under such a zone. The second answer is not validated by
// Recursor, and with bypass on the proxy is not in the path at all.
const FORWARD_UNKNOWN_CACHE_MS = 5000;
let forwardUnknownZones = { at: 0, names: [] };
let loggedForwardUnknownRetry = false;

function underForwardUnknownZone(queryName) {
  const now = Date.now();
  if (now - forwardUnknownZones.at > FORWARD_UNKNOWN_CACHE_MS) {
    forwardUnknownZones = {
      at: now,
      names: deps.db()
        .prepare('SELECT name FROM dns_zones WHERE enabled = 1 AND forward_unknown = 1')
        .all()
        .map((row) => normalizeZoneName(row.name)),
    };
  }
  const name = normalizeZoneName(queryName);
  return forwardUnknownZones.names.some((zone) => name === zone || name.endsWith(`.${zone}`));
}

const normalizeZoneName = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/\.$/, '');

/** Should this answer be asked again of the forwarder? See above. */
export function wantsUnknownRetry(response, queryName) {
  if (response?.rcode !== 'NXDOMAIN' || !queryName) return false;
  if (config.forwardsUnknownItself !== false) return false;
  if (deps.setting('dns_no_recursion') === 'true') return false;
  return underForwardUnknownZone(queryName);
}

function noteUnknownRetry(queryName) {
  if (loggedForwardUnknownRetry) return;
  loggedForwardUnknownRetry = true;
  proxyLog('info', 'Asking the forwarder for names a forward-unknown zone does not hold', {
    example: queryName,
  });
}

// The forwarder's answer to `query` (raw bytes), or null.
async function askForwarder(query, { tcp = false, timeoutMs }) {
  if (timeoutMs <= 0) return null;
  if (tcp) return relayQueryOverTcp(query, '127.0.0.1', ENCRYPTED_FORWARDER_PORT, timeoutMs);
  const { answer } = await plainUdpQuery('127.0.0.1', query, {
    timeoutMs,
    port: ENCRYPTED_FORWARDER_PORT,
  });
  return answer;
}

// A FORMERR reply built from a query's own header, for a message dns-packet
// cannot decode, so the client gets an answer instead of retrying into
// silence. Null for anything shorter than a header or already a response (a
// reply to a reply could loop between two resolvers). Keeps the ID, opcode
// and RD; every count is zero, which RFC 1035 allows for FORMERR.
const HEADER_BYTES = 12;
const QR_BIT = 0x80;
export function formErrReply(msg) {
  if (!msg || msg.length < HEADER_BYTES || msg[2] & QR_BIT) return null;
  const reply = Buffer.alloc(HEADER_BYTES);
  reply[0] = msg[0];
  reply[1] = msg[1];
  reply[2] = QR_BIT | (msg[2] & 0x79); // opcode (0x78) and RD (0x01)
  reply[3] = 0x80 | RCODE.FORMERR; // RA, as every proxy answer sets it
  return reply;
}

// Name the client and show the start of the message: the error alone ("Cannot
// decode name") says nothing about who sent it or what it was.
function logMalformed(clientIp, msg, err, transport) {
  proxyLog('warn', 'Malformed query', {
    clientIp,
    transport,
    bytes: msg.length,
    head: msg.subarray(0, 48).toString('hex'),
    error: err.message,
  });
}

function handleQuery(msg, rinfo, sock) {
  try {
    const startNs = process.hrtime.bigint();
    let query;
    try {
      query = dnsPacket.decode(msg);
    } catch (err) {
      logMalformed(canonicalizeIp(rinfo.address) || rinfo.address, msg, err, 'udp');
      const reply = formErrReply(msg);
      if (reply) sock.send(reply, rinfo.port, rinfo.address);
      return;
    }
    // One spelling per client, whichever socket family delivered the query,
    // so analytics and liveness never see the same host twice.
    const clientIp = canonicalizeIp(rinfo.address) || rinfo.address;

    // Extract query metadata for analytics
    const queryName = query.questions?.[0]?.name;
    const queryType = query.questions?.[0]?.type || 'A';

    try {
      deps.liveness(clientIp);
    } catch (err) {
      proxyLog('warn', 'Failed to record DNS-query liveness', {
        clientIp,
        error: err.message,
      });
    }

    // Blocklist check, intercept before forwarding to dnsmasq
    const inbound = evaluateInboundPolicy(queryName, clientIp);
    if (inbound.action === 'block') {
      recordInboundBlock(inbound);
      deps.resolution({ kind: 'blocklist', name: queryName, type: queryType });
      const response = createBlockedResponse(query);
      sock.send(response, rinfo.port, rinfo.address);
      const latencyUs = Number(process.hrtime.bigint() - startNs) / 1000;
      recordLatency(latencyUs);
      noteQuery({
        clientIp,
        domain: queryName,
        queryType,
        responseCode: inbound.responseCode,
        action: 'blocked_blocklist',
        blockReason: inbound.blockReason,
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
        noteQuery({
          clientIp: p.clientIp,
          domain: p.queryName,
          queryType: p.queryType,
          responseCode: 'SERVFAIL',
          action: 'allowed',
          latencyUs,
          ...noteAnswer(null, { timedOut: true }),
        });
        try {
          // Echo the client's EDNS OPT (stored on the pending entry) so a
          // validating stub still gets a well-formed SERVFAIL.
          const servfail = encodeServfail({
            id: p.originalId,
            questions: [],
            additionals: p.opt ? [p.opt] : [],
          });
          p.socket.send(servfail, p.port, p.address);
        } catch {
          /* ignore */
        }
      }
    }, PROXY_UDP_TIMEOUT_MS);

    pendingQueries.set(internalId, {
      address: rinfo.address,
      clientIp,
      port: rinfo.port,
      originalId: query.id,
      socket: sock,
      queryName: queryName || '',
      queryType,
      checkingDisabled: !!query.flag_cd,
      opt: getQueryOpt(query), // echoed on a synthesized GeoIP-block response
      query: msg, // asked again of the forwarder for a forward-unknown zone
      clientRd: asksRecursion(msg),
      timer,
      startNs,
    });

    // Rewrite query ID and forward to the backend on the internal port.
    const fwdBuf = withRecursionDesired(msg);
    fwdBuf.writeUInt16BE(internalId, 0);
    dnsmasqSocket.send(fwdBuf, config.internalPort, '127.0.0.1');
  } catch (err) {
    proxyLog('error', 'Query processing error', { error: err.message });
  }
}

// Recursion Desired: bit 0 of the third header byte. PowerDNS Recursor
// refuses a query without it, even for a name CIDRella serves, where dnsmasq
// answered it; Home Assistant's hourly reverse sweep of a network sends RD=0
// and drew a REFUSED for every address. The proxy asks the backend with RD set
// on either stack and gives the client back its own bit.
const RD_BIT = 0x01;
export const asksRecursion = (msg) => msg.length > 2 && (msg[2] & RD_BIT) !== 0;
export function withRecursionDesired(msg) {
  const buf = Buffer.from(msg);
  if (buf.length > 2) buf[2] |= RD_BIT;
  return buf;
}
export function withClientRd(reply, clientRd) {
  if (reply.length > 2) reply[2] = (reply[2] & ~RD_BIT) | (clientRd ? RD_BIT : 0);
  return reply;
}

// Handle a response from dnsmasq
function handleDnsmasqResponse(msg) {
  try {
    const response = dnsPacket.decode(msg);
    const pending = pendingQueries.get(response.id);
    if (!pending) return;

    pendingQueries.delete(response.id);
    clearTimeout(pending.timer);

    if (wantsUnknownRetry(response, pending.queryName)) {
      noteUnknownRetry(pending.queryName);
      const elapsedMs = Number(process.hrtime.bigint() - pending.startNs) / 1e6;
      askForwarder(pending.query, { timeoutMs: PROXY_UDP_TIMEOUT_MS - elapsedMs })
        .then((answer) => {
          let retried = null;
          try {
            retried = answer && dnsPacket.decode(answer);
          } catch {
            /* keep the first answer */
          }
          if (retried) deliverResponse(pending, answer, retried);
          else deliverResponse(pending, msg, response);
        })
        .catch((err) => proxyLog('error', 'Response processing error', { error: err.message }));
      return;
    }
    deliverResponse(pending, msg, response);
  } catch (err) {
    proxyLog('error', 'Response processing error', { error: err.message });
  }
}

// Send the client its answer: GeoIP checked, query ID restored, logged.
function deliverResponse(pending, msg, response) {
  try {
    // GeoIP check, inspect resolved IPs
    const ips = response.answers
      .filter((a) => a.type === 'A' || a.type === 'AAAA')
      .map((a) => a.data);

    const resolved = evaluateResolvedPolicy(pending.queryName, ips, pending.clientIp);
    deps.resolution({
      kind: resolved.action === 'block' ? 'geoip' : 'answer',
      name: pending.queryName,
      type: pending.queryType,
      destination: resolved.destination,
    });
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
      noteQuery({
        clientIp: pending.clientIp,
        domain: pending.queryName,
        queryType: pending.queryType,
        responseCode: 'NXDOMAIN',
        action: 'blocked_geoip',
        blockReason: resolved.blockReason,
        latencyUs,
        resolvedIp: ips[0],
      });
      return;
    }

    // Allowed, forward original response (restore original query ID)
    statsAllowed++;
    statsTotal++;
    const buf = withClientRd(Buffer.from(msg), pending.clientRd);
    buf.writeUInt16BE(pending.originalId, 0);
    pending.socket.send(buf, pending.port, pending.address);
    const latencyUs = Number(process.hrtime.bigint() - pending.startNs) / 1000;
    recordLatency(latencyUs);

    // Extract response code name and first resolved IP
    const rcodeNames = ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED'];
    const rcode = response.rcode || rcodeNames[0];
    const firstIp = ips.length > 0 ? ips[0] : null;
    const dnssecSupported = classifyDnssecSupport(response, {
      enabled: deps.setting('dnssec_enabled') === 'true',
      checkingDisabled: pending.checkingDisabled,
    });
    noteQuery({
      clientIp: pending.clientIp,
      domain: pending.queryName,
      queryType: pending.queryType,
      responseCode: rcode,
      action: 'allowed',
      latencyUs,
      resolvedIp: firstIp,
      dnssecSupported,
      ...noteAnswer(response),
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
  try {
    sock.write(frameTcpMessage(payload));
  } catch {
    /* client gone */
  }
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
      try {
        upstream.destroy();
      } catch {
        /* ignore */
      }
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
  const clientIp = canonicalizeIp(clientSock.remoteAddress || '') || clientSock.remoteAddress || '';
  try {
    query = dnsPacket.decode(msg);
  } catch (err) {
    // Answer and keep the connection open for the client's next message.
    logMalformed(clientIp, msg, err, 'tcp');
    const reply = formErrReply(msg);
    if (reply) writeTcpMessage(clientSock, reply);
    return;
  }
  const queryName = query.questions?.[0]?.name;
  const queryType = query.questions?.[0]?.type || 'A';

  try {
    deps.liveness(clientIp);
  } catch (err) {
    proxyLog('warn', 'Failed to record DNS-query liveness (TCP)', { clientIp, error: err.message });
  }

  // Blocklist intercept, no dnsmasq round-trip. Same verdict path as UDP.
  const inbound = evaluateInboundPolicy(queryName, clientIp);
  if (inbound.action === 'block') {
    recordInboundBlock(inbound);
    deps.resolution({ kind: 'blocklist', name: queryName, type: queryType });
    writeTcpMessage(clientSock, createBlockedResponse(query));
    const latencyUs = Number(process.hrtime.bigint() - startNs) / 1000;
    recordLatency(latencyUs);
    noteQuery({
      clientIp,
      domain: queryName,
      queryType,
      responseCode: inbound.responseCode,
      action: 'blocked_blocklist',
      blockReason: inbound.blockReason,
      latencyUs,
    });
    return;
  }

  // Relay to dnsmasq over TCP (same internal port it serves UDP on).
  const internalPort = config.internalPort;
  let respMsg = await relayQueryOverTcp(
    withRecursionDesired(msg),
    '127.0.0.1',
    internalPort,
    PROXY_TCP_RELAY_TIMEOUT_MS,
  );
  if (respMsg) {
    let first = null;
    try {
      first = dnsPacket.decode(respMsg);
    } catch {
      /* relayed raw below */
    }
    if (wantsUnknownRetry(first, queryName)) {
      noteUnknownRetry(queryName);
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      const retried = await askForwarder(msg, {
        tcp: true,
        timeoutMs: PROXY_TCP_RELAY_TIMEOUT_MS - elapsedMs,
      });
      if (retried) respMsg = retried;
    }
  }
  const latencyUs = Number(process.hrtime.bigint() - startNs) / 1000;
  recordLatency(latencyUs);

  if (!respMsg) {
    timeoutCount++;
    statsTotal++;
    writeTcpMessage(clientSock, encodeServfail(query));
    noteQuery({
      clientIp,
      domain: queryName || '',
      queryType,
      responseCode: 'SERVFAIL',
      action: 'allowed',
      latencyUs,
      ...noteAnswer(null, { timedOut: true }),
    });
    return;
  }

  // GeoIP check on the resolved answers, same policy as the UDP path.
  let response = null;
  try {
    response = dnsPacket.decode(respMsg);
  } catch {
    /* relay raw below */
  }

  const ips = response
    ? response.answers.filter((a) => a.type === 'A' || a.type === 'AAAA').map((a) => a.data)
    : [];

  // Same verdict path as UDP's handleDnsmasqResponse.
  const resolved = evaluateResolvedPolicy(queryName, ips, clientIp);
  deps.resolution({
    kind: resolved.action === 'block' ? 'geoip' : 'answer',
    name: queryName,
    type: queryType,
    destination: resolved.destination,
  });
  if (resolved.action === 'block') {
    recordResolvedBlock(resolved);
    writeTcpMessage(clientSock, createNxdomainResponse(query));
    noteQuery({
      clientIp,
      domain: queryName || '',
      queryType,
      responseCode: 'NXDOMAIN',
      action: 'blocked_geoip',
      blockReason: resolved.blockReason,
      latencyUs,
      resolvedIp: ips[0],
    });
    return;
  }

  // Allowed, relay the backend's raw bytes (preserves signatures + ID), with
  // the client's own RD bit; the header is outside every signature.
  statsAllowed++;
  statsTotal++;
  writeTcpMessage(clientSock, withClientRd(Buffer.from(respMsg), asksRecursion(msg)));
  const dnssecSupported = classifyDnssecSupport(response, {
    enabled: deps.setting('dnssec_enabled') === 'true',
    checkingDisabled: !!query.flag_cd,
  });
  noteQuery({
    clientIp,
    domain: queryName || '',
    queryType,
    // response is null when decode failed and we relayed raw bytes, don't claim NOERROR.
    responseCode: response?.rcode || 'UNKNOWN',
    action: 'allowed',
    latencyUs,
    resolvedIp: ips[0] || null,
    dnssecSupported,
    ...noteAnswer(response),
  });
}

// Accept a client TCP connection: buffer, deframe, dispatch each message.
function onTcpConnection(clientSock) {
  if (activeTcpConnections >= PROXY_MAX_TCP_CONNECTIONS) {
    try {
      clientSock.destroy();
    } catch {
      /* ignore */
    }
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
    try {
      clientSock.destroy();
    } catch {
      /* ignore */
    }
  };

  clientSock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, rest } = extractTcpMessages(buf);
    buf = rest;
    for (const m of messages) void handleTcpQuery(m, clientSock);
    // Guard against a peer that sends a huge length prefix but never the body.
    if (buf.length > 0xffff + 2) cleanup();
  });
  clientSock.on('timeout', cleanup);
  clientSock.on('error', cleanup);
  clientSock.on('close', cleanup);
}

// Start answering: one UDP socket and one TCP listener per LAN address. DNS
// switched off: the proxy does not listen, whatever stack serves, so the LAN
// port gets no answer.
export function startServing() {
  if (proxyServers.length > 0) {
    proxyLog('warn', 'Proxy already running');
    return;
  }
  if (config.dnsOff) {
    proxyLog('info', 'DNS is switched off, the proxy does not listen');
    return;
  }

  proxyStartedAt = Date.now();
  cancelBindRetries();

  // Create socket for forwarding to dnsmasq. A restart attempt that bound
  // nothing left the last one open.
  try {
    dnsmasqSocket?.close();
  } catch {
    /* already closed */
  }
  dnsmasqSocket = dgram.createSocket('udp4');
  dnsmasqSocket.on('error', (err) => {
    proxyLog('error', 'dnsmasq socket error', { error: err.message });
  });
  dnsmasqSocket.on('message', (msg) => handleDnsmasqResponse(msg));

  // Bind one socket per LAN address on the configured DNS listen port (default 53).
  const addresses = config.listenAddresses;
  if (addresses.length === 0) {
    proxyLog('warn', 'No LAN addresses found, proxy has nothing to bind to');
    return;
  }
  const { listenPort } = config;

  for (const addr of addresses) {
    bindUdp(addr, listenPort, addresses.length);
    bindTcp(addr, listenPort);
  }
}

// An address can be on the interface but not usable yet: an IPv6 address
// waits out Duplicate Address Detection after boot, and a bind to it fails
// with EADDRNOTAVAIL. Such a bind is tried again, a second apart and then
// further, for about a minute, so the proxy is not left deaf on that address
// until the next restart. Any other bind error stays final, as before.
const BIND_RETRY_DELAYS_MS = [1000, 2000, 3000, 5000, 5000, 10000, 10000, 10000, 15000];
const bindRetries = new Set();

function retryBind(err, addr, attempt, bind) {
  if (err.code !== 'EADDRNOTAVAIL' || attempt >= BIND_RETRY_DELAYS_MS.length) return false;
  const delayMs = BIND_RETRY_DELAYS_MS[attempt];
  proxyLog('warn', 'Address not usable yet, binding again', {
    address: addr,
    error: err.message,
    delayMs,
  });
  const timer = setTimeout(() => {
    bindRetries.delete(timer);
    bind(attempt + 1);
  }, delayMs);
  timer.unref?.();
  bindRetries.add(timer);
  return true;
}

export function cancelBindRetries() {
  for (const timer of bindRetries) clearTimeout(timer);
  bindRetries.clear();
}

function bindUdp(addr, listenPort, total, attempt = 0) {
  const sock = dgram.createSocket({
    type: net.isIP(addr) === 6 ? 'udp6' : 'udp4',
    reuseAddr: true,
  });
  let bound = false;

  sock.on('message', (msg, rinfo) => handleQuery(msg, rinfo, sock));

  sock.on('error', (err) => {
    // A socket that never bound answers nothing: drop it, so the status and
    // the health monitor do not count it, and try again when that may help
    // (retryBind logs that, so a retried bind is a warning, not an error).
    if (!bound) {
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      if (retryBind(err, addr, attempt, (next) => bindUdp(addr, listenPort, total, next))) return;
    }
    proxyLog('error', 'Proxy socket error', {
      address: addr,
      error: err.message,
      code: err.code,
    });
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      proxyLog('error', `Cannot bind port ${listenPort}`, { address: addr });
    }
  });

  sock.on('close', () => {
    // Remove from proxyServers array
    const idx = proxyServers.findIndex((s) => s.socket === sock);
    if (idx >= 0) proxyServers.splice(idx, 1);
    if (proxyServers.length === 0 && bound) {
      proxyLog('warn', 'All proxy sockets closed');
    }
  });

  sock.bind(listenPort, addr, () => {
    bound = true;
    const entry = proxyServers.find((s) => s.socket === sock);
    if (entry) entry.bound = true;
    proxyLog('info', 'Proxy socket bound', { address: `${addr}:${listenPort}` });
    if (proxyServers.filter((s) => s.bound).length === total) {
      proxyStartupMs = Date.now() - proxyStartedAt;
      proxyLog('info', 'Proxy fully started', { sockets: total, startupMs: proxyStartupMs });
    }
  });

  proxyServers.push({ socket: sock, address: addr, bound: false });
}

// Bind a TCP listener per LAN address on the same port. TCP is additive and
// best-effort: a TCP bind failure is logged but does NOT tear down the UDP
// path or trip the watchdog (which counts UDP sockets), UDP
// DNS keeps working even if TCP can't bind. In practice they bind or fail
// together since they share the address/port.
function bindTcp(addr, listenPort, attempt = 0) {
  const tcpServer = net.createServer(onTcpConnection);
  let listening = false;
  tcpServer.on('error', (err) => {
    if (!listening) {
      const idx = tcpServers.findIndex((t) => t.server === tcpServer);
      if (idx >= 0) tcpServers.splice(idx, 1);
      if (retryBind(err, addr, attempt, (next) => bindTcp(addr, listenPort, next))) return;
    }
    proxyLog('error', 'Proxy TCP server error', {
      address: addr,
      error: err.message,
      code: err.code,
    });
  });
  tcpServer.listen(listenPort, addr, () => {
    listening = true;
    proxyLog('info', 'Proxy TCP listener bound', { address: `${addr}:${listenPort}` });
  });
  tcpServers.push({ server: tcpServer, address: addr });
}

// Stop answering
export function stopServing() {
  cancelBindRetries();
  for (const { socket } of proxyServers) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
  proxyServers = [];

  for (const { server } of tcpServers) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }
  tcpServers = [];
  activeTcpConnections = 0;

  if (dnsmasqSocket) {
    try {
      dnsmasqSocket.close();
    } catch {
      /* ignore */
    }
    dnsmasqSocket = null;
  }

  // Clear pending queries
  for (const [, pending] of pendingQueries) {
    clearTimeout(pending.timer);
  }
  pendingQueries.clear();
  proxyLog('info', 'Proxy stopped');
}

// What the proxy is doing now, for the status pages and the watchdog:
// `sockets` counts UDP sockets bound or binding, `bound` those that answer.
export function serverStatus() {
  const bound = proxyServers.filter((s) => s.bound);
  return {
    running: bound.length > 0,
    sockets: proxyServers.length,
    bound: bound.length,
    listenAddresses: bound.map((s) => s.address),
    tcpListeners: tcpServers.length,
    activeTcpConnections,
    dbLoaded: mmdbReader !== null,
    statsTotal,
    statsBlocked,
    statsAllowed,
    blocklistLoaded: blocklistCategories !== null,
    // Summed from the per-category counters the refresh already maintains.
    // A COUNT(*) here would scan the whole domains table on every status poll.
    blocklistDomainCount: blocklistCategories === null ? 0 : countEnabledDomains(),
    filteringPausedUntil:
      filteringPausedUntil > Date.now() ? new Date(filteringPausedUntil).toISOString() : null,
    filteringExemptClients: exemptClients.size,
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
  const { sorted: samples, seen } = latency.drain();

  const hits = cacheHits;
  const misses = cacheMisses;
  cacheHits = 0;
  cacheMisses = 0;

  const timeouts = timeoutCount;
  timeoutCount = 0;

  const pending = pendingQueries.size;
  const failures = failureCounts;
  const nxdomain = nxdomainCount;
  failureCounts = noFailures();
  nxdomainCount = 0;

  if (samples.length === 0) {
    return {
      queryCount: 0,
      latencyMin: null,
      latencyAvg: null,
      latencyMax: null,
      latencyP95: null,
      cacheHits: hits,
      cacheMisses: misses,
      timeouts,
      pendingQueries: pending,
      startupMs: proxyStartupMs,
      failures,
      nxdomain,
    };
  }

  const sum = samples.reduce((a, b) => a + b, 0);

  return {
    queryCount: seen,
    latencyMin: Math.round(samples[0]),
    latencyAvg: Math.round(sum / samples.length),
    latencyMax: Math.round(samples[samples.length - 1]),
    latencyP95: Math.round(quantileOfSorted(samples, 0.95)),
    cacheHits: hits,
    cacheMisses: misses,
    timeouts,
    pendingQueries: pending,
    startupMs: proxyStartupMs,
    failures,
    nxdomain,
  };
}

/** Everything the metrics aggregator takes each minute, counted since the last call. */
export function drainMetrics() {
  return {
    blocklistHits: getAndResetBlocklistHits(),
    blockedDelta: getBlockedDelta(),
    countryHits: getAndResetCountryHits(),
    performance: getAndResetPerformanceMetrics(),
  };
}
