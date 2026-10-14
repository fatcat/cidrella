/**
 * The DHCP option values a scope takes from its network: one rule for the
 * server (fillScopeOptions, for new scopes and Bulk Change) and the scope
 * dialog, which imports this file through the @shared alias. Keep it free of
 * Node built-ins and of imports the client cannot load.
 */

/**
 * Each value a scope gets from its network, as { code, value, overwrite }.
 * `overwrite` marks the topology values (mask, router, broadcast), which
 * replace one already set; the rest only fill a blank.
 *
 * IPv4: router (3), mask (1), broadcast (28), domain (15) and search list
 * (119), and DNS (6) as CIDRella's address alone: an outside resolver beside it
 * does not know local names, skips filtering, and most clients ask either one,
 * not one as a backup. IPv6: the search list (24) from the domain and DNS (23)
 * as CIDRella's IPv6 address on the network; routers, prefixes and the rest come from
 * Router Advertisements. A value the network does not have is left out.
 */
export function networkOptionFills({ family, mask, broadcast, gateway, domain, serverIp }) {
  const fills =
    Number(family) === 6
      ? [
          [24, domain, false],
          [23, serverIp, false],
        ]
      : [
          [3, gateway, true],
          [1, mask, true],
          [28, broadcast, true],
          [15, domain, false],
          [119, domain, false],
          [6, serverIp, false],
        ];
  return fills
    .filter(([, value]) => value != null && value !== '')
    .map(([code, value, overwrite]) => ({ code, value: String(value), overwrite }));
}
