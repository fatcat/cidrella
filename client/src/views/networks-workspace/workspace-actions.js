import api from '../../api/client.js';
import { mergeNetworks } from '../../utils/ip.js';

// The workspace action registry (plan section 5, W-05). Every menu, quick
// action and keyboard invocation resolves to one of these entries by ID and
// hands the handler an immutable target. Labels are display text only; nothing
// dispatches on them.
//
// A target is `{ kind, ...facts }`. Kinds:
//   workspace         no resource selected; the create menu, explorer footer
//   folder            an explorer folder row or the folder context
//   network           a network row or the selected network
//   network-selection checked network rows; the selection bar
//   address           an address row inside a network
//   address-selection checked address rows; the selection bar
//   dns-zone          a zone row in an aggregate DNS inventory
//   dns-record        a record row
//   dhcp-scope        a scope row in an aggregate DHCP inventory
//   dhcp-address      a scope-member row (lease, reservation or free pool slot)
//   range             a range row
//
// Order here is menu order. When an action serves several kinds, its position
// has to satisfy each kind's menu at once.
const ACTION_DEFINITIONS = [
  // Read/navigation
  {
    id: 'network.open',
    label: 'Open network context',
    targetKind: 'network',
  },
  {
    id: 'dns.zone.open',
    label: 'Open zone',
    targetKind: 'dns-zone',
  },
  {
    id: 'dhcp.scope.open',
    label: 'Open scope',
    targetKind: 'dhcp-scope',
  },
  {
    id: 'network.open-dhcp',
    label: 'Open network DHCP',
    targetKind: 'dhcp-scope',
    available: (target) => target.subnet_id != null,
    disabledReason: 'This scope is not attached to a network.',
  },
  {
    id: 'dns.zones.switch-side',
    label: 'Switch forward / reverse',
    note: 'Browse the other side of DNS',
    icon: 'pi pi-replay',
    targetKind: 'workspace',
    menus: ['actions'],
    views: ['dns'],
  },

  // Networks and folders
  {
    id: 'network.allocate',
    label: 'Create network',
    note: 'Add address space to IPAM; allocate it once it is configured',
    icon: 'pi pi-sitemap',
    capability: 'subnets:write',
    targetKind: ['workspace', 'folder'],
    menus: ['create', 'actions', 'row'],
    views: ['networks'],
  },
  {
    id: 'folder.create',
    label: 'Create folder',
    note: 'Organize related networks',
    icon: 'pi pi-folder-plus',
    capability: 'subnets:write',
    targetKind: 'workspace',
    menus: ['create'],
  },
  {
    id: 'folder.manage',
    label: 'Manage folders',
    capability: 'subnets:write',
    targetKind: 'workspace',
    menus: [],
  },
  // Ungrouped is the server's bucket for networks without a folder (id null),
  // not a folder that can be renamed or deleted.
  {
    id: 'folder.edit',
    label: 'Rename folder',
    note: 'Name and description',
    icon: 'pi pi-pencil',
    capability: 'subnets:write',
    targetKind: 'folder',
    available: (target) => target.id != null,
    disabledReason: 'Ungrouped is not a folder.',
    menus: ['actions', 'row'],
    views: ['networks'],
  },
  {
    id: 'folder.delete',
    label: 'Delete folder',
    note: 'Networks stay, as Ungrouped',
    icon: 'pi pi-trash',
    capability: 'subnets:write',
    targetKind: 'folder',
    available: (target) => target.id != null,
    disabledReason: 'Ungrouped is not a folder.',
    danger: true,
    menus: ['actions', 'row'],
    views: ['networks'],
  },
  {
    id: 'workspace.defaults',
    label: 'Network defaults',
    capability: 'subnets:write',
    targetKind: 'workspace',
    menus: [],
  },
  {
    id: 'network.edit',
    // An unallocated network is allocated through the same form.
    label: (target) => (target.status === 'unallocated' ? 'Allocate network' : 'Edit network'),
    note: 'Name, gateway, VLAN, domain, and scanning',
    icon: 'pi pi-pencil',
    capability: 'subnets:write',
    targetKind: 'network',
    menus: ['actions', 'row'],
    views: ['networks', 'addresses', 'ranges'],
  },
  {
    id: 'network.scan',
    label: 'Scan network',
    placement: 'last',
    separatorBefore: true,
    capability: 'subnets:write',
    targetKind: 'network',
    menus: ['row'],
    available: (target) => target.status === 'allocated',
    disabledReason: 'Only allocated networks are scanned.',
  },
  // Divide and merge reshape address space, so they only apply to networks
  // that are not allocated. An allocated network is deallocated first, which
  // drops its hosts from DNS and removes its DHCP scopes.
  {
    id: 'network.divide',
    label: 'Divide network',
    note: 'Preview child networks and dependencies',
    icon: 'pi pi-share-alt',
    capability: 'subnets:write',
    targetKind: 'network',
    menus: ['actions', 'row'],
    views: ['networks', 'addresses', 'ranges'],
    available: (target) => target.status === 'unallocated' && !hasChildren(target),
    disabledReason: (target) =>
      hasChildren(target)
        ? 'This network is already divided.'
        : 'Deallocate the network first. Only unallocated networks can be divided.',
  },
  {
    id: 'network.merge',
    label: 'Merge',
    note: 'Merge the selected sibling networks',
    icon: 'pi pi-sitemap',
    capability: 'subnets:write',
    targetKind: 'network-selection',
    available: (target) => mergeBlocker(target) === '',
    disabledReason: (target) => mergeBlocker(target),
    menus: ['selection'],
  },
  {
    id: 'network.move',
    label: 'Move to folder',
    note: 'Change organization without changing CIDR',
    icon: 'pi pi-folder',
    capability: 'subnets:write',
    targetKind: 'network',
    menus: ['actions', 'row'],
    views: ['networks', 'addresses', 'ranges'],
  },
  {
    id: 'network.apply-defaults',
    label: 'Apply defaults',
    note: 'Review template-managed settings',
    icon: 'pi pi-sync',
    capability: 'subnets:write',
    targetKind: ['network', 'network-selection'],
    available: (target) => target.kind === 'network' || target.count > 0,
    disabledReason: 'Select at least one network.',
    menus: ['actions', 'row', 'selection'],
    views: ['networks', 'addresses', 'ranges'],
  },
  {
    id: 'network.deallocate',
    label: 'Deallocate network',
    note: 'Return this block to its parent',
    icon: 'pi pi-undo',
    danger: true,
    capability: 'subnets:write',
    targetKind: 'network',
    menus: ['actions', 'row'],
    views: ['networks', 'addresses', 'ranges'],
    available: (target) => target.status === 'allocated',
    disabledReason: 'This network is not allocated.',
  },
  {
    id: 'network.delete',
    label: 'Delete network',
    note: 'Remove this network and its dependencies',
    icon: 'pi pi-trash',
    danger: true,
    capability: 'subnets:write',
    targetKind: 'network',
    menus: ['actions', 'row'],
    views: ['networks', 'addresses', 'ranges'],
  },
  {
    id: 'network.gateway.edit',
    label: 'Edit Gateway',
    capability: 'subnets:write',
    targetKind: 'address',
    available: (target) => target.type === 'gateway',
    disabledReason: 'Only the gateway address has gateway settings.',
  },
  {
    id: 'network.gateway.delete',
    label: 'Delete Gateway',
    capability: 'subnets:write',
    targetKind: 'address',
    available: (target) => target.type === 'gateway',
    disabledReason: 'Only the gateway address has gateway settings.',
  },

  // DNS
  {
    id: 'dns.zone.create',
    label: 'Add DNS zone',
    note: 'Forward or reverse authority',
    icon: 'pi pi-globe',
    capability: 'dns:write',
    targetKind: 'workspace',
    menus: ['create', 'actions'],
    views: ['dns'],
  },
  {
    id: 'dns.zone.edit',
    label: (target) => (target.kind === 'workspace' ? 'Edit selected zone' : 'Edit zone'),
    note: 'Authority, SOA, description, and state',
    icon: 'pi pi-pencil',
    capability: 'dns:write',
    targetKind: ['dns-zone', 'dns-record', 'workspace'],
    menus: ['actions', 'row'],
    views: ['dns'],
    available: (target) =>
      target.kind === 'dns-zone' ||
      (target.kind === 'dns-record' && target.zone_id != null) ||
      target.zone != null,
    disabledReason: 'Open a zone first.',
  },
  {
    id: 'dns.record.create',
    label: 'Add DNS record',
    capability: 'dns:write',
    targetKind: ['dns-zone', 'workspace'],
    available: (target) => target.kind === 'dns-zone' || target.zone != null,
    disabledReason: 'Open a zone first. A record needs a zone to be saved into.',
  },
  {
    id: 'dns.record.edit',
    label: 'Edit record',
    capability: 'dns:write',
    targetKind: 'dns-record',
  },
  {
    id: 'dns.record.create-cname',
    label: 'Add CNAME',
    capability: 'dns:write',
    targetKind: 'dns-record',
  },
  {
    id: 'dns.record.delete',
    label: 'Delete record',
    danger: true,
    capability: 'dns:write',
    targetKind: 'dns-record',
  },
  {
    id: 'dns.zone.delete',
    label: (target) => (target.kind === 'workspace' ? 'Delete selected zone' : 'Delete zone'),
    note: 'Review dependent records first',
    icon: 'pi pi-trash',
    danger: true,
    capability: 'dns:write',
    targetKind: ['dns-zone', 'workspace'],
    menus: ['actions', 'row'],
    views: ['dns'],
    available: (target) => target.kind === 'dns-zone' || target.zone != null,
    disabledReason: 'Open a zone first.',
  },
  // Apply and sync act on the whole appliance, not the open context (D-06,
  // H-06). The banner shows durable apply status separately (O-01).
  {
    id: 'dns.apply',
    label: 'Apply DNS configuration',
    note: 'Publishes DNS for the whole appliance',
    icon: 'pi pi-sync',
    capability: 'dns:write',
    targetKind: 'workspace',
    menus: ['actions'],
    views: ['dns'],
  },
  {
    id: 'dns.settings',
    label: 'Appliance-wide DNS settings',
    note: 'Forwarders, encryption, DNSSEC, and SOA defaults',
    icon: 'pi pi-cog',
    capability: 'dns:read',
    targetKind: 'workspace',
    menus: ['actions'],
    views: ['dns'],
  },

  // DHCP scopes
  {
    id: 'dhcp.scope.create',
    label: 'Add DHCP scope',
    note: 'Create a dynamic address pool',
    icon: 'pi pi-server',
    capability: 'dhcp:write',
    targetKind: 'workspace',
    menus: ['create', 'actions'],
    views: ['dhcp'],
  },
  {
    id: 'dhcp.scope.create-here',
    label: 'Create DHCP Scope',
    capability: 'dhcp:write',
    targetKind: ['address', 'range'],
    available: (target) => (target.kind === 'range' ? !target.isScope : target.type === 'gateway'),
    disabledReason: 'This range already backs a DHCP scope.',
  },
  {
    id: 'dhcp.scope.edit',
    label: (target) => (target.kind === 'workspace' ? 'Edit selected scope' : 'Edit Scope'),
    note: 'Pool, lease policy, options, and state',
    icon: 'pi pi-pencil',
    capability: 'dhcp:write',
    targetKind: ['dhcp-scope', 'dhcp-address', 'address', 'range', 'workspace'],
    menus: ['actions', 'row'],
    views: ['dhcp'],
    available: (target) =>
      target.kind === 'dhcp-scope' ||
      (target.kind === 'dhcp-address' && target.scope_id != null) ||
      (target.kind === 'address' && target.status === 'DHCP Scope') ||
      (target.kind === 'range' && target.isScope) ||
      (target.kind === 'workspace' && target.scope != null),
    disabledReason: 'This resource is not part of a DHCP scope.',
  },
  {
    id: 'dhcp.scope.remove-members',
    label: (target) =>
      target.kind === 'address' ? 'Remove this IP from Scope' : 'Remove addresses from Scope',
    capability: 'dhcp:write',
    targetKind: ['address', 'range'],
    available: (target) =>
      target.kind === 'address' ? target.status === 'DHCP Scope' : target.isScope,
    disabledReason: 'This resource is not part of a DHCP scope.',
  },
  {
    id: 'dhcp.leases.sync',
    label: 'Sync leases now',
    note: 'Refresh dnsmasq lease state',
    icon: 'pi pi-sync',
    capability: 'dhcp:write',
    targetKind: ['dhcp-scope', 'workspace'],
    menus: ['actions', 'row'],
    views: ['dhcp'],
  },
  {
    id: 'dhcp.reservation.create',
    label: (target) =>
      ['address', 'dhcp-address'].includes(target.kind)
        ? 'Create DHCP Reservation'
        : 'Add DHCP Reservation',
    note: 'Bind a client to an address',
    icon: 'pi pi-bookmark',
    capability: 'dhcp:write',
    targetKind: ['workspace', 'dhcp-scope', 'dhcp-address', 'address'],
    menus: ['create', 'row'],
    available: (target) => {
      if (target.kind === 'dhcp-address') return !target.reserved;
      if (target.kind === 'address')
        return target.type === 'dynamic DHCP' || target.status === 'DHCP Scope';
      return true;
    },
    disabledReason: 'Only a DHCP scope member without a reservation can be reserved.',
  },
  {
    id: 'dhcp.reservation.edit',
    label: 'Edit DHCP Reservation',
    capability: 'dhcp:write',
    targetKind: 'dhcp-address',
    available: (target) => target.reserved,
    disabledReason: 'This address has no DHCP Reservation.',
  },
  {
    id: 'dhcp.reservation.delete',
    label: 'Delete DHCP Reservation',
    danger: true,
    capability: 'dhcp:write',
    targetKind: 'dhcp-address',
    available: (target) => target.reserved,
    disabledReason: 'This address has no DHCP Reservation.',
  },
  {
    id: 'dhcp.scope.delete',
    label: (target) => (target.kind === 'workspace' ? 'Delete selected scope' : 'Delete Scope'),
    note: 'Keep the underlying range',
    icon: 'pi pi-trash',
    danger: true,
    capability: 'dhcp:write',
    targetKind: ['dhcp-scope', 'address', 'range', 'workspace'],
    menus: ['actions', 'row'],
    views: ['dhcp'],
    available: (target) =>
      target.kind === 'dhcp-scope' ||
      (target.kind === 'address' && target.status === 'DHCP Scope') ||
      (target.kind === 'range' && target.isScope) ||
      (target.kind === 'workspace' && target.scope != null),
    disabledReason: 'This resource is not part of a DHCP scope.',
  },
  {
    id: 'dhcp.apply',
    label: 'Apply DHCP configuration',
    note: 'Publishes DHCP for the whole appliance',
    icon: 'pi pi-sync',
    capability: 'dhcp:write',
    targetKind: 'workspace',
    menus: ['actions'],
    views: ['dhcp'],
  },
  {
    id: 'dhcp.settings',
    label: 'Appliance-wide DHCP settings',
    note: 'Defaults, options, and rogue detection',
    icon: 'pi pi-cog',
    capability: 'dhcp:read',
    targetKind: 'workspace',
    menus: ['actions'],
    views: ['dhcp'],
  },

  // Addresses
  {
    id: 'ip.release',
    label: 'Release IP Reservation',
    capability: 'subnets:write',
    targetKind: 'address',
    // A reserved row owned by dns is held by a disabled record (ADR 004); the
    // record, not this action, releases it.
    available: (target) =>
      target.allocation_state === 'reserved' && target.allocation_source_type !== 'dns',
    disabledReason:
      'Only an IP Reservation can be released here. An address held by a disabled DNS record is freed by deleting the record.',
  },
  {
    id: 'ip.reserve',
    label: 'Create IP Reservation',
    capability: 'subnets:write',
    targetKind: 'address',
    available: (target) => target.allocation_state === 'unassigned',
    disabledReason: 'Only an unassigned address can become an IP Reservation.',
  },
  {
    id: 'ip.reserve-new',
    label: 'Create IP Reservation',
    capability: 'subnets:write',
    targetKind: 'network',
    menus: [],
  },
  {
    id: 'ip.bulk-reserve',
    label: 'Reserve',
    note: 'Create IP Reservations',
    capability: 'subnets:write',
    targetKind: 'address-selection',
    menus: ['selection'],
    available: (target) =>
      target.count > 0 &&
      target.allocationStates?.length === target.count &&
      target.allocationStates.every((state) => state === 'unassigned'),
    disabledReason: 'Select only unassigned addresses to create IP Reservations.',
  },
  {
    id: 'ip.bulk-release',
    label: 'Release',
    note: 'Release IP Reservations',
    capability: 'subnets:write',
    targetKind: 'address-selection',
    menus: ['selection'],
    available: (target) =>
      target.count > 0 &&
      target.allocationStates?.length === target.count &&
      target.allocationStates.every((state) => state === 'reserved'),
    disabledReason: 'Select only IP Reservations to release them.',
  },
  {
    id: 'ip.bulk-range-type',
    label: 'Set range type',
    capability: 'subnets:write',
    targetKind: 'address-selection',
    menus: ['selection'],
    available: (target) => target.count > 0,
    disabledReason: 'Select at least one address.',
  },
  {
    id: 'ip.range-type',
    label: 'Set Range Type',
    capability: 'subnets:write',
    targetKind: 'address',
  },
  // Liveness scan, as the current interface's context menu has it: one toggle
  // for the effective state, plus Reset to Inherit while an override is set.
  {
    id: 'ip.scan-toggle',
    label: (target) =>
      target.raw?.scanning_enabled === true || target.raw?.scanning_enabled === 1
        ? 'Disable liveness scan'
        : 'Enable liveness scan',
    capability: 'subnets:write',
    targetKind: 'address',
  },
  {
    id: 'ip.scan-inherit',
    label: 'Reset to Inherit',
    capability: 'subnets:write',
    targetKind: 'address',
    available: (target) => target.raw?.scan_enabled != null,
    disabledReason: 'This address inherits the network scan setting.',
  },
  // Probe sits last in the menu, under the one separator (operator's rule).
  {
    id: 'ip.probe',
    label: 'Probe now',
    capability: 'subnets:write',
    targetKind: ['address', 'dhcp-address'],
    available: (target) => target.kind === 'address' || target.address != null,
    disabledReason: 'This row has no address to probe.',
    placement: 'last',
    separatorBefore: true,
  },

  // Ranges
  {
    id: 'range.create',
    label: 'Add Network Range Type range',
    capability: 'subnets:write',
    targetKind: 'network',
    menus: [],
  },
  {
    id: 'range.edit',
    label: 'Edit range',
    capability: 'subnets:write',
    targetKind: 'range',
    available: (target) => !target.isScope,
    disabledReason: 'DHCP scope ranges are edited through the scope.',
  },
  {
    id: 'range.delete',
    label: 'Delete range',
    danger: true,
    capability: 'subnets:write',
    targetKind: 'range',
    available: (target) => !target.isScope,
    disabledReason: 'DHCP scope ranges are deleted through the scope.',
  },
];

