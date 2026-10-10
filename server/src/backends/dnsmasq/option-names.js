/**
 * How dnsmasq's dhcp-option= spells an option. DHCPv4 options are written by
 * number. DHCPv6 options use dnsmasq's `option6:` name where dnsmasq has one
 * (from `dnsmasq --help dhcp6`, 2.91) and the number otherwise: dnsmasq
 * refuses a name it does not know (`option6:captive-portal` is a "bad
 * dhcp-option"), while every number is accepted.
 */
const DNSMASQ_OPTION6_NAMES = Object.freeze({
  21: 'sip-server-domain',
  22: 'sip-server',
  23: 'dns-server',
  24: 'domain-search',
  27: 'nis-server',
  28: 'nis+-server',
  29: 'nis-domain',
  30: 'nis+-domain',
  31: 'sntp-server',
  32: 'information-refresh-time',
  41: 'posix-timezone',
  42: 'tzdb-timezone',
  56: 'ntp-server',
  59: 'bootfile-url',
  60: 'bootfile-param',
});

export function dnsmasqOptionToken(code, family) {
  if (family === 4) return String(code);
  return `option6:${DNSMASQ_OPTION6_NAMES[code] ?? code}`;
}
