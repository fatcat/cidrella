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
import { ENCRYPTED_FORWARDER_PORT, ENCRYPTED_FORWARDER_TIMEOUT_MS } from '../config/defaults.js';

const HOST = '127.0.0.1';

// Module state
let udpSocket = null;
let tcpServer = null;
let mode = 'off'; // 'off' | 'tls' | 'https'
let upstreams = []; // [{ label, addresses:[], hostname, doh_url }]
let rrIndex = 0;
let errorTimes = []; // timestamps of recent failures (sliding window)
let lastError = null;
const ERROR_WINDOW_MS = 10 * 60 * 1000; // "recent" = last 10 minutes

function recentErrorCount() {
  const cutoff = Date.now() - ERROR_WINDOW_MS;
  errorTimes = errorTimes.filter((t) => t >= cutoff);
  return errorTimes.length;
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
  errorTimes.push(now);
  lastError = e?.message || String(e);
  if (now - lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS) {
    unloggedErrors++;
    return;
  }
  const extra = { mode, upstream: upstream?.hostname || upstream?.label || null, address };
  if (unloggedErrors) extra.notLoggedSinceLastLine = unloggedErrors;
  efLog('warn', `Upstream query failed: ${lastError}`, extra);
  lastErrorLoggedAt = now;
  unloggedErrors = 0;
}

// Build a SERVFAIL preserving the query id + question and echoing the client's
// EDNS OPT (so a validating stub still gets a well-formed reply). RCODE is folded
// into the low 4 bits of `flags` (dns-packet ignores the `rcode` field).
export function buildServfail(reqBuf) {
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
            options: [],
          },
        ]
      : [],
  });
}

function pickUpstream() {
  if (upstreams.length === 0) return null;
  return upstreams[rrIndex++ % upstreams.length];
}

// ── DoT and DoH: connections to each upstream address stay open and carry
// every query (utils/upstream-pool.js), validated against the upstream's
// hostname. DoH connects by address too, so no bootstrap DNS is needed. One
// pool per protocol and timeout, since tests pass short timeouts.
const pools = new Map();

function poolFor(protocol, timeoutMs) {
  const key = `${protocol}|${timeoutMs}`;
  let pool = pools.get(key);
  if (!pool) {
    pool = createUpstreamPool({ protocol, timeoutMs, onError: recordError });
    pools.set(key, pool);
  }
  return pool;
}

export function forwardDoT(reqBuf, upstream, timeoutMs = ENCRYPTED_FORWARDER_TIMEOUT_MS) {
  return poolFor('dot', timeoutMs).query(reqBuf, upstream);
}

export function forwardDoH(reqBuf, upstream, timeoutMs = ENCRYPTED_FORWARDER_TIMEOUT_MS) {
  return poolFor('doh', timeoutMs).query(reqBuf, upstream);
}

function closePools() {
  for (const pool of pools.values()) pool.closeAll();
  pools.clear();
}

async function handleQuery(reqBuf) {
  const upstream = pickUpstream();
  let resp = null;
  if (upstream) {
    try {
      resp =
        mode === 'tls'
          ? await forwardDoT(reqBuf, upstream)
          : mode === 'https'
            ? await forwardDoH(reqBuf, upstream)
            : null;
    } catch (e) {
      recordError(e, upstream);
      resp = null;
    }
  }
  return resp || buildServfail(reqBuf); // fail closed
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
  try {
    const raw = getSetting('forwarder_encrypted_upstreams');
    upstreams = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
  } catch {
    upstreams = [];
  }
  errorTimes = [];
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
    upstreams: upstreams.map((u) => u.hostname || u.label || ''),
    recentErrors: recentErrorCount(),
    lastError,
  };
}