// One global order cannot serve every menu: the address row menu shows DHCP
// scope entries before the reservation entries, and the header Actions menu
// leads with the edit action. Overrides by row kind and by view fix the few
// places where registry order is wrong. Unlisted actions sort last.
const ACTIONS_MENU_ORDER = {
  dns: [
    'dns.zone.edit',
    'dns.zones.switch-side',
    'dns.zone.create',
    'dns.apply',
    'dns.settings',
    'dns.zone.delete',
  ],
  dhcp: [
    'dhcp.scope.edit',
    'dhcp.leases.sync',
    'dhcp.scope.create',
    'dhcp.apply',
    'dhcp.settings',
    'dhcp.scope.delete',
  ],
};
const ROW_MENU_ORDER = {
  network: [
    'network.open',
    'network.edit',
    'network.divide',
    'network.move',
    'network.apply-defaults',
    'network.deallocate',
    'network.delete',
    'network.scan',
  ],
  'dns-record': [
    'dns.record.edit',
    'dns.record.create-cname',
    'dns.record.delete',
    'dns.zone.edit',
  ],
  address: [
    'network.gateway.edit',
    'network.gateway.delete',
    'dhcp.scope.create-here',
    'dhcp.scope.edit',
    'dhcp.scope.remove-members',
    'dhcp.scope.delete',
    'ip.release',
    'ip.reserve',
    'dhcp.reservation.create',
    'ip.range-type',
    'ip.scan-toggle',
    'ip.scan-inherit',
    'ip.probe',
  ],
  'dhcp-address': [
    'dhcp.scope.edit',
    'dhcp.reservation.edit',
    'dhcp.reservation.create',
    'ip.probe',
    'dhcp.reservation.delete',
  ],
  'dhcp-scope': [
    'dhcp.scope.open',
    'network.open-dhcp',
    'dhcp.scope.edit',
    'dhcp.reservation.create',
    'dhcp.leases.sync',
    'dhcp.scope.delete',
  ],
  range: [
    'dhcp.scope.edit',
    'dhcp.scope.remove-members',
    'dhcp.scope.delete',
    'range.edit',
    'dhcp.scope.create-here',
    'range.delete',
  ],
};

