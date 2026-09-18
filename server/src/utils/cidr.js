/**
 * CIDR arithmetic for IPv4 and IPv6, shared by the server and the client.
 *
 * Pure functions only: no I/O, no Node built-ins, so the client bundles it
 * through the @shared alias (client/shared-modules.js). This is the option-2
 * resolution of duplicate-logic audit #3 (docs/CROSS-TIER-DUPLICATION.md):
 * the two ip.js copies diverged and nothing failed. Now there is one body and
 * client/tests/unit/utils/ip-shared.test.js goes red if a client-local fork
 * reappears.
 *
 * Two layers live here:
 *
 *   - The family-generic layer (`parseNetwork`, `splitNetwork`,
 *     `mergeNetworks`, ...) does all arithmetic in BigInt on top of the
 *     address core in address.js, so a /64 and a /24 go through one code path.
 *     This is the IPv6 work's foundation; new code uses these.
 *   - The IPv4 layer (`parseCidr`, `calculateSubnets`, ...) is the contract
 *     every existing caller was written against: Number fields, dotted quads,
 *     and a refusal of anything that is not IPv4. Each is a thin wrapper over
 *     the generic layer, so there is still one implementation. The refusal
 *     is deliberate: the routes, the schema and the dnsmasq writers are not
 *     IPv6-ready yet, and letting a v6 string through `isValidCidr` today
 *     would fail deeper down with a worse message.
 */
import { parseIp, formatIp, IPV4_BITS, IPV6_BITS } from './address.js';

// ---------------------------------------------------------------------------
// Address primitives
// ---------------------------------------------------------------------------

/**
 * Parse an address of either family to a BigInt. Zone ids are refused (a
 * scoped address has no place in CIDR math) and IPv4-mapped IPv6 folds to
 * IPv4, the same way address.js canonicalizes it.
 */
export function addressToBig(ip) {
  if (typeof ip !== 'string') {
    throw new Error(`Invalid IP address: expected string, got ${typeof ip}`);
  }
  const parsed = parseIp(ip, { zoneId: false });
  if (!parsed) throw new Error(`Invalid IP address: ${ip}`);
  return { value: parsed.value, bits: parsed.bits, family: parsed.bits === IPV4_BITS ? 4 : 6 };
}

/** Render a BigInt as an address of the given family (4 or 6). */
export function bigToAddress(value, family) {
  return formatIp(value, family === 6 ? IPV6_BITS : IPV4_BITS);
}

