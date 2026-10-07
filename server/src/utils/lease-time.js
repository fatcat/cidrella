/**
 * Lease times as CIDRella stores them: `dhcp_scopes.lease_time`, the
 * `default_lease_time` setting and DHCPv4 option 51 hold text such as "12h",
 * "3600" or "7d". Every backend and the client read them through here, so
 * an adapter that wants seconds (Kea's valid-lifetime) never parses the text
 * itself. Shared with the client through the @shared alias: no server-only
 * imports.
 */

const UNIT_SECONDS = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

// What the API accepts as a new lease time: a number of seconds, minutes,
// hours or days. Stored values may also carry `w` or read "infinite".
const LEASE_TIME_INPUT = /^\d+[smhd]?$/;

/** May `text` be stored as a lease time? */
export function isValidLeaseTime(text) {
  return typeof text === 'string' && LEASE_TIME_INPUT.test(text);
}

/**
 * A stored lease time as seconds: Infinity for "infinite", NaN for anything
 * unparseable. Bare numbers are seconds.
 */
export function leaseSeconds(text) {
  const raw = String(text ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'infinite') return Infinity;
  const match = /^(\d+)([smhdw]?)$/.exec(raw);
  if (!match) return NaN;
  return Number(match[1]) * UNIT_SECONDS[match[2]];
}

/** A stored lease time as milliseconds (see leaseSeconds). */
export const leaseDurationMs = (text) => leaseSeconds(text) * 1000;
