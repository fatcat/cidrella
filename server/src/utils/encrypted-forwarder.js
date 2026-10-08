/**
 * In-Node DNS forwarder stub: dnsmasq's one upstream whenever CIDRella
 * recurses. dnsmasq's `server=` points at this loopback stub
 * (127.0.0.1:<port>), and it relays each query to the configured resolvers
 * over DNS-over-TLS, DNS-over-HTTPS or, in plaintext mode, plain DNS, then
 * returns the raw response verbatim (preserving EDNS/DO so DNSSEC records
 * pass through and CIDRella's own validation still works).
 *
 * It, not dnsmasq, decides which resolver a query goes to: a primary and an
 * optional backup, asked On failure or in turns (utils/forwarding-settings.js),
 * with a resolver that gave no answer held at the back of the line. dnsmasq
 * has no turns of its own (it favors the fastest server), and going through
 * here gives plaintext the same per-resolver metrics as the encrypted modes.
 *
 * FAIL CLOSED: any failure returns SERVFAIL, never a silent fallback to
 * plaintext (or, in plaintext mode, to anything else). The cost is that
 * resolution is down if the path is broken (surfaced via
 * getEncryptedForwarderStatus()).
 *
 * The file keeps its name from when it carried only DoT and DoH. Coupling
 * seam #7 in docs/DNSMASQ-COUPLING.md: a future PowerDNS Recursor would do
 * this natively, and this module is deleted.
 */

import dgram from 'dgram';
import net from 'net';
import dnsPacket from 'dns-packet';
import { getSetting } from '../db/init.js';
import { frameTcpMessage, extractTcpMessages } from './dns-wire.js';
import { createUpstreamPool } from './upstream-pool.js';
import { edeOption } from './dns-ede.js';
import { createReservoir, quantileOfSorted } from './samples.js';
import { backupMode } from './forwarding-settings.js';
import { plainUdpQuery, plainTcpQuery } from './plain-dns.js';
import { DOH_PROVIDERS } from '../data/doh-providers.js';
import {
  ENCRYPTED_FORWARDER_PORT,
  ENCRYPTED_FORWARDER_TIMEOUT_MS,
  ENCRYPTED_FORWARDER_BUDGET_MS,
  ENCRYPTED_FORWARDER_HOLD_MS,
} from '../config/defaults.js';

const HOST = '127.0.0.1';

// Module state
let udpSocket = null;
let tcpServer = null;
let mode = 'off'; // 'off' | 'tls' | 'https'
let upstreams = []; // [{ label, addresses:[], hostname, doh_url }]
let rrIndex = 0;
let order = 'balance'; // 'failover' always starts at the primary, see forwarding-settings.js
let recentErrors = []; // { at, provider } of recent failures (sliding window)
let lastError = null;
const ERROR_WINDOW_MS = 10 * 60 * 1000; // "recent" = last 10 minutes

const providerName = (upstream) => upstream?.hostname || upstream?.label || '';

function recentErrorList() {
  const cutoff = Date.now() - ERROR_WINDOW_MS;
  recentErrors = recentErrors.filter((e) => e.at >= cutoff);
  return recentErrors;
}

function efLog(level, msg, extra) {
  const ts = new Date().toISOString();
  const prefix = `[enc-forwarder] ${ts}`;
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  if (level === 'error') console.error(`${prefix} ERROR: ${msg}${suffix}`);
  else if (level === 'warn') console.warn(`${prefix} WARN: ${msg}${suffix}`);
  else console.log(`${prefix} ${msg}${suffix}`);
}

// Failures also go to the journal, at most one line a minute: the first
// failure at once, then the next one after the minute is up, carrying how many
// were left out in between. Without these lines a burst of upstream failures
// (and the SERVFAILs or DNSSEC BOGUS answers they cause) left no trace.
const ERROR_LOG_INTERVAL_MS = 60 * 1000;
let lastErrorLoggedAt = -Infinity;
let unloggedErrors = 0;

