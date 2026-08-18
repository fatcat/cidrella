/**
 * Shared IPv4 + IPv6 address core.
 *
 * This is the single place that knows how to turn an address string into a
 * number and back. It is deliberately dependency-free and free of any Node
 * built-in, because the client imports this same file through a Vite alias
 * (see client/vite.config.js). Do not add imports here without checking that
 * the client build still works.
 *
 * Everything is BigInt internally so IPv4 (32-bit) and IPv6 (128-bit) share one
 * code path. The older `ipToLong`/`longToIp` pair in ip.js stays IPv4-only and
 * is not built on this: those two do 32-bit bit-twiddling that is faster and
 * still correct for the v4-only call sites. They throw on a v6 string rather
 * than truncating, and there is a test locking that in.
 *
 * `cidr-match.js` re-exports its own public API on top of this module. That API
 * predates IPv6 support in the IPAM and is consumed by the GeoIP allowlist,
 * which stores canonicalized values in the database, so its parsing semantics
 * must not shift. Anything looser lives behind an explicit option here.
 */

export const IPV4_BITS = 32;
export const IPV6_BITS = 128;

const V4_OCTET_RE = /^\d{1,3}$/;
const V6_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;

/**
 * Parse dotted-quad to BigInt, or null.
 *
 * Leading zeros are accepted ('010.0.0.0' is 10.0.0.0). That is long-standing
 * behavior the GeoIP allowlist relies on: it canonicalizes on the way in so
 * '10.5.5.5/8', '010.0.0.0/8' and '10.0.0.0/8' collapse to one stored row.
 * Note this is NOT the right rule at a security boundary, where a leading zero
 * can mean octal to some parsers. url-guard.js keeps its own stricter parser on
 * purpose and must not be pointed at this one.
 */
function parseV4(str) {
  const octets = str.split('.');
  if (octets.length !== 4) return null;
  let v = 0n;
  for (const octet of octets) {
    if (!V4_OCTET_RE.test(octet)) return null;
    const n = Number(octet);
    if (n > 255) return null;
    v = (v << 8n) + BigInt(n);
  }
  return v;
}

/**
 * Parse IPv6 to BigInt, or null. `embeddedV4` allows the trailing dotted-quad
 * form ('::ffff:10.0.0.1', '2001:db8::192.168.1.1'). With it off the address
 * must be pure hextets.
 */
function parseV6(str, embeddedV4) {
  if (str.indexOf('::') !== str.lastIndexOf('::')) return null;
  const hasDoubleColon = str.includes('::');
  const [head, tail = ''] = hasDoubleColon ? str.split('::') : [str, ''];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];

  let parts;
  if (hasDoubleColon) {
    parts = [...headParts, ...tailParts];
  } else {
    parts = headParts;
  }

  // A trailing dotted-quad occupies the last two hextets.
  let trailing = null;
  if (parts.length > 0 && parts[parts.length - 1].includes('.')) {
    if (!embeddedV4) return null;
    const v4 = parseV4(parts[parts.length - 1]);
    if (v4 === null) return null;
    trailing = v4;
    parts = parts.slice(0, -1);
  }

  const groupCount = trailing === null ? 8 : 6;
  if (hasDoubleColon) {
    const fill = groupCount - parts.length;
    if (fill < 0) return null;
    parts = [...parts.slice(0, headParts.length), ...Array(fill).fill('0'),
      ...parts.slice(headParts.length)];
  }
  if (parts.length !== groupCount) return null;

  let v = 0n;
  for (const part of parts) {
    if (!V6_GROUP_RE.test(part)) return null;
    v = (v << 16n) + BigInt(parseInt(part, 16));
  }
  if (trailing !== null) v = (v << 32n) + trailing;
  return v;
}

// ::ffff:0:0/96, the IPv4-mapped range.
const V4_MAPPED_PREFIX = 0xffffn << 32n;
const V4_MAPPED_MASK = (1n << 128n) - (1n << 32n);

