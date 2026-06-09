// Compact IPv4 + IPv6 single-IP / CIDR matcher (no dependencies). Used by the
// GeoIP IP allowlist to test resolved answer IPs against allowed addresses/ranges.
// (The IPv4-only helpers in ip.js can't handle the AAAA answers GeoIP also sees.)

// Parse an IP string to { v: BigInt, bits: 32|128 } or null.
function ipToBigInt(ip) {
  if (typeof ip !== 'string') return null;
  ip = ip.trim();
  if (ip.includes(':')) {
    // IPv6 (no zone-id support). Exactly one "::" allowed.
    if (ip.indexOf('::') !== ip.lastIndexOf('::')) return null;
    const hasDoubleColon = ip.includes('::');
    const [head, tail = ''] = hasDoubleColon ? ip.split('::') : [ip, ''];
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    let parts;
    if (hasDoubleColon) {
      const fill = 8 - headParts.length - tailParts.length;
      if (fill < 0) return null;
      parts = [...headParts, ...Array(fill).fill('0'), ...tailParts];
    } else {
      parts = headParts;
    }
    if (parts.length !== 8) return null;
    let v = 0n;
    for (const p of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      v = (v << 16n) + BigInt(parseInt(p, 16));
    }
    return { v, bits: 128 };
  }
  const o = ip.split('.');
  if (o.length !== 4) return null;
  let v = 0n;
  for (const p of o) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) + BigInt(n);
  }
  return { v, bits: 32 };
}

// Parse a single-IP or CIDR string into { bits, network, mask } or null.
export function parseCidrEntry(entry) {
  if (typeof entry !== 'string') return null;
  const segs = entry.trim().split('/');
  if (segs.length > 2) return null;
  const parsed = ipToBigInt(segs[0]);
  if (!parsed) return null;
  let prefix = parsed.bits;
  if (segs.length === 2) {
    if (!/^\d{1,3}$/.test(segs[1])) return null;
    prefix = Number(segs[1]);
    if (prefix > parsed.bits) return null;
  }
  const full = (1n << BigInt(parsed.bits)) - 1n;
  const mask = full ^ ((1n << BigInt(parsed.bits - prefix)) - 1n);
  return { bits: parsed.bits, network: parsed.v & mask, mask };
}

export function isValidIpOrCidr(entry) {
  return parseCidrEntry(entry) !== null;
}

export function ipMatchesEntry(ip, entry) {
  const p = ipToBigInt(ip);
  if (!p || p.bits !== entry.bits) return false;
  return (p.v & entry.mask) === entry.network;
}

// True if `ip` falls in any of the pre-parsed entries.
export function ipInAny(ip, parsedEntries) {
  if (!parsedEntries || parsedEntries.length === 0) return false;
  for (const e of parsedEntries) {
    if (ipMatchesEntry(ip, e)) return true;
  }
  return false;
}
