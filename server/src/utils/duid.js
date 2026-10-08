/**
 * DHCP Unique Identifiers (RFC 8415 section 11).
 *
 * A DUID is what identifies a DHCPv6 client or server, the way a MAC
 * identifies a DHCPv4 client. CIDRella stores one as lowercase colon-separated
 * hex bytes, the spelling dnsmasq writes to its lease file and accepts in
 * dhcp-host lines. This module is the one place that spelling is defined.
 */

// Two to 130 bytes: type code plus at least one byte of identity, capped at
// the RFC's 128-octet limit for the identifier part.
export const DUID_RE = /^([0-9a-f]{2}:){1,129}[0-9a-f]{2}$/;

/** Canonical lowercase spelling of a DUID string, or null when malformed. */
export function normalizeDuid(value) {
  if (typeof value !== 'string') return null;
  const duid = value.trim().toLowerCase();
  return DUID_RE.test(duid) ? duid : null;
}

/**
 * The Ethernet MAC a DUID-LLT (type 1) or DUID-LL (type 3) carries, or null.
 * Only hardware type 1 (Ethernet) with a 6-byte address counts; DUID-EN and
 * DUID-UUID carry no MAC. RFC 8415 calls a DUID opaque and the embedded
 * address may belong to another interface, so this names a vendor for an
 * unnamed client and is not the client's MAC of record.
 */
export function macFromDuid(value) {
  const duid = normalizeDuid(value);
  if (!duid) return null;
  const bytes = duid.split(':');
  const type = parseInt(bytes[0] + bytes[1], 16);
  const hardware = parseInt(bytes[2] + bytes[3], 16);
  const offset = type === 1 ? 8 : type === 3 ? 4 : null;
  if (offset === null || hardware !== 1 || bytes.length !== offset + 6) return null;
  return bytes.slice(offset).join(':');
}

/** Render raw DUID bytes in the canonical spelling. */
export function duidFromBytes(bytes) {
  if (!bytes || bytes.length === 0) return null;
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}
