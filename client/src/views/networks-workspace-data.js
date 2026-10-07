import {
  countOf,
  displayExpiry,
  displayMacAddress,
  displayOnlineStatus,
  EMPTY_CELL,
  formatNumber,
  isOnlineFlag,
} from '../utils/format.js';
import { addressToBig, sortKey } from '../utils/ip.js';
import { leaseSeconds } from '@shared/lease-time.js';
import { allocationSourceLabel, recordSourceLabel } from '../utils/ipTableDisplay.js';

// A server boolean, which arrives as true, 1 or '1' depending on the route.
function flag(value) {
  return isOnlineFlag(value) === true;
}

function humanize(value) {
  if (!value) return EMPTY_CELL;
  return String(value)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\b(Dhcp|Dns|Slaac|Arp)\b/g, (match) => match.toUpperCase());
}

// Seconds, or a stored lease time as the scopes API returns it ("900s",
// "12h", "7d", "infinite"), read with the server's own parser.
export function formatDuration(seconds) {
  if (seconds == null || seconds === '') return EMPTY_CELL;
  const value = leaseSeconds(seconds);
  if (value === Infinity) return 'Infinite';
  if (Number.isNaN(value)) return EMPTY_CELL;
  if (value < 60) return `${value} sec`;
  if (value < 3600) return `${Math.round(value / 60)} min`;
  if (value < 86400) return `${Math.round(value / 3600)} hr`;
  const days = Math.round(value / 86400);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
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

// Percent of a countable network in use. Null when the server sends no total,
// which it does for a prefix larger than a JavaScript number holds (an IPv6 /64
// and wider); a small IPv6 prefix such as a /120 has a total like any IPv4 one.
export function networkUtilization(network) {
  const total = network.total_addresses == null ? null : Number(network.total_addresses);
  if (!Number.isFinite(total)) return null;
  const used = Number(network.used_count) || 0;
  return total ? Math.min(100, Math.round((used / total) * 100)) : 0;
}

/** Addresses from startIp to endIp inclusive, as a BigInt; null when unreadable. */
export function addressCount(startIp, endIp) {
  try {
    const start = addressToBig(startIp);
    const end = addressToBig(endIp);
    if (start.family !== end.family || end.value < start.value) return null;
    return end.value - start.value + 1n;
  } catch {
    return null;
  }
}

/**
 * An address count for display. Exact while it fits a JavaScript number;
 * beyond that a power of two is written as one ('2^64'), anything else in
 * full, so an IPv6 pool never reads as zero or blank.
 */
export function formatAddressCount(count) {
  if (count == null) return EMPTY_CELL;
  const big = BigInt(count);
  if (big <= BigInt(Number.MAX_SAFE_INTEGER)) return formatNumber(Number(big));
  if ((big & (big - 1n)) === 0n) return `2^${big.toString(2).length - 1}`;
  return big.toLocaleString();
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
        state: used !== null && used >= 85 ? 'warning' : 'healthy',
      });
    }
    collectAllocatedNetworks(network.children, folder, output);
  }
}

// StatusDot kind for an explorer node's state. Unallocated space shows the
// same filled dot as a healthy network; a subdivided container is muted.
const NETWORK_STATE_KIND = {
  healthy: 'ok',
  warning: 'warn',
  unallocated: 'ok',
  container: 'muted',
};
// The allocatable leaves of an unallocated tree, in tree order: the networks
// that can be allocated, without the subdivided containers above them.
export function flattenAllocatable(nodes) {
  return (nodes || []).flatMap((node) => [
    ...(node.allocatable ? [node] : []),
    ...flattenAllocatable(node.children),
  ]);
}

export function networkStateKind(state) {
  return NETWORK_STATE_KIND[state] || 'ok';
}

export function buildExplorerFolders(folders) {
  return (folders || [])
    .map((folder) => {
      const networks = [];
      collectAllocatedNetworks(folder.subnets, folder, networks);
      return { id: folder.id, name: folder.name, description: folder.description || '', networks };
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
    utilization: network.used === null ? EMPTY_CELL : `${network.used}%`,
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
    enabled: flag(zone.enabled),
    raw: zone,
  }));
}

export function mapDhcpScopeRows(scopes) {
  return (scopes || []).map((scope) => ({
    id: `scope:${scope.id}`,
    range: scope.start_ip === scope.end_ip ? scope.start_ip : `${scope.start_ip} – ${scope.end_ip}`,
    network: scope.subnet_name || scope.subnet_cidr || null,
    poolSize: isPoolScope(scope)
      ? `${formatAddressCount(sumScopeAddresses([scope]))} addresses`
      : 'No pool (addresses self-assigned)',
    leaseTime: formatDuration(scope.effective?.lease_time || scope.lease_time),
    description: scope.description || null,
    enabled: flag(scope.enabled),
    raw: scope,
  }));
}

