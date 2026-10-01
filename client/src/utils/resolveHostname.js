/**
 * Shared DHCP hostname-resolution utilities used by DHCP.vue and ScopeDialog.vue.
 */

import { addressFamily, isValidAddress } from './ip.js';

/**
 * Is this entry already an address, so it needs no DNS lookup?
 *
 * This was a local IP_RE that checked shape only, with no octet range check, so
 * "300.1.1.1" was treated as an address already and passed through untouched
 * into a DHCP option value instead of being resolved or rejected. isValidIpv4
 * is the same shape test plus the 0-255 bound.
 * See REVIEW.md, duplicate-logic audit #51.
 */
// Either family, no zone id: an IPv6 literal in an option value is passed
// through the same way an IPv4 one is.
const isAddress = (v) => isValidAddress(String(v ?? '').trim());

/**
 * Resolve a comma-separated list of hostnames/IPs to IP addresses.
 * An entry that is already an address of the option's family is passed
 * through unchanged; one of the other family is left out with a warning,
 * because the config writer could only drop it (a DHCPv6 option cannot carry
 * 192.168.1.53), and an option that reads as set but is never served is
 * worse than one the operator is told about. A hostname
 * yields only the addresses of the option's family: a DHCPv4 option takes
 * IPv4 addresses and a DHCPv6 option IPv6 ones, so a name with both (like
 * 2.pool.ntp.org) never puts the other family's addresses into an option.
 * An entry that resolves to nothing of that family is kept as-is and a toast
 * warning is emitted.
 *
 * @param {string} value - Raw input value (hostname or comma-separated list)
 * @param {object} api   - Axios-compatible API client
 * @param {object} toast - PrimeVue toast instance
 * @param {number} [family=4] - address family of the option (4 or 6)
 * @returns {Promise<string>} Resolved comma-separated IP string
 */
export async function resolveHostname(value, api, toast, family = 4) {
  if (!value) return value;
  const wanted = Number(family);
  if (isAddress(value) && addressFamily(value.trim()) === wanted) return value;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const resolved = [];
  for (const part of parts) {
    if (isAddress(part)) {
      if (addressFamily(part) === wanted) {
        resolved.push(part);
      } else {
        toast.add({
          severity: 'warn',
          summary: `"${part}" is not an IPv${wanted} address, left out of this DHCPv${wanted} option`,
          life: 5000,
        });
      }
    } else {
      let ips;
      try {
        const res = await api.get(`/dns/resolve?name=${encodeURIComponent(part)}`);
        ips = res.data.ips;
      } catch {
        toast.add({ severity: 'warn', summary: `Could not resolve "${part}"`, life: 3000 });
        resolved.push(part);
        continue;
      }
      const matching = ips.filter((ip) => addressFamily(ip) === wanted);
      if (matching.length) {
        resolved.push(...matching);
      } else {
        toast.add({
          severity: 'warn',
          summary: `"${part}" has no IPv${Number(family)} address`,
          life: 4000,
        });
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
 * @param {number} [family=4] - address family the option belongs to (4 or 6)
 * @returns {string}
 */
export function placeholderForType(type, family = 4) {
  const v6 = Number(family) === 6;
  switch (type) {
    case 'ip':
      return v6 ? 'e.g. fd00::1' : 'e.g. 192.168.1.1';
    case 'ip-list':
      return v6 ? 'e.g. fd00::53, 2606:4700:4700::1111' : 'e.g. 192.168.1.1, 192.168.1.2';
    case 'text':
      return 'Value';
    case 'text-list':
      return 'e.g. domain1.com, domain2.com';
    case 'number':
      return '0';
    default:
      return '';
  }
}
