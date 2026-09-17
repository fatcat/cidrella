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

/** Render raw DUID bytes in the canonical spelling. */
export function duidFromBytes(bytes) {
  if (!bytes || bytes.length === 0) return null;
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}