function recordError(e, upstream = null, address = null) {
  const now = Date.now();
  recentErrors.push({ at: now, provider: providerName(upstream) });
  lastError = e?.message || String(e);
  if (now - lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS) {
    unloggedErrors++;
    return;
  }
  const extra = { mode, upstream: providerName(upstream) || null, address };
  if (unloggedErrors) extra.notLoggedSinceLastLine = unloggedErrors;
  efLog('warn', `Upstream query failed: ${lastError}`, extra);
  lastErrorLoggedAt = now;
  unloggedErrors = 0;
}

// Build a SERVFAIL preserving the query id + question and echoing the client's
// EDNS OPT (so a validating stub still gets a well-formed reply). RCODE is folded
// into the low 4 bits of `flags` (dns-packet ignores the `rcode` field). `ede`
// ({ code, text }) rides in that OPT: dnsmasq relays an upstream's EDE to the
// client, so the proxy can tell this failure from a DNSSEC one.
export function buildServfail(reqBuf, ede = null) {
  let q;
  try {
    q = dnsPacket.decode(reqBuf);
  } catch {
    return null;
  }
  const opt = q.additionals?.find((a) => a.type === 'OPT');
  return dnsPacket.encode({
    id: q.id,
    type: 'response',
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE | 2, // 2 = SERVFAIL
    questions: q.questions || [],
    answers: [],
    authorities: [],
    additionals: opt
      ? [
          {
            type: 'OPT',
            name: '.',
            udpPayloadSize: opt.udpPayloadSize || 1232,
            extendedRcode: 0,
            ednsVersion: 0,
            flags: opt.flag_do ? dnsPacket.DNSSEC_OK : 0,
            flag_do: !!opt.flag_do,
            options: ede ? [edeOption(ede.code, ede.text)] : [],
          },
        ]
      : [],
  });
}

// Every upstream failed this query (RFC 8914 code 22).
const NO_UPSTREAM_ANSWER = { code: 22, text: 'no upstream answered' };

// ── DoT and DoH: connections to each upstream address stay open and carry
// every query (utils/upstream-pool.js), validated against the upstream's
// hostname. DoH connects by address too, so no bootstrap DNS is needed. One
// pool per protocol and timeout, since tests pass short timeouts.
const pools = new Map();

// ── What each upstream address did this minute, for the metrics_forwarder
// rows (utils/metrics-aggregator.js). Keyed by provider hostname and address;
// address '' holds a provider's failovers, which belong to no one address.
let minuteRows = new Map();

function minuteRow(upstream, address, protocol) {
  const provider = providerName(upstream);
  const key = `${provider}|${address}|${protocol}`;
  let row = minuteRows.get(key);
  if (!row) {
    row = {
      provider,
      address,
      protocol,
      queries: 0,
      answers: 0,
      timeouts: 0,
      drops: 0,
      connect_failures: 0,
      failovers: 0,
      latency: createReservoir(200),
    };
    minuteRows.set(key, row);
  }
  return row;
}

const COUNTER_FOR_EVENT = {
  query: 'queries',
  answer: 'answers',
  timeout: 'timeouts',
  drop: 'drops',
  connect_failed: 'connect_failures',
};

function recordEvent(protocol, kind, upstream, address, ms) {
  const counter = COUNTER_FOR_EVENT[kind];
  if (!counter) return;
  const row = minuteRow(upstream, address, protocol);
  row[counter]++;
  if (kind === 'answer') row.latency.add(ms * 1000);
}

/** This minute's rows, one per upstream address that saw traffic; then empty. */
export function getAndResetForwarderMetrics() {
  const rows = [...minuteRows.values()];
  minuteRows = new Map();
  return rows.map(({ latency, ...row }) => {
    const { sorted } = latency.drain();
    const us = (q) => (sorted.length ? Math.round(quantileOfSorted(sorted, q)) : null);
    return { ...row, latency_p50_us: us(0.5), latency_p95_us: us(0.95) };
  });
}

function poolFor(protocol, timeoutMs) {
  const key = `${protocol}|${timeoutMs}`;
  let pool = pools.get(key);
  if (!pool) {
    pool = createUpstreamPool({
      protocol,
      timeoutMs,
      onError: recordError,
      onEvent: (...event) => recordEvent(protocol, ...event),
    });
    pools.set(key, pool);
  }
  return pool;
}

export function forwardDoT(reqBuf, upstream, timeoutMs = ENCRYPTED_FORWARDER_TIMEOUT_MS, deadline) {
  return poolFor('dot', timeoutMs).query(reqBuf, upstream, { deadline });
}

