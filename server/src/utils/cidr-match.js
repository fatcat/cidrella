// IPv4 + IPv6 single-IP / CIDR matcher. Used by the GeoIP IP allowlist to test
// resolved answer IPs against allowed addresses/ranges.
//
// The parsing and formatting primitives moved to ./address.js, which is the
// shared address core the IPAM side uses too. This module keeps its own public
// API and, deliberately, its own STRICTER parsing options: the allowlist stores
// canonicalized values in the database, so widening what parses here would
// change what an existing stored row means. Zone ids and IPv4-mapped v6 are
// therefore refused here even though address.js accepts them.
//
// `cidr-match-equivalence.test.js` pins this module's verdicts against the
// pre-refactor implementation over a fixture table. If you change STRICT or the
// formatter, that test is the thing that should go red.

import { parseIp, formatIp } from './address.js';

// The parsing rules this module has always had. Anything looser belongs in
// address.js, behind its own options, not here.
const STRICT = { zoneId: false, mapV4: false, embeddedV4: false };

// Parse an IP string to { v: BigInt, bits: 32|128 } or null.
function ipToBigInt(ip) {
  const parsed = parseIp(ip, STRICT);
  return parsed ? { v: parsed.value, bits: parsed.bits } : null;
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
  return { bits: parsed.bits, network: parsed.v & mask, mask, prefix };
}

export function isValidIpOrCidr(entry) {
  return parseCidrEntry(entry) !== null;
}

// Render a parsed entry back to its one canonical string: host bits masked
// off, explicit /prefix, IPv6 lowercased and zero-compressed (RFC 5952).
// The address half is formatIp's job now.
// Storing this form makes the allowlist's UNIQUE(value) mean "unique
// network" instead of "unique spelling" ('10.5.5.5/8', '010.0.0.0/8', and
// '10.0.0.0/8' all become '10.0.0.0/8').
export function formatCidrEntry(entry) {
  if (!entry || typeof entry.network !== 'bigint') return null;
  return `${formatIp(entry.network, entry.bits)}/${entry.prefix}`;
}

// Parse + reformat in one step; null for invalid input.
export function canonicalizeIpOrCidr(value) {
  const parsed = parseCidrEntry(value);
  return parsed ? formatCidrEntry(parsed) : null;
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
