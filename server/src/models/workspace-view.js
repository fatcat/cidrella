import { computeIpView, enrichIpViewRows } from './ip-view.js';
import { getScopePools } from './dhcp-scope.js';
import { fqdnForRecordName, ipForPtrRecord } from './dns-record.js';
import { canonicalizeIp, sortKey } from '../utils/address.js';
import {
  ipToLong,
  longToIp,
  isValidIpv4,
  isValidAddress,
  networkContains,
  addressInRange,
} from '../utils/ip.js';
import { parseIp } from '../utils/address.js';
import { isLeaseActive } from '../utils/lease-sql.js';

const DNS_SORT_FIELDS = new Set([
  'record_fqdn',
  'record_type',
  'value',
  'dns_source',
  'enabled',
  'zone_name',
  'ip_address',
]);
const DHCP_SORT_FIELDS = new Set([
  'ip_address',
  'hostname',
  'mac_address',
  'dhcp_assignment_type',
  'lease_status',
  'dhcp_lease_state',
  'ip_display_status',
  'expires_at',
  'subnet_name',
]);

function text(value) {
  return String(value ?? '').toLowerCase();
}

function includesLiteral(value, query) {
  return text(value).includes(text(query));
}

function anyFieldMatches(row, fields, query) {
  if (!query) return true;
  return fields.some((field) => includesLiteral(row[field], query));
}

function enabledMatches(value, expected) {
  return expected === undefined || Boolean(value) === expected;
}

function allocatedLeaves(db) {
  return db
    .prepare(
      `
      SELECT s.*, v.name AS vlan_name
        FROM subnets s
        LEFT JOIN vlans v ON v.id = s.vlan_id
       WHERE s.status = 'allocated'
         AND NOT EXISTS (SELECT 1 FROM subnets child WHERE child.parent_id = s.id)
       ORDER BY s.network_address, s.prefix_length, s.id
    `,
    )
    .all();
}

function containingSubnet(subnets, ip) {
  if (!ip || !isValidAddress(ip)) return null;
  return (
    subnets
      .filter((subnet) => networkContains(subnet.cidr, ip))
      .sort((a, b) => b.prefix_length - a.prefix_length || a.id - b.id)[0] || null
  );
}

function canonicalIpRows(db) {
  return db
    .prepare(
      `
      SELECT ip.*, sub.cidr AS subnet_cidr, sub.name AS subnet_name,
             sub.domain_name AS subnet_domain_name, sub.folder_id
        FROM ip_addresses ip
        JOIN subnets sub ON sub.id = ip.subnet_id
    `,
    )
    .all();
}

function networkMatches(db, subnet, query, ipRows) {
  if (!query) return true;
  if (
    anyFieldMatches(
      subnet,
      [
        'name',
        'cidr',
        'network_address',
        'broadcast_address',
        'gateway_address',
        'domain_name',
        'vlan_name',
      ],
      query,
    )
  ) {
    return true;
  }
  const exactIp = canonicalizeIp(query);
  if (exactIp && networkContains(subnet.cidr, exactIp)) return true;
  return ipRows.some(
    (row) =>
      row.subnet_id === subnet.id &&
      anyFieldMatches(row, ['ip_address', 'hostname', 'mac_address', 'last_seen_mac'], query),
  );
}

export function getWorkspaceNetworks(db, { folderId, q, tableQ } = {}) {
  const ipRows = canonicalIpRows(db);
  let items = allocatedLeaves(db);
  if (folderId !== undefined) items = items.filter((row) => row.folder_id === folderId);
  if (q) items = items.filter((row) => networkMatches(db, row, q, ipRows));
  if (tableQ) items = items.filter((row) => networkMatches(db, row, tableQ, ipRows));
  return { items, total: items.length };
}

function directRecordIp(record, zoneName) {
  if (record.type === 'A' || record.type === 'AAAA') return canonicalizeIp(record.value);
  if (record.type === 'PTR') return canonicalizeIp(ipForPtrRecord(record.name, zoneName));
  return null;
}

