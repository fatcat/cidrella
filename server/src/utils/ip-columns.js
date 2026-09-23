/**
 * Server side of the one IP table model (client
 * views/networks-workspace/workspace-columns.js): one value getter per column
 * key, the same for a row of any of the three tables, used to filter, count
 * and sort on any column.
 *
 * `table` is the table the row belongs to: 'addresses', 'dns' or 'dhcp'. A DNS
 * row is its own record and a DHCP row its own reservation or lease; the other
 * tables' rows carry theirs as `dns_record` and `dhcp` (models/ip-row-facts.js).
 * The client's ipRowFields reads the same facts the same way.
 *
 * Filters travel as one JSON object, `{ column: [value, ...] }`. An enum
 * column matches any listed value (string, boolean, or null for "none"); a
 * text column matches a case-insensitive substring of its one value.
 */
import { sortKey } from './address.js';

const TABLES = new Set(['addresses', 'dns', 'dhcp']);

const dnsOf = (row, table) => (table === 'dns' ? row : row.dns_record) || null;
const dhcpOf = (row, table) => (table === 'dhcp' ? row : row.dhcp) || null;
const bool = (value) => (value == null ? null : Boolean(Number(value) || value === true));
const str = (value) => (value == null || value === '' ? null : String(value));

// An address a disabled DNS record holds is its own source (ADR 004), not
// static DNS.
function allocationSource(row) {
  if (row.allocation_state === 'reserved' && row.allocation_source_type === 'dns') {
    return 'dns_hold';
  }
  return str(row.allocation_source_type || row.detection_source);
}

export const IP_COLUMNS = Object.freeze({
  ip_address: {
    kind: 'text',
    get: (row) => str(row.ip_address),
    sort: (row) => sortKey(row.ip_address),
  },
  hostname: { kind: 'text', get: (row) => str(row.hostname) },
  status: { kind: 'enum', get: (row) => str(row.ip_display_status) },
  type: { kind: 'enum', get: (row) => str(row.address_type) },
  network_range_type: { kind: 'enum', get: (row) => str(row.network_range_type) },
  dns_hostname: { kind: 'text', get: (row, t) => str(dnsOf(row, t)?.record_fqdn) },
  record_name: { kind: 'text', get: (row, t) => str(dnsOf(row, t)?.name) },
  record_type: { kind: 'enum', get: (row, t) => str(dnsOf(row, t)?.record_type) },
  value: { kind: 'text', get: (row, t) => str(dnsOf(row, t)?.value) },
  priority: { kind: 'none', get: (row, t) => dnsOf(row, t)?.priority ?? null },
  port: { kind: 'none', get: (row, t) => dnsOf(row, t)?.port ?? null },
  ttl: {
    kind: 'none',
    get: (row, t) => {
      const dns = dnsOf(row, t);
      return dns ? (dns.ttl ?? dns.zone_soa_minimum_ttl ?? null) : null;
    },
  },
  record_enabled: {
    kind: 'enum',
    get: (row, t) => (dnsOf(row, t) ? bool(dnsOf(row, t).enabled) : null),
  },
  record_source: { kind: 'enum', get: (row, t) => str(dnsOf(row, t)?.dns_source) },
  source: { kind: 'enum', get: (row) => allocationSource(row) },
  mac_address: { kind: 'text', get: (row) => str(row.mac_address || row.last_seen_mac) },
  vendor: { kind: 'enum', get: (row) => str(row.vendor) },
  duid: { kind: 'text', get: (row, t) => str(dhcpOf(row, t)?.duid ?? row.dhcp_duid) },
  iaid: { kind: 'text', get: (row, t) => str(dhcpOf(row, t)?.iaid ?? row.dhcp_iaid) },
  device: { kind: 'enum', get: (row) => str(row.os_family) },
  os_family: { kind: 'enum', get: (row) => str(row.os_family) },
  device_type: { kind: 'enum', get: (row) => str(row.device_type) },
  device_confidence: { kind: 'enum', get: (row) => str(row.device_confidence) },
  dhcp_fingerprint: { kind: 'text', get: (row) => str(row.dhcp_fingerprint) },
  dhcp_vendor_class: { kind: 'text', get: (row) => str(row.dhcp_vendor_class) },
  dhcp_fingerprint_hostname: { kind: 'text', get: (row) => str(row.dhcp_fingerprint_hostname) },
  device_fingerprint_source: { kind: 'enum', get: (row) => str(row.device_fingerprint_source) },
  is_online: { kind: 'enum', get: (row) => bool(row.is_online) ?? false },
  last_seen_at: { kind: 'none', get: (row) => str(row.last_seen_at) },
  scanning_enabled: { kind: 'enum', get: (row) => bool(row.scanning_enabled) },
  lease: { kind: 'enum', get: (row) => str(row.dhcp_lease_state) },
  network: {
    kind: 'enum',
    get: (row, t) => str(row.subnet_name || row.subnet_cidr || dhcpOf(row, t)?.subnet_name),
  },
  expires: { kind: 'none', get: (row) => str(row.dhcp_expires_at) },
  assignment: { kind: 'enum', get: (row, t) => str(dhcpOf(row, t)?.dhcp_assignment_type) },
  reservation_enabled: {
    kind: 'enum',
    get: (row, t) => {
      const dhcp = dhcpOf(row, t);
      return dhcp?.dhcp_assignment_type === 'reserved' ? bool(dhcp.enabled) : null;
    },
  },
});

