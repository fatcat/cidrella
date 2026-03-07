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
 *
 * Groups (display order):
 *   Common, Network, DNS, Time, Boot/PXE, NetBIOS, Ancient History
 */

export const DHCP_OPTION_GROUPS = [
  { name: 'Common',          label: 'Common' },
  { name: 'Network',         label: 'Network' },
  { name: 'DNS',             label: 'DNS' },
  { name: 'Time',            label: 'Time' },
  { name: 'Boot/PXE',        label: 'Boot / PXE' },
  { name: 'NetBIOS',         label: 'NetBIOS' },
  { name: 'Custom',          label: 'Custom' },
  { name: 'Ancient History',  label: 'Ancient History' },
];

export const DHCP_OPTIONS = [
  // ── Common ──────────────────────────────────────────────────────────
  { code: 1,   name: 'subnet-mask',            label: 'Subnet Mask',               type: 'ip',        dnsmasqName: 'option:netmask',        group: 'Common',  rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.3',  description: 'Subnet mask for the client\'s network interface.' },
  { code: 3,   name: 'router',                 label: 'Gateway / Router',           type: 'ip-list',   dnsmasqName: 'option:router',         group: 'Common',  rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.5',  description: 'Default gateway routers, listed in order of preference.' },
  { code: 6,   name: 'dns-server',             label: 'DNS Servers',                type: 'ip-list',   dnsmasqName: 'option:dns-server',     group: 'Common',  rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.8',  description: 'DNS recursive name servers available to the client.' },
  { code: 15,  name: 'domain-name',            label: 'Domain Name',                type: 'text',      dnsmasqName: 'option:domain-name',    group: 'Common',  rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.17', description: 'Domain name the client should use for DNS hostname resolution.' },
  { code: 26,  name: 'mtu',                    label: 'Interface MTU',              type: 'number',    dnsmasqName: '26',                    group: 'Common',  rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.1',  description: 'Maximum transmission unit for the interface.' },
  { code: 28,  name: 'broadcast',              label: 'Broadcast Address',          type: 'ip',        dnsmasqName: 'option:broadcast',      group: 'Common',  rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.3',  description: 'Broadcast address for the client\'s subnet.' },
  { code: 51,  name: 'lease-time',             label: 'Lease Time',                 type: 'number',    dnsmasqName: '51',                    group: 'Common',  rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-9.2',  description: 'IP address lease time in seconds.' },

  // ── Network ─────────────────────────────────────────────────────────
  { code: 2,   name: 'time-offset',            label: 'Time Offset',                type: 'number',    dnsmasqName: '2',                     group: 'Network', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.4',  description: 'UTC offset in seconds for the client\'s subnet.' },
  { code: 4,   name: 'time-server',            label: 'Time Servers (RFC 868)',      type: 'ip-list',   dnsmasqName: '4',                     group: 'Network', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.6',  description: 'RFC 868 time servers available to the client.' },
  { code: 5,   name: 'name-server',            label: 'IEN 116 Name Servers',       type: 'ip-list',   dnsmasqName: '5',                     group: 'Network', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.7',  description: 'IEN 116 name servers available to the client.' },
  { code: 21,  name: 'policy-filter',          label: 'Policy Filter',              type: 'text',      dnsmasqName: '21',                    group: 'Network', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-4.4',  description: 'Policy filters for non-local source-routed datagrams (IP/mask pairs).' },
  { code: 31,  name: 'router-discovery',       label: 'Router Discovery',           type: 'select',    dnsmasqName: '31',                    group: 'Network', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.6',  description: 'Whether the client should perform ICMP router discovery.', choices: ['0', '1'] },
  { code: 32,  name: 'router-solicitation',    label: 'Router Solicitation Address', type: 'ip',        dnsmasqName: '32',                    group: 'Network', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.7',  description: 'Address to which the client transmits router solicitation requests.' },
  { code: 33,  name: 'static-route',           label: 'Static Routes',              type: 'text',      dnsmasqName: '33',                    group: 'Network', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.8',  description: 'List of destination/router pairs the client should install. Superseded by option 121.' },
  { code: 34,  name: 'trailer-encap',          label: 'Trailer Encapsulation',      type: 'select',    dnsmasqName: '34',                    group: 'Network', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.9',  description: 'Whether the client should negotiate trailer encapsulation.', choices: ['0', '1'] },
  { code: 35,  name: 'arp-timeout',            label: 'ARP Cache Timeout',          type: 'number',    dnsmasqName: '35',                    group: 'Network', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.10', description: 'Timeout in seconds for ARP cache entries.' },
  { code: 36,  name: 'ethernet-encap',         label: 'Ethernet Encapsulation',     type: 'select',    dnsmasqName: '36',                    group: 'Network', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.11', description: 'Whether to use IEEE 802.3 (0) or Ethernet II (1) framing.', choices: ['0', '1'] },
  { code: 37,  name: 'tcp-default-ttl',        label: 'TCP Default TTL',            type: 'number',    dnsmasqName: '37',                    group: 'Network', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.12', description: 'Default TTL for TCP segments (1-255).' },
  { code: 38,  name: 'tcp-keepalive-interval', label: 'TCP Keepalive Interval',     type: 'number',    dnsmasqName: '38',                    group: 'Network', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.13', description: 'Interval in seconds between TCP keepalive messages. 0 disables.' },
  { code: 82,  name: 'relay-agent-info',       label: 'Relay Agent Information',    type: 'text',      dnsmasqName: '82',                    group: 'Network', rfc: 'RFC 3046', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc3046',             description: 'Information inserted by DHCP relay agents. Used for agent-based policies.' },
  { code: 121, name: 'classless-static-route', label: 'Classless Static Routes',    type: 'text',      dnsmasqName: '121',                   group: 'Network', rfc: 'RFC 3442', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc3442',             description: 'Classless static routes with CIDR notation. Supersedes option 33.' },

  // ── DNS ─────────────────────────────────────────────────────────────
  { code: 12,  name: 'hostname',               label: 'Hostname',                   type: 'text',      dnsmasqName: 'option:hostname',       group: 'DNS',     rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.14', description: 'Hostname for the client.' },
  { code: 40,  name: 'nis-domain',             label: 'NIS Domain Name',            type: 'text',      dnsmasqName: 'option:nis-domain',     group: 'DNS',     rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.1',  description: 'Network Information Service (NIS) domain name.' },
  { code: 41,  name: 'nis-server',             label: 'NIS Servers',                type: 'ip-list',   dnsmasqName: '41',                    group: 'DNS',     rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.2',  description: 'NIS server addresses, in order of preference.' },
  { code: 119, name: 'domain-search',          label: 'DNS Search List',            type: 'text-list', dnsmasqName: 'option:domain-search',  group: 'DNS',     rfc: 'RFC 3397', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc3397',             description: 'Domain search list for hostname resolution.' },

  // ── Time ────────────────────────────────────────────────────────────
  { code: 42,  name: 'ntp-server',             label: 'NTP Servers',                type: 'ip-list',   dnsmasqName: 'option:ntp-server',     group: 'Time',    rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.3',  description: 'NTP server addresses, in order of preference.' },

  // ── Boot/PXE ────────────────────────────────────────────────────────
  { code: 13,  name: 'boot-file-size',         label: 'Boot File Size',             type: 'number',    dnsmasqName: '13',                    group: 'Boot/PXE', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.15', description: 'Length of the default boot image in 512-octet blocks.' },
  { code: 43,  name: 'vendor-specific',        label: 'Vendor-Specific Info',       type: 'text',      dnsmasqName: '43',                    group: 'Boot/PXE', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.4',  description: 'Vendor-specific information, interpreted by vendor code on the client.' },
  { code: 60,  name: 'vendor-class',           label: 'Vendor Class ID',            type: 'text',      dnsmasqName: '60',                    group: 'Boot/PXE', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-9.13', description: 'Vendor class identifier used to distinguish vendor-type clients.' },
  { code: 66,  name: 'tftp-server',            label: 'TFTP Server Name',           type: 'text',      dnsmasqName: '66',                    group: 'Boot/PXE', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-9.4',  description: 'TFTP server hostname for network boot.' },
  { code: 67,  name: 'bootfile-name',          label: 'Bootfile Name',              type: 'text',      dnsmasqName: '67',                    group: 'Boot/PXE', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-9.5',  description: 'Name of the boot file for network boot (PXE).' },
  { code: 150, name: 'tftp-server-address',    label: 'TFTP Server Address (Cisco)',type: 'ip',        dnsmasqName: '150',                   group: 'Boot/PXE', rfc: 'RFC 5859', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc5859',             description: 'TFTP server IP address. Commonly used by Cisco IP phones.' },
  { code: 252, name: 'wpad-url',               label: 'WPAD URL',                   type: 'text',      dnsmasqName: '252',                   group: 'Boot/PXE', rfc: 'WPAD Draft', rfcUrl: 'https://datatracker.ietf.org/doc/html/draft-ietf-wrec-wpad-01', description: 'Web Proxy Auto-Discovery URL for automatic proxy configuration.' },

  // ── NetBIOS ─────────────────────────────────────────────────────────
  { code: 44,  name: 'netbios-ns',             label: 'NetBIOS Name Server (WINS)', type: 'ip-list',   dnsmasqName: 'option:netbios-ns',     group: 'NetBIOS', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.5',  description: 'NetBIOS over TCP/IP name server (WINS) addresses.' },
  { code: 45,  name: 'netbios-dd',             label: 'NetBIOS Datagram Dist',      type: 'ip-list',   dnsmasqName: '45',                    group: 'NetBIOS', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.6',  description: 'NetBIOS datagram distribution server addresses.' },
  { code: 46,  name: 'netbios-nodetype',       label: 'NetBIOS Node Type',          type: 'select',    dnsmasqName: '46',                    group: 'NetBIOS', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.7',  description: 'NetBIOS node type: 1=B-node, 2=P-node, 4=M-node, 8=H-node.', choices: ['1', '2', '4', '8'] },
  { code: 47,  name: 'netbios-scope',          label: 'NetBIOS Scope',              type: 'text',      dnsmasqName: '47',                    group: 'NetBIOS', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.8',  description: 'NetBIOS over TCP/IP scope parameter.' },

  // ── Ancient History ─────────────────────────────────────────────────
  { code: 7,   name: 'log-server',             label: 'Log Server',                 type: 'ip-list',   dnsmasqName: '7',   group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.9',  description: 'MIT-LCS UDP log server addresses.' },
  { code: 8,   name: 'cookie-server',          label: 'Cookie Server',              type: 'ip-list',   dnsmasqName: '8',   group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.10', description: 'RFC 865 cookie/quote-of-the-day server addresses.' },
  { code: 9,   name: 'lpr-server',             label: 'LPR Server',                 type: 'ip-list',   dnsmasqName: '9',   group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.11', description: 'Line printer (LPR) server addresses.' },
  { code: 10,  name: 'impress-server',         label: 'Impress Server',             type: 'ip-list',   dnsmasqName: '10',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.12', description: 'Imagen Impress network image server addresses.' },
  { code: 11,  name: 'rlp-server',             label: 'Resource Location Server',   type: 'ip-list',   dnsmasqName: '11',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.13', description: 'RFC 887 Resource Location Protocol server addresses.' },
  { code: 14,  name: 'merit-dump-file',        label: 'Merit Dump File',            type: 'text',      dnsmasqName: '14',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.16', description: 'Path name for a file to dump core image on crash.' },
  { code: 16,  name: 'swap-server',            label: 'Swap Server',                type: 'ip',        dnsmasqName: '16',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.18', description: 'IP address of the client\'s swap server.' },
  { code: 17,  name: 'root-path',              label: 'Root Path',                  type: 'text',      dnsmasqName: '17',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.19', description: 'Path name for the client\'s root disk.' },
  { code: 18,  name: 'extensions-path',        label: 'Extensions Path',            type: 'text',      dnsmasqName: '18',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-3.20', description: 'Path to a file with additional DHCP-like vendor extensions.' },
  { code: 19,  name: 'ip-forwarding',          label: 'IP Forwarding',              type: 'select',    dnsmasqName: '19',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-4.1',  description: 'Enable (1) or disable (0) IP packet forwarding on the client.', choices: ['0', '1'] },
  { code: 20,  name: 'non-local-source-route', label: 'Non-Local Source Routing',   type: 'select',    dnsmasqName: '20',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-4.2',  description: 'Enable (1) or disable (0) forwarding of non-local source-routed datagrams.', choices: ['0', '1'] },
  { code: 22,  name: 'max-dgram-reassembly',   label: 'Max Datagram Reassembly',    type: 'number',    dnsmasqName: '22',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-4.5',  description: 'Maximum datagram size the client should reassemble (min 576).' },
  { code: 23,  name: 'default-ip-ttl',         label: 'Default IP TTL',             type: 'number',    dnsmasqName: '23',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-4.6',  description: 'Default time-to-live for outgoing IP datagrams (1-255).' },
  { code: 24,  name: 'mtu-aging-timeout',      label: 'Path MTU Aging Timeout',     type: 'number',    dnsmasqName: '24',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-4.7',  description: 'Timeout in seconds for aging Path MTU values discovered by RFC 1191.' },
  { code: 25,  name: 'mtu-plateau-table',      label: 'Path MTU Plateau Table',     type: 'text',      dnsmasqName: '25',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-4.8',  description: 'Table of MTU sizes for Path MTU Discovery, sorted smallest to largest.' },
  { code: 27,  name: 'all-subnets-local',      label: 'All Subnets Local',          type: 'select',    dnsmasqName: '27',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.2',  description: 'Whether all subnets use the same MTU as the local subnet.', choices: ['0', '1'] },
  { code: 29,  name: 'mask-discovery',         label: 'Mask Discovery',             type: 'select',    dnsmasqName: '29',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.4',  description: 'Whether to perform ICMP subnet mask discovery.', choices: ['0', '1'] },
  { code: 30,  name: 'mask-supplier',          label: 'Mask Supplier',              type: 'select',    dnsmasqName: '30',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.5',  description: 'Whether to respond to ICMP subnet mask requests.', choices: ['0', '1'] },
  { code: 39,  name: 'tcp-keepalive-garbage',  label: 'TCP Keepalive Garbage',      type: 'select',    dnsmasqName: '39',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-5.14', description: 'Whether to send an octet of garbage in TCP keepalive messages for compatibility.', choices: ['0', '1'] },
  { code: 48,  name: 'x-window-font',          label: 'X Window Font Server',       type: 'ip-list',   dnsmasqName: '48',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.9',  description: 'X Window System font server addresses.' },
  { code: 49,  name: 'x-window-manager',       label: 'X Window Display Manager',   type: 'ip-list',   dnsmasqName: '49',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.10', description: 'X Window System Display Manager addresses.' },
  { code: 62,  name: 'netware-ip-domain',      label: 'NetWare/IP Domain',          type: 'text',      dnsmasqName: '62',  group: 'Ancient History', rfc: 'RFC 2242', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2242',             description: 'NetWare/IP domain name.' },
  { code: 63,  name: 'netware-ip-option',      label: 'NetWare/IP Information',     type: 'text',      dnsmasqName: '63',  group: 'Ancient History', rfc: 'RFC 2242', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2242',             description: 'NetWare/IP sub-options for configuring the NetWare/IP client.' },
  { code: 64,  name: 'nisplus-domain',         label: 'NIS+ Domain',                type: 'text',      dnsmasqName: '64',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.11', description: 'NIS+ domain name for the client.' },
  { code: 65,  name: 'nisplus-server',         label: 'NIS+ Servers',               type: 'ip-list',   dnsmasqName: '65',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.12', description: 'NIS+ server addresses, in order of preference.' },
  { code: 68,  name: 'mobile-ip-home-agent',   label: 'Mobile IP Home Agent',       type: 'ip-list',   dnsmasqName: '68',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.13', description: 'Mobile IP home agent addresses.' },
  { code: 69,  name: 'smtp-server',            label: 'SMTP Server',                type: 'ip-list',   dnsmasqName: '69',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.14', description: 'SMTP mail server addresses.' },
  { code: 70,  name: 'pop3-server',            label: 'POP3 Server',                type: 'ip-list',   dnsmasqName: '70',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.15', description: 'POP3 mail server addresses.' },
  { code: 71,  name: 'nntp-server',            label: 'NNTP Server',                type: 'ip-list',   dnsmasqName: '71',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.16', description: 'Network News (NNTP/Usenet) server addresses.' },
  { code: 72,  name: 'www-server',             label: 'WWW Server',                 type: 'ip-list',   dnsmasqName: '72',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.17', description: 'Default World Wide Web server addresses.' },
  { code: 73,  name: 'finger-server',          label: 'Finger Server',              type: 'ip-list',   dnsmasqName: '73',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.18', description: 'Finger protocol server addresses.' },
  { code: 74,  name: 'irc-server',             label: 'IRC Server',                 type: 'ip-list',   dnsmasqName: '74',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.19', description: 'Internet Relay Chat (IRC) server addresses.' },
  { code: 75,  name: 'streettalk-server',      label: 'StreetTalk Server',          type: 'ip-list',   dnsmasqName: '75',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.20', description: 'Banyan StreetTalk server addresses.' },
  { code: 76,  name: 'streettalk-da',          label: 'StreetTalk DA Server',       type: 'ip-list',   dnsmasqName: '76',  group: 'Ancient History', rfc: 'RFC 2132', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc2132#section-8.21', description: 'Banyan StreetTalk Directory Assistance server addresses.' },
  { code: 77,  name: 'user-class',             label: 'User Class',                 type: 'text',      dnsmasqName: '77',  group: 'Ancient History', rfc: 'RFC 3004', rfcUrl: 'https://datatracker.ietf.org/doc/html/rfc3004',             description: 'User class identifier for selecting configuration parameters.' },
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