function zoneSubnetIds(zone, subnets) {
  const ids = new Set();
  const zoneName = text(zone.name).replace(/\.$/, '');
  if (zone.type === 'forward') {
    for (const subnet of subnets) {
      if (text(subnet.domain_name).replace(/\.$/, '') === zoneName) ids.add(subnet.id);
    }
  }
  return ids;
}

function resolveDnsAssociations(records, zones, subnets) {
  const zonesById = new Map(zones.map((zone) => [zone.id, zone]));
  const recordsByFqdn = new Map();
  const associations = new Map();

  for (const record of records) {
    const zone = zonesById.get(record.zone_id);
    record.record_fqdn = fqdnForRecordName(record.name, zone?.name || '');
    const key = text(record.record_fqdn).replace(/\.$/, '');
    const existing = recordsByFqdn.get(key) || [];
    existing.push(record);
    recordsByFqdn.set(key, existing);
    // Record membership is derived from the address the record represents,
    // not from the zone's domain association. MX/TXT/SRV records remain
    // visible in whole-zone context without being attributed to every network
    // that uses the zone.
    const ids = new Set();
    const ip = zone ? directRecordIp(record, zone.name) : null;
    const subnet = ip ? containingSubnet(subnets, ip) : null;
    if (subnet) ids.add(subnet.id);
    associations.set(record.id, ids);
  }

  // Resolve managed CNAME chains only. This never performs network I/O and
  // intentionally leaves cycles and external targets without an association.
  for (const record of records.filter((row) => row.type === 'CNAME')) {
    const seen = new Set([text(record.record_fqdn).replace(/\.$/, '')]);
    let target = text(record.value).replace(/\.$/, '');
    for (let depth = 0; depth < 16 && target && !seen.has(target); depth += 1) {
      seen.add(target);
      const targets = recordsByFqdn.get(target) || [];
      if (!targets.length) break;
      let nextTarget = null;
      for (const targetRecord of targets) {
        for (const id of associations.get(targetRecord.id) || [])
          associations.get(record.id).add(id);
        if (targetRecord.type === 'CNAME') nextTarget = text(targetRecord.value).replace(/\.$/, '');
      }
      target = nextTarget;
    }
  }

  return associations;
}

function allDnsRows(db) {
  const zones = db.prepare('SELECT * FROM dns_zones ORDER BY type, name, id').all();
  const subnets = allocatedLeaves(db);
  const records = db
    .prepare(
      `
      SELECT r.*, r.type AS record_type, r.source AS dns_source,
             z.name AS zone_name, z.type AS zone_type, z.folder_id AS zone_folder_id,
             CASE WHEN r.type IN ('A', 'AAAA') THEN r.value END AS ip_address
        FROM dns_records r
        JOIN dns_zones z ON z.id = r.zone_id
    `,
    )
    .all();
  const associations = resolveDnsAssociations(records, zones, subnets);
  for (const record of records) {
    record.related_subnet_ids = [...(associations.get(record.id) || [])].sort((a, b) => a - b);
    if (!record.ip_address && record.type === 'PTR') {
      record.ip_address = canonicalizeIp(ipForPtrRecord(record.name, record.zone_name));
    }
    record.subnet_id = record.ip_address
      ? (containingSubnet(subnets, record.ip_address)?.id ?? null)
      : (record.related_subnet_ids[0] ?? null);
  }
  enrichIpViewRows(
    db,
    records.filter((row) => row.ip_address),
    { fillFromIpAddress: true },
  );
  return { records, zones, subnets, associations };
}