export const FILTERABLE = Object.freeze(
  Object.keys(IP_COLUMNS).filter((key) => IP_COLUMNS[key].kind !== 'none'),
);

// Which columns filter by a list of values and which by text, so the client's
// filter menu takes the list from here rather than keeping its own.
export const FILTER_KINDS = Object.freeze(
  Object.fromEntries(FILTERABLE.map((key) => [key, IP_COLUMNS[key].kind])),
);

/** The response fields a read adds when asked for its filter counts. */
export function facetFields(facets) {
  return facets ? { facets, filter_kinds: FILTER_KINDS } : {};
}

const MAX_VALUES = 50;
const MAX_TEXT = 200;

/**
 * Read `filters` (a JSON object) from a query. Unknown columns, a value that
 * is not a string, boolean or null, more than 50 values or a string over 200
 * characters are refused with the reason.
 */
export function parseColumnFilters(raw) {
  if (raw === undefined || raw === '') return { value: {} };
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { error: 'filters must be a JSON object' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'filters must be a JSON object' };
  }
  const value = {};
  for (const [key, values] of Object.entries(parsed)) {
    if (!FILTERABLE.includes(key)) return { error: `filters: unknown column ${key}` };
    const list = Array.isArray(values) ? values : [values];
    if (!list.length) continue;
    if (list.length > MAX_VALUES) return { error: `filters.${key}: at most ${MAX_VALUES} values` };
    for (const item of list) {
      const ok =
        item === null ||
        typeof item === 'boolean' ||
        (typeof item === 'string' && item.length <= MAX_TEXT);
      if (!ok) return { error: `filters.${key}: values must be strings, booleans or null` };
    }
    if (IP_COLUMNS[key].kind === 'text' && (list.length !== 1 || typeof list[0] !== 'string')) {
      return { error: `filters.${key}: a text column takes one string` };
    }
    value[key] = list;
  }
  return { value };
}

export function columnValue(row, key, table) {
  return IP_COLUMNS[key]?.get(row, table) ?? null;
}

function passes(row, key, values, table) {
  const actual = columnValue(row, key, table);
  if (IP_COLUMNS[key].kind === 'text') {
    return actual != null && actual.toLowerCase().includes(values[0].toLowerCase());
  }
  return values.some((value) => value === actual);
}

/** Does the row match every filter, optionally ignoring one column's? */
export function matchesColumnFilters(row, filters, table, except = null) {
  for (const [key, values] of Object.entries(filters)) {
    if (key !== except && !passes(row, key, values, table)) return false;
  }
  return true;
}

/**
 * Count each enum column's values across `entries` ({ row, weight }), where a
 * weight stands in for a run of identical free addresses. A column's counts
 * ignore that column's own filter, so picking a value does not hide the
 * others. Values come back most common first.
 */
export function columnFacets(entries, filters, table) {
  if (!TABLES.has(table)) throw new Error(`unknown table ${table}`);
  const keys = FILTERABLE.filter((key) => IP_COLUMNS[key].kind === 'enum');
  const counts = Object.fromEntries(keys.map((key) => [key, new Map()]));
  const active = Object.keys(filters);
  for (const { row, weight = 1 } of entries) {
    if (!weight) continue;
    const failing = active.filter((key) => !passes(row, key, filters[key], table));
    if (failing.length > 1) continue;
    const only = failing[0];
    for (const key of keys) {
      if (only && key !== only) continue;
      const value = columnValue(row, key, table);
      const map = counts[key];
      map.set(value, (map.get(value) || 0) + weight);
    }
  }
  return Object.fromEntries(
    keys.map((key) => [
      key,
      [...counts[key].entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value))),
    ]),
  );
}

/** Sort key for a column: IP numerically, text case-insensitively, empty last. */
export function columnSortValue(row, key, table) {
  const column = IP_COLUMNS[key];
  if (!column) return null;
  const value = column.sort ? column.sort(row) : column.get(row, table);
  if (typeof value === 'string') return value.trim() ? value.toLowerCase() : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value ?? null;
}

export function compareByColumn(key, order, table) {
  const direction = order === 'desc' || order === -1 ? -1 : 1;
  return (a, b) => {
    const left = columnSortValue(a, key, table);
    const right = columnSortValue(b, key, table);
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    if (left < right) return -1 * direction;
    if (left > right) return direction;
    return 0;
  };
}
