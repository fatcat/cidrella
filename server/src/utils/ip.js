/**
 * IP address and subnet utility functions.
 * All IPs are handled as 32-bit unsigned integers internally for math,
 * and converted to/from dotted-quad strings at boundaries.
 */
import os from 'os';

export function ipToLong(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IP address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function longToIp(long) {
  return [
    (long >>> 24) & 255,
    (long >>> 16) & 255,
    (long >>> 8) & 255,
    long & 255
  ].join('.');
}

export function parseCidr(cidr) {
  const match = cidr.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (!match) throw new Error(`Invalid CIDR notation: ${cidr}`);

  const ip = match[1];
  const prefix = parseInt(match[2], 10);
  if (prefix < 0 || prefix > 32) throw new Error(`Invalid prefix length: ${prefix}`);

  const ipLong = ipToLong(ip);
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  const network = (ipLong & mask) >>> 0;
  const broadcast = (network | ~mask) >>> 0;
  const totalAddresses = broadcast - network + 1;

  return {
    network: longToIp(network),
    broadcast: longToIp(broadcast),
    prefix,
    mask: longToIp(mask),
    networkLong: network,
    broadcastLong: broadcast,
    totalAddresses,
    firstUsable: prefix >= 31 ? longToIp(network) : longToIp(network + 1),
    lastUsable: prefix >= 31 ? longToIp(broadcast) : longToIp(broadcast - 1),
    usableCount: prefix >= 31 ? totalAddresses : totalAddresses - 2
  };
}

export function isIpInSubnet(ip, cidr) {
  const { networkLong, broadcastLong } = parseCidr(cidr);
  const ipLong = ipToLong(ip);
  return ipLong >= networkLong && ipLong <= broadcastLong;
}

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
        } catch { /* skip invalid */ }
      }
    }
  }
  return null;
}

/**
 * Normalize a CIDR — ensures the IP portion is the actual network address.
 * e.g., 192.168.1.50/24 -> 192.168.1.0/24
 */
export function normalizeCidr(cidr) {
  const parsed = parseCidr(cidr);
  return `${parsed.network}/${parsed.prefix}`;
}

/**
 * Check if two ranges overlap.
 */
export function rangesOverlap(startA, endA, startB, endB) {
  const a0 = ipToLong(startA), a1 = ipToLong(endA);
  const b0 = ipToLong(startB), b1 = ipToLong(endB);
  return a0 <= b1 && b0 <= a1;
}

// Well-known reserved/private IP ranges
export const RESERVED_RANGES = [
  { cidr: '10.0.0.0/8',      name: 'RFC1918 Class A' },
  { cidr: '172.16.0.0/12',   name: 'RFC1918 Class B' },
  { cidr: '192.168.0.0/16',  name: 'RFC1918 Class C' },
  { cidr: '100.64.0.0/10',   name: 'CGNAT (RFC6598)' },
  { cidr: '169.254.0.0/16',  name: 'Link-Local (RFC3927)' },
  { cidr: '127.0.0.0/8',     name: 'Loopback (RFC1122)' },
  { cidr: '224.0.0.0/4',     name: 'Multicast (RFC5771)' },
  { cidr: '240.0.0.0/4',     name: 'Reserved (RFC1112)' },
];

/**
 * Validate a supernet CIDR against reserved range boundaries.
 * If the CIDR overlaps a reserved range, it must be fully within it.
 * Public IPs are allowed freely.
 */
export function validateSupernet(cidr) {
  const parsed = parseCidr(cidr);
  for (const reserved of RESERVED_RANGES) {
    const res = parseCidr(reserved.cidr);
    if (cidrsOverlap(cidr, reserved.cidr)) {
      if (parsed.networkLong >= res.networkLong && parsed.broadcastLong <= res.broadcastLong) {
        return { valid: true };
      }
      return {
        valid: false,
        error: `${cidr} extends beyond ${reserved.name} (${reserved.cidr}). Supernet must be within ${reserved.cidr}.`
      };
    }
  }
  return { valid: true };
}

/**
 * Apply a naming template to a CIDR.
 * Variables: %1-%4 (octets), %bitmask (prefix length)
 */
export function applyNameTemplate(template, cidr) {
  const parsed = parseCidr(cidr);
  const octets = parsed.network.split('.');
  return template
    .replace(/%1/g, octets[0])
    .replace(/%2/g, octets[1])
    .replace(/%3/g, octets[2])
    .replace(/%4/g, octets[3])
    .replace(/%bitmask/g, String(parsed.prefix));
}

/**
 * Validate whether a set of CIDRs can be merged into a single valid CIDR.
 * All must have the same prefix, be contiguous, power-of-2 count, and aligned.
 */
