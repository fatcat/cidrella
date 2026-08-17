import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import { PassThrough, Transform, pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';

// SSRF guard for outbound HTTP fetches. The Pi-hole probe / fetch path and
// the blocklist source_url field both accept operator-supplied URLs that
// the server then connects to, without guarding, these can be pointed at
// loopback, link-local, RFC1918, or cloud-metadata IPs to probe internal
// services or exfiltrate their responses. v0.4.15 adds this guard and
// wires it into both callers.
//
// Policy: hostname resolves to IPv4, IP must be in the public-unicast space.
// IPv6 is blocked entirely (simpler + our target feeds are all v4).
// CIDRs blocked: loopback, link-local, multicast, broadcast, private
// (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), 0/8, metadata (169.254/16),
// TEST-NET ranges.

function ipInCidr(ip, cidr) {
  const [base, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const ipLong = ipToLong(ip);
  const baseLong = ipToLong(base);
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return (ipLong & mask) === (baseLong & mask);
}

function ipToLong(ip) {
  const p = ip.split('.').map(Number);
  return (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0);
}

const BLOCKED_IPV4_RANGES = [
  '0.0.0.0/8',        // "this network"
  '10.0.0.0/8',       // RFC1918
  '100.64.0.0/10',    // CGNAT (RFC6598)
  '127.0.0.0/8',      // loopback
  '169.254.0.0/16',   // link-local + AWS/GCP metadata (169.254.169.254)
  '172.16.0.0/12',    // RFC1918
  '192.0.0.0/24',     // IETF protocol assignments
  '192.0.2.0/24',     // TEST-NET-1
  '192.168.0.0/16',   // RFC1918
  '198.18.0.0/15',    // benchmarking
  '198.51.100.0/24',  // TEST-NET-2
  '203.0.113.0/24',   // TEST-NET-3
  '224.0.0.0/4',      // multicast
  '240.0.0.0/4',      // reserved (includes 255.255.255.255 broadcast)
];

/**
 * True if a literal IPv4 address falls in a blocked (private/loopback/metadata/
 * reserved) range. Synchronous, for callers that already have a literal IP
 * (e.g. encrypted-forwarder upstreams) and don't need hostname resolution.
 */
export function isBlockedIpv4(ip) {
  if (net.isIP(ip) !== 4) return false; // not a v4 literal, caller validates format separately
  return BLOCKED_IPV4_RANGES.some(range => ipInCidr(ip, range));
}

/**
 * Parse and validate an outbound URL. Returns `{ ok: true, url, hostname, ip }`
 * or `{ ok: false, reason }`. Only http/https are accepted. The hostname is
 * resolved; if it's already an IP, that IP is checked directly.
 *
 * Callers that fetch the URL should use requestPinnedOutboundUrl below, which
 * connects to this validated IP while preserving Host/SNI for virtual hosts.
 */
export async function validateOutboundUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    return { ok: false, reason: 'URL must be a non-empty string' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'URL must use http or https' };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: 'URL has no hostname' };
  }

  // If hostname is already a literal IP, check directly. Otherwise resolve.
  let ip;
  if (net.isIP(parsed.hostname) === 4) {
    ip = parsed.hostname;
  } else if (net.isIP(parsed.hostname) === 6) {
    return { ok: false, reason: 'IPv6 URLs are not allowed' };
  } else {
    try {
      const lookup = await dns.promises.lookup(parsed.hostname, { family: 4 });
      ip = lookup.address;
    } catch (err) {
      return { ok: false, reason: `Hostname does not resolve (IPv4): ${err.code || err.message}` };
    }
  }

  for (const range of BLOCKED_IPV4_RANGES) {
    if (ipInCidr(ip, range)) {
      return { ok: false, reason: `IP ${ip} is in blocked range ${range}` };
    }
  }

  return { ok: true, url: parsed.toString(), hostname: parsed.hostname, ip };
}

/**
 * Fetch a guarded outbound URL without a DNS rebinding window. The hostname is
 * validated once, then the socket connects to that exact IP. Redirects are not
 * followed; callers can validate a new Location explicitly if needed later.
 */