export function ipToLong(ip) {
  // Defense-in-depth: reject non-strings with a clean message rather than
  // the opaque `ip.split is not a function` crash v0.4.14 exposed through
  // the global error handler. Route handlers guard their own inputs, but
  // this helper is called from many code paths (scheduler, lease watcher,
  // DB-sourced rows) and has to be safe against bad data too.
  if (typeof ip !== 'string') {
    throw new Error(`Invalid IP address: expected string, got ${typeof ip}`);
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IP address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function longToIp(long) {
  return [(long >>> 24) & 255, (long >>> 16) & 255, (long >>> 8) & 255, long & 255].join('.');
}

// ---------------------------------------------------------------------------
// Family-generic layer
// ---------------------------------------------------------------------------

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
function safeNumber(big) {
  return big <= MAX_SAFE ? Number(big) : null;
}

/**
 * Parse `address/prefix` of either family.
 *
 * Returns, for both families: `family`, `bits`, `cidr` (normalized, the
 * network address with the prefix), `network`, `prefix`, `mask`, `first`,
 * `last`, `firstUsable`, `lastUsable`, and the BigInt fields `networkBig`,
 * `lastBig`, `sizeBig`, `usableBig`. `size` and `usable` are Numbers when
 * they fit in a safe integer and null otherwise (a /64 does not fit).
 *
 * Usable range: IPv4 excludes the network and broadcast addresses except on
 * /31 (RFC 3021) and /32. IPv6 has no broadcast; it excludes only the
 * subnet-router anycast address (the network address), except on /127 and
 * /128, so a gateway policy of `first` means network plus one in both
 * families.
 *
 * IPv4 results also carry the legacy Number fields `broadcast`,
 * `networkLong`, `broadcastLong`, `totalAddresses` and `usableCount`.
 */
export function parseNetwork(cidr) {
  if (typeof cidr !== 'string') throw new Error(`Invalid CIDR notation: ${String(cidr)}`);
  const slash = cidr.lastIndexOf('/');
  if (slash < 1 || slash === cidr.length - 1) throw new Error(`Invalid CIDR notation: ${cidr}`);
  const prefixText = cidr.slice(slash + 1);
  if (!/^\d+$/.test(prefixText)) throw new Error(`Invalid CIDR notation: ${cidr}`);
  let address;
  try {
    address = addressToBig(cidr.slice(0, slash));
  } catch {
    throw new Error(`Invalid CIDR notation: ${cidr}`);
  }
  let prefix = parseInt(prefixText, 10);
  const { bits, family } = address;
  // An IPv4-mapped IPv6 network (::ffff:10.0.0.0/120) folds to its IPv4
  // identity, so its prefix loses the 96 bits of the mapping. A shorter
  // prefix would reach outside the mapped range and cannot be an IPv4 block.
  const folded = family === 4 && cidr.includes(':');
  if (folded) {
    if (prefix < 96) throw new Error(`Invalid prefix length: ${prefix}`);
    prefix -= 96;
  }
  if (prefix < 0 || prefix > bits) throw new Error(`Invalid prefix length: ${prefix}`);

  const bitsBig = BigInt(bits);
  const all = (1n << bitsBig) - 1n;
  const mask = prefix === 0 ? 0n : (all << BigInt(bits - prefix)) & all;
  const network = address.value & mask;
  const last = network | (all ^ mask);
  const size = last - network + 1n;

  const reservesEndpoints = prefix < bits - 1;
  const firstUsableBig = reservesEndpoints ? network + 1n : network;
  const lastUsableBig = reservesEndpoints && family === 4 ? last - 1n : last;
  const usable = lastUsableBig - firstUsableBig + 1n;

  const parsed = {
    family,
    bits,
    prefix,
    network: bigToAddress(network, family),
    cidr: `${bigToAddress(network, family)}/${prefix}`,
    mask: bigToAddress(mask, family),
    first: bigToAddress(network, family),
    last: bigToAddress(last, family),
    firstUsable: bigToAddress(firstUsableBig, family),
    lastUsable: bigToAddress(lastUsableBig, family),
    size: safeNumber(size),
    usable: safeNumber(usable),
  };
  // The BigInt views are real properties but not enumerable: parsed networks
  // travel through JSON.stringify in API responses, which cannot serialize a
  // BigInt, and the string fields already carry the same facts.
  Object.defineProperties(parsed, {
    networkBig: { value: network, enumerable: false },
    lastBig: { value: last, enumerable: false },
    sizeBig: { value: size, enumerable: false },
    usableBig: { value: usable, enumerable: false },
  });
  if (family === 4) {
    parsed.broadcast = parsed.last;
    parsed.networkLong = Number(network);
    parsed.broadcastLong = Number(last);
    parsed.totalAddresses = Number(size);
    parsed.usableCount = Number(usable);
  }
  return parsed;
}

export function isValidNetwork(cidr) {
  try {
    parseNetwork(cidr);
    return true;
  } catch {
    return false;
  }
}

/** The network address with its prefix: 192.168.1.50/24 becomes 192.168.1.0/24. */
export function normalizeNetwork(cidr) {
  return parseNetwork(cidr).cidr;
}

/** True when the address is inside the network. A different family is never inside. */
export function networkContains(cidr, ip) {
  const net = parseNetwork(cidr);
  const address = addressToBig(ip);
  if (address.family !== net.family) return false;
  return address.value >= net.networkBig && address.value <= net.lastBig;
}

/** True when the two networks share at least one address. Different families never do. */
export function networksOverlap(cidrA, cidrB) {
  const a = parseNetwork(cidrA);
  const b = parseNetwork(cidrB);
  if (a.family !== b.family) return false;
  return a.networkBig <= b.lastBig && b.networkBig <= a.lastBig;
}

/** True when the child sits inside the parent with a longer prefix. */
export function isNetworkWithin(childCidr, parentCidr) {
  const child = parseNetwork(childCidr);
  const parent = parseNetwork(parentCidr);
  if (child.family !== parent.family) return false;
  return (
    child.networkBig >= parent.networkBig &&
    child.lastBig <= parent.lastBig &&
    child.prefix > parent.prefix
  );
}

/**
 * The parent minus the child as the fewest CIDR blocks: walk the binary tree
 * from the parent's prefix to the child's, keeping the half that does not
 * hold the child at each level. Exactly (childPrefix - parentPrefix) blocks.
 */
export function subtractNetwork(parentCidr, childCidr) {
  const parent = parseNetwork(parentCidr);
  const child = parseNetwork(childCidr);
  if (child.family !== parent.family) throw new Error('Child CIDR is not within parent CIDR');
  if (child.networkBig < parent.networkBig || child.lastBig > parent.lastBig) {
    throw new Error('Child CIDR is not within parent CIDR');
  }
  if (child.prefix <= parent.prefix) {
    throw new Error('Child prefix must be longer than parent prefix');
  }
  const remainder = [];
  let currentNet = parent.networkBig;
  let currentPrefix = parent.prefix;
  while (currentPrefix < child.prefix) {
    const nextPrefix = currentPrefix + 1;
    const halfSize = 1n << BigInt(parent.bits - nextPrefix);
    const midpoint = currentNet + halfSize;
    if (child.networkBig >= midpoint) {
      remainder.push(`${bigToAddress(currentNet, parent.family)}/${nextPrefix}`);
      currentNet = midpoint;
    } else {
      remainder.push(`${bigToAddress(midpoint, parent.family)}/${nextPrefix}`);
    }
    currentPrefix = nextPrefix;
  }
  return remainder;
}

/**
 * Every child network of the new prefix inside the parent, as parsed
 * networks. Refuses a prefix that is not longer than the parent's or that
 * would produce more than `maxCount` children.
 */
export function splitNetwork(cidr, newPrefix, maxCount = 65536) {
  const parent = parseNetwork(cidr);
  if (!Number.isInteger(newPrefix) || newPrefix <= parent.prefix || newPrefix > parent.bits) {
    throw new Error(
      `New prefix /${newPrefix} must be larger than /${parent.prefix} and <= ${parent.bits}`,
    );
  }
  const count = 1n << BigInt(newPrefix - parent.prefix);
  if (count > BigInt(maxCount)) {
    throw new Error(`Cannot divide into more than ${maxCount} networks`);
  }
  const childSize = 1n << BigInt(parent.bits - newPrefix);
  const results = [];
  for (let i = 0n; i < count; i++) {
    results.push(
      parseNetwork(
        `${bigToAddress(parent.networkBig + i * childSize, parent.family)}/${newPrefix}`,
      ),
    );
  }
  return results;
}

/**
 * Whether a set of networks is an exact, gap-free cover of one larger
 * network, and which one. Leaves may have different prefix lengths, which is
 * what makes carve reversible.
 */
export function mergeNetworks(cidrs) {
  if (!Array.isArray(cidrs) || cidrs.length < 2) {
    return { valid: false, error: 'Need at least 2 networks to merge' };
  }
  const parsed = cidrs.map((c) => parseNetwork(c));
  if (parsed.some((net) => net.family !== parsed[0].family)) {
    return { valid: false, error: 'Networks must be the same address family' };
  }
  parsed.sort((a, b) => (a.networkBig < b.networkBig ? -1 : a.networkBig > b.networkBig ? 1 : 0));

  let total = 0n;
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].networkBig <= parsed[i - 1].lastBig) {
      return { valid: false, error: 'Networks must not overlap' };
    }
    if (parsed[i].networkBig !== parsed[i - 1].lastBig + 1n) {
      return { valid: false, error: 'Networks must be contiguous' };
    }
  }
  for (const net of parsed) total += net.sizeBig;
  if ((total & (total - 1n)) !== 0n) {
    return { valid: false, error: 'Network union size must be a power of 2' };
  }
  const exponent = total.toString(2).length - 1;
  const newPrefix = parsed[0].bits - exponent;
  const first = parsed[0];
  const lastNet = parsed[parsed.length - 1];
  if (first.networkBig % total !== 0n || lastNet.lastBig !== first.networkBig + total - 1n) {
    return { valid: false, error: 'Networks do not align to a valid CIDR boundary' };
  }
  return { valid: true, merged_cidr: `${first.network}/${newPrefix}` };
}

