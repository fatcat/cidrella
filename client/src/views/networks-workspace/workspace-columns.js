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

export function workspaceColumnCatalog(kind) {
  if (BASIC[kind]) return basicColumns(kind);
  const view =
    kind === 'dhcp'
      ? IP_TABLE_VIEW.DHCP
      : kind === 'dns'
        ? IP_TABLE_VIEW.DNS_FORWARD
        : IP_TABLE_VIEW.NETWORKS;
  const columns = ipTableColumns(view).map((column) => ({ ...column, label: column.header }));
  const extras =
    kind === 'dhcp'
      ? [
          {
            key: 'assignment',
            header: 'Assignment',
            label: 'Assignment',
            field: 'dhcp_assignment_type',
            sortable: true,
          },
        ]
      : kind === 'dns'
        ? [
            {
              key: 'network',
              header: 'Related network',
              label: 'Related network',
              field: 'subnet_name',
              sortable: true,
            },
          ]
        : [];
  const keys = new Set(columns.map((column) => column.key));
  return [...columns, ...extras.filter((column) => !keys.has(column.key))];
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
