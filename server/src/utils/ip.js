/**
 * IP address and subnet utility functions.
 * All IPs are handled as 32-bit unsigned integers internally for math,
 * and converted to/from dotted-quad strings at boundaries.
 */
import os from 'os';

import { ipToLong, longToIp, isIpInSubnet, cidrsOverlap } from './cidr.js';

// The pure CIDR arithmetic lives in cidr.js so the client can share it; every
// server caller keeps importing it from here.
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
} from './cidr.js';

export function isIpInRange(ip, startIp, endIp) {
  const ipLong = ipToLong(ip);
  return ipLong >= ipToLong(startIp) && ipLong <= ipToLong(endIp);
}

/**
 * Find the server's (host's) IP address that falls within a given CIDR subnet.
 * Uses os.networkInterfaces() to scan all interfaces. Returns the first match or null.
 */
export function getServerIpForSubnet(cidr) {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        try {
          if (isIpInSubnet(addr.address, cidr)) return addr.address;
        } catch {
          /* skip invalid */
        }
      }
    }
  }
  return null;
}

/**
 * Check if two ranges overlap.
 */
export function rangesOverlap(startA, endA, startB, endB) {
  const a0 = ipToLong(startA),
    a1 = ipToLong(endA);
  const b0 = ipToLong(startB),
    b1 = ipToLong(endB);
  return a0 <= b1 && b0 <= a1;
}

// IPv4 blocks that are not globally routable. Automatic scans may inherit the
// global scan setting for these ranges. Globally routable space requires an
// explicit per-network opt-in so merely documenting a public prefix cannot
// turn CIDRella into an Internet scanner or classify unrelated hosts as rogue.
const NON_GLOBAL_IPV4_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

export function isGloballyRoutableCidr(cidr) {
  return !NON_GLOBAL_IPV4_RANGES.some((special) => cidrsOverlap(cidr, special));
}

/**
 * Generate all IPs in a range (inclusive). Use cautiously for large ranges.
 */
export function* ipRange(startIp, endIp) {
  const start = ipToLong(startIp);
  const end = ipToLong(endIp);
  for (let i = start; i <= end; i++) {
    yield longToIp(i);
  }
}

const MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

/**
 * Validate MAC address string (colon-separated hex).
 */
export function isValidMac(mac) {
  return MAC_RE.test(mac);
}

/**
 * Stricter check for a MAC that can belong to an actual DHCP client.
 * Rejects MACs a client would never use:
 *   - all-zero  (00:00:00:00:00:00)
 *   - broadcast (ff:ff:ff:ff:ff:ff)
 *   - multicast (first-octet LSB set, the I/G bit, RFC 5342)
 */
export function isClientMac(mac) {
  if (!isValidMac(mac)) return false;
  const octets = mac
    .toLowerCase()
    .split(':')
    .map((o) => parseInt(o, 16));
  if (octets.every((o) => o === 0)) return false;
  if (octets.every((o) => o === 0xff)) return false;
  if ((octets[0] & 0x01) !== 0) return false; // I/G bit set → multicast
  return true;
}

// Domain name validation. Shared by dns.js, dhcp.js, subnets.js, blocklists.js,
// models/dns-record.js and the Pi-hole importer: 15 call sites, so read the
// notes before changing it.
//
// Validated per label rather than with one flat character class. The old regex
// allowed any mix of alphanumerics, dots and hyphens between a leading and
// trailing alphanumeric, which let through two shapes that are never a domain:
//
//   'sub..evil.com'   an empty label
//   '10.0.0.1'        a dotted-quad, which reached the dnsmasq writers as a
//                     "domain". That is the one with teeth and the reason this
//                     was worth touching at all.
//
// A SINGLE label is still accepted, on purpose. 'lan', 'local' and 'home' are
// legitimate values for a subnet or scope domain_name, dnsmasq takes
// 'domain=lan' quite happily, and existing installs hold exactly those. A
// caller that genuinely needs two or more labels has to say so itself rather
// than have this refuse a config that has always worked.
//
// Mixed case is accepted rather than rejected. DNS is case-insensitive and the
// storage side normalizes (migration 052_normalize_dns_names), so rejecting
// 'Evil.COM' would be enforcing the wrong thing at the wrong layer.
const DOMAIN_LABEL_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

const IPV4_LITERAL_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function isValidDomain(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 253) return false;
  // A dotted-quad is an address, not a name, whatever field it arrived in.
  if (IPV4_LITERAL_RE.test(name)) return false;
  const labels = name.split('.');
  return labels.every((l) => l.length > 0 && l.length <= 63 && DOMAIN_LABEL_RE.test(l));
}

/**
 * Validator for free-text display fields (subnet name, description,
 * folder name, etc.). Refuses `<` `>` and control characters to keep
 * stored data benign even if a future UI surface uses v-html.
 * Returns null on success or an error string.
 */
export function validateDisplayString(value, { maxLength = 255, allowEmpty = true } = {}) {
  if (value == null || value === '') return allowEmpty ? null : 'must not be empty';
  if (typeof value !== 'string') return 'must be a string';
  if (value.length > maxLength) return `must be ${maxLength} characters or fewer`;
  if (/[<>]/.test(value)) return 'must not contain < or >';
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) return 'must not contain control characters';
  return null;
}