export function forwardDoH(reqBuf, upstream, timeoutMs = ENCRYPTED_FORWARDER_TIMEOUT_MS, deadline) {
  return poolFor('doh', timeoutMs).query(reqBuf, upstream, { deadline });
}

// Providers that gave no answer lately, by name: hostname -> held until (ms).
const held = new Map();

/**
 * Ask the upstreams in turn, starting at `first`, until one answers or the
 * budget is spent. Taking turns on who goes first still spreads the load; the
 * others are there for a query the first could not answer, as when Quad9
 * timed out on both its addresses for two hours.
 *
 * A provider that gives no answer is held for ENCRYPTED_FORWARDER_HOLD_MS:
 * while held it goes to the back of the line, so a dead primary costs one
 * timeout per hold rather than one per query. Once the hold ends, the next
 * query tries it again. When every provider is held they are still asked,
 * in order, since a held one may be back.
 * `forward(reqBuf, upstream, deadline)` resolves an answer or null.
 */
export async function queryUpstreams(
  reqBuf,
  list,
  {
    first = 0,
    forward,
    budgetMs = ENCRYPTED_FORWARDER_BUDGET_MS,
    holdMs = ENCRYPTED_FORWARDER_HOLD_MS,
    now = Date.now,
  },
) {
  const deadline = now() + budgetMs;
  const turn = list.map((_, i) => list[(first + i) % list.length]);
  const isHeld = (upstream) => (held.get(providerName(upstream)) ?? 0) > now();
  const line = [...turn.filter((u) => !isHeld(u)), ...turn.filter(isHeld)];
  for (let i = 0; i < line.length && now() < deadline; i++) {
    const upstream = line[i];
    try {
      const resp = await forward(reqBuf, upstream, deadline);
      if (resp) {
        held.delete(providerName(upstream));
        return resp;
      }
    } catch (e) {
      recordError(e, upstream);
    }
    held.set(providerName(upstream), now() + holdMs);
    if (i + 1 < line.length && now() < deadline) {
      minuteRow(upstream, '', protocolFor(mode)).failovers++;
    }
  }
  return null;
}

/** The providers held after giving no answer (status, tests). */
export function heldProviders(at = Date.now()) {
  return [...held].filter(([, until]) => until > at).map(([name]) => name);
}

/** Release every hold (tests; a reconfigure does it too). */
export function releaseHolds() {
  held.clear();
}

const PROTOCOLS = { off: 'plain', tls: 'dot', https: 'doh' };
const protocolFor = (forwarderMode) => PROTOCOLS[forwarderMode] || 'dot';

/**
 * Plaintext forwarding: the resolver's addresses in turn, UDP or TCP as the
 * query came in (a truncated UDP answer goes back to dnsmasq as is, and it
 * asks again over TCP). Resolves an answer or null; each address gets one
 * send, cut short by the deadline.
 */
export async function forwardPlain(
  reqBuf,
  upstream,
  deadline = Infinity,
  { tcp = false, timeoutMs = ENCRYPTED_FORWARDER_TIMEOUT_MS, port } = {},
) {
  for (const address of upstream.addresses || []) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    recordEvent('plain', 'query', upstream, address);
    const send = tcp ? plainTcpQuery : plainUdpQuery;
    const { answer, ms, refused } = await send(address, reqBuf, {
      timeoutMs: Math.min(timeoutMs, left),
      port,
    });
    if (answer) {
      recordEvent('plain', 'answer', upstream, address, ms);
      return answer;
    }
    recordEvent('plain', refused ? 'connect_failed' : 'timeout', upstream, address);
    recordError(new Error(refused ? 'connection refused' : 'no answer in time'), upstream, address);
  }
  return null;
}

// The plaintext primary and backup as the forwarder's upstreams, each named
// after the preset whose addresses it has, or after its addresses.
function plainResolvers() {
  return [getSetting('dns_upstream_servers'), getSetting('dns_upstream_backup_servers')]
    .filter((addresses) => Array.isArray(addresses) && addresses.length)
    .map((addresses) => {
      const key = [...addresses].sort().join();
      const preset = DOH_PROVIDERS.find((p) => [...p.addresses].sort().join() === key);
      return { label: preset?.hostname || addresses.join(', '), hostname: '', addresses };
    });
}

