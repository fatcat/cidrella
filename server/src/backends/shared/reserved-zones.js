/**
 * The names reserved for local use that every DNS backend answers itself
 * rather than forwards (dnsmasq with local=, PowerDNS with an empty zone).
 */
import { getSetting } from '../../db/init.js';
import { isValidAddress, isGloballyRoutableCidr } from '../../utils/ip.js';
import { addressFamily } from '../../utils/address.js';
import { plainUpstreams } from '../../utils/forwarding-settings.js';

// Names reserved for local use, which CIDRella answers itself (NXDOMAIN, or
// its own record) rather than forwards: RFC 6761 (localhost, invalid, test),
// 7686 (onion), 9462 (resolver.arpa, the DDR probe) and the RFC 6303 reverse
// zones for loopback, link-local, "this network", broadcast and documentation
// addresses in both families, plus the IPv4 private ranges bogus-priv already
// keeps from upstreams. Public resolvers make up answers for these with no
// DNSSEC proof (Quad9 sends EDE 29 and an empty authority section), so with
// DNSSEC on a validating backend calls them BOGUS and the client gets SERVFAIL.
export const RESERVED_LOCAL_DOMAINS = Object.freeze([
  'localhost',
  'invalid',
  'test',
  'onion',
  'resolver.arpa',
  '0.in-addr.arpa',
  '127.in-addr.arpa',
  '254.169.in-addr.arpa',
  '255.255.255.255.in-addr.arpa',
  '2.0.192.in-addr.arpa',
  '100.51.198.in-addr.arpa',
  '113.0.203.in-addr.arpa',
  '10.in-addr.arpa',
  ...Array.from({ length: 16 }, (_, i) => `${16 + i}.172.in-addr.arpa`),
  '168.192.in-addr.arpa',
  `${'0.'.repeat(32)}ip6.arpa`, // ::
  `1.${'0.'.repeat(31)}ip6.arpa`, // ::1
  '8.e.f.ip6.arpa', // fe80::/10
  '9.e.f.ip6.arpa',
  'a.e.f.ip6.arpa',
  'b.e.f.ip6.arpa',
  '8.b.d.0.1.0.0.2.ip6.arpa', // 2001:db8::/32
]);

// Reserved for sites rather than for nobody: an office resolver may serve
// corp.internal or an AD domain under .local, a homenet router home.arpa, and
// either the PTRs of a ULA prefix. These stay local only while every upstream
// is a public address, so CIDRella never hides a private resolver's zone.
export const SITE_LOCAL_DOMAINS = Object.freeze(['home.arpa', 'internal', 'local', 'd.f.ip6.arpa']);

export const MANAGED_LOCAL_DOMAINS = new Set([...RESERVED_LOCAL_DOMAINS, ...SITE_LOCAL_DOMAINS]);

/**
 * The addresses forwarded queries end up at: the encrypted forwarder's
 * upstreams when it is on, the plain servers otherwise, none with recursion off.
 */
export function forwardedAddresses({ noRecursion = getSetting('dns_no_recursion') === 'true' } = {}) {
  if (noRecursion) return [];
  const encryption = getSetting('forwarder_encryption') || 'off';
  if (encryption !== 'tls' && encryption !== 'https') return plainUpstreams();
  return (getSetting('forwarder_encrypted_upstreams') || []).flatMap((u) => u?.addresses || []);
}

function isPublicAddress(address) {
  if (!isValidAddress(address)) return false;
  return isGloballyRoutableCidr(`${address}/${addressFamily(address) === 6 ? 128 : 32}`);
}

/** The reserved domains to answer locally, given where queries go. */
export function reservedLocalDomains({ addresses = [] } = {}) {
  return addresses.every(isPublicAddress)
    ? [...RESERVED_LOCAL_DOMAINS, ...SITE_LOCAL_DOMAINS]
    : [...RESERVED_LOCAL_DOMAINS];
}