export async function requestPinnedOutboundUrl(rawUrl, {
  method = 'GET',
  body = null,
  headers = {},
  timeout = 5000,
  maxBytes = 10 * 1024 * 1024,
} = {}) {
  const check = rawUrl && typeof rawUrl === 'object' && rawUrl.ok && rawUrl.url && rawUrl.ip
    ? rawUrl
    : await validateOutboundUrl(rawUrl);
  if (!check.ok) return { ok: false, error: check.reason };

  const parsed = new URL(check.url);
  const data = body == null
    ? null
    : Buffer.isBuffer(body) || typeof body === 'string'
      ? body
      : JSON.stringify(body);
  const requestHeaders = { ...headers, Host: parsed.host };
  if (data != null && requestHeaders['Content-Length'] == null && requestHeaders['content-length'] == null) {
    requestHeaders['Content-Length'] = Buffer.byteLength(data);
  }

  return new Promise((resolve) => {
    const mod = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: check.ip,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method,
      timeout,
      headers: requestHeaders,
      servername: parsed.hostname,
      lookup: (_hostname, _opts, cb) => cb(null, check.ip, 4),
    };

    try {
      const req = mod.request(reqOpts, (resp) => {
        const chunks = [];
        let received = 0;
        resp.on('error', () => {
          // req.destroy() on an oversized response can also emit an error on
          // the IncomingMessage. The request error handler resolves the
          // promise; this listener prevents an unhandled EventEmitter error.
        });
        resp.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        resp.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          resolve({
            ok: resp.statusCode >= 200 && resp.statusCode < 300,
            status: resp.statusCode,
            statusText: resp.statusMessage,
            headers: resp.headers,
            text,
          });
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Connection timed out' }); });
      if (data != null) req.write(data);
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

/** Error code carried by both size caps in openPinnedOutboundStream. */
export const TOO_LARGE_CODE = 'E_FEED_TOO_LARGE';

/**
 * Transform that aborts the pipe once more than `limit` bytes pass through.
 * `stage` is 'wire' or 'decompressed' so the caller can tell which cap tripped.
 */
function byteCap(limit, stage) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) {
        const err = new Error(`Response exceeded the ${limit} byte limit (${stage})`);
        err.code = TOO_LARGE_CODE;
        err.limitBytes = limit;
        err.stage = stage;
        return cb(err);
      }
      cb(null, chunk);
    },
  });
}

/**
 * Streaming sibling of requestPinnedOutboundUrl, for responses too big to hold
 * in memory. Same SSRF posture: the hostname is validated once and the socket
 * connects to that exact IP, with Host and SNI preserved. Redirects are still
 * NOT followed, a 3xx comes back as a non-ok status with the Location header
 * intact. Do not "fix" that by switching to fetch() or follow-redirects, the
 * pinned lookup below is the only thing closing the DNS rebinding window.
 *
 * Resolves to `{ ok, status, statusText, headers, stream }` once response
 * headers arrive. `stream` is present only for 2xx; the caller consumes it
 * (for await, readline, pipe) and must handle an 'error' event, which is how
 * a size overrun mid-download surfaces. Non-2xx resolves with no stream and
 * the connection torn down, so a 304 costs nothing.
 *
 * Two independent size caps, both `maxBytes`:
 *   - wire bytes, so a huge body cannot be streamed at us indefinitely
 *   - decompressed bytes, because we advertise gzip and the source URL is
 *     operator-editable, which makes a zip bomb a real input
 * A Content-Length over the cap is rejected before any body is read.
 */
export async function openPinnedOutboundStream(rawUrl, {
  headers = {},
  timeout = 5000,
  maxBytes = 10 * 1024 * 1024,
  acceptGzip = true,
} = {}) {
  const check = rawUrl && typeof rawUrl === 'object' && rawUrl.ok && rawUrl.url && rawUrl.ip
    ? rawUrl
    : await validateOutboundUrl(rawUrl);
  if (!check.ok) return { ok: false, error: check.reason };

  const parsed = new URL(check.url);
  const requestHeaders = { ...headers, Host: parsed.host };
  const hasAcceptEncoding = Object.keys(requestHeaders)
    .some(h => h.toLowerCase() === 'accept-encoding');
  if (acceptGzip && !hasAcceptEncoding) requestHeaders['Accept-Encoding'] = 'gzip';

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };

    const mod = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: check.ip,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'GET',
      timeout,
      headers: requestHeaders,
      servername: parsed.hostname,
      lookup: (_hostname, _opts, cb) => cb(null, check.ip, 4),
    };

    try {
      const req = mod.request(reqOpts, (resp) => {
        const status = resp.statusCode;
        const base = { status, statusText: resp.statusMessage, headers: resp.headers };

        // Non-2xx (including the 304 we ask for on a conditional GET) carries
        // nothing we want to read. Tear the socket down rather than draining,
        // so an oversized error body cannot be pushed at us.
        if (status < 200 || status >= 300) {
          req.destroy();
          return settle({ ok: false, ...base });
        }

        const encoding = String(resp.headers['content-encoding'] || '').toLowerCase();

        // Cheapest rejection: the server already told us it is too big. Note
        // that under gzip this is the transfer size, which is smaller than the
        // feed the operator sees, so it can only ever reject early, never
        // falsely. The decompressed cap below is what actually bounds us.
        const declared = Number(resp.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          req.destroy();
          const err = new Error(`Response exceeded the ${maxBytes} byte limit (content-length)`);
          err.code = TOO_LARGE_CODE;
          err.limitBytes = maxBytes;
          err.actualBytes = declared;
          err.compressed = encoding === 'gzip';
          err.stage = 'content-length';
          return settle({ ok: false, ...base, error: err.message, cause: err });
        }
        const out = new PassThrough();
        const stages = [resp, byteCap(maxBytes, 'wire')];
        if (encoding === 'gzip') stages.push(createGunzip(), byteCap(maxBytes, 'decompressed'));
        stages.push(out);

        // pipeline destroys `out` with the error, so a cap trip or a socket
        // failure reaches the consumer as an 'error' on the stream it holds.
        pipeline(...stages, () => {});

        settle({ ok: true, ...base, stream: out });
      });

      req.on('error', (err) => settle({ ok: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); settle({ ok: false, error: 'Connection timed out' }); });
      req.end();
    } catch (err) {
      settle({ ok: false, error: err.message });
    }
  });
}
