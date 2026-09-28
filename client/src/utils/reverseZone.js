/**
 * Reverse zone names of either family.
 *
 * An IPv4 reverse zone is `<octets reversed>.in-addr.arpa`, an IPv6 one
 * `<nibbles reversed>.ip6.arpa`. The DNS panel used to rebuild the address
 * a PTR names by splitting on dots and reversing, which only holds for
 * octets. These helpers do the same for both spellings through the shared
 * address core, so the panel never parses an arpa name itself.
 */
import { canonicalizeIp, sortKey } from '@shared/address.js';

const V4_SUFFIX = /\.?in-addr\.arpa\.?$/i;
const V6_SUFFIX = /\.?ip6\.arpa\.?$/i;

/** 4 for in-addr.arpa, 6 for ip6.arpa, null for anything else. */
export function reverseZoneFamily(name) {
  if (typeof name !== 'string') return null;
  if (V4_SUFFIX.test(name)) return 4;
  if (V6_SUFFIX.test(name)) return 6;
  return null;
}

/** The labels of a reverse zone in address order (most significant first). */
function zoneLabels(name, family) {
  const stripped = name.replace(family === 6 ? V6_SUFFIX : V4_SUFFIX, '');
  return stripped ? stripped.split('.').reverse() : [];
}

/**
 * The address a PTR record names: the record's own labels in front of the
 * zone's, reversed back into address order. IPv6 nibbles become hextets and
 * come out in the canonical spelling. Null when the pieces do not add up to
 * an address.
 */
export function ptrRecordAddress(zoneName, recordName) {
  const family = reverseZoneFamily(zoneName);
  if (!family) return null;
  const recordLabels = recordName ? String(recordName).split('.').filter(Boolean) : [];
  const labels = [...zoneLabels(zoneName, family), ...recordLabels.reverse()];
  if (family === 4) {
    if (labels.length !== 4) return null;
    return canonicalizeIp(labels.join('.'));
  }
  if (labels.length !== 32 || labels.some((label) => !/^[0-9a-f]$/i.test(label))) return null;
  const hextets = [];
  for (let i = 0; i < 32; i += 4) hextets.push(labels.slice(i, i + 4).join(''));
  return canonicalizeIp(hextets.join(':'));
}

// The network a reverse zone covers, as its first address and prefix length:
// octets or nibbles padded out to a full address.
function zoneNetwork(name) {
  const family = reverseZoneFamily(name);
  if (!family) return null;
  const labels = zoneLabels(name, family);
  if (family === 4) {
    const octets = [...labels, ...Array(Math.max(0, 4 - labels.length)).fill('0')].slice(0, 4);
    return { family, address: octets.join('.'), prefix: Math.min(labels.length, 4) * 8 };
  }
  const nibbles = [...labels, ...Array(Math.max(0, 32 - labels.length)).fill('0')].slice(0, 32);
  const hextets = [];
  for (let i = 0; i < 32; i += 4) hextets.push(nibbles.slice(i, i + 4).join(''));
  return { family, address: hextets.join(':'), prefix: Math.min(labels.length, 32) * 4 };
}

/**
 * A key that orders reverse zones by the network they cover: octets or
 * nibbles padded to a full address, then the shared fixed-width sort key,
 * so IPv4 zones come before IPv6 ones and each family sorts numerically.
 */
export function reverseZoneSortKey(name) {
  const network = zoneNetwork(name);
  return (network && sortKey(network.address)) || `9${name}`;
}

/** The network a reverse zone covers, as a CIDR: 2.0.10.in-addr.arpa is 10.0.2.0/24. */
export function reverseZoneCidr(name) {
  const network = zoneNetwork(name);
  if (!network) return null;
  return `${canonicalizeIp(network.address) || network.address}/${network.prefix}`;
}

/** Whether an address falls in the network a reverse zone covers. */
export function reverseZoneContains(name, ip) {
  const network = zoneNetwork(name);
  const address = canonicalizeIp(String(ip ?? '').trim());
  if (!network || !address) return false;
  const addressKey = sortKey(address);
  const zoneKey = sortKey(network.address);
  if (!addressKey || !zoneKey || addressKey[0] !== zoneKey[0]) return false;
  // The keys are the family digit and 32 hex digits; an IPv4 address fills
  // the last 8. The prefix covers one hex digit per 4 bits.
  const start = network.family === 4 ? 25 : 1;
  const digits = network.prefix / 4;
  return addressKey.slice(start, start + digits) === zoneKey.slice(start, start + digits);
}

/** Form copy for the PTR name field by zone family. */
export function ptrHostHint(family) {
  if (family === 6) {
    return {
      label: 'Host nibbles *',
      placeholder: 'e.g. 1.0.0.0',
      help: 'The remaining hex digits of the address, least significant first, as in the zone name',
    };
  }
  return {
    label: 'Last Octet *',
    placeholder: 'e.g. 5',
    help: 'Host portion of the IP address',
  };
}
