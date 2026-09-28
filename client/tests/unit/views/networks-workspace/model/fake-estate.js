// An in-memory estate that answers the Networks workspace's reads the way the
// server filters them (models/workspace-view.js and the subnet routes), so a
// model test can say which rows the visible state should show and compare.
//
// The data is small and deliberately awkward: two folders plus Ungrouped, a
// /23 with two reverse zones, a divided unallocated /24, a reverse zone a
// deallocated network left disabled, an enabled standalone reverse zone, a
// generated record, a disabled one, and three DHCP scopes.

const net = (id, cidr, fields = {}) => {
  const [address, prefix] = cidr.split('/');
  return {
    id,
    cidr,
    name: fields.name ?? cidr,
    status: 'allocated',
    parent_id: null,
    folder_id: null,
    network_address: address,
    prefix_length: Number(prefix),
    total_addresses: 2 ** (32 - Number(prefix)),
    used_count: 0,
    gateway_address: null,
    domain_name: null,
    vlan_id: null,
    children: [],
    ...fields,
  };
};

export const FOLDERS = [
  { id: 1, name: 'Home', description: '' },
  { id: 2, name: 'Lab', description: '' },
];

export const NETWORKS = [
  net(11, '10.0.0.0/23', { name: 'Trust Network', folder_id: 1, domain_name: 'home.example' }),
  net(12, '10.0.8.0/24', { name: 'IOT', folder_id: 1, domain_name: 'home.example' }),
  net(13, '172.16.0.0/24', { name: 'Lab net', folder_id: 2, domain_name: 'lab.example' }),
  net(14, '1.1.2.0/24', { name: 'Loose net' }),
  net(20, '192.168.0.0/24', { name: null, status: 'unallocated', folder_id: 2 }),
  net(21, '192.168.0.0/25', { name: null, status: 'unallocated', folder_id: 2, parent_id: 20 }),
  net(22, '192.168.0.128/25', { name: null, status: 'unallocated', folder_id: 2, parent_id: 20 }),
  net(15, '1.1.1.0/24', { name: null, status: 'unallocated' }),
];

const zone = (id, name, type, related, fields = {}) => ({
  id,
  name,
  type,
  enabled: 1,
  folder_id: null,
  soa_minimum_ttl: 3600,
  related,
  ...fields,
});

export const ZONES = [
  zone(101, 'home.example', 'forward', [11, 12]),
  zone(102, 'lab.example', 'forward', [13]),
  zone(201, '0.0.10.in-addr.arpa', 'reverse', [11]),
  zone(202, '1.0.10.in-addr.arpa', 'reverse', [11]),
  zone(203, '8.0.10.in-addr.arpa', 'reverse', [12]),
  zone(204, '0.16.172.in-addr.arpa', 'reverse', [13]),
  zone(205, '2.1.1.in-addr.arpa', 'reverse', [14]),
  // Left behind when 1.1.1.0/24 was deallocated: disabled, used by nothing.
  zone(206, '1.1.1.in-addr.arpa', 'reverse', [], { enabled: 0 }),
  // Kept for address space outside IPAM: enabled, used by nothing.
  zone(207, '99.51.198.in-addr.arpa', 'reverse', []),
];

const record = (id, zoneId, name, type, value, fields = {}) => ({
  id,
  zone_id: zoneId,
  name,
  record_type: type,
  value,
  ttl: 3600,
  dns_source: 'manual',
  enabled: 1,
  ...fields,
});

