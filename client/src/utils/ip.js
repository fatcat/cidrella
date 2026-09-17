/**
 * Client-side IP utilities.
 *
 * The CIDR arithmetic itself comes from the server's cidr.js through the
 * @shared alias, so both tiers run one body (duplicate-logic audit #3). What
 * stays here is client-only: netmask text, DHCP pool defaults, gateway
 * position helpers and the form-level error messages built on top of them.
 */
import {
  ipToLong,
  longToIp,
  parseCidr,
  normalizeCidr,
  validateSupernet,
  isValidIpv4,
  isValidCidr,
} from '@shared/cidr.js';

export {
  ipToLong,
  longToIp,
  parseCidr,
  isIpInSubnet,
  normalizeCidr,
  RESERVED_RANGES,
  validateSupernet,
  applyNameTemplate,
  canMergeCidrs,
  calculateSubnets,
  isValidIpv4,
  isValidCidr,
  isSubnetOf,
  cidrsOverlap,
  subtractCidr,
} from '@shared/cidr.js';

/**
 * Dotted-quad netmask for a prefix length.
 *
 * parseCidr returns the broadcast but not the mask, so ScopeDialog hand-rolled
 * both of those inline. Its copies did no validation, and `parseInt(undefined)`
 * is NaN, which slips through a `p < 0 || p > 32` guard, so a malformed CIDR
 * yielded a 255.255.255.255 mask that was written straight into DHCP option 1.
 * See REVIEW.md, duplicate-logic audit #50.
 */
export function netmaskFor(prefix) {
  // Explicit shape check rather than leaning on Number(): Number('') and
  // Number(null) are both 0, which is a legal prefix, so coercion alone would
  // turn "no prefix at all" into a valid /0.
  const p =
    typeof prefix === 'number'
      ? prefix
      : typeof prefix === 'string' && /^\d+$/.test(prefix.trim())
        ? parseInt(prefix, 10)
        : NaN;
  if (!Number.isInteger(p) || p < 0 || p > 32) return null;
  const m = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
  return longToIp(m);
}

export function nearestPow2(n) {
  if (n <= 1) return 1;
  const lower = Math.pow(2, Math.floor(Math.log2(n)));
  const upper = lower * 2;
  return n - lower <= upper - n ? lower : upper;
}

// Auto-fill bounds for DHCP Start/End IP. Subnets outside this range either
// can't carry a sensible pool (/30–/32) or are large enough to OOM a modest
// host when CIDRella's per-IP tables populate (prefix < 16). For those, the
// UI surfaces a warning and the user enters Start/End manually.
export const DHCP_DEFAULT_MIN_PREFIX = 16;

export const DHCP_DEFAULT_MAX_PREFIX = 29;

export function dhcpRangeDefaults(p, gw) {
  const size = p.broadcastLong - p.networkLong + 1;
  const prefix = Math.round(32 - Math.log2(size));
  if (prefix < DHCP_DEFAULT_MIN_PREFIX || prefix > DHCP_DEFAULT_MAX_PREFIX) {
    return { start: '', end: '' };
  }
  const gwLong = gw ? ipToLong(gw) : null;
  let poolEnd, poolSize;
  if (prefix >= 21 && prefix <= 23) {
    // /21, /22, /23: cap end at network + 128, pool size = 64 (conservative)
    // default to keep the pool near the start so ops can use the rest for
    // static allocations.
    poolEnd = p.networkLong + 128;
    poolSize = 64;
  } else {
    // /16–/20 and /24–/29: pool sized at ~15% of the subnet, ending at ~35%.
    poolEnd = p.networkLong + nearestPow2(size * 0.35);
    poolSize = nearestPow2(size * 0.15);
    if (poolSize < 2) poolSize = 2;
  }
  let poolStart = poolEnd - poolSize + 1;
  // Clamp into the usable range (exclude network + broadcast).
  poolStart = Math.max(poolStart, p.networkLong + 1);
  poolEnd = Math.min(poolEnd, p.broadcastLong - 1);
  if (gwLong === poolStart) poolStart++;
  else if (gwLong === poolEnd) poolEnd--;
  return { start: longToIp(poolStart), end: longToIp(poolEnd) };
}

export function gatewayIpFromPosition(cidr, position) {
  if (!position || position === 'none') return null;
  const p = parseCidr(cidr);
  return position === 'last' ? p.lastUsable : p.firstUsable;
}

export function normalizeGatewayPositionDefault(value) {
  return value === 'last' ? 'last' : 'first';
}

/**
 * Validate a DHCP pool against its subnet. Returns an operator-facing message,
 * or null when the pool is fine.
 *
 * There were three DHCP-pool checks in the client and they did not agree
 * (duplicate-logic audit #53): the network wizard applied the full rule, the
 * Configure dialog applied nothing at all, and ScopeDialog.save() checked only
 * that the fields were non-empty. A start after the end was blocked in one and
 * submitted from the other two, so the same mistake either got a useful message
 * or a server 400 depending on which dialog you happened to open.
 *
 * `label` prefixes the messages, because the wizard calls these fields
 * "DHCP Scope Start IP" while the scope dialog calls them "Start IP".
 */
export function dhcpPoolError(startIp, endIp, subnetCidr, { label = '' } = {}) {
  const S = label ? `${label} Start IP` : 'Start IP';
  const E = label ? `${label} End IP` : 'End IP';

  const start = (startIp || '').trim();
  const end = (endIp || '').trim();
  if (!start || !end) return `${S} and ${E} are required`;
  if (!isValidIpv4(start)) return `${S} must be a valid IPv4 address`;
  if (!isValidIpv4(end)) return `${E} must be a valid IPv4 address`;

  const startLong = ipToLong(start);
  const endLong = ipToLong(end);
  if (startLong > endLong) return `${S} must be less than or equal to ${E}`;

  // Containment needs a subnet. Callers that do not have one yet still get the
  // shape and ordering checks above, which is the half that was missing.
  if (!subnetCidr || !isValidCidr(subnetCidr)) return null;
  const parsed = parseCidr(subnetCidr);
  const firstUsableLong = ipToLong(parsed.firstUsable);
  const lastUsableLong = ipToLong(parsed.lastUsable);
  if (startLong < firstUsableLong || startLong > lastUsableLong) {
    return `${S} must be within usable range ${parsed.firstUsable} - ${parsed.lastUsable}`;
  }
  if (endLong < firstUsableLong || endLong > lastUsableLong) {
    return `${E} must be within usable range ${parsed.firstUsable} - ${parsed.lastUsable}`;
  }
  return null;
}

/**
 * Validate a CIDR the user typed. Returns a message or null.
 *
 * `supernet` additionally applies the reserved-range rule that
 * validateSupernet encodes. Three client CIDR checks existed and only one ran
 * that rule, so `10.0.0.0/7` was refused inline in the supernet dialog and
 * silently became a server 400 in the other two (duplicate-logic audit #54).
 * The server enforces it either way, so this is about telling the operator
 * which field is wrong instead of surfacing a generic failure.
 */
export function cidrValidationError(cidr, { supernet = false } = {}) {
  const value = (cidr || '').trim();
  if (!value) return null;
  if (!isValidCidr(value)) return 'Invalid CIDR notation';
  if (!supernet) return null;
  const result = validateSupernet(normalizeCidr(value));
  return result.valid ? null : result.error;
}