// The selection bar keeps its own order: the range tag first, then the
// allocation pair; merge before the template re-apply.
const SELECTION_MENU_ORDER = {
  'address-selection': ['ip.bulk-range-type', 'ip.bulk-reserve', 'ip.bulk-release'],
  'network-selection': ['network.merge', 'network.apply-defaults'],
};

const asList = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);

function hasChildren(target) {
  return Boolean(target.raw?.children?.length || target.raw?.child_count);
}

// Why a checked set of networks cannot be merged, or '' when it can. The
// server applies the same rules; saying them here keeps the Merge button
// honest instead of letting the preview fail.
function mergeBlocker(target) {
  const networks = target.networks || [];
  if (target.count < 2 || networks.length < 2)
    return 'Select at least two sibling networks to merge.';
  if (networks.some((network) => network.status === 'allocated'))
    return 'Deallocate the allocated networks first. Only unallocated networks can be merged.';
  if (networks.some((network) => network.hasChildren))
    return 'A divided network cannot be merged. Merge its children first.';
  const parents = new Set(networks.map((network) => network.parent_id ?? null));
  if (parents.has(null)) return 'Root networks cannot be merged.';
  if (parents.size > 1) return 'Only networks under the same parent can be merged.';
  // Either family; a mixed selection is refused by the shared check.
  let check;
  try {
    check = mergeNetworks(networks.map((network) => network.cidr));
  } catch (error) {
    return `${error.message}.`;
  }
  return check.valid ? '' : `${check.error}.`;
}