function onlineValue(row, { unknownWhenUnaddressed = false } = {}) {
  if (unknownWhenUnaddressed && !row.ip_address) return 'unknown';
  const status = displayOnlineStatus(row.is_online);
  if (!status.known) return 'unknown';
  return status.label.toLowerCase();
}

const LEASE_LABEL = { active: 'Active', expired: 'Expired' };

// The TTL a record is answered with, as the DNS server reports it
// (served_ttl). When that is not the record's own TTL, because it has none or
// the server cannot serve it, it says so, the way Scanning says "inherited".
function recordTtl(record) {
  const served = record.served_ttl;
  if (served == null) return EMPTY_CELL;
  return record.ttl === served ? formatNumber(served) : `${formatNumber(served)} · default`;
}

// Whether a held address sits inside a dynamic pool of its scope. The server
// lists the scopes whose pools contain the address in related_scope_ids, so
// an empty list means outside every pool. A reservation outside the pool is
// the normal way to keep an address out of dynamic hand-out, so it is plain
// information. A dynamic lease outside the pool is odd: dnsmasq only hands
// out pool addresses, so the pool shrank after the lease or another server
// issued it, and that one is flagged. Free pool addresses get nothing, they
// are the pool.
function poolMembership(row) {
  if (!row.dhcp_assignment_type) return null;
  const inPool = (row.related_scope_ids || []).length > 0;
  if (inPool) return { label: 'in pool', tone: 'muted' };
  return {
    label: 'outside pool',
    tone: row.dhcp_assignment_type === 'dynamic' ? 'warn' : 'muted',
  };
}

// Every column of the one IP table model (workspace-columns.js), filled from
// a row of any of the three tables. `dns` is the DNS record behind the row and
// `dhcp` its DHCP reservation or lease: the row itself on its own table, the
// facts the server attached (dns_record, dhcp) on the others. A column a row
// has no fact for is null, which the table shows as an empty cell.
function ipRowFields(row, { dns = row.dns_record || null, dhcp = row.dhcp || null } = {}) {
  return {
    address: row.ip_address || null,
    hostname: row.hostname || null,
    status: row.ip_display_status || null,
    type: row.address_type || null,
    // The lease dnsmasq holds: Active, Expired, or nothing. Whether the
    // address is free for DHCP is the status column's job.
    lease: LEASE_LABEL[row.dhcp_lease_state] || null,
    expires: displayExpiry(row.dhcp_expires_at, formatTimestamp, {
      reserved: dhcp?.dhcp_assignment_type === 'reserved' || flag(row.has_dhcp_reservation),
    }),
    online: onlineValue(row, { unknownWhenUnaddressed: true }),
    mac: displayMacAddress(row.mac_address || row.last_seen_mac),
    source: row.allocation_source_type || row.detection_source ? allocationSourceLabel(row) : null,
    rangeType: row.network_range_type || null,
    rangeColor: row.network_range_type_color || null,
    lastSeen: formatTimestamp(row.last_seen_at),
    lastScanned: formatTimestamp(row.last_scanned_at),
    scanning:
      row.scanning_enabled == null
        ? null
        : row.scanning_enabled
          ? row.scan_enabled == null
            ? 'On · inherited'
            : 'On'
          : row.scan_enabled == null
            ? 'Off · inherited'
            : 'Off',
    network: row.subnet_name || row.subnet_cidr || dhcp?.subnet_name || null,
    dnsName: dns?.record_fqdn || null,
    recordType: dns?.record_type || null,
    value: dns?.value ?? null,
    ttl: dns ? recordTtl(dns) : null,
    priority: dns?.priority ?? null,
    port: dns?.port ?? null,
    recordEnabled: dns ? flag(dns.enabled) : null,
    recordSource: dns?.dns_source ? recordSourceLabel(dns) : null,
    assignment: dhcp?.dhcp_assignment_type ? humanize(dhcp.dhcp_assignment_type) : null,
    pool: dhcp ? poolMembership(dhcp) : null,
    reservationEnabled: dhcp?.dhcp_assignment_type === 'reserved' ? flag(dhcp.enabled) : null,
    duid: dhcp?.duid ?? row.dhcp_duid ?? null,
    iaid: dhcp?.iaid ?? row.dhcp_iaid ?? null,
    raw: row,
  };
}

export function mapAddressRows(rows) {
  return (rows || []).map((row) => ({
    id: `address:${row.ip_address}`,
    ...ipRowFields(row),
  }));
}

