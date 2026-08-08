/**
 * Shared DHCP hostname-resolution utilities used by DHCP.vue and ScopeDialog.vue.
 */

import { isValidIpv4 } from './ip.js';

/**
 * Is this entry already an address, so it needs no DNS lookup?
 *
 * This was a local IP_RE that checked shape only, with no octet range check, so
 * "300.1.1.1" was treated as an address already and passed through untouched
 * into a DHCP option value instead of being resolved or rejected. isValidIpv4
 * is the same shape test plus the 0-255 bound.
 * See REVIEW.md, duplicate-logic audit #51.
 */
const isAddress = (v) => isValidIpv4(String(v ?? '').trim());

/**
 * Resolve a comma-separated list of hostnames/IPs to IP addresses.
 * Entries that are already IPs are passed through unchanged.
 * Unresolvable entries are kept as-is and a toast warning is emitted.
 *
 * @param {string} value - Raw input value (hostname or comma-separated list)
 * @param {object} api   - Axios-compatible API client
 * @param {object} toast - PrimeVue toast instance
 * @returns {Promise<string>} Resolved comma-separated IP string
 */
export async function resolveHostname(value, api, toast) {
  if (!value || isAddress(value)) return value;
  const parts = value.split(',').map(s => s.trim()).filter(Boolean);
  const resolved = [];
  for (const part of parts) {
    if (isAddress(part)) {
      resolved.push(part);
    } else {
      try {
        const res = await api.get(`/dns/resolve?name=${encodeURIComponent(part)}`);
        resolved.push(...res.data.ips);
      } catch {
        toast.add({ severity: 'warn', summary: `Could not resolve "${part}"`, life: 3000 });
        resolved.push(part);
      }
    }
  }
  return resolved.join(',');
}

/**
 * Return an input placeholder string appropriate for a DHCP option type.
 *
 * @param {string} type - DHCP option type ('ip', 'ip-list', 'text', 'text-list', 'number')
 * @returns {string}
 */
export function placeholderForType(type) {
  switch (type) {
    case 'ip': return 'e.g. 192.168.1.1';
    case 'ip-list': return 'e.g. 192.168.1.1, 192.168.1.2';
    case 'text': return 'Value';
    case 'text-list': return 'e.g. domain1.com, domain2.com';
    case 'number': return '0';
    default: return '';
  }
}