export const WORKSPACE_ACTIONS = Object.freeze(
  Object.fromEntries(
    ACTION_DEFINITIONS.map((definition) => [
      definition.id,
      Object.freeze({
        capability: null,
        available: () => true,
        disabledReason: '',
        note: '',
        icon: 'pi pi-angle-right',
        danger: false,
        menus: ['row'],
        views: null,
        placement: null,
        separatorBefore: false,
        ...definition,
        targetKinds: asList(definition.targetKind),
      }),
    ]),
  ),
);

export function actionLabel(actionId, target = {}) {
  const action = WORKSPACE_ACTIONS[actionId];
  if (!action) return '';
  return typeof action.label === 'function' ? action.label(target) : action.label;
}

export function actionAvailability(actionId, target, can = () => false) {
  const action = WORKSPACE_ACTIONS[actionId];
  if (!action) return { available: false, reason: 'Unknown action.' };
  if (!target || !action.targetKinds.includes(target.kind)) {
    return { available: false, reason: 'This action is not available for this resource.' };
  }
  if (action.capability && !can(action.capability)) {
    return { available: false, reason: `Requires ${action.capability}.` };
  }
  if (!action.available(target)) {
    return {
      available: false,
      reason:
        typeof action.disabledReason === 'function'
          ? action.disabledReason(target)
          : action.disabledReason,
    };
  }
  return { available: true, reason: '' };
}

