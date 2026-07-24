/**
 * Client-side IP utilities for instant subnet preview calculations.
 */

export function ipToLong(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function longToIp(long) {
  return [(long >>> 24) & 255, (long >>> 16) & 255, (long >>> 8) & 255, long & 255].join('.');
}

export function parseCidr(cidr) {
  const match = cidr.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (!match) throw new Error(`Invalid CIDR: ${cidr}`);

  const prefix = parseInt(match[2], 10);
  if (prefix < 0 || prefix > 32) throw new Error(`Invalid prefix: ${prefix}`);

  const ipLong = ipToLong(match[1]);
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  const network = (ipLong & mask) >>> 0;
  const broadcast = (network | ~mask) >>> 0;

  return {
    network: longToIp(network),
    broadcast: longToIp(broadcast),
    firstUsable: longToIp(network + 1),
    lastUsable: longToIp(broadcast - 1),
    prefix,
    networkLong: network,
    broadcastLong: broadcast,
    totalAddresses: broadcast - network + 1
  };
}

export function normalizeCidr(cidr) {
  const p = parseCidr(cidr);
  return `${p.network}/${p.prefix}`;
}

export function isValidCidr(cidr) {
  try { parseCidr(cidr); return true; } catch { return false; }
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export function isValidIpv4(ip) {
  return typeof ip === 'string'
    && IPV4_RE.test(ip)
    && ip.split('.').every(o => {
      const n = Number(o);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
}

export function isSubnetOf(childCidr, parentCidr) {
  const child = parseCidr(childCidr);
  const parent = parseCidr(parentCidr);
  return child.networkLong >= parent.networkLong &&
         child.broadcastLong <= parent.broadcastLong &&
         child.prefix > parent.prefix;
}

function cidrsOverlap(cidrA, cidrB) {
  const a = parseCidr(cidrA);
  const b = parseCidr(cidrB);
  return a.networkLong <= b.broadcastLong && b.networkLong <= a.broadcastLong;
}

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
        error: `${cidr} extends beyond ${reserved.name} (${reserved.cidr})`
      };
    }
  }
  return { valid: true };
}

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

export function calculateSubnets(cidr, newPrefix) {
  const parent = parseCidr(cidr);
  if (newPrefix <= parent.prefix || newPrefix > 32) return [];
  const count = 1 << (newPrefix - parent.prefix);
  const subnetSize = 1 << (32 - newPrefix);
  const results = [];
  for (let i = 0; i < count; i++) {
    const netLong = (parent.networkLong + i * subnetSize) >>> 0;
    results.push(`${longToIp(netLong)}/${newPrefix}`);
  }
  return results;
}

export function canMergeCidrs(cidrs) {
  if (cidrs.length < 2) return { valid: false, error: 'Need at least 2 networks to merge' };

  const parsed = cidrs.map(c => parseCidr(c)).sort((a, b) => a.networkLong - b.networkLong);

  const prefix = parsed[0].prefix;
  if (!parsed.every(p => p.prefix === prefix)) {
    return { valid: false, error: 'All networks must have the same prefix length' };
  }

  const count = parsed.length;
  if ((count & (count - 1)) !== 0) {
    return { valid: false, error: 'Number of networks must be a power of 2' };
  }

  const subnetSize = (1 << (32 - prefix)) >>> 0;
  for (let i = 1; i < parsed.length; i++) {
    if ((parsed[i].networkLong >>> 0) !== ((parsed[i - 1].networkLong + subnetSize) >>> 0)) {
      return { valid: false, error: 'Networks must be contiguous' };
    }
  }

  const stepsUp = Math.log2(count);
  const newPrefix = prefix - stepsUp;
  if (newPrefix < 0) return { valid: false, error: 'Resulting prefix would be invalid' };

  const newMask = (0xFFFFFFFF << (32 - newPrefix)) >>> 0;
  if (((parsed[0].networkLong & newMask) >>> 0) !== parsed[0].networkLong) {
    return { valid: false, error: 'Networks do not align to a valid CIDR boundary' };
  }

  const mergedCidr = `${parsed[0].network}/${newPrefix}`;
  return { valid: true, merged_cidr: mergedCidr };
}

export function nearestPow2(n) {
  if (n <= 1) return 1;
  const lower = Math.pow(2, Math.floor(Math.log2(n)));
  const upper = lower * 2;
  return (n - lower) <= (upper - n) ? lower : upper;
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

export function subtractCidr(parentCidr, childCidr) {
  const parent = parseCidr(parentCidr);
  const child = parseCidr(childCidr);

  if (child.networkLong < parent.networkLong || child.broadcastLong > parent.broadcastLong) {
    throw new Error('Child CIDR is not within parent');
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
      remainder.push(`${longToIp(currentNet)}/${nextPrefix}`);
      currentNet = midpoint;
    } else {
      remainder.push(`${longToIp(midpoint)}/${nextPrefix}`);
    }
    currentPrefix = nextPrefix;
  }

  return remainder;
}
