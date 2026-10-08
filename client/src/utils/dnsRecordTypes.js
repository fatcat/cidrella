/**
 * The record types a zone's editor offers. Reverse zones take PTR only;
 * forward zones take the usual set, with AAAA while IPv6 support is on.
 */
export const FORWARD_RECORD_TYPES = Object.freeze([
  'A',
  'AAAA',
  'CNAME',
  'MX',
  'TXT',
  'SRV',
  'PTR',
]);

export function recordTypesFor({ zoneType, ipv6 = false } = {}) {
  if (zoneType === 'reverse') return ['PTR'];
  return FORWARD_RECORD_TYPES.filter((type) => type !== 'AAAA' || ipv6);
}
