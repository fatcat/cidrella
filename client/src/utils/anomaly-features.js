// Formatting + plain-English descriptions for the anomaly detector's DNS
// behavior features. Shared by the contributing-factors list and the
// per-signal trend charts so both read a value the same way.
import { EMPTY_CELL } from './format.js';

export const FACTOR_DESCRIPTIONS = {
  'Unusual time of day': 'DNS queries are happening at hours this client doesn\'t normally generate traffic.',
  'Unusual day of week': 'Query patterns differ from this client\'s typical day-of-week behavior.',
  'Abnormal query volume': 'The total number of DNS queries is significantly different from this client\'s learned baseline.',
  'Bursty query pattern': 'Queries are arriving in sharp bursts rather than the client\'s normal steady pattern.',
  'Unusual number of distinct domains': 'The client is querying far more or fewer unique domains than usual.',
  'High ratio of never-before-seen domains': 'A large proportion of queried domains have never been seen before from this client.',
  'High-entropy domains (possible DGA)': 'Domain names have unusually random character patterns, which can indicate domain generation algorithms used by malware.',
  'Unusually long domain names': 'Queries include abnormally long domain names, sometimes used for DNS tunneling or data exfiltration.',
  'Deep subdomain nesting': 'Domains have more subdomain levels than typical, which can indicate tunneling.',
  'Unusual TLD diversity': 'The client is querying an unusual variety of top-level domains compared to its baseline.',
  'High NXDOMAIN rate': 'A large fraction of queries are returning NXDOMAIN (non-existent domain), which can indicate scanning or DGA activity.',
  'High blocked query rate': 'An unusually high percentage of this client\'s queries are being blocked by the blocklist.',
  'Unusual A record ratio': 'The proportion of A (IPv4) record queries differs significantly from this client\'s normal mix.',
  'Unusual AAAA record ratio': 'The proportion of AAAA (IPv6) record queries differs significantly from this client\'s normal mix.',
  'Unusual non-A/AAAA query types': 'The client is making an unusual number of non-standard query types (MX, TXT, SRV, etc.).',
  'Unusual query type diversity': 'The variety of DNS query types is different from this client\'s typical behavior.',
  'Unusual number of resolved IPs': 'Queries are resolving to a significantly different number of unique IP addresses than expected.',
  'High unresolved query ratio': 'A large fraction of queries are failing to resolve, which can indicate probing or misconfiguration.',
};

// Features that are counts (display as integers); the rest not listed here
// as ratios are displayed as decimals (entropy, diversity, depth).
const COUNT_FEATURES = new Set([
  'query_count', 'unique_domain_count', 'max_domain_length', 'unique_resolved_ips',
]);
const RATIO_FEATURES = new Set([
  'burst_ratio', 'new_domain_ratio', 'nxdomain_ratio', 'block_ratio',
  'type_a_ratio', 'type_aaaa_ratio', 'type_other_ratio', 'null_resolved_ratio',
]);

export function formatFeatureValue(feature, value) {
  if (value == null) return EMPTY_CELL;
  if (COUNT_FEATURES.has(feature)) return Math.round(value).toLocaleString();
  if (RATIO_FEATURES.has(feature)) return (value * 100).toFixed(1) + '%';
  return value.toFixed(2);
}
