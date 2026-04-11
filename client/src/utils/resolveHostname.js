/**
 * Shared DHCP hostname-resolution utilities used by DHCP.vue and ScopeDialog.vue.
 */

export const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

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
  if (!value || IP_RE.test(value.trim())) return value;
  const parts = value.split(',').map(s => s.trim()).filter(Boolean);
  const resolved = [];
  for (const part of parts) {
    if (IP_RE.test(part)) {
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
