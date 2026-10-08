/**
 * In-Node encrypted DNS forwarder stub (DoT / DoH).
 *
 * dnsmasq can't forward over DoT/DoH, so when encrypted forwarding is enabled we
 * point dnsmasq's `server=` at this loopback stub (127.0.0.1:<port>). It relays
 * each query to the configured upstream over DNS-over-TLS or DNS-over-HTTPS and
 * returns the raw response verbatim (preserving EDNS/DO so DNSSEC records pass
 * through and CIDRella's own validation still works).
 *
 * FAIL CLOSED: any encrypted-path failure returns SERVFAIL, never a silent
 * fallback to plaintext. The cost is that resolution is down if the encrypted
 * path is broken (surfaced via getEncryptedForwarderStatus()).
 *
 * Self-contained on purpose (coupling seam #7 in docs/DNSMASQ-COUPLING.md): a
 * future PowerDNS Recursor would do DoT/DoH natively, and this module is deleted.
 */

import dgram from 'dgram';
import net from 'net';
import dnsPacket from 'dns-packet';
import { getSetting } from '../db/init.js';
import { frameTcpMessage, extractTcpMessages } from './dns-wire.js';
import { createUpstreamPool } from './upstream-pool.js';
import { edeOption } from './dns-ede.js';
import { createReservoir, quantileOfSorted } from './samples.js';
import {
  ENCRYPTED_FORWARDER_PORT,
  ENCRYPTED_FORWARDER_TIMEOUT_MS,
  ENCRYPTED_FORWARDER_BUDGET_MS,
} from '../config/defaults.js';

const HOST = '127.0.0.1';

// Module state
let udpSocket = null;
let tcpServer = null;
let mode = 'off'; // 'off' | 'tls' | 'https'
let upstreams = []; // [{ label, addresses:[], hostname, doh_url }]
let rrIndex = 0;
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

// Every encrypted upstream failed this query (RFC 8914 code 22).
const NO_UPSTREAM_ANSWER = { code: 22, text: 'no encrypted upstream answered' };

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

/**
 * Ask the upstreams in turn, starting at `first`, until one answers or the
 * budget is spent. Taking turns on who goes first still spreads the load; the
 * others are there for a query the first could not answer, as when Quad9
 * timed out on both its addresses for two hours.
 * `forward(reqBuf, upstream, deadline)` resolves an answer or null.
 */
export async function queryUpstreams(
  reqBuf,
  list,
  { first = 0, forward, budgetMs = ENCRYPTED_FORWARDER_BUDGET_MS },
) {
  const deadline = Date.now() + budgetMs;
  for (let i = 0; i < list.length && Date.now() < deadline; i++) {
    const upstream = list[(first + i) % list.length];
    try {
      const resp = await forward(reqBuf, upstream, deadline);
      if (resp) return resp;
    } catch (e) {
      recordError(e, upstream);
    }
    if (i + 1 < list.length && Date.now() < deadline) {
      minuteRow(upstream, '', protocolFor(mode)).failovers++;
    }
  }
  return null;
}

const protocolFor = (forwarderMode) => (forwarderMode === 'https' ? 'doh' : 'dot');

function closePools() {
  for (const pool of pools.values()) pool.closeAll();
  pools.clear();
}

async function handleQuery(reqBuf) {
  const forward =
    mode === 'tls'
      ? (buf, upstream, deadline) => forwardDoT(buf, upstream, undefined, deadline)
      : mode === 'https'
        ? (buf, upstream, deadline) => forwardDoH(buf, upstream, undefined, deadline)
        : null;
  const resp =
    forward && upstreams.length
      ? await queryUpstreams(reqBuf, upstreams, { first: rrIndex++ % upstreams.length, forward })
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
        const resp = await handleQuery(m);
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

  efLog('info', `Encrypted forwarder listening on ${HOST}:${ENCRYPTED_FORWARDER_PORT}`, {
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
  upstreams = getSetting('forwarder_encrypted_upstreams') || [];
  recentErrors = [];
  lastError = null;
  // A changed upstream list or mode starts on fresh connections.
  closePools();

  // With recursion disabled, CIDRella forwards nothing, don't run the stub even
  // if an encryption mode is still persisted (preference is preserved for when
  // recursion is re-enabled).
  const noRecursion = getSetting('dns_no_recursion') === 'true';

  if (mode === 'off' || noRecursion || !Array.isArray(upstreams) || upstreams.length === 0) {
    stopListeners();
    return;
  }
  if (!udpSocket && !tcpServer) startListeners();
  else efLog('info', 'Encrypted forwarder reconfigured', { mode, upstreams: upstreams.length });
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
