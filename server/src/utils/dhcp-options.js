/**
 * Standard DHCP options catalog.
 * Each entry defines how the option is displayed in the UI and written to dnsmasq config.
 *
 * Types:
 *   ip       — single IPv4 address
 *   ip-list  — comma-separated IPv4 addresses
 *   text     — free-form string
 *   text-list— comma-separated strings
 *   number   — integer
 *   select   — pick from choices[]
 */
export const DHCP_OPTIONS = [
  { code: 3,   name: 'router',                 label: 'Gateway / Router',           type: 'ip-list',   dnsmasqName: 'option:router' },
  { code: 6,   name: 'dns-server',             label: 'DNS Servers',                type: 'ip-list',   dnsmasqName: 'option:dns-server' },
  { code: 12,  name: 'hostname',               label: 'Hostname',                   type: 'text',      dnsmasqName: 'option:hostname' },
  { code: 15,  name: 'domain-name',            label: 'Domain Name',                type: 'text',      dnsmasqName: 'option:domain-name' },
  { code: 26,  name: 'mtu',                    label: 'Interface MTU',              type: 'number',    dnsmasqName: '26' },
  { code: 28,  name: 'broadcast',              label: 'Broadcast Address',          type: 'ip',        dnsmasqName: 'option:broadcast' },
  { code: 42,  name: 'ntp-server',             label: 'NTP Servers',                type: 'ip-list',   dnsmasqName: 'option:ntp-server' },
  { code: 44,  name: 'netbios-ns',             label: 'NetBIOS Name Server (WINS)', type: 'ip-list',   dnsmasqName: 'option:netbios-ns' },
  { code: 46,  name: 'netbios-nodetype',       label: 'NetBIOS Node Type',          type: 'select',    dnsmasqName: '46', choices: ['1', '2', '4', '8'] },
  { code: 60,  name: 'vendor-class',           label: 'Vendor Class ID',            type: 'text',      dnsmasqName: '60' },
  { code: 66,  name: 'tftp-server',            label: 'TFTP Server Name',           type: 'text',      dnsmasqName: '66' },
  { code: 67,  name: 'bootfile-name',          label: 'Bootfile Name',              type: 'text',      dnsmasqName: '67' },
  { code: 119, name: 'domain-search',          label: 'DNS Search List',            type: 'text-list', dnsmasqName: 'option:domain-search' },
  { code: 121, name: 'classless-static-route', label: 'Classless Static Routes',    type: 'text',      dnsmasqName: '121' },
  { code: 150, name: 'tftp-server-address',    label: 'TFTP Server Address (Cisco)',type: 'ip',        dnsmasqName: '150' },
  { code: 252, name: 'wpad-url',               label: 'WPAD URL',                   type: 'text',      dnsmasqName: '252' },
];

/** Lookup by option code */
export const DHCP_OPTIONS_BY_CODE = Object.fromEntries(DHCP_OPTIONS.map(o => [o.code, o]));

/** Map legacy dhcp_scopes column names to option codes */
export const LEGACY_COLUMN_MAP = {
  gateway:       3,
  dns_servers:   6,
  domain_name:   15,
  ntp_servers:   42,
  domain_search: 119,
};