/**
 * Apply a naming template to a network. `%1` to `%4` are the first four
 * groups of the network address (octets for IPv4, hextets for IPv6, as they
 * appear in the canonical spelling with '::' expanded), `%bitmask` the prefix.
 * For IPv6 a dot written between two group placeholders becomes a colon, so
 * the default `%1.%2.%3.%4/%bitmask` names `fd00:9:0:0/48` rather than
 * `fd00.9.0.0/48`; dots elsewhere in a template are left alone.
 */
export function networkNameFromTemplate(template, cidr) {
  const parsed = parseNetwork(cidr);
  const groups =
    parsed.family === 4
      ? parsed.network.split('.')
      : Array.from({ length: 8 }, (_, i) =>
          ((parsed.networkBig >> BigInt(112 - 16 * i)) & 0xffffn).toString(16),
        );
  if (parsed.family === 6) template = template.replace(/(%[1-4])\.(?=%[1-4])/g, '$1:');
  return template
    .replace(/%1/g, groups[0])
    .replace(/%2/g, groups[1])
    .replace(/%3/g, groups[2])
    .replace(/%4/g, groups[3])
    .replace(/%bitmask/g, String(parsed.prefix));
}

/** True for a plain address of either family: no zone id, no prefix. */
export function isValidAddress(ip) {
  if (typeof ip !== 'string') return false;
  return parseIp(ip, { zoneId: false }) !== null;
}