function compareRows(field, order) {
  const direction = order === 'desc' ? -1 : 1;
  return (a, b) => {
    let result;
    if (field === 'ip_address') result = sortKey(a[field]).localeCompare(sortKey(b[field]));
    else result = text(a[field]).localeCompare(text(b[field]), undefined, { numeric: true });
    if (!result) result = sortKey(a.ip_address).localeCompare(sortKey(b.ip_address));
    if (!result) result = text(a.protocol_id || a.id).localeCompare(text(b.protocol_id || b.id));
    return result * direction;
  };
}

export function getWorkspaceDnsRecords(
  db,
  {
    subnetId,
    folderId,
    zoneId,
    q,
    tableQ,
    ipAddress,
    recordType,
    dnsSource,
    enabled,
    page = 1,
    pageSize = 50,
    sortField = 'record_fqdn',
    sortOrder = 'asc',
  } = {},
) {
  let { records } = allDnsRows(db);
  if (subnetId !== undefined)
    records = records.filter((row) => row.related_subnet_ids.includes(subnetId));
  if (folderId !== undefined) {
    const folderSubnetIds = new Set(
      allocatedLeaves(db)
        .filter((row) => row.folder_id === folderId)
        .map((row) => row.id),
    );
    records = records.filter(
      (row) =>
        row.zone_folder_id === folderId ||
        row.related_subnet_ids.some((id) => folderSubnetIds.has(id)),
    );
  }
  if (zoneId !== undefined) records = records.filter((row) => row.zone_id === zoneId);
  if (ipAddress) records = records.filter((row) => row.ip_address === ipAddress);
  if (recordType) records = records.filter((row) => row.record_type === recordType);
  if (dnsSource) records = records.filter((row) => row.dns_source === dnsSource);
  if (enabled !== undefined)
    records = records.filter((row) => enabledMatches(row.enabled, enabled));
  const searchFields = [
    'record_fqdn',
    'name',
    'value',
    'record_type',
    'dns_source',
    'zone_name',
    'ip_address',
    'hostname',
    'mac_address',
  ];
  if (q) records = records.filter((row) => anyFieldMatches(row, searchFields, q));
  if (tableQ) records = records.filter((row) => anyFieldMatches(row, searchFields, tableQ));
  records.sort(compareRows(DNS_SORT_FIELDS.has(sortField) ? sortField : 'record_fqdn', sortOrder));
  const total = records.length;
  return {
    items: records.slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    page_size: pageSize,
  };
}

export function getWorkspaceDnsZones(
  db,
  { subnetId, folderId, q, tableQ, type, enabled, includeNetworks = true } = {},
) {
  const { records, zones, subnets, associations } = allDnsRows(db);
  const recordsByZone = new Map();
  for (const record of records) {
    const list = recordsByZone.get(record.zone_id) || [];
    list.push(record);
    recordsByZone.set(record.zone_id, list);
  }
  let rows = zones.map((zone) => {
    const ids = zoneSubnetIds(zone, subnets);
    for (const record of recordsByZone.get(zone.id) || []) {
      for (const id of associations.get(record.id) || []) ids.add(id);
    }
    const relatedSubnetIds = [...ids].sort((a, b) => a - b);
    return {
      ...zone,
      record_count: (recordsByZone.get(zone.id) || []).length,
      ...(includeNetworks
        ? {
            related_subnet_ids: relatedSubnetIds,
            related_networks: subnets
              .filter((subnet) => ids.has(subnet.id))
              .map(({ id, cidr, name }) => ({ id, cidr, name })),
          }
        : {}),
      _related_subnet_ids: relatedSubnetIds,
    };
  });
  if (subnetId !== undefined)
    rows = rows.filter((row) => row._related_subnet_ids.includes(subnetId));
  if (folderId !== undefined) {
    const folderSubnetIds = new Set(
      subnets.filter((row) => row.folder_id === folderId).map((row) => row.id),
    );
    rows = rows.filter(
      (row) =>
        row.folder_id === folderId || row._related_subnet_ids.some((id) => folderSubnetIds.has(id)),
    );
  }
  if (type) rows = rows.filter((row) => row.type === type);
  if (enabled !== undefined) rows = rows.filter((row) => enabledMatches(row.enabled, enabled));
  const matches = (row, query) =>
    anyFieldMatches(row, ['name', 'type', 'description'], query) ||
    (recordsByZone.get(row.id) || []).some((record) =>
      anyFieldMatches(record, ['record_fqdn', 'name', 'value', 'ip_address', 'hostname'], query),
    );
  if (q) rows = rows.filter((row) => matches(row, q));
  if (tableQ) rows = rows.filter((row) => matches(row, tableQ));
  return rows.map(({ _related_subnet_ids, ...row }) => row);
}