// Builds a target from a workspace table row. Row IDs carry their kind as a
// prefix (`network:`, `address:`, `zone:`, `dns:`, `scope:`, `dhcp:`, `range:`),
// which is more reliable than the view name once zone and scope drill-ins put
// record rows into aggregate contexts.
// Drag payload type for a network moved onto a folder (N-08). Shared with the
// current interface so both surfaces read each other's drags.
export const NETWORK_DRAG_TYPE = 'application/x-subnet-id';

export function targetForRow(row) {
  if (!row?.id) return null;
  const kind = String(row.id).split(':')[0];
  const raw = row.raw || {};
  switch (kind) {
    case 'network':
      return { kind: 'network', id: raw.id, status: raw.status, raw };
    case 'address':
      return {
        kind: 'address',
        id: row.id,
        address: row.address,
        allocation_state: raw.allocation_state,
        allocation_source_type: raw.allocation_source_type,
        type: row.type,
        status: row.status,
        raw,
      };
    case 'zone':
      return { kind: 'dns-zone', id: raw.id, raw };
    case 'dns':
      return { kind: 'dns-record', id: raw.id, zone_id: raw.zone_id, address: row.value, raw };
    case 'scope':
      return { kind: 'dhcp-scope', id: raw.id, subnet_id: raw.subnet_id, raw };
    case 'dhcp':
      return {
        kind: 'dhcp-address',
        id: raw.id,
        address: row.address,
        hostname: row.hostname,
        reserved: raw.dhcp_assignment_type === 'reserved',
        scope_id: raw.scope_id ?? raw.dhcp_scope_id ?? null,
        subnet_id: raw.subnet_id,
        raw,
      };
    case 'range':
      return { kind: 'range', id: raw.id, isScope: row.rangeType === 'DHCP Scope', raw };
    default:
      return null;
  }
}

