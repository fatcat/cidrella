import {
  displayExpiry,
  displayMacAddress,
  displayOnlineStatus,
  EMPTY_CELL,
  formatNumber,
  isOnlineFlag,
} from '../utils/format.js';
import { ipToLong } from '../utils/ip.js';

function humanize(value) {
  if (!value) return EMPTY_CELL;
  return String(value)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\b(Dhcp|Dns|Slaac|Arp)\b/g, (match) => match.toUpperCase());
}

export function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return EMPTY_CELL;
  if (value < 60) return `${value} sec`;
  if (value < 3600) return `${Math.round(value / 60)} min`;
  if (value < 86400) return `${Math.round(value / 3600)} hr`;
  return `${Math.round(value / 86400)} days`;
}

export function formatTimestamp(value) {
  if (!value) return EMPTY_CELL;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return String(value);
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)} days ago`;
  return new Date(timestamp).toLocaleString();
}

function networkUtilization(network) {
  const total = Number(network.total_addresses) || 0;
  const used = Number(network.used_count) || 0;
  return total ? Math.min(100, Math.round((used / total) * 100)) : 0;
}

function collectAllocatedNetworks(nodes, folder, output) {
  for (const network of nodes || []) {
    if (network.status === 'allocated') {
      const used = networkUtilization(network);
      output.push({
        ...network,
        folder: folder.name,
        folderId: folder.id,
        vlan: network.vlan_id ?? network.vlan ?? null,
        domain: network.domain_name || null,
        gateway: network.gateway_address || null,
        used,
        state: used >= 85 ? 'warning' : 'healthy',
      });
    }
    collectAllocatedNetworks(network.children, folder, output);
  }
}

export function buildExplorerFolders(folders) {
  return (folders || [])
    .map((folder) => {
      const networks = [];
      collectAllocatedNetworks(folder.subnets, folder, networks);
      return { id: folder.id, name: folder.name, networks };
    })
    .filter((folder) => folder.networks.length > 0);
}

export function mapNetworkRows(networks) {
  return (networks || []).map((network) => ({
    id: `network:${network.id}`,
    name: network.name,
    cidr: network.cidr,
    folder: network.folder,
    vlan: network.vlan != null ? `VLAN ${network.vlan}` : null,
    domain: network.domain,
    gateway: network.gateway,
    utilization: `${network.used}%`,
    status: humanize(network.status),
    raw: network,
  }));
}

export function mapDnsZoneRows(zones, networkLabels = new Map()) {
  return (zones || []).map((zone) => ({
    id: `zone:${zone.id}`,
    name: zone.name,
    zoneType: humanize(zone.type),
    records: formatNumber(zone.record_count || 0),
    networks: networkLabels.get(Number(zone.id)) || 'Unlinked',
    description: zone.description || null,
    enabled: zone.enabled === true || zone.enabled === 1 || zone.enabled === '1',
    raw: zone,
  }));
}

export function mapDhcpScopeRows(scopes) {
  return (scopes || []).map((scope) => ({
    id: `scope:${scope.id}`,
    range: scope.start_ip === scope.end_ip ? scope.start_ip : `${scope.start_ip} – ${scope.end_ip}`,
    network: scope.subnet_name || scope.subnet_cidr || null,
    poolSize: `${formatNumber(sumScopeAddresses([scope]))} addresses`,
    leaseTime: formatDuration(scope.effective?.lease_time || scope.lease_time),
    description: scope.description || null,
    enabled: scope.enabled === true || scope.enabled === 1 || scope.enabled === '1',
    raw: scope,
  }));
}

function onlineValue(row, { unknownWhenUnaddressed = false } = {}) {
  if (unknownWhenUnaddressed && !row.ip_address) return 'unknown';
  const status = displayOnlineStatus(row.is_online);
  if (!status.known) return 'unknown';
  return status.label.toLowerCase();
}

export function mapAddressRows(rows) {
  return (rows || []).map((row) => ({
    id: `address:${row.ip_address}`,
    address: row.ip_address,
    hostname: row.hostname || null,
    status: row.ip_display_status,
    type: row.address_type || null,
    online: onlineValue(row),
    mac: displayMacAddress(row.mac_address || row.last_seen_mac),
    source: row.allocation_source_type
      ? humanize(row.allocation_source_type)
      : row.detection_source
        ? humanize(row.detection_source)
        : null,
    lastSeen: formatTimestamp(row.last_seen_at),
    scanning: row.scanning_enabled
      ? row.scan_enabled == null
        ? 'On · inherited'
        : 'On'
      : row.scan_enabled == null
        ? 'Off · inherited'
        : 'Off',
    raw: row,
  }));
}

export function mapDnsRows(zoneRecords) {
  return (zoneRecords || []).flatMap(({ zone, records }) =>
    (records || []).map((record) => ({
      id: `dns:${zone.id}:${record.id}`,
      name: record.name || '@',
      recordType: record.record_type,
      value: record.value,
      ttl: formatDuration(record.ttl),
      source: humanize(record.dns_source),
      enabled: record.enabled === true || record.enabled === 1 || record.enabled === '1',
      online: onlineValue(record, { unknownWhenUnaddressed: true }),
      zone: zone.name,
      zoneType: zone.type,
      raw: record,
    })),
  );
}

export function mapDhcpRows(rows) {
  return (rows || []).map((row) => ({
    id: `dhcp:${row.dhcp_assignment_type || 'pool'}:${row.id}:${row.ip_address}`,
    address: row.ip_address,
    hostname: row.hostname || null,
    mac: displayMacAddress(row.mac_address),
    assignment: row.dhcp_assignment_type ? humanize(row.dhcp_assignment_type) : null,
    leaseStatus: row.lease_status,
    expires: displayExpiry(row.expires_at, formatTimestamp, {
      reserved: row.dhcp_assignment_type === 'reserved' && !row.expires_at,
    }),
    online: onlineValue(row),
    source:
      row.dhcp_assignment_type === 'reserved'
        ? 'DHCP Reservation'
        : row.dhcp_assignment_type === 'dynamic'
          ? 'DHCP Lease'
          : 'Dynamic pool',
    network: row.subnet_name || row.subnet_cidr || null,
    type: row.address_type || null,
    raw: row,
  }));
}

function rangeSize(startIp, endIp) {
  try {
    const size = ipToLong(endIp) - ipToLong(startIp) + 1;
    return `${formatNumber(size)} ${size === 1 ? 'address' : 'addresses'}`;
  } catch {
    return EMPTY_CELL;
  }
}

export function mapRangeRows(rows, scopes = []) {
  const scopesByRange = new Map((scopes || []).map((scope) => [Number(scope.range_id), scope]));
  return (rows || []).map((row) => {
    const scope = scopesByRange.get(Number(row.id));
    const start = row.start_ip;
    const end = row.end_ip;
    return {
      id: `range:${row.id}`,
      range: start === end ? start : `${start} – ${end}`,
      rangeType: row.range_type_name,
      size: rangeSize(start, end),
      description: row.description || null,
      policy: scope
        ? `${formatDuration(scope.effective?.lease_time || scope.lease_time)} lease`
        : row.range_type_is_system
          ? 'Topology'
          : 'Organizational tag',
      enabled: scope ? Boolean(scope.enabled) : true,
      color: row.range_type_color || null,
      raw: row,
    };
  });
}

export function sumScopeAddresses(scopes) {
  return (scopes || []).reduce(
    (total, scope) =>
      total +
      (scope.pools || [{ start_ip: scope.start_ip, end_ip: scope.end_ip }]).reduce(
        (poolTotal, pool) => {
          try {
            return poolTotal + (ipToLong(pool.end_ip) - ipToLong(pool.start_ip)) + 1;
          } catch {
            return poolTotal;
          }
        },
        0,
      ),
    0,
  );
}

export function gridKind(row) {
  const type = row?.type;
  if (type === 'system') return 'system';
  if (type === 'gateway') return 'gateway';
  if (type === 'rogue') return 'rogue';
  if (type === 'static DNS') return 'dns';
  if (type === 'IP Reservation') return 'reserved';
  if (type === 'dynamic DHCP' || type === 'DHCP Reservation') return 'dhcp-active';
  if (row?.status === 'DHCP Scope') return 'dhcp';
  return 'available';
}

export function isAttentionRow(row) {
  return row?.type === 'rogue' || row?.leaseStatus === 'unavailable' || row?.online === 'offline';
}

export function isConfiguredRow(row) {
  return row?.status !== 'available' && row?.leaseStatus !== 'available';
}

export function countOnline(rows) {
  return (rows || []).filter((row) => isOnlineFlag(row.raw?.is_online) === true).length;
}