function closePools() {
  for (const pool of pools.values()) pool.closeAll();
  pools.clear();
}

/** Where a query starts: the primary under failover, turns under balance. */
export function firstUpstream() {
  return order === 'failover' || upstreams.length === 0 ? 0 : rrIndex++ % upstreams.length;
}

async function handleQuery(reqBuf, { tcp = false } = {}) {
  const forward =
    mode === 'tls'
      ? (buf, upstream, deadline) => forwardDoT(buf, upstream, undefined, deadline)
      : mode === 'https'
        ? (buf, upstream, deadline) => forwardDoH(buf, upstream, undefined, deadline)
        : (buf, upstream, deadline) => forwardPlain(buf, upstream, deadline, { tcp });
  const resp =
    forward && upstreams.length
      ? await queryUpstreams(reqBuf, upstreams, { first: firstUpstream(), forward })
      : null;
  return resp || buildServfail(reqBuf, NO_UPSTREAM_ANSWER); // fail closed
}

function startListeners() {
  udpSocket = dgram.createSocket('udp4');
  udpSocket.on('message', async (msg, rinfo) => {
    const resp = await handleQuery(msg);
    if (resp) {
      try {
        udpSocket.send(resp, rinfo.port, rinfo.address);
      } catch {
        /* ignore */
      }
    }
  });
  udpSocket.on('error', (e) => efLog('error', 'UDP socket error', { error: e.message }));
  udpSocket.bind(ENCRYPTED_FORWARDER_PORT, HOST);

  tcpServer = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.setTimeout(15000);
    sock.on('data', async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { messages, rest } = extractTcpMessages(buf);
      buf = rest;
      for (const m of messages) {
        const resp = await handleQuery(m, { tcp: true });
        if (resp && sock.writable) {
          try {
            sock.write(frameTcpMessage(resp));
          } catch {
            /* ignore */
          }
        }
      }
    });
    sock.on('timeout', () => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    });
    sock.on('error', () => {
      /* client gone */
    });
  });
  tcpServer.on('error', (e) => efLog('error', 'TCP server error', { error: e.message }));
  tcpServer.listen(ENCRYPTED_FORWARDER_PORT, HOST);

  efLog('info', `Forwarder listening on ${HOST}:${ENCRYPTED_FORWARDER_PORT}`, {
    mode,
    upstreams: upstreams.length,
  });
}

function stopListeners() {
  try {
    udpSocket?.close();
  } catch {
    /* ignore */
  }
  try {
    tcpServer?.close();
  } catch {
    /* ignore */
  }
  udpSocket = null;
  tcpServer = null;
}

// Start/stop/reconfigure from settings. Call at startup and on settings change.
export function applyEncryptedForwarder() {
  mode = getSetting('forwarder_encryption') || 'off';
  upstreams = mode === 'off' ? plainResolvers() : getSetting('forwarder_encrypted_upstreams') || [];
  order = backupMode();
  releaseHolds();
  recentErrors = [];
  lastError = null;
  // A changed upstream list or mode starts on fresh connections.
  closePools();

  // With recursion disabled, CIDRella forwards nothing, don't run the stub even
  // if an encryption mode is still persisted (preference is preserved for when
  // recursion is re-enabled).
  const noRecursion = getSetting('dns_no_recursion') === 'true';

  if (noRecursion || !Array.isArray(upstreams) || upstreams.length === 0) {
    stopListeners();
    return;
  }
  if (!udpSocket && !tcpServer) startListeners();
  else efLog('info', 'Forwarder reconfigured', { mode, upstreams: upstreams.length });
}

export function stopEncryptedForwarder() {
  stopListeners();
  closePools();
}

export function getEncryptedForwarderStatus() {
  return {
    mode,
    running: !!(udpSocket || tcpServer),
    upstreams: upstreams.map(providerName),
    recentErrors: recentErrorList().length,
    // The same count for each provider, so one failing is told from all.
    providers: upstreams.map((u) => ({
      hostname: providerName(u),
      recentErrors: recentErrorList().filter((e) => e.provider === providerName(u)).length,
    })),
    lastError,
  };
}