function unifiedDhcpRows(db) {
  const subnets = allocatedLeaves(db);
  const leases = db.prepare('SELECT * FROM dhcp_leases').all();
  const reservations = db.prepare('SELECT * FROM dhcp_reservations').all();
  const activeByIdentity = new Map(
    leases
      .filter((lease) => isLeaseActive(lease.expires_at))
      .map((lease) => [`${text(lease.mac_address)}:${lease.ip_address}`, lease]),
  );
  const matched = new Set();
  const rows = reservations.map((reservation) => {
    const subnet = subnets.find((item) => item.id === reservation.subnet_id);
    const key = `${text(reservation.mac_address)}:${reservation.ip_address}`;
    const lease = activeByIdentity.get(key);
    if (lease) matched.add(key);
    return {
      ...reservation,
      protocol_id: `reservation:${reservation.id}`,
      reservation_id: reservation.id,
      lease_id: lease?.id ?? null,
      dhcp_assignment_type: 'reserved',
      lease_status: lease ? 'active' : 'offline',
      expires_at: lease?.expires_at ?? null,
      subnet_cidr: subnet?.cidr ?? null,
      subnet_name: subnet?.name ?? null,
      subnet_domain_name: subnet?.domain_name ?? null,
      folder_id: subnet?.folder_id ?? null,
    };
  });
  for (const lease of leases) {
    const key = `${text(lease.mac_address)}:${lease.ip_address}`;
    if (matched.has(key)) continue;
    const subnet = subnets.find((item) => item.id === lease.subnet_id);
    rows.push({
      ...lease,
      protocol_id: `lease:${lease.id}`,
      reservation_id: null,
      lease_id: lease.id,
      dhcp_assignment_type: 'dynamic',
      lease_status: isLeaseActive(lease.expires_at) ? 'active' : 'offline',
      enabled: 1,
      subnet_cidr: subnet?.cidr ?? null,
      subnet_name: subnet?.name ?? null,
      subnet_domain_name: subnet?.domain_name ?? null,
      folder_id: subnet?.folder_id ?? null,
    });
  }
  return rows;
}

function allScopes(db) {
  const scopes = db
    .prepare(
      `
      SELECT s.*, sub.cidr AS subnet_cidr, sub.name AS subnet_name,
             sub.domain_name AS subnet_domain_name, sub.folder_id
        FROM dhcp_scopes s
        JOIN subnets sub ON sub.id = s.subnet_id
       ORDER BY sub.network_address, s.id
    `,
    )
    .all();
  for (const scope of scopes) scope.pools = getScopePools(db, scope.id);
  return scopes;
}

function poolForAddress(scopes, subnetId, ip) {
  if (!isValidAddress(ip)) return undefined;
  return scopes.find(
    (scope) =>
      scope.subnet_id === subnetId &&
      scope.pools.some((pool) => addressInRange(ip, pool.start_ip, pool.end_ip)),
  );
}

function scopesForAddress(scopes, subnetId, ip) {
  if (!isValidAddress(ip)) return [];
  return scopes.filter(
    (scope) =>
      scope.subnet_id === subnetId &&
      scope.pools.some((pool) => addressInRange(ip, pool.start_ip, pool.end_ip)),
  );
}

