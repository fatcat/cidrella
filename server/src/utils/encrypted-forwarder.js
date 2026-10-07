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
import https from 'https';
import dnsPacket from 'dns-packet';
import { getSetting } from '../db/init.js';
import { frameTcpMessage, extractTcpMessages } from './dns-wire.js';
import { createDotPool } from './dot-pool.js';
import { ENCRYPTED_FORWARDER_PORT, ENCRYPTED_FORWARDER_TIMEOUT_MS } from '../config/defaults.js';

const HOST = '127.0.0.1';
const dohAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

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

// ── DoT: connections to each upstream address stay open and carry every query
// (utils/dot-pool.js), validated against the upstream's hostname. One pool per
// timeout, since tests pass short ones.
const dotPools = new Map();

function dotPool(timeoutMs) {
  let pool = dotPools.get(timeoutMs);
  if (!pool) {
    pool = createDotPool({ timeoutMs, onError: recordError });
    dotPools.set(timeoutMs, pool);
  }
  return pool;
}

export function forwardDoT(reqBuf, upstream, timeoutMs = ENCRYPTED_FORWARDER_TIMEOUT_MS) {
  return dotPool(timeoutMs).query(reqBuf, upstream);
}

function closeDotPools() {
  for (const pool of dotPools.values()) pool.closeAll();
  dotPools.clear();
}

// ── DoH: HTTPS POST application/dns-message, connecting by IP (custom lookup)
// with SNI/cert validation against the hostname, no bootstrap DNS needed.
export function forwardDoH(reqBuf, upstream, timeoutMs = ENCRYPTED_FORWARDER_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(upstream.doh_url);
    } catch (e) {
      recordError(e, upstream);
      return resolve(null);
    }
    const ip = upstream.addresses?.[0];
    if (!ip) {
      recordError(new Error('no upstream address'), upstream);
      return resolve(null);
    }
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        servername: upstream.hostname || url.hostname,
        // Connect by IP, validate the cert against the hostname. Node asks
        // for { all: true } (an array) when autoSelectFamily is on, and the
        // family must be the address's own or an IPv6 upstream gets an IPv4
        // socket.
        lookup: (_h, opts, cb) => {
          const family = net.isIP(ip);
          return opts?.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family);
        },
        headers: {
          'content-type': 'application/dns-message',
          accept: 'application/dns-message',
          'content-length': reqBuf.length,
        },
        timeout: timeoutMs,
        agent: dohAgent,
      },
      (res) => {
        if (res.statusCode !== 200) {
          recordError(new Error(`DoH HTTP ${res.statusCode}`), upstream, ip);
          res.resume();
          return done(null);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => done(Buffer.concat(chunks)));
        res.on('error', (e) => {
          recordError(e, upstream, ip);
          done(null);
        });
      },
    );
    req.on('timeout', () => {
      recordError(new Error('DoH timeout'), upstream, ip);
      req.destroy();
      done(null);
    });
    req.on('error', (e) => {
      recordError(e, upstream, ip);
      done(null);
    });
    req.write(reqBuf);
    req.end();
  });
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
  closeDotPools();

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
  closeDotPools();
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