export const RECORDS = [
  record(1001, 101, 'trust-a', 'A', '10.0.0.10'),
  record(1002, 101, 'trust-b', 'A', '10.0.1.20'),
  record(1003, 101, 'iot-cam', 'A', '10.0.8.5'),
  record(1004, 101, 'www', 'CNAME', 'trust-a.home.example', { ip_address: '10.0.0.10' }),
  record(1005, 101, 'laptop', 'A', '10.0.1.50', { dns_source: 'dhcp' }),
  record(1006, 102, 'lab-a', 'A', '172.16.0.10'),
  record(1007, 102, 'lab-b', 'A', '172.16.0.11', { enabled: 0 }),
  record(1008, 201, '10', 'PTR', 'trust-a.home.example', { dns_source: 'dns', ip: '10.0.0.10' }),
  record(1009, 202, '20', 'PTR', 'trust-b.home.example', { dns_source: 'dns', ip: '10.0.1.20' }),
  record(1010, 202, '50', 'PTR', 'laptop.home.example', { dns_source: 'dhcp', ip: '10.0.1.50' }),
  record(1011, 203, '5', 'PTR', 'iot-cam.home.example', { dns_source: 'dns', ip: '10.0.8.5' }),
  record(1012, 204, '10', 'PTR', 'lab-a.lab.example', { dns_source: 'dns', ip: '172.16.0.10' }),
  record(1013, 205, '1', 'PTR', '1.1.2.1', { dns_source: 'placeholder', ip: '1.1.2.1' }),
  record(1014, 207, '7', 'PTR', 'ext.outside.example', { ip: '198.51.99.7' }),
];

export const SCOPES = [
  { id: 301, subnet_id: 11, start_ip: '10.0.1.100', end_ip: '10.0.1.200', enabled: 1 },
  { id: 302, subnet_id: 12, start_ip: '10.0.8.100', end_ip: '10.0.8.150', enabled: 1 },
  { id: 303, subnet_id: 13, start_ip: '172.16.0.50', end_ip: '172.16.0.99', enabled: 0 },
];

export const DHCP_ROWS = [
  { id: 401, ip_address: '10.0.1.150', hostname: 'laptop', type: 'dynamic', scope_id: 301 },
  { id: 402, ip_address: '10.0.1.110', hostname: 'printer', type: 'reserved', scope_id: 301 },
  { id: 403, ip_address: '10.0.8.120', hostname: 'thermostat', type: 'dynamic', scope_id: 302 },
  { id: 404, ip_address: '172.16.0.60', hostname: 'bench', type: 'reserved', scope_id: 303 },
];

// ─── Address arithmetic ───────────────────────────────────────────────

export const ipToNumber = (ip) =>
  ip.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
