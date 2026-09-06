export const IP_TABLE_VIEW = Object.freeze({
  NETWORKS: 'networks',
  DHCP: 'dhcp',
  DNS_FORWARD: 'dns-forward',
  DNS_REVERSE: 'dns-reverse'
});

const COLUMN_CATALOG = [
  {
    key: 'ip_address', header: 'IP Address', description: 'Canonical IP address associated with the row.', field: 'ip_address', style: 'width: 10rem',
    sortFields: { [IP_TABLE_VIEW.DNS_REVERSE]: '_ip_long' }
  },
  { key: 'status', header: 'Status', description: 'Server-owned IP availability status.', field: 'ip_display_status', style: 'width: 7rem' },
  { key: 'type', header: 'Type', description: 'Server-owned IP allocation type.', field: 'computed_type', style: 'width: 9.5rem' },
  { key: 'hostname', header: 'Hostname', description: 'Best known canonical hostname for the IP.', field: 'hostname', style: 'width: 10rem' },
  {
    key: 'dns_hostname', header: 'DNS Hostname', description: 'DNS record owner or PTR hostname.', field: 'name', style: 'width: 16rem',
    fields: { [IP_TABLE_VIEW.DNS_REVERSE]: 'value' },
    headers: { [IP_TABLE_VIEW.DNS_FORWARD]: 'Hostname', [IP_TABLE_VIEW.DNS_REVERSE]: 'Hostname' }
  },
  { key: 'record_name', header: 'Record Name', description: 'DNS record owner name within its zone.', field: 'name', style: 'width: 14rem', headers: { [IP_TABLE_VIEW.DNS_REVERSE]: 'Name' } },
  { key: 'record_type', header: 'Record Type', description: 'DNS resource record type.', field: 'record_type', style: 'width: 7rem' },
  { key: 'value', header: 'Value', description: 'DNS record target value.', field: 'value', style: 'width: 14rem' },
  { key: 'priority', header: 'Priority', description: 'Priority used by MX and SRV records.', field: 'priority', style: 'width: 5rem' },
  { key: 'port', header: 'Port', description: 'Service port used by SRV records.', field: 'port', style: 'width: 4rem' },
  { key: 'ttl', header: 'TTL', description: 'DNS record time-to-live or the zone default.', field: 'ttl', style: 'width: 6rem' },
  { key: 'enabled', header: 'Enabled', description: 'Whether the owning DNS or DHCP row is enabled.', field: 'enabled', style: 'width: 6rem' },
  {
    key: 'source', header: 'Source', description: 'Protocol, topology, or observation source associated with the IP.', field: 'allocation_source_type', style: 'width: 9rem',
    fields: { [IP_TABLE_VIEW.DNS_FORWARD]: 'dns_source', [IP_TABLE_VIEW.DNS_REVERSE]: 'dns_source' }
  },
  { key: 'mac_address', header: 'MAC Address', description: 'Best known hardware address for the IP.', field: 'mac_address', style: 'width: 10rem' },
  { key: 'vendor', header: 'Vendor', description: 'Hardware vendor inferred from the MAC address OUI.', field: 'vendor', style: 'width: 10rem' },
  { key: 'device', header: 'Device', description: 'Device type or OS family inferred from DHCP fingerprint data.', field: 'os_family', style: 'width: 9rem' },
  { key: 'is_online', header: 'Online', description: 'Current liveness state.', field: 'is_online', style: 'width: 5rem' },
  { key: 'last_seen_at', header: 'Last Seen', description: 'Most recent time CIDRella observed the IP.', field: 'last_seen_at', style: 'width: 10rem' },
  { key: 'scanning_enabled', header: 'Scanning', description: 'Server-resolved effective scanning status for the IP.', field: 'scanning_enabled', style: 'width: 7rem' },
  { key: 'lease', header: 'Lease', description: 'DHCP lease availability or activity state.', field: 'lease_status', style: 'width: 7rem' },
  { key: 'network', header: 'Network', description: 'Network containing the IP.', field: 'subnet_name', sortFields: { [IP_TABLE_VIEW.DHCP]: 'network' }, style: 'width: 10rem' },
  {
    key: 'expires', header: 'Expires', description: 'Active DHCP lease expiration time.', field: 'dhcp_expires_at', style: 'width: 9rem',
    fields: { [IP_TABLE_VIEW.DHCP]: 'expires_at' }
  }
];

export const IP_TABLE_DEFAULT_KEYS = Object.freeze({
  [IP_TABLE_VIEW.NETWORKS]: [
    'ip_address', 'status', 'type', 'hostname', 'mac_address', 'vendor',
    'device', 'is_online', 'last_seen_at', 'expires'
  ],
  [IP_TABLE_VIEW.DHCP]: [
    'ip_address', 'is_online', 'lease', 'type', 'hostname', 'mac_address',
    'vendor', 'network', 'expires'
  ],
  [IP_TABLE_VIEW.DNS_FORWARD]: [
    'dns_hostname', 'record_type', 'value', 'priority', 'port', 'ttl',
    'enabled', 'source', 'is_online'
  ],
  [IP_TABLE_VIEW.DNS_REVERSE]: [
    'dns_hostname', 'ip_address', 'record_name', 'record_type', 'ttl',
    'enabled', 'source'
  ]
});

export const IP_TABLE_COLUMN_ALIASES = Object.freeze({
  [IP_TABLE_VIEW.NETWORKS]: { dhcp_expires_at: 'expires' },
  [IP_TABLE_VIEW.DHCP]: { expires_at: 'expires' },
  [IP_TABLE_VIEW.DNS_FORWARD]: { hostname: 'dns_hostname', online: 'is_online' },
  [IP_TABLE_VIEW.DNS_REVERSE]: { ptr_hostname: 'dns_hostname', name: 'record_name' }
});

export function ipTableColumns(view) {
  return COLUMN_CATALOG.map(column => ({
    ...column,
    header: column.headers?.[view] || column.header,
    field: column.fields?.[view] || column.field,
    sortField: column.sortFields?.[view] || column.fields?.[view] || column.field,
    sortable: true
  }));
}