/** True when the address is inside the parsed network. A different family is never inside. */
export function parsedNetworkContains(parsed, ip) {
  if (typeof ip !== 'string') return false;
  const address = parseIp(ip, { zoneId: false });
  if (!address) return false;
  const family = address.bits === IPV4_BITS ? 4 : 6;
  if (family !== parsed.family) return false;
  return address.value >= parsed.networkBig && address.value <= parsed.lastBig;
}

/**
 * The addresses topology reserves in a network: the network address for both
 * families (the subnet-router anycast address in IPv6) and the broadcast
 * address for IPv4. Point-to-point and host prefixes reserve nothing.
 */
export function topologyAddresses(parsed) {
  if (parsed.prefix >= parsed.bits - 1) return [];
  return parsed.family === 4 ? [parsed.network, parsed.broadcast] : [parsed.network];
}

/** The address `offset` places after the network address, in the network's family. */
export function addressAtOffset(parsed, offset) {
  return bigToAddress(parsed.networkBig + BigInt(offset), parsed.family);
}

/** True when the two inclusive address intervals share an address. Different families never do. */
export function addressRangesOverlap(startA, endA, startB, endB) {
  const a0 = addressToBig(startA);
  const a1 = addressToBig(endA);
  const b0 = addressToBig(startB);
  const b1 = addressToBig(endB);
  if (a0.family !== b0.family) return false;
  return a0.value <= b1.value && b0.value <= a1.value;
}

/** True when `ip` lies inside the inclusive interval, same family only. */
export function addressInRange(ip, startIp, endIp) {
  return addressRangesOverlap(ip, ip, startIp, endIp);
}

