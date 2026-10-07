/**
 * The features CIDRella offers, or may offer, that depend on which backend
 * fills a role. The contract is a superset: an adapter declares which of
 * these it supports (capabilities() returns `{ [id]: boolean }` for the
 * features of the roles it fills), the API refuses a write that needs one
 * the active backend lacks (utils/backend-features.js), and the UI hides or
 * disables it with the reason.
 *
 * The ids match the backend feature survey of 2026-10-07, where each was
 * given a verdict: 'yes' (CIDRella offers it, or will) or 'maybe' (a later
 * release). Features ruled out are not listed. Neither are features
 * CIDRella provides itself whatever the backend (automatic PTRs, encrypted
 * upstreams through its forwarder, the blocklist proxy, DHCP-to-DNS names),
 * or properties nobody switches on (live changes, config validation).
 *
 * Support is a boolean. A backend that does part of a feature gets a finer
 * id, never a level.
 */

const feature = (id, role, verdict, label) => Object.freeze({ id, role, verdict, label });

export const FEATURES = Object.freeze([
  // Records and zones
  feature('dns-core-records', 'dns', 'yes', 'Core record types'),
  feature('dns-caa', 'dns', 'maybe', 'CAA records'),
  feature('dns-https-svcb', 'dns', 'maybe', 'HTTPS and SVCB records'),
  feature('dns-ns-delegation', 'dns', 'maybe', 'Subdomain delegation (NS records)'),
  feature('dns-any-type', 'dns', 'maybe', 'Arbitrary record types'),
  feature('dns-alias', 'dns', 'maybe', 'ALIAS at the zone apex'),
  feature('dns-record-ttl', 'dns', 'yes', 'TTL per record, as served'),
  feature('dns-soa-ns', 'dns', 'yes', 'SOA and NS answers for zones'),
  feature('dns-wildcard', 'dns', 'maybe', 'Wildcard records'),
  feature('dns-local-zones', 'dns', 'yes', 'Zones answer their own names'),
  feature('dns-views', 'dns', 'maybe', 'Split horizon by client network'),
  // Zone sharing and outside updates
  feature('dns-axfr-out', 'dns', 'maybe', 'Zone transfer to secondaries (AXFR/IXFR)'),
  feature('dns-notify', 'dns', 'maybe', 'NOTIFY on change'),
  feature('dns-tsig', 'dns', 'maybe', 'TSIG keys'),
  feature('dns-secondary', 'dns', 'maybe', 'Secondary zones (copy a zone in)'),
  feature('dns-catalog', 'dns', 'maybe', 'Catalog zones'),
  feature('dns-rfc2136', 'dns', 'maybe', 'Dynamic updates (RFC 2136)'),
  feature('dns-dnssec-sign', 'dns', 'maybe', 'DNSSEC signing of local zones'),
  feature('dns-lua-records', 'dns', 'maybe', 'Health-checked and location-aware answers'),
  // Resolving and forwarding
  feature('rec-forwarders', 'dns', 'yes', 'Upstream forwarders'),
  feature('rec-conditional', 'dns', 'yes', 'Conditional forwarding per domain'),
  feature('rec-full-recursion', 'dns', 'maybe', 'Full recursion from the root'),
  feature('rec-dnssec-validate', 'dns', 'yes', 'DNSSEC validation'),
  feature('rec-cache', 'dns', 'yes', 'Cache tuning'),
  feature('rec-serve-stale', 'dns', 'maybe', 'Serve stale answers'),
  feature('rec-prefetch', 'dns', 'maybe', 'Prefetch popular names'),
  feature('rec-rebind', 'dns', 'maybe', 'DNS rebinding protection'),
  feature('rec-acl', 'dns', 'maybe', 'Who may use CIDRella as a resolver'),
  feature('rec-rate-limit', 'dns', 'maybe', 'Per-client query rate limits'),
  // Encrypted DNS
  feature('rec-serve-encrypted', 'dns', 'maybe', 'Encrypted DNS for LAN clients'),
  // DHCP addressing
  feature('dhcp-scopes', 'dhcp', 'yes', 'Scopes with several pools'),
  feature('dhcp-res-mac', 'dhcp', 'yes', 'Reservations by MAC'),
  feature('dhcp-res-other', 'dhcp', 'maybe', 'Reservations by client ID or switch port'),
  feature('dhcp-relay', 'dhcp', 'yes', 'Subnets behind a DHCP relay'),
  feature('dhcp-shared-net', 'dhcp', 'maybe', 'Shared networks'),
  feature('dhcp-lease-times', 'dhcp', 'maybe', 'Lease time controls'),
  feature('dhcp-authoritative', 'dhcp', 'yes', 'Authoritative mode'),
  feature('dhcp-ping-check', 'dhcp', 'yes', 'Ping before offering'),
  // DHCP options and classes
  feature('dhcp-options', 'dhcp', 'yes', 'Option catalog and custom options'),
  feature('dhcp-option-defs', 'dhcp', 'maybe', 'Named option definitions'),
  feature('dhcp-vendor-opts', 'dhcp', 'maybe', 'Vendor options (43 and 125)'),
  feature('dhcp-classes', 'dhcp', 'maybe', 'Client classes'),
  feature('dhcp-pxe', 'dhcp', 'maybe', 'Network boot (PXE)'),
  // DHCP scale and resilience
  feature('dhcp-ha', 'dhcp', 'maybe', 'DHCP failover between two boxes'),
  feature('dhcp-rate-limit', 'dhcp', 'maybe', 'Per-client DHCP limits'),
  feature('dhcp-stats', 'dhcp', 'yes', 'Pool use from the server'),
  feature('dhcp-leasequery', 'dhcp', 'maybe', 'Leasequery for routers'),
  feature('dhcp-sql-leases', 'dhcp', 'maybe', 'Leases in an SQL database'),
  // IPv6: DHCPv6 and router advertisements
  feature('dhcp6-stateful', 'dhcp', 'yes', 'Stateful DHCPv6'),
  feature('dhcp6-stateless', 'dhcp', 'yes', 'Stateless DHCPv6'),
  feature('dhcp6-duid-res', 'dhcp', 'yes', 'DUID reservations'),
  feature('dhcp6-pd', 'dhcp', 'maybe', 'Prefix delegation'),
  feature('ra', 'ra', 'yes', 'Router advertisements'),
  feature('ra-tuning', 'ra', 'maybe', 'RA tuning'),
  feature('ra-names', 'ra', 'yes', 'Names for SLAAC hosts'),
  // Leases and names
  feature('lease-release', 'dhcp', 'yes', 'Release a lease on demand'),
  feature('ddns-kea-d2', 'dhcp', 'maybe', 'Kea updates DNS directly (D2)'),
  feature('fingerprint', 'dhcp', 'yes', 'Device fingerprinting from DHCP'),
  feature('forensic-log', 'dhcp', 'yes', 'DHCP audit log'),
  // Observability and operations
  feature('qlog-structured', 'dns', 'yes', 'Structured query log'),
]);

export const FEATURE_IDS = Object.freeze(FEATURES.map((f) => f.id));

const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

/** The catalog entry for `id`, or undefined. */
export const featureById = (id) => BY_ID.get(id);

/** Catalog ids for the features of `role`. */
export const featureIdsForRole = (role) => FEATURES.filter((f) => f.role === role).map((f) => f.id);

/**
 * An adapter's capabilities(): every feature of `roles`, true for the ids in
 * `supported` (an array, or an object of id -> boolean for support known
 * only at run time) and false for the rest. An id that is not in the
 * catalog, or belongs to a role the adapter does not fill, throws, so a
 * typo can't quietly switch a feature off.
 */
export function declareSupport(roles, supported) {
  const given = Array.isArray(supported)
    ? Object.fromEntries(supported.map((id) => [id, true]))
    : supported;
  for (const id of Object.keys(given)) {
    if (!roles.includes(featureById(id)?.role)) {
      throw new Error(`Unknown feature for roles ${roles.join(', ')}: ${id}`);
    }
  }
  return Object.fromEntries(
    FEATURES.filter((f) => roles.includes(f.role)).map((f) => [f.id, given[f.id] === true]),
  );
}