// The view fields (status, type, lease state) come from the same computation
// the Addresses table uses, fed the same facts: the lease dnsmasq holds and,
// for anything inside a pool, that it sits in one. That is what makes a free
// pool address read "DHCP Scope" here as it does there.
function enrichDhcp(db, rows) {
  for (const row of rows) {
    row.has_dhcp_reservation = row.dhcp_assignment_type === 'reserved' ? 1 : 0;
    row.dhcp_expires_at = row.expires_at ?? null;
    row.in_dynamic_pool = (row.related_scope_ids || []).length > 0 ? 1 : 0;
  }
  enrichIpViewRows(db, rows, { fillFromIpAddress: true });
  for (const row of rows) {
    if (!row.dhcp_assignment_type && row.address_type) row.lease_status = 'unavailable';
  }
  return rows;
}

function availableRow(scopes, subnet, ip) {
  const matchingScopes = scopesForAddress(scopes, subnet.id, ip);
  const scope = matchingScopes[0];
  const row = {
    id: `available:${scope.id}:${ip}`,
    protocol_id: `scope:${scope.id}:${ip}`,
    scope_id: scope.id,
    related_scope_ids: matchingScopes.map((item) => item.id),
    in_dynamic_pool: 1,
    dhcp_assignment_type: null,
    ip_address: ip,
    mac_address: null,
    hostname: null,
    description: null,
    subnet_id: subnet.id,
    subnet_cidr: subnet.cidr,
    subnet_name: subnet.name,
    subnet_domain_name: subnet.domain_name,
    folder_id: subnet.folder_id,
    enabled: scope.enabled,
    lease_status: 'available',
    expires_at: null,
    reservation_id: null,
    lease_id: null,
    // Nothing has ever answered at this address, so it is offline, the same
    // reading the Addresses view gives a synthesized row. The DHCP view used
    // to leave this unset and the table printed "unknown" for every free
    // pool address, which read as a failed check rather than an idle one.
    is_online: 0,
    last_seen_at: null,
    created_at: null,
    updated_at: null,
  };
  // A synthesized pool address never touches the database, so it takes its
  // view fields straight from the pure computation.
  return { ...row, ...computeIpView(row) };
}

function virtualPoolProjection(scopes, excludedKeys, queries, descending = false) {
  const subnets = new Map();
  for (const scope of scopes) {
    if (!subnets.has(scope.subnet_id)) {
      subnets.set(scope.subnet_id, {
        id: scope.subnet_id,
        cidr: scope.subnet_cidr,
        name: scope.subnet_name,
        domain_name: scope.subnet_domain_name,
        folder_id: scope.folder_id,
        intervals: [],
      });
    }
    for (const pool of scope.pools) {
      // The interval walk below is 32-bit. IPv6 pools are never enumerated:
      // their addresses appear only as persisted leases and reservations.
      if (parseIp(pool.start_ip)?.bits !== 32) continue;
      subnets.get(scope.subnet_id).intervals.push({
        start: ipToLong(pool.start_ip),
        end: ipToLong(pool.end_ip),
      });
    }
  }

  const segments = [];
  for (const subnet of subnets.values()) {
    const exactQueries = [];
    let includeAll = true;
    for (const query of queries.filter(Boolean)) {
      if (
        anyFieldMatches(
          {
            subnet_cidr: subnet.cidr,
            subnet_name: subnet.name,
            subnet_domain_name: subnet.domain_name,
          },
          ['subnet_cidr', 'subnet_name', 'subnet_domain_name'],
          query,
        )
      ) {
        continue;
      }
      const exactIp = canonicalizeIp(query);
      if (!exactIp || !isValidIpv4(exactIp)) {
        includeAll = false;
        break;
      }
      exactQueries.push(ipToLong(exactIp));
    }
    if (!includeAll) continue;

    const merged = [];
    for (const interval of subnet.intervals.sort((a, b) => a.start - b.start || a.end - b.end)) {
      const previous = merged[merged.length - 1];
      if (previous && interval.start <= previous.end + 1)
        previous.end = Math.max(previous.end, interval.end);
      else merged.push({ ...interval });
    }
    for (const interval of merged) {
      let start = interval.start;
      let end = interval.end;
      if (exactQueries.length) {
        if (exactQueries.some((value) => value !== exactQueries[0])) continue;
        start = exactQueries[0];
        end = exactQueries[0];
        if (start < interval.start || start > interval.end) continue;
      }
      const excluded = [];
      // Avoid walking the interval. Only test materialized keys for this
      // subnet, which stays proportional to real protocol/IP rows.
      for (const key of excludedKeys) {
        const [subnetId, ip] = key.split(':');
        if (Number(subnetId) !== subnet.id || !isValidIpv4(ip)) continue;
        const value = ipToLong(ip);
        if (value >= start && value <= end) excluded.push(value);
      }
      excluded.sort((a, b) => a - b);
      segments.push({ subnet, start, end, excluded, count: end - start + 1 - excluded.length });
    }
  }
  segments.sort((a, b) => a.start - b.start || a.subnet.id - b.subnet.id);
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);

  function at(index) {
    let remaining = descending ? total - index - 1 : index;
    for (const segment of segments) {
      if (remaining >= segment.count) {
        remaining -= segment.count;
        continue;
      }
      let value = segment.start + remaining;
      for (const excluded of segment.excluded) {
        if (excluded > value) break;
        value += 1;
      }
      return availableRow(scopes, segment.subnet, longToIp(value));
    }
    return null;
  }

  return { total, at };
}