export function mapDnsRows(zoneRecords) {
  return (zoneRecords || []).flatMap(({ zone, records }) =>
    (records || []).map((record) => ({
      id: `dns:${zone.id}:${record.id}`,
      ...ipRowFields(record, { dns: record }),
      name: record.name || '@',
      // The row's own switch: a disabled record recedes in the table.
      enabled: flag(record.enabled),
      zone: zone.name,
      zoneType: zone.type,
    })),
  );
}

export function mapDhcpRows(rows) {
  return (rows || []).map((row) => ({
    id: `dhcp:${row.dhcp_assignment_type || 'pool'}:${row.id}:${row.ip_address}`,
    ...ipRowFields(row, { dhcp: row }),
    // The pool slot as the server filters it (active, offline, available,
    // unavailable). Drives the status filter and the attention rules; the
    // Lease column shows `lease` instead.
    leaseStatus: row.lease_status,
    enabled: flag(row.enabled),
  }));
}

function rangeSize(startIp, endIp) {
  const size = addressCount(startIp, endIp);
  if (size === null) return EMPTY_CELL;
  return `${formatAddressCount(size)} ${size === 1n ? 'address' : 'addresses'}`;
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
      rangeColor: row.range_type_color || null,
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

/**
 * The result line under an address table. A sparse (IPv6) network has no
 * total to show, only the addresses CIDRella holds rows for.
 */
// The DNS records behind one address, as the details panel lists them. A
// disabled record is kept but does not answer or claim the address, so it is
// named rather than folded into the count.
export function dnsRecordSummary(rows) {
  const total = rows.length;
  const disabled = rows.filter((row) => row.enabled === false).length;
  const verb = total === 1 ? 'references' : 'reference';
  let note;
  if (!disabled) note = `${countOf(total, 'record')} ${verb} this address`;
  else if (disabled === total) note = `${countOf(total, 'disabled record')} ${verb} this address`;
  else
    note = `${countOf(total, 'record')} ${verb} this address, ${formatNumber(disabled)} disabled`;
  return { total, disabled, note };
}

export function addressCountLabel({ shown, matching, total, sparse = false, paged = true }) {
  const tail = sparse ? `${total} assigned addresses` : `${total} addresses in network`;
  // The grid shows the whole network, so "on this page" would be noise.
  return `Showing ${shown}${paged ? ' on this page' : ''} · ${matching} matching · ${tail}`;
}

// Whether a scope's pools hand out addresses: every DHCPv4 scope and a
// stateful DHCPv6 one. A SLAAC or stateless scope's range is the prefix shown
// for reference, not a pool (the server's isAddressPoolScope).
function isPoolScope(scope) {
  const raw = scope?.raw || scope;
  return Number(raw?.address_family) !== 6 || raw?.v6_mode === 'stateful';
}

/**
 * Pool addresses across scopes, as a BigInt: an IPv6 pool can exceed what a
 * JavaScript number holds. Scopes that are not pools count nothing. Format it
 * with formatAddressCount.
 */
export function sumScopeAddresses(scopes) {
  let total = 0n;
  for (const scope of scopes || []) {
    if (!isPoolScope(scope)) continue;
    for (const pool of scope.pools || [{ start_ip: scope.start_ip, end_ip: scope.end_ip }]) {
      total += addressCount(pool.start_ip, pool.end_ip) ?? 0n;
    }
  }
  return total;
}

export function gridKind(row) {
  const type = row?.type;
  if (type === 'system') return 'system';
  if (type === 'gateway') return 'gateway';
  if (type === 'rogue') return 'rogue';
  if (type === 'static DNS') return 'dns';
  if (type === 'IP Reservation' || type === 'disabled DNS') return 'reserved';
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

// The order key of a cell that holds an address, a network ('2001:db8::/64')
// or an address range ('10.0.0.5 – 10.0.0.9'), or null for anything else.
function addressOrderKey(value) {
  const head = String(value ?? '')
    .trim()
    .split(/\s+[–-]\s+/)[0];
  const [address, prefix] = head.split('/');
  const key = sortKey(address);
  if (!key) return null;
  return `${key}/${String(prefix ?? '').padStart(3, '0')}`;
}

/**
 * Compare two table cells. Addresses, networks and ranges sort by address
 * value and then prefix (IPv4 before IPv6), so 2001:db8:a:: comes before
 * 2001:db8:10::, which a numeric text sort reads as decimal and reverses.
 * Anything else is compared as text with numeric runs.
 */
export function compareCellValues(a, b) {
  const left = addressOrderKey(a);
  const right = addressOrderKey(b);
  if (left !== null && right !== null) return left < right ? -1 : left > right ? 1 : 0;
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true });
}