// Actions a menu should offer for a target: registry order, filtered to the
// menu, the active view when the entry names one, the target kind, the
// caller's capabilities, and the entry's own predicate. Unavailable entries
// are left out rather than shown disabled; the reason is still reachable
// through actionAvailability for panels that want to explain it.
// Menus hide what the target cannot do. The selection bar is the exception
// (`includeUnavailable`): a mixed selection keeps the button visible, disabled,
// with the reason as its title, so the operator learns what to deselect.
export function menuActions({
  menu,
  target,
  view = null,
  can = () => false,
  includeUnavailable = false,
}) {
  const states = new Map();
  const ids = Object.keys(WORKSPACE_ACTIONS).filter((id) => {
    const action = WORKSPACE_ACTIONS[id];
    if (!action.menus.includes(menu)) return false;
    // `views` scopes the header Actions menu to a view. Row menus follow the
    // row's kind instead, so a scope entry still shows on an address or range
    // row, and the create menu offers every resource from every view.
    if (menu === 'actions' && action.views && view && !action.views.includes(view)) return false;
    if (!target || !action.targetKinds.includes(target.kind)) return false;
    if (action.capability && !can(action.capability)) return false;
    const state = actionAvailability(id, target, can);
    states.set(id, state);
    return state.available || includeUnavailable;
  });
  const order =
    menu === 'row'
      ? ROW_MENU_ORDER[target?.kind]
      : menu === 'actions'
        ? ACTIONS_MENU_ORDER[view]
        : menu === 'selection'
          ? SELECTION_MENU_ORDER[target?.kind]
          : null;
  if (order) ids.sort((a, b) => orderIndex(order, a) - orderIndex(order, b));
  // `placement: 'last'` entries (scan, probe) close the menu whatever the order says.
  const lastIds = ids.filter((id) => WORKSPACE_ACTIONS[id].placement === 'last');
  const ordered = [...ids.filter((id) => !lastIds.includes(id)), ...lastIds];
  return ordered.map((id) => {
    const action = WORKSPACE_ACTIONS[id];
    return {
      id,
      label: actionLabel(id, target),
      note: action.note,
      icon: action.icon,
      danger: action.danger,
      separatorBefore: action.separatorBefore,
      available: states.get(id).available,
      reason: states.get(id).reason,
    };
  });
}

