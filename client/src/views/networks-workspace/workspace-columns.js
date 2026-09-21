import { IP_TABLE_VIEW, ipTableColumns } from '../../utils/ipTableColumns.js';

const BASIC = {
  networks: [
    ['name', 'Network'],
    ['cidr', 'CIDR'],
    ['folder', 'Folder'],
    ['vlan', 'VLAN'],
    ['domain', 'Domain'],
    ['gateway', 'Gateway'],
    ['utilization', 'Utilization'],
    ['status', 'State'],
  ],
  dnsZones: [
    ['name', 'Zone'],
    ['zoneType', 'Type'],
    ['records', 'Records'],
    ['networks', 'Network scope'],
    ['description', 'Description'],
    ['enabled', 'State'],
  ],
  dhcpScopes: [
    ['range', 'Scope'],
    ['network', 'Network'],
    ['poolSize', 'Pool size'],
    ['leaseTime', 'Lease time'],
    ['description', 'Description'],
    ['enabled', 'State'],
  ],
  ranges: [
    ['range', 'Address / range'],
    ['rangeType', 'Range type'],
    ['size', 'Size'],
    ['description', 'Description'],
    ['policy', 'Behavior'],
    ['enabled', 'State'],
  ],
};

const DEFAULTS = {
  networks: BASIC.networks.map(([key]) => key),
  addresses: [
    'ip_address',
    'hostname',
    'status',
    'type',
    'is_online',
    'mac_address',
    'last_seen_at',
  ],
  dns: ['dns_hostname', 'record_type', 'value', 'ttl', 'enabled', 'source', 'network'],
  dnsZones: BASIC.dnsZones.map(([key]) => key),
  dhcp: [
    'ip_address',
    'hostname',
    'mac_address',
    'assignment',
    'lease',
    'expires',
    'status',
    'type',
    'is_online',
  ],
  dhcpScopes: BASIC.dhcpScopes.map(([key]) => key),
  ranges: BASIC.ranges.map(([key]) => key),
};

function basicColumns(kind) {
  return (BASIC[kind] || []).map(([key, label]) => ({
    key,
    header: label,
    label,
    field: key,
    sortable: true,
  }));
}

// The IP columns each table can actually fill. The shared catalog describes
// every column any IP table has; a DNS record has no lease and a plain
// address has no enabled flag and no network but the one on screen, so
// offering those columns only produced a column of dashes.
const IP_COLUMNS = {
  addresses: [
    'ip_address',
    'hostname',
    'status',
    'type',
    'lease',
    'expires',
    'is_online',
    'mac_address',
    'vendor',
    'device',
    'os_family',
    'device_type',
    'device_confidence',
    'dhcp_fingerprint',
    'dhcp_vendor_class',
    'dhcp_fingerprint_hostname',
    'device_fingerprint_source',
    'source',
    'network_range_type',
    'last_seen_at',
    'scanning_enabled',
  ],
  dhcp: [
    'ip_address',
    'hostname',
    'status',
    'type',
    'lease',
    'expires',
    'assignment',
    'is_online',
    'mac_address',
    'vendor',
    'duid',
    'iaid',
    'device',
    'os_family',
    'device_type',
    'device_confidence',
    'dhcp_fingerprint',
    'dhcp_vendor_class',
    'dhcp_fingerprint_hostname',
    'device_fingerprint_source',
    'source',
    'network',
    'network_range_type',
    'last_seen_at',
    'enabled',
    'scanning_enabled',
  ],
  dns: [
    'dns_hostname',
    'record_type',
    'value',
    'priority',
    'port',
    'ttl',
    'enabled',
    'source',
    'is_online',
    'network',
  ],
};

export function workspaceColumnCatalog(kind) {
  if (BASIC[kind]) return basicColumns(kind);
  const view =
    kind === 'dhcp'
      ? IP_TABLE_VIEW.DHCP
      : kind === 'dns'
        ? IP_TABLE_VIEW.DNS_FORWARD
        : IP_TABLE_VIEW.NETWORKS;
  const offered = new Set(IP_COLUMNS[kind] || IP_COLUMNS.addresses);
  const columns = ipTableColumns(view)
    .filter((column) => offered.has(column.key))
    .map((column) => ({ ...column, label: column.header }));
  // Assignment is the one column the shared catalog does not know: reserved
  // or dynamic, with the pool membership beside it.
  if (kind === 'dhcp') {
    columns.push({
      key: 'assignment',
      header: 'Assignment',
      label: 'Assignment',
      field: 'dhcp_assignment_type',
      sortable: true,
    });
  }
  return columns;
}

export function defaultWorkspaceColumnKeys(kind) {
  return [...(DEFAULTS[kind] || [])];
}

export function restoreWorkspaceColumnKeys(kind, stored) {
  const valid = new Set(workspaceColumnCatalog(kind).map((column) => column.key));
  const restored = Array.isArray(stored) ? stored.filter((key) => valid.has(key)) : [];
  if (!restored.length) return defaultWorkspaceColumnKeys(kind).filter((key) => valid.has(key));
  const identity =
    kind === 'networks'
      ? 'name'
      : kind === 'ranges'
        ? 'range'
        : kind.endsWith('Scopes')
          ? 'range'
          : kind === 'dnsZones'
            ? 'name'
            : kind === 'dns'
              ? 'dns_hostname'
              : 'ip_address';
  if (!restored.includes(identity) && valid.has(identity)) restored.unshift(identity);
  return [...new Set(restored)];
}