export function canMergeCidrs(cidrs) {
  if (cidrs.length < 2) return { valid: false, error: 'Need at least 2 subnets to merge' };

  const parsed = cidrs.map(c => parseCidr(c)).sort((a, b) => a.networkLong - b.networkLong);

  const prefix = parsed[0].prefix;
  if (!parsed.every(p => p.prefix === prefix)) {
    return { valid: false, error: 'All subnets must have the same prefix length' };
  }

  const count = parsed.length;
  if ((count & (count - 1)) !== 0) {
    return { valid: false, error: 'Number of subnets must be a power of 2' };
  }

  const subnetSize = (1 << (32 - prefix)) >>> 0;
  for (let i = 1; i < parsed.length; i++) {
    if ((parsed[i].networkLong >>> 0) !== ((parsed[i - 1].networkLong + subnetSize) >>> 0)) {
      return { valid: false, error: 'Subnets must be contiguous' };
    }
  }

  const stepsUp = Math.log2(count);
  const newPrefix = prefix - stepsUp;
  if (newPrefix < 0) return { valid: false, error: 'Resulting prefix would be invalid' };

  const newMask = (0xFFFFFFFF << (32 - newPrefix)) >>> 0;
  if (((parsed[0].networkLong & newMask) >>> 0) !== parsed[0].networkLong) {
    return { valid: false, error: 'Subnets do not align to a valid CIDR boundary' };
  }

  const mergedCidr = `${parsed[0].network}/${newPrefix}`;
  return { valid: true, merged_cidr: mergedCidr };
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

/**
 * Calculate available subnet splits for a given prefix into a target prefix.
 */
export function calculateSubnets(cidr, newPrefix) {
  const parent = parseCidr(cidr);
  if (newPrefix <= parent.prefix || newPrefix > 32) {
    throw new Error(`New prefix /${newPrefix} must be larger than /${parent.prefix} and <= 32`);
  }

  const count = 1 << (newPrefix - parent.prefix);
  const subnetSize = 1 << (32 - newPrefix);
  const results = [];

  for (let i = 0; i < count; i++) {
    const netLong = (parent.networkLong + i * subnetSize) >>> 0;
    results.push(parseCidr(`${longToIp(netLong)}/${newPrefix}`));
  }

  return results;
}

/**
 * Validate that an IP string is well-formed.
 */
export function isValidIp(ip) {
  try {
    ipToLong(ip);
    return true;
  } catch {
    return false;
  }
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

/**
 * Validate IPv4 address string (regex + octet range check).
 */
export function isValidIpv4(ip) {
  if (!IPV4_RE.test(ip)) return false;
  return ip.split('.').every(o => { const n = parseInt(o, 10); return n >= 0 && n <= 255; });
}

/**
 * Validate MAC address string (colon-separated hex).
 */
export function isValidMac(mac) {
  return MAC_RE.test(mac);
}

/**
 * Validate that a CIDR string is well-formed.
 */
export function isValidCidr(cidr) {
  try {
    parseCidr(cidr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if childCidr fits entirely within parentCidr.
 */
export function isSubnetOf(childCidr, parentCidr) {
  const child = parseCidr(childCidr);
  const parent = parseCidr(parentCidr);
  return child.networkLong >= parent.networkLong &&
         child.broadcastLong <= parent.broadcastLong &&
         child.prefix > parent.prefix;
}

/**
 * Check if two CIDRs overlap.
 */
export function cidrsOverlap(cidrA, cidrB) {
  const a = parseCidr(cidrA);
  const b = parseCidr(cidrB);
  return a.networkLong <= b.broadcastLong && b.networkLong <= a.broadcastLong;
}

/**
 * Subtract a child CIDR from a parent CIDR, returning the remainder
 * as the fewest possible CIDR blocks (optimal consolidation).
 *
 * Algorithm: Walk the binary tree of address space. At each level,
 * the half NOT containing the child is a remainder block, and the
 * half containing the child is split again recursively.
 * Produces exactly (childPrefix - parentPrefix) remainder blocks.
 *
 * @param {string} parentCidr - e.g. "172.16.0.0/12"
 * @param {string} childCidr  - e.g. "172.16.0.0/24"
 * @returns {string[]} Array of CIDR strings representing the remainder
 */
export function subtractCidr(parentCidr, childCidr) {
  const parent = parseCidr(parentCidr);
  const child = parseCidr(childCidr);

  if (child.networkLong < parent.networkLong || child.broadcastLong > parent.broadcastLong) {
    throw new Error('Child CIDR is not within parent CIDR');
  }
  if (child.prefix <= parent.prefix) {
    throw new Error('Child prefix must be longer than parent prefix');
  }

  const remainder = [];
  let currentNet = parent.networkLong;
  let currentPrefix = parent.prefix;

  while (currentPrefix < child.prefix) {
    const nextPrefix = currentPrefix + 1;
    const halfSize = 1 << (32 - nextPrefix);
    const midpoint = (currentNet + halfSize) >>> 0;

    if (child.networkLong >= midpoint) {
      // Child is in the upper half; lower half is remainder
      remainder.push(`${longToIp(currentNet)}/${nextPrefix}`);
      currentNet = midpoint;
    } else {
      // Child is in the lower half; upper half is remainder
      remainder.push(`${longToIp(midpoint)}/${nextPrefix}`);
    }
    currentPrefix = nextPrefix;
  }

  return remainder;
}