function mergePage(materialRows, virtualRows, compare, offset, limit) {
  const items = [];
  const combinedTotal = materialRows.length + virtualRows.total;

  // Select the row at a merged rank by partitioning the two sorted sources.
  // This keeps work proportional to the requested page even for a high page
  // number in a /8 pool.
  const at = (index) => {
    const leftCount = index + 1;
    let low = Math.max(0, leftCount - virtualRows.total);
    let high = Math.min(leftCount, materialRows.length);
    while (low <= high) {
      const materialCount = Math.floor((low + high) / 2);
      const virtualCount = leftCount - materialCount;
      const materialLeft = materialCount ? materialRows[materialCount - 1] : null;
      const materialRight =
        materialCount < materialRows.length ? materialRows[materialCount] : null;
      const virtualLeft = virtualCount ? virtualRows.at(virtualCount - 1) : null;
      const virtualRight = virtualCount < virtualRows.total ? virtualRows.at(virtualCount) : null;

      if (materialLeft && virtualRight && compare(materialLeft, virtualRight) > 0) {
        high = materialCount - 1;
      } else if (virtualLeft && materialRight && compare(virtualLeft, materialRight) > 0) {
        low = materialCount + 1;
      } else if (!materialLeft) {
        return virtualLeft;
      } else if (!virtualLeft) {
        return materialLeft;
      } else {
        return compare(materialLeft, virtualLeft) > 0 ? materialLeft : virtualLeft;
      }
    }
    return null;
  };

  for (let index = offset; index < Math.min(combinedTotal, offset + limit); index += 1) {
    items.push(at(index));
  }
  return items;
}

