import dns from 'dns';
import net from 'net';

// SSRF guard for outbound HTTP fetches. The Pi-hole probe / fetch path and
// the blocklist source_url field both accept operator-supplied URLs that
// the server then connects to — without guarding, these can be pointed at
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
 * Parse and validate an outbound URL. Returns `{ ok: true, url, hostname, ip }`
 * or `{ ok: false, reason }`. Only http/https are accepted. The hostname is
 * resolved; if it's already an IP, that IP is checked directly.
 *
 * Note: this is NOT a DNS-rebinding fix by itself — it can't stop a
 * malicious DNS response from changing between the allowlist check and the
 * actual fetch. Callers who care must either pin the IP in the URL or
 * re-resolve + check immediately before connecting. For CIDRella's current
 * threat model (admin-only writers) the check-then-fetch window is narrow.
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
