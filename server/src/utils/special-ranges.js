/**
 * The special-purpose address blocks, both families, in one table. Three
 * modules used to keep their own copies, so a fix to one never reached the
 * others. Each flag says which list a row is in:
 *
 * - `scan`: not globally routable. Automatic scans may inherit the global
 *   scan setting here; public space needs a per-network opt-in, so documenting
 *   a public prefix cannot turn CIDRella into an Internet scanner
 *   (`isGloballyRoutableCidr` in ip.js).
 * - `outbound`: an outbound fetch may not connect here (the SSRF guard in
 *   url-guard.js). A superset of `scan`: it adds NAT64 and the Teredo and 6to4
 *   blocks, whose embedded IPv4 gets the IPv4 check.
 * - `name`: a reserved range a supernet must sit inside if it touches it
 *   (`validateNetworkBounds` in cidr.js). Its order is the order that check
 *   reports in, so keep the named rows first and in this order.
 *
 * No imports on purpose: cidr.js is shared with the client through @shared,
 * and a leaf module cannot start an import cycle.
 */
export const SPECIAL_RANGES = Object.freeze(
  [
    { cidr: '10.0.0.0/8', name: 'RFC1918 Class A', scan: true, outbound: true },
    { cidr: '172.16.0.0/12', name: 'RFC1918 Class B', scan: true, outbound: true },
    { cidr: '192.168.0.0/16', name: 'RFC1918 Class C', scan: true, outbound: true },
    { cidr: '100.64.0.0/10', name: 'CGNAT (RFC6598)', scan: true, outbound: true },
    // Link-local, and the AWS/GCP metadata address 169.254.169.254.
    { cidr: '169.254.0.0/16', name: 'Link-Local (RFC3927)', scan: true, outbound: true },
    { cidr: '127.0.0.0/8', name: 'Loopback (RFC1122)', scan: true, outbound: true },
    { cidr: '224.0.0.0/4', name: 'Multicast (RFC5771)', scan: true, outbound: true },
    // Includes the 255.255.255.255 broadcast.
    { cidr: '240.0.0.0/4', name: 'Reserved (RFC1112)', scan: true, outbound: true },
    { cidr: 'fc00::/7', name: 'Unique Local (RFC4193)', scan: true, outbound: true },
    { cidr: 'fe80::/10', name: 'Link-Local (RFC4291)', scan: true, outbound: true },
    { cidr: '::1/128', name: 'Loopback (RFC4291)', scan: true, outbound: true },
    { cidr: 'ff00::/8', name: 'Multicast (RFC4291)', scan: true, outbound: true },
    { cidr: '2001:db8::/32', name: 'Documentation (RFC3849)', scan: true, outbound: true },
    { cidr: '0.0.0.0/8', scan: true, outbound: true }, // "this network"
    { cidr: '192.0.0.0/24', scan: true, outbound: true }, // IETF protocol assignments
    { cidr: '192.0.2.0/24', scan: true, outbound: true }, // TEST-NET-1
    { cidr: '198.18.0.0/15', scan: true, outbound: true }, // benchmarking
    { cidr: '198.51.100.0/24', scan: true, outbound: true }, // TEST-NET-2
    { cidr: '203.0.113.0/24', scan: true, outbound: true }, // TEST-NET-3
    { cidr: '::/128', scan: true, outbound: true }, // unspecified
    { cidr: '::ffff:0:0/96', scan: true, outbound: true }, // IPv4-mapped
    { cidr: '64:ff9b::/96', outbound: true }, // NAT64
    { cidr: '2001::/32', outbound: true }, // Teredo
    { cidr: '2002::/16', outbound: true }, // 6to4
  ].map((row) => Object.freeze(row)),
);

const isV6 = (row) => row.cidr.includes(':');
const cidrs = (keep) => Object.freeze(SPECIAL_RANGES.filter(keep).map((row) => row.cidr));

export const NON_GLOBAL_IPV4_RANGES = cidrs((r) => r.scan && !isV6(r));
export const NON_GLOBAL_IPV6_RANGES = cidrs((r) => r.scan && isV6(r));
export const BLOCKED_IPV4_RANGES = cidrs((r) => r.outbound && !isV6(r));
export const BLOCKED_IPV6_RANGES = cidrs((r) => r.outbound && isV6(r));

/** The named reserved ranges, `{ cidr, name }`, in the order the supernet check reports. */
export const RESERVED_RANGES = Object.freeze(
  SPECIAL_RANGES.filter((r) => r.name).map(({ cidr, name }) => Object.freeze({ cidr, name })),
);