export function getWorkspaceDhcpAddresses(
  db,
  {
    subnetId,
    folderId,
    scopeId,
    q,
    tableQ,
    ipAddress,
    leaseStatus,
    assignmentType,
    page = 1,
    pageSize = 50,
    sortField = 'ip_address',
    sortOrder = 'asc',
  } = {},
) {
  let scopes = allScopes(db);
  if (scopeId !== undefined) scopes = scopes.filter((scope) => scope.id === scopeId);
  if (subnetId !== undefined) scopes = scopes.filter((scope) => scope.subnet_id === subnetId);
  if (folderId !== undefined) scopes = scopes.filter((scope) => scope.folder_id === folderId);
  let rows = unifiedDhcpRows(db).filter((row) => {
    if (scopeId !== undefined) return poolForAddress(scopes, row.subnet_id, row.ip_address);
    // Network and folder views include their reservations and leases even when
    // the address is outside a dynamic pool (or the network has no scope).
    if (subnetId !== undefined) return row.subnet_id === subnetId;
    if (folderId !== undefined) return row.folder_id === folderId;
    return true;
  });
  const materializedKeys = new Set(rows.map((row) => `${row.subnet_id}:${row.ip_address}`));
  // Canonical rows are sparse facts. Materialize only those that overlap a
  // pool so enrichIpViewRows can project unavailable addresses accurately.
  for (const canonical of canonicalIpRows(db)) {
    const matchingScopes = scopesForAddress(scopes, canonical.subnet_id, canonical.ip_address);
    const key = `${canonical.subnet_id}:${canonical.ip_address}`;
    if (!matchingScopes.length || materializedKeys.has(key)) continue;
    const scope = matchingScopes[0];
    rows.push(
      availableRow(
        scopes,
        {
          id: scope.subnet_id,
          cidr: scope.subnet_cidr,
          name: scope.subnet_name,
          domain_name: scope.subnet_domain_name,
          folder_id: scope.folder_id,
        },
        canonical.ip_address,
      ),
    );
    materializedKeys.add(key);
  }
  for (const row of rows) {
    const matchingScopes = scopesForAddress(scopes, row.subnet_id, row.ip_address);
    row.scope_id = row.scope_id ?? matchingScopes[0]?.id ?? null;
    row.related_scope_ids = matchingScopes.map((scope) => scope.id);
  }
  enrichDhcp(db, rows);
  const searchFields = [
    'ip_address',
    'hostname',
    'mac_address',
    'description',
    'subnet_cidr',
    'subnet_name',
    'subnet_domain_name',
  ];
  if (q) rows = rows.filter((row) => anyFieldMatches(row, searchFields, q));
  if (tableQ) rows = rows.filter((row) => anyFieldMatches(row, searchFields, tableQ));
  if (ipAddress) rows = rows.filter((row) => row.ip_address === ipAddress);
  if (leaseStatus) rows = rows.filter((row) => row.lease_status === leaseStatus);
  if (assignmentType) rows = rows.filter((row) => row.dhcp_assignment_type === assignmentType);
  const virtualRows =
    (!leaseStatus || leaseStatus === 'available') && !assignmentType
      ? virtualPoolProjection(
          scopes,
          materializedKeys,
          [q, tableQ, ipAddress],
          sortOrder === 'desc',
        )
      : { total: 0, at: () => null };
  const compare = compareRows(
    DHCP_SORT_FIELDS.has(sortField) ? sortField : 'ip_address',
    sortOrder,
  );
  rows.sort(compare);
  const total = rows.length + virtualRows.total;
  const items = mergePage(rows, virtualRows, compare, (page - 1) * pageSize, pageSize);
  // Synthesized pool addresses are made per page, so only the page's worth
  // get the per-subnet fields (scanning, the organizational range tag) the
  // stored rows already have.
  enrichIpViewRows(
    db,
    items.filter((row) => row.scanning_enabled === undefined),
  );
  return {
    items,
    total,
    page,
    page_size: pageSize,
  };
}

export function scopeMatches(scope, query, addressRows) {
  if (!query) return true;
  if (
    anyFieldMatches(
      scope,
      ['subnet_name', 'subnet_cidr', 'subnet_domain_name', 'description', 'start_ip', 'end_ip'],
      query,
    )
  ) {
    return true;
  }
  const exactIp = canonicalizeIp(query);
  if (exactIp && scope.pools.some((pool) => addressInRange(exactIp, pool.start_ip, pool.end_ip))) {
    return true;
  }
  return addressRows.some(
    (row) =>
      row.scope_id === scope.id &&
      anyFieldMatches(row, ['ip_address', 'hostname', 'mac_address'], query),
  );
}
