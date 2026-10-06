// Reverse DNS zone names for a network and the network a zone name covers.
// Pure naming: DNS topology uses them to create reverse zones, and a backend
// uses them to place PTRs; neither depends on how a backend serves them.
import { parseNetwork } from './ip.js';

export function generateReverseName(cidr) {
  return generateReverseNames(cidr)[0];
}

/**
 * Generate the reverse zone names for a CIDR.
 * IPv4: /24+ → 1 zone, /17-/23 → multiple /24 zones, /16 → /16 zone, etc.
 * IPv6: one ip6.arpa zone at the nibble boundary of the prefix (the prefix
 * length rounded down to a multiple of four), never a walk of the space.
 */
export function generateReverseNames(cidr) {
  const parsed = parseNetwork(cidr);
  if (parsed.family === 6) {
    // A zone has at most 31 nibbles: with all 32 the zone name would be the
    // PTR owner itself, which no PTR lookup tries, so a /128 uses its /124.
    const zoneNibbles = Math.min(31, Math.max(1, Math.floor(parsed.prefix / 4)));
    const nibbles = parsed.networkBig.toString(16).padStart(32, '0').split('');
    return [`${nibbles.slice(0, zoneNibbles).reverse().join('.')}.ip6.arpa`];
  }
  const octets = parsed.network.split('.').map(Number);

  if (parsed.prefix >= 24) {
    return [`${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`];
  } else if (parsed.prefix >= 17) {
    // Split into individual /24 zones
    const numBlocks = 1 << (24 - parsed.prefix);
    const zones = [];
    for (let i = 0; i < numBlocks; i++) {
      zones.push(`${octets[2] + i}.${octets[1]}.${octets[0]}.in-addr.arpa`);
    }
    return zones;
  } else if (parsed.prefix >= 16) {
    return [`${octets[1]}.${octets[0]}.in-addr.arpa`];
  } else if (parsed.prefix >= 8) {
    return [`${octets[0]}.in-addr.arpa`];
  }
  return [`${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`];
}

/**
 * The network a reverse zone name covers, as a CIDR string, or null when the
 * name is not a whole-octet in-addr.arpa or nibble-aligned ip6.arpa zone.
 * This is the inverse of generateReverseNames for the shapes it produces:
 * "1.0.10.in-addr.arpa" is 10.0.1.0/24, "8.b.d.0.1.0.0.2.ip6.arpa" is
 * 2001:db8::/32.
 */
export function reverseZoneNetwork(zoneName) {
  const name = String(zoneName || '')
    .toLowerCase()
    .replace(/\.$/, '');
  const v4 = name.match(/^((?:\d{1,3}\.){1,3})in-addr\.arpa$/);
  if (v4) {
    const octets = v4[1].split('.').filter(Boolean).reverse();
    if (octets.some((o) => Number(o) > 255)) return null;
    const padded = [...octets, ...Array(4 - octets.length).fill('0')];
    return `${padded.join('.')}/${octets.length * 8}`;
  }
  const v6 = name.match(/^((?:[0-9a-f]\.){1,32})ip6\.arpa$/);
  if (v6) {
    const nibbles = v6[1].split('.').filter(Boolean).reverse();
    const hex = [...nibbles, ...Array(32 - nibbles.length).fill('0')].join('');
    const hextets = hex.match(/.{4}/g).join(':');
    return `${parseNetwork(`${hextets}/${nibbles.length * 4}`).network}/${nibbles.length * 4}`;
  }
  return null;
}
