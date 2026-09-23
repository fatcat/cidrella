import { IP_TABLE_VIEW, ipTableColumns } from '../../utils/ipTableColumns.js';
import { allocationSourceLabel, recordSourceLabel } from '../../utils/ipTableDisplay.js';

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
  dns: [
    'dns_hostname',
    'record_type',
    'value',
    'ttl',
    'record_enabled',
    'record_source',
    'network',
  ],
  dnsZones: BASIC.dnsZones.map(([key]) => key),
  dhcp: [
    'ip_address',
    'hostname',
    'mac_address',
    'assignment',
    'lease',
    'expires',
    'type',
    'status',
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

// Addresses, DNS and DHCP are one table model: each can show any column any
// of them has, and a column means the same thing on every one. What keeps the
// tables apart is LOCKED, the columns each cannot hide (they still reorder).
const IP_KINDS = new Set(['addresses', 'dns', 'dhcp']);

export const LOCKED = Object.freeze({
  addresses: ['ip_address', 'hostname', 'status'],
  dns: ['dns_hostname', 'record_type', 'value'],
  dhcp: ['ip_address', 'hostname', 'mac_address', 'assignment', 'lease', 'expires', 'type'],
});

// The shared catalog's `enabled` and `source` each meant two things depending
// on the table. Here each meaning is its own column.
const WORKSPACE_COLUMNS = [
  {
    key: 'record_enabled',
    header: 'Record Enabled',
    description: 'Whether the DNS record naming the address is enabled.',
    field: 'enabled',
  },
  {
    key: 'record_source',
    header: 'Record Source',
    description: 'What wrote the DNS record: manual, DHCP, a reservation, or a placeholder.',
    field: 'dns_source',
  },
  {
    key: 'assignment',
    header: 'Assignment',
    description: 'DHCP Reservation or dynamic lease, with pool membership beside it.',
    field: 'dhcp_assignment_type',
  },
  {
    key: 'reservation_enabled',
    header: 'Reservation Enabled',
    description: 'Whether the DHCP Reservation for the address is enabled.',
    field: 'reservation_enabled',
  },
];

// Keys a stored preference may still hold from before the split, per table.
const RENAMED = {
  dns: { enabled: 'record_enabled', source: 'record_source' },
  dhcp: { enabled: 'reservation_enabled' },
  addresses: {},
};

function ipColumnCatalog() {
  const shared = ipTableColumns(IP_TABLE_VIEW.NETWORKS)
    .filter((column) => column.key !== 'enabled')
    .map((column) =>
      column.key === 'dns_hostname'
        ? { ...column, header: 'DNS Name', field: 'record_fqdn', sortField: 'record_fqdn' }
        : column,
    );
  const extra = WORKSPACE_COLUMNS.map((column) => ({
    ...column,
    sortField: column.field,
    sortable: true,
  }));
  return [...shared, ...extra].map((column) => ({ ...column, label: column.header }));
}

export function workspaceColumnCatalog(kind) {
  if (BASIC[kind]) return basicColumns(kind);
  const locked = new Set(LOCKED[IP_KINDS.has(kind) ? kind : 'addresses']);
  return ipColumnCatalog().map((column) => ({ ...column, locked: locked.has(column.key) }));
}

export function defaultWorkspaceColumnKeys(kind) {
  return [...(DEFAULTS[kind] || [])];
}

export function lockedWorkspaceColumnKeys(kind) {
  return [...(LOCKED[kind] || [])];
}

export function restoreWorkspaceColumnKeys(kind, stored) {
  const valid = new Set(workspaceColumnCatalog(kind).map((column) => column.key));
  const renamed = RENAMED[kind] || {};
  const restored = Array.isArray(stored)
    ? stored.map((key) => renamed[key] || key).filter((key) => valid.has(key))
    : [];
  if (!restored.length) return defaultWorkspaceColumnKeys(kind).filter((key) => valid.has(key));
  // A preference saved before a column was locked lacks it; locked columns
  // lead, in their own order, ahead of what was stored.
  const missingLocked = lockedWorkspaceColumnKeys(kind).filter((key) => !restored.includes(key));
  restored.unshift(...missingLocked);
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

// How a filter value reads in the Filter menu and on its chip: the words the
// cell uses for it, so "false" in Online reads Offline.
const BOOLEAN_LABELS = {
  is_online: ['Online', 'Offline'],
  scanning_enabled: ['On', 'Off'],
  record_enabled: ['Enabled', 'Disabled'],
  reservation_enabled: ['Enabled', 'Disabled'],
  enabled: ['Enabled', 'Disabled'],
};
const VALUE_LABELS = {
  assignment: { reserved: 'Reserved', dynamic: 'Dynamic' },
  lease: { active: 'Active', expired: 'Expired' },
};

export function filterValueLabel(key, value) {
  if (value === null || value === '') return 'None';
  if (typeof value === 'boolean') {
    const [on, off] = BOOLEAN_LABELS[key] || ['Yes', 'No'];
    return value ? on : off;
  }
  if (key === 'source') {
    return value === 'dns_hold'
      ? allocationSourceLabel({ allocation_state: 'reserved', allocation_source_type: 'dns' })
      : allocationSourceLabel({ allocation_source_type: value });
  }
  if (key === 'record_source') return recordSourceLabel({ dns_source: value });
  return VALUE_LABELS[key]?.[value] || String(value);
}