function orderIndex(order, id) {
  const index = order.indexOf(id);
  return index < 0 ? order.length : index;
}

export function createWorkspaceActionRegistry({ can, handlers = {} }) {
  function availability(actionId, target) {
    return actionAvailability(actionId, target, can);
  }

  async function invoke(actionId, target) {
    const action = WORKSPACE_ACTIONS[actionId];
    const state = availability(actionId, target);
    if (!state.available) return { invoked: false, reason: state.reason };
    const handler = handlers[actionId];
    if (typeof handler !== 'function') {
      return { invoked: false, reason: 'This action is not implemented yet.' };
    }
    const immutableTarget = Object.freeze({ ...target });
    return { invoked: true, result: await handler(immutableTarget, action) };
  }

  return { actions: WORKSPACE_ACTIONS, availability, invoke };
}

export function allocationPayload(allocationState, note = '') {
  if (!['reserved', 'unassigned'].includes(allocationState)) {
    throw new TypeError('Bulk allocation state must be reserved or unassigned.');
  }
  if (allocationState === 'reserved') {
    const cleanNote = note.trim();
    if (!cleanNote) throw new TypeError('An IP Reservation note is required.');
    return { allocation_state: 'reserved', note: cleanNote };
  }
  return { allocation_state: 'unassigned' };
}

export async function executeBulkAllocation({ subnetId, runs, allocationState, note, put }) {
  const send = put || api.put.bind(api);
  const allocation = allocationPayload(allocationState, note);
  const ledger = {
    completed: [],
    remaining: runs.map((run) => ({ ...run })),
    updated: 0,
    skipped: 0,
    error: null,
  };

  for (const run of runs) {
    const payload = { start_ip: run.start_ip, end_ip: run.end_ip, ...allocation };
    try {
      const response = await send(`/subnets/${subnetId}/ips/bulk-allocation`, payload);
      const result = response?.data || {};
      ledger.completed.push({ run: { ...run }, payload, result });
      ledger.remaining.shift();
      ledger.updated += Number(result.updated ?? result.count ?? 0);
      ledger.skipped += Number(result.skipped ?? 0);
    } catch (error) {
      ledger.error = error;
      break;
    }
  }
  return ledger;
}