// Well-known reserved and private ranges, both families.
export const RESERVED_RANGES = [
  { cidr: '10.0.0.0/8', name: 'RFC1918 Class A' },
  { cidr: '172.16.0.0/12', name: 'RFC1918 Class B' },
  { cidr: '192.168.0.0/16', name: 'RFC1918 Class C' },
  { cidr: '100.64.0.0/10', name: 'CGNAT (RFC6598)' },
  { cidr: '169.254.0.0/16', name: 'Link-Local (RFC3927)' },
  { cidr: '127.0.0.0/8', name: 'Loopback (RFC1122)' },
  { cidr: '224.0.0.0/4', name: 'Multicast (RFC5771)' },
  { cidr: '240.0.0.0/4', name: 'Reserved (RFC1112)' },
  { cidr: 'fc00::/7', name: 'Unique Local (RFC4193)' },
  { cidr: 'fe80::/10', name: 'Link-Local (RFC4291)' },
  { cidr: '::1/128', name: 'Loopback (RFC4291)' },
  { cidr: 'ff00::/8', name: 'Multicast (RFC4291)' },
  { cidr: '2001:db8::/32', name: 'Documentation (RFC3849)' },
];

/**
 * A supernet that touches a reserved range must sit entirely inside it.
 * Public space is allowed freely.
 */
export function validateNetworkBounds(cidr) {
  const parsed = parseNetwork(cidr);
  for (const reserved of RESERVED_RANGES) {
    const res = parseNetwork(reserved.cidr);
    if (res.family !== parsed.family) continue;
    if (networksOverlap(cidr, reserved.cidr)) {
      if (parsed.networkBig >= res.networkBig && parsed.lastBig <= res.lastBig) {
        return { valid: true };
      }
      return {
        valid: false,
        error: `${cidr} extends beyond ${reserved.name} (${reserved.cidr}). Supernet must be within ${reserved.cidr}.`,
      };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// IPv4 layer: the contract existing callers hold, as wrappers over the above
// ---------------------------------------------------------------------------

function requireIpv4(parsed, cidr) {
  if (parsed.family !== 4) throw new Error(`Invalid CIDR notation: ${cidr}`);
  return parsed;
}

export function parseCidr(cidr) {
  return requireIpv4(parseNetwork(cidr), cidr);
}

export function isIpInSubnet(ip, cidr) {
  parseCidr(cidr);
  ipToLong(ip);
  return networkContains(cidr, ip);
}

/**
 * Normalize a CIDR, ensures the IP portion is the actual network address.
 * e.g., 192.168.1.50/24 -> 192.168.1.0/24
 */
export function normalizeCidr(cidr) {
  return parseCidr(cidr).cidr;
}

export function validateSupernet(cidr) {
  parseCidr(cidr);
  return validateNetworkBounds(cidr);
}

/**
 * Apply a naming template to a CIDR.
 * Variables: %1-%4 (octets), %bitmask (prefix length)
 */
export function applyNameTemplate(template, cidr) {
  parseCidr(cidr);
  return networkNameFromTemplate(template, cidr);
}

export function canMergeCidrs(cidrs) {
  if (Array.isArray(cidrs)) cidrs.forEach((c) => parseCidr(c));
  return mergeNetworks(cidrs);
}

export function calculateSubnets(cidr, newPrefix, maxCount = 65536) {
  parseCidr(cidr);
  return splitNetwork(cidr, newPrefix, maxCount);
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Validate IPv4 address string (regex + octet range check).
 */
export function isValidIpv4(ip) {
  if (!IPV4_RE.test(ip)) return false;
  return ip.split('.').every((o) => {
    const n = parseInt(o, 10);
    return n >= 0 && n <= 255;
  });
}

/** Well-formed IPv4 CIDR. IPv6 is refused here until the routes and schema take it. */
export function isValidCidr(cidr) {
  try {
    parseCidr(cidr);
    return true;
  } catch {
    return false;
  }
}

export function isSubnetOf(childCidr, parentCidr) {
  parseCidr(childCidr);
  parseCidr(parentCidr);
  return isNetworkWithin(childCidr, parentCidr);
}

export function cidrsOverlap(cidrA, cidrB) {
  parseCidr(cidrA);
  parseCidr(cidrB);
  return networksOverlap(cidrA, cidrB);
}

export function subtractCidr(parentCidr, childCidr) {
  parseCidr(parentCidr);
  parseCidr(childCidr);
  return subtractNetwork(parentCidr, childCidr);
}