const numberToIp = (value) =>
  [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');

export function networkOf(ip) {
  if (!ip || ip.includes(':')) return null;
  const value = ipToNumber(ip);
  return (
    NETWORKS.filter((network) => network.status === 'allocated')
      .filter((network) => {
        const start = ipToNumber(network.network_address);
        return value >= start && value < start + network.total_addresses;
      })
      .sort((a, b) => b.prefix_length - a.prefix_length)[0] || null
  );
}
export function scopeOf(ip) {
  const value = ipToNumber(ip);
  return (
    SCOPES.find(
      (scope) => value >= ipToNumber(scope.start_ip) && value <= ipToNumber(scope.end_ip),
    ) || null
  );
}
export const zoneById = (id) => ZONES.find((entry) => entry.id === Number(id)) || null;
export const networkById = (id) => NETWORKS.find((entry) => entry.id === Number(id)) || null;

const isLeaf = (network) => !NETWORKS.some((entry) => entry.parent_id === network.id);
export const allocatedLeaves = () =>
  NETWORKS.filter((network) => network.status === 'allocated' && isLeaf(network));
export const unallocatedLeaves = () =>
  NETWORKS.filter((network) => network.status === 'unallocated' && isLeaf(network));
const inFolder = (network, folderId) => (network.folder_id ?? null) === (folderId ?? null);

// ─── Row shapes the server returns ────────────────────────────────────

export function recordRow(entry) {
  const owner = zoneById(entry.zone_id);
  const ip = entry.ip ?? entry.ip_address ?? (entry.record_type === 'A' ? entry.value : null);
  const network = networkOf(ip);
  return {
    ...entry,
    zone_name: owner.name,
    zone_type: owner.type,
    zone_folder_id: owner.folder_id,
    zone_soa_minimum_ttl: owner.soa_minimum_ttl,
    record_fqdn:
      owner.type === 'forward' ? `${entry.name}.${owner.name}` : `${entry.name}.${owner.name}`,
    ip_address: ip,
    is_online: 0,
    related_subnet_ids: network ? [network.id] : [],
    subnet_id: network?.id ?? null,
    subnet_name: network?.name ?? null,
  };
}

export function zoneRow(entry) {
  const records = RECORDS.filter((row) => row.zone_id === entry.id);
  const related = new Set(entry.related);
  for (const row of records) for (const id of recordRow(row).related_subnet_ids) related.add(id);
  const ids = [...related].filter((id) => networkById(id)?.status === 'allocated').sort();
  const rest = { ...entry };
  delete rest.related;
  return {
    ...rest,
    record_count: records.length,
    related_subnet_ids: ids,
    related_networks: ids.map((id) => {
      const { cidr, name } = networkById(id);
      return { id, cidr, name };
    }),
  };
}

export function dhcpRow(entry) {
  const network = networkOf(entry.ip_address);
  return {
    id: entry.id,
    ip_address: entry.ip_address,
    hostname: entry.hostname,
    mac_address: `02:00:00:00:00:${String(entry.id % 100).padStart(2, '0')}`,
    subnet_id: network.id,
    subnet_name: network.name,
    subnet_cidr: network.cidr,
    scope_id: entry.scope_id,
    dhcp_assignment_type: entry.type,
    lease_status: entry.type === 'dynamic' ? 'active' : 'offline',
    dhcp_lease_state: entry.type === 'dynamic' ? 'active' : null,
    ip_display_status: 'in use',
    address_type: entry.type === 'dynamic' ? 'dynamic DHCP' : 'DHCP Reservation',
    enabled: 1,
    is_online: 0,
  };
}

function addressRows(network) {
  const start = ipToNumber(network.network_address);
  const named = new Map(
    RECORDS.filter((row) => row.record_type === 'A' && row.enabled)
      .map(recordRow)
      .map((row) => [row.ip_address, row.record_fqdn]),
  );
  return Array.from({ length: network.total_addresses }, (_, offset) => {
    const ip = numberToIp(start + offset);
    const edge = offset === 0 || offset === network.total_addresses - 1;
    const hostname = named.get(ip) || null;
    const pooled = scopeOf(ip)?.enabled === 1 && scopeOf(ip).subnet_id === network.id;
    const state = edge ? 'system' : hostname ? 'static_dns' : 'unassigned';
    return {
      ip_address: ip,
      subnet_id: network.id,
      allocation_state: state,
      allocation_source_type: edge ? 'topology' : hostname ? 'dns' : null,
      ip_display_status: state !== 'unassigned' ? 'in use' : pooled ? 'DHCP Scope' : 'available',
      ip_status_severity: state !== 'unassigned' ? 'danger' : 'secondary',
      address_type: edge ? 'system' : hostname ? 'static DNS' : null,
      in_dynamic_pool: pooled ? 1 : 0,
      hostname,
      mac_address: null,
      is_online: 0,
      scanning_enabled: true,
      scan_enabled: null,
    };
  });
}

// ─── Query semantics ──────────────────────────────────────────────────

const text = (value) => String(value ?? '').toLowerCase();
const matchesAny = (row, fields, query) =>
  !query || fields.some((field) => text(row[field]).includes(text(query).trim()));

// GET /workspace/dns-records, as getWorkspaceDnsRecords filters it.
// folder_id=ungrouped is the networks in no folder (folder null).
const folderParam = (value) =>
  value === 'ungrouped' ? null : value != null ? Number(value) : undefined;

export function queryDnsRecords(params = {}) {
  let rows = RECORDS.map(recordRow);
  const subnetId = params.subnet_id != null ? Number(params.subnet_id) : null;
  const folderId = folderParam(params.folder_id);
  if (subnetId != null) rows = rows.filter((row) => row.related_subnet_ids.includes(subnetId));
  if (folderId !== undefined) {
    const folderNets = new Set(
      allocatedLeaves()
        .filter((network) => network.folder_id === folderId)
        .map((network) => network.id),
    );
    rows = rows.filter(
      (row) =>
        (folderId !== null && row.zone_folder_id === folderId) ||
        row.related_subnet_ids.some((id) => folderNets.has(id)),
    );
  }
  if (params.zone_id != null) rows = rows.filter((row) => row.zone_id === Number(params.zone_id));
  if (params.zone_type) rows = rows.filter((row) => row.zone_type === params.zone_type);
  if (params.ip_address) rows = rows.filter((row) => row.ip_address === params.ip_address);
  const fields = ['record_fqdn', 'name', 'value', 'record_type', 'dns_source', 'zone_name'];
  rows = rows.filter((row) => matchesAny(row, [...fields, 'ip_address'], params.q));
  rows = rows.filter((row) => matchesAny(row, [...fields, 'ip_address'], params.table_q));
  return rows;
}

// GET /dns/zones.
export function queryZones(params = {}) {
  let rows = ZONES.map(zoneRow);
  if (params.folder_id != null) {
    const folderId = folderParam(params.folder_id);
    const folderNets = new Set(
      allocatedLeaves()
        .filter((network) => network.folder_id === folderId)
        .map((network) => network.id),
    );
    rows = rows.filter(
      (row) =>
        (folderId !== null && row.folder_id === folderId) ||
        row.related_subnet_ids.some((id) => folderNets.has(id)),
    );
  }
  if (params.q) {
    const records = queryDnsRecords({ q: params.q });
    rows = rows.filter(
      (row) =>
        matchesAny(row, ['name'], params.q) || records.some((entry) => entry.zone_id === row.id),
    );
  }
  return rows;
}

// GET /workspace/dhcp-addresses.
export function queryDhcpRows(params = {}) {
  let rows = DHCP_ROWS.map(dhcpRow);
  if (params.subnet_id != null)
    rows = rows.filter((row) => row.subnet_id === Number(params.subnet_id));
  if (params.folder_id != null)
    rows = rows.filter(
      (row) => networkById(row.subnet_id).folder_id === folderParam(params.folder_id),
    );
  if (params.scope_id != null)
    rows = rows.filter((row) => row.scope_id === Number(params.scope_id));
  if (params.ip_address) rows = rows.filter((row) => row.ip_address === params.ip_address);
  const fields = ['ip_address', 'hostname', 'mac_address', 'subnet_name'];
  rows = rows.filter((row) => matchesAny(row, fields, params.q));
  rows = rows.filter((row) => matchesAny(row, fields, params.table_q));
  return rows;
}

// GET /dhcp/scopes, as scopeMatches filters it: the network's name, CIDR or
// domain, the pool, or a member's address, hostname or MAC.
export function queryScopes(params = {}) {
  const members = DHCP_ROWS.map(dhcpRow);
  return SCOPES.map((scope) => {
    const network = networkById(scope.subnet_id);
    return {
      ...scope,
      subnet_name: network.name,
      subnet_cidr: network.cidr,
      subnet_domain_name: network.domain_name,
      lease_time: 43200,
      pools: [{ start_ip: scope.start_ip, end_ip: scope.end_ip }],
    };
  })
    .filter(
      (scope) =>
        params.folder_id == null ||
        networkById(scope.subnet_id).folder_id === folderParam(params.folder_id),
    )
    .filter((scope) =>
      [params.q, params.table_q].every(
        (query) =>
          !query ||
          matchesAny(
            scope,
            ['subnet_name', 'subnet_cidr', 'subnet_domain_name', 'start_ip', 'end_ip'],
            query,
          ) ||
          members.some(
            (row) =>
              row.scope_id === scope.id &&
              matchesAny(row, ['ip_address', 'hostname', 'mac_address'], query),
          ),
      ),
    );
}

// GET /workspace/networks: allocated leaves, by folder and search.
export function queryNetworks(params = {}) {
  let rows = allocatedLeaves();
  if (params.folder_id != null)
    rows = rows.filter((row) => row.folder_id === folderParam(params.folder_id));
  const fields = ['name', 'cidr', 'domain_name'];
  rows = rows.filter((row) => matchesAny(row, fields, params.q));
  rows = rows.filter((row) => matchesAny(row, fields, params.table_q));
  return rows;
}

// GET /subnets: folders of trees, allocated and not; Ungrouped has id null.
function subnetTree() {
  const node = (network) => ({
    ...network,
    folder: null,
    children: NETWORKS.filter((entry) => entry.parent_id === network.id).map(node),
  });
  const roots = NETWORKS.filter((network) => network.parent_id == null);
  return {
    folders: [
      ...FOLDERS.map((folder) => ({
        ...folder,
        subnets: roots.filter((network) => inFolder(network, folder.id)).map(node),
      })),
      { id: null, name: 'Ungrouped', subnets: roots.filter((n) => n.folder_id == null).map(node) },
    ],
  };
}

function page(rows, params, sizeKey = 'page_size') {
  const size = Number(params[sizeKey]) || 50;
  const at = Number(params.page) || 1;
  return {
    items: rows.slice((at - 1) * size, at * size),
    total: rows.length,
    page: at,
    page_size: size,
  };
}

// The api client's get(), as the workspace calls it. Anything this estate
// does not know is recorded, not thrown, so a model run reports it.
export function createFakeApi() {
  const unexpected = [];
  const reply = (data) => Promise.resolve({ data });
  function get(url, config = {}) {
    const params = config.params || {};
    if (url === '/subnets') return reply(subnetTree());
    if (url === '/folders') return reply(FOLDERS);
    if (url === '/workspace/networks') {
      const rows = queryNetworks(params);
      return reply({ items: rows, total: rows.length });
    }
    if (url === '/dns/zones') return reply(queryZones(params));
    if (url === '/workspace/dns-records') return reply(page(queryDnsRecords(params), params));
    if (url === '/dhcp/scopes') return reply(queryScopes(params));
    if (url === '/workspace/dhcp-addresses') return reply(page(queryDhcpRows(params), params));
    if (url === '/range-types' || url === '/dhcp/leases') return reply([]);
    if (url === '/settings') return reply({});
    if (url.startsWith('/metrics/')) return reply(url.endsWith('generation') ? [] : {});
    const ips = url.match(/^\/subnets\/(\d+)\/ips$/);
    if (ips) {
      const network = networkById(ips[1]);
      let rows = addressRows(network);
      if (params.showAvailable === 'false')
        rows = rows.filter((row) => row.ip_display_status !== 'available');
      const fields = ['ip_address', 'hostname', 'mac_address'];
      rows = rows.filter((row) => matchesAny(row, fields, params.search));
      rows = rows.filter((row) => matchesAny(row, fields, params.table_search));
      const size = Number(params.pageSize) || 256;
      const at = Number(params.page) || 1;
      return reply({
        subnet: network,
        ips: rows.slice((at - 1) * size, at * size),
        ranges: [],
        totalIps: network.total_addresses,
        filteredTotal: rows.length,
        page: at,
        pageSize: size,
        totalPages: Math.max(1, Math.ceil(rows.length / size)),
      });
    }
    const summary = url.match(/^\/subnets\/(\d+)\/summary$/);
    if (summary) {
      const network = networkById(summary[1]);
      return reply({
        subnet_id: network.id,
        total_addresses: network.total_addresses,
        assigned_count: 0,
        unassigned_count: network.total_addresses,
        online_count: 0,
        rogue_count: 0,
      });
    }
    if (/^\/subnets\/\d+\/ranges$/.test(url)) return reply([]);
    const one = url.match(/^\/subnets\/(\d+)\/ips\/([^/]+)$/);
    if (one) {
      const row = addressRows(networkById(one[1])).find(
        (entry) => entry.ip_address === decodeURIComponent(one[2]),
      );
      return row ? reply({ ip: row }) : Promise.reject({ response: { status: 404, data: {} } });
    }
    if (/^\/subnets\/\d+\/ips\/[^/]+\/events(\?.*)?$/.test(url)) return reply({ events: [] });
    unexpected.push(`GET ${url}`);
    return reply({});
  }
  return { get, unexpected };
}