/**
 * Parse any address string.
 *
 * Returns { value, bits, zoneId } or null. Options:
 *   zoneId    accept and strip a scope suffix ('fe80::1%eth0'). Default true.
 *   mapV4     fold an IPv4-mapped v6 address down to a plain 32-bit v4 value,
 *             so '::ffff:10.0.0.1' and '10.0.0.1' are one address rather than
 *             two rows for one host. Default true. Node hands us the mapped
 *             form for v4 peers on a dual-stack socket, which is where this
 *             actually bites.
 *   embeddedV4  accept a trailing dotted-quad inside a v6 literal. Default
 *             true. Turning mapV4 on without this would be incoherent, so
 *             mapV4 implies it.
 */
export function parseIp(str, options = {}) {
  if (typeof str !== 'string') return null;
  const { zoneId: allowZoneId = true, mapV4 = true } = options;
  const embeddedV4 = options.embeddedV4 !== undefined ? options.embeddedV4 : true;

  let s = str.trim();
  if (s === '') return null;

  let zoneId = null;
  const pct = s.indexOf('%');
  if (pct !== -1) {
    if (!allowZoneId) return null;
    zoneId = s.slice(pct + 1);
    if (zoneId === '') return null;
    s = s.slice(0, pct);
  }

  if (s.includes(':')) {
    const v = parseV6(s, embeddedV4 || mapV4);
    if (v === null) return null;
    if (mapV4 && (v & V4_MAPPED_MASK) === V4_MAPPED_PREFIX) {
      return { value: v & 0xffffffffn, bits: IPV4_BITS, zoneId };
    }
    return { value: v, bits: IPV6_BITS, zoneId };
  }

  // A zone id on a v4 literal is meaningless.
  if (zoneId !== null) return null;
  const v = parseV4(s);
  if (v === null) return null;
  return { value: v, bits: IPV4_BITS, zoneId: null };
}

/** 4, 6, or null for anything unparseable. */
export function addressFamily(str) {
  const parsed = parseIp(str);
  if (!parsed) return null;
  return parsed.bits === IPV4_BITS ? 4 : 6;
}

export function isValidIp(str) {
  return parseIp(str) !== null;
}

export function isValidIpv6(str) {
  const parsed = parseIp(str);
  return parsed !== null && parsed.bits === IPV6_BITS;
}

/**
 * Render a BigInt back to a string. IPv6 comes out lowercased and
 * zero-compressed per RFC 5952: the longest run of two or more zero groups is
 * replaced by '::', leftmost run wins a tie (s4.2.3).
 *
 * This never emits the '::ffff:1.2.3.4' mixed form, because parseIp folds
 * mapped addresses down to v4 and they come back out as dotted-quad.
 */
export function formatIp(value, bits) {
  if (typeof value !== 'bigint') return null;
  if (bits === IPV4_BITS) {
    const octets = [];
    for (let shift = 24n; shift >= 0n; shift -= 8n) {
      octets.push(((value >> shift) & 0xffn).toString(10));
    }
    return octets.join('.');
  }

  const groups = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(((value >> shift) & 0xffffn).toString(16));
  }

  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }

  if (bestLen >= 2) {
    const head = groups.slice(0, bestStart).join(':');
    const tail = groups.slice(bestStart + bestLen).join(':');
    return `${head}::${tail}`;
  }
  return groups.join(':');
}

/** Parse then re-render, giving the one canonical spelling. Null if invalid. */
export function canonicalizeIp(str) {
  const parsed = parseIp(str);
  if (!parsed) return null;
  return formatIp(parsed.value, parsed.bits);
}

/**
 * A fixed-width sort key, so ORDER BY on a TEXT column sorts addresses
 * numerically and keeps the two families apart.
 *
 * Shape is one family digit then 32 lowercase hex chars, zero-padded. The
 * family digit means every IPv4 address sorts before every IPv6 one instead of
 * interleaving at whatever numeric position the v4-mapped range happens to
 * occupy, which is what a reader of a mixed table expects.
 *
 * Fixed width is the point: it makes byte order and numeric order the same, so
 * SQLite can use an index for the sort. Returns null for an unparseable input,
 * and callers must decide what to store rather than getting a key that sorts
 * somewhere arbitrary.
 */
export function sortKey(str) {
  const parsed = parseIp(str);
  if (!parsed) return null;
  const family = parsed.bits === IPV4_BITS ? '4' : '6';
  return family + parsed.value.toString(16).padStart(32, '0');
}
