import { reservedLeaseFirstSql } from '../utils/lease-sql.js';
import { addressToBig, parseNetwork, parsedNetworkContains } from '../utils/ip.js';
import { staticDnsClaimSql } from './dns-record.js';
import { ADDRESS_TYPE, buildVirtualSubnetIpRow, enrichIpViewRows } from './ip-view.js';
import { ALLOCATION_STATE } from './ip-lifecycle.js';
import * as Range from './range.js';
import { isAddressPoolScope } from './dhcp-scope.js';
import { dhcpPoolUse } from './dhcp-pool-use.js';

// The system ranges an address can fall in. A SLAAC or stateless DHCPv6
// scope's range is the prefix shown for display, not a pool: an address in
// it is not "DHCP Scope".
function functionalRangeLookup(ranges) {
  return ranges
    .filter((range) => range.range_type_is_system)
    .filter(
      (range) =>
        !range.dhcp_scope_id ||
        isAddressPoolScope({
          address_family: range.dhcp_address_family,
          v6_mode: range.dhcp_v6_mode,
        }),
    )
    .map((range) => ({
      ...range,
      start: addressToBig(range.start_ip).value,
      end: addressToBig(range.end_ip).value,
    }))
    .sort((left, right) => (left.start < right.start ? -1 : left.start > right.start ? 1 : 0));
}

// `ip` is an address string, or a numeric value for callers walking an IPv4
// prefix. Ranges belong to one subnet, so they share the address's family.
function addressValue(ip) {
  if (typeof ip === 'bigint') return ip;
  if (typeof ip === 'number') return BigInt(ip);
  return addressToBig(ip).value;
}

export function functionalRangeForIp(rangeLookup, ip) {
  const value = addressValue(ip);
  return rangeLookup.find((range) => value >= range.start && value <= range.end) || null;
}

/**
 * SQL that is true for a stored row with real facts: a claim, or any sign a
 * host was there. An IPv4 network keeps an empty row per address, and that
 * alone is not one. `alias` qualifies the columns when the query joins.
 */
export function rowHasFactsSql(alias = '') {
  const c = alias ? `${alias}.` : '';
  return `(${c}allocation_state <> 'unassigned' OR ${c}is_online = 1 OR ${c}is_rogue = 1
  OR ${c}first_seen_at IS NOT NULL OR ${c}last_seen_at IS NOT NULL
  OR ${c}mac_address IS NOT NULL OR ${c}last_seen_mac IS NOT NULL
  OR ${c}dhcp_duid IS NOT NULL OR ${c}hostname IS NOT NULL)`;
}

export function getSubnetIpReadContext(db, subnet) {
  const ranges = Range.listSubnetDetailRanges(db, subnet.id);
  return { ranges, rangeLookup: functionalRangeLookup(ranges) };
}

function attachFunctionalRange(row, rangeLookup) {
  const range = functionalRangeForIp(rangeLookup, row.ip_address);
  row.range_type_id = range?.range_type_id || null;
  row.range_type_name = range?.range_type_name || null;
  row.range_type_color = range?.range_type_color || null;
  return row;
}

// dhcp_expires_at is the newest lease dnsmasq holds for the address, active
// or not, so the Lease column can say "expired" here as it does in the DHCP
// table. Whether that lease still owns the address is the lifecycle state's
// call, made elsewhere.
// The WHERE clause of a network's persisted rows: one address, a range of
// sort keys (utils/cidr.js sortKeyRange) or the rows sorting below a key,
// and optionally only the unassigned ones or only those with real facts.
function persistedRowFilter(
  subnet,
  {
    ipAddress = null,
    sortKeyRange = null,
    belowKey = null,
    unassignedOnly = false,
    withFacts = false,
  } = {},
) {
  const clauses = ['ip.subnet_id = ?'];
  const params = [subnet.id];
  if (ipAddress) {
    clauses.push('ip.ip_address = ?');
    params.push(ipAddress);
  }
  if (sortKeyRange) {
    clauses.push('ip.address_sort_key BETWEEN ? AND ?');
    params.push(...sortKeyRange);
  }
  if (belowKey) {
    clauses.push('ip.address_sort_key < ?');
    params.push(belowKey);
  }
  if (unassignedOnly) {
    clauses.push('ip.allocation_state = ?');
    params.push(ALLOCATION_STATE.UNASSIGNED);
  }
  if (withFacts) clauses.push(rowHasFactsSql('ip'));
  return { where: clauses.join(' AND '), params };
}

/** How many rows a network stores, narrowed as persistedRowFilter allows. */
export function countPersistedSubnetIps(db, subnet, filter = {}) {
  const { where, params } = persistedRowFilter(subnet, filter);
  return db.prepare(`SELECT COUNT(*) AS n FROM ip_addresses ip WHERE ${where}`).get(...params).n;
}

// `limit` pages the rows in address order (the subnet_id, address_sort_key
// index); without it every matching row loads.
export function projectPersistedSubnetIpRows(
  db,
  subnet,
  { context = null, limit = null, offset = 0, ...filter } = {},
) {
  const readContext = context || getSubnetIpReadContext(db, subnet);
  const { where, params } = persistedRowFilter(subnet, filter);
  let page = '';
  if (limit !== null) {
    page = 'ORDER BY ip.address_sort_key, ip.interface_id LIMIT ? OFFSET ?';
    params.push(limit, offset);
  }
  const rows = db
    .prepare(
      `
      SELECT ip.*,
        CASE WHEN dr.id IS NOT NULL THEN 1 ELSE 0 END as has_dhcp_reservation,
        (SELECT dl.expires_at FROM dhcp_leases dl
          WHERE dl.subnet_id = ip.subnet_id AND dl.ip_address = ip.ip_address
          ORDER BY ${reservedLeaseFirstSql('dl')}, dl.expires_at DESC
          LIMIT 1) as dhcp_expires_at,
        CASE WHEN ${staticDnsClaimSql('ip.ip_address')} THEN 1 ELSE 0 END as has_static_dns
      FROM ip_addresses ip
      LEFT JOIN dhcp_reservations dr ON dr.subnet_id = ip.subnet_id AND dr.ip_address = ip.ip_address
      WHERE ${where}
      ${page}
    `,
    )
    .all(...params);
  for (const row of rows) attachFunctionalRange(row, readContext.rangeLookup);
  enrichIpViewRows(db, rows);
  return rows;
}

export function projectVirtualSubnetIpRow(db, subnet, ip, context = null) {
  const readContext = context || getSubnetIpReadContext(db, subnet);
  const functionalRange = functionalRangeForIp(readContext.rangeLookup, ip);
  const row = buildVirtualSubnetIpRow(subnet, ip, functionalRange);
  enrichIpViewRows(db, [row]);
  return row;
}

export function getCanonicalSubnetIpRow(db, subnet, ipAddress, context = null) {
  const readContext = context || getSubnetIpReadContext(db, subnet);
  return (
    projectPersistedSubnetIpRows(db, subnet, { ipAddress, context: readContext })[0] ||
    projectVirtualSubnetIpRow(db, subnet, ipAddress, readContext)
  );
}

// Counted in SQL, so a busy IPv6 network is never loaded whole. An address
// stored on two interfaces counts once. Only unassigned rows can be rogue,
// and ip-view still decides which are.
export function summarizeCanonicalSubnetIps(db, subnet) {
  const parsed = parseNetwork(subnet.cidr);
  // Null when the prefix holds more addresses than a Number represents (IPv6).
  const totalAddresses = parsed.size;
  const context = getSubnetIpReadContext(db, subnet);
  const counts = db
    .prepare(
      `
      SELECT COUNT(*) AS known, COALESCE(SUM(assigned), 0) AS assigned,
             COALESCE(SUM(online), 0) AS online
        FROM (SELECT MAX(allocation_state <> ?) AS assigned, MAX(is_online = 1) AS online
                FROM ip_addresses WHERE subnet_id = ? GROUP BY ip_address)
    `,
    )
    .get(ALLOCATION_STATE.UNASSIGNED, subnet.id);
  const rogue = new Set(
    projectPersistedSubnetIpRows(db, subnet, { context, unassignedOnly: true })
      .filter((row) => row.address_type === ADDRESS_TYPE.ROGUE)
      .map((row) => row.ip_address),
  );

  // The topology addresses are rows whether or not anything is stored.
  const protectedAddresses = new Set(
    parsed.family === 4 ? [parsed.network, parsed.broadcast] : [parsed.network],
  );
  if (subnet.gateway_address && parsedNetworkContains(parsed, subnet.gateway_address)) {
    protectedAddresses.add(subnet.gateway_address);
  }
  const virtualRows = [...protectedAddresses]
    .filter((ipAddress) => countPersistedSubnetIps(db, subnet, { ipAddress }) === 0)
    .map((ipAddress) => projectVirtualSubnetIpRow(db, subnet, ipAddress, context));
  for (const row of virtualRows) {
    if (row.address_type === ADDRESS_TYPE.ROGUE) rogue.add(row.ip_address);
  }

  // Each address once per state it holds; one held in two states on two
  // interfaces counts under both rather than under a picked winner.
  const byState = Object.fromEntries(
    db
      .prepare(
        `SELECT allocation_state AS state, COUNT(DISTINCT ip_address) AS count
           FROM ip_addresses WHERE subnet_id = ? AND allocation_state <> ?
          GROUP BY allocation_state`,
      )
      .all(subnet.id, ALLOCATION_STATE.UNASSIGNED)
      .map((row) => [row.state, row.count]),
  );
  for (const row of virtualRows) {
    if (row.allocation_state !== ALLOCATION_STATE.UNASSIGNED)
      byState[row.allocation_state] = (byState[row.allocation_state] || 0) + 1;
  }
  // Seen: no claim on any interface, but online or rogue.
  const unclaimedOnline = db
    .prepare(
      `SELECT ip_address FROM ip_addresses WHERE subnet_id = ? GROUP BY ip_address
        HAVING MAX(allocation_state <> ?) = 0 AND MAX(is_online = 1) = 1`,
    )
    .all(subnet.id, ALLOCATION_STATE.UNASSIGNED)
    .map((row) => row.ip_address);
  const claimed = new Set(
    db
      .prepare(
        `SELECT DISTINCT ip_address FROM ip_addresses WHERE subnet_id = ? AND allocation_state <> ?`,
      )
      .all(subnet.id, ALLOCATION_STATE.UNASSIGNED)
      .map((row) => row.ip_address),
  );
  const seen = new Set(unclaimedOnline);
  for (const ip of rogue) if (!claimed.has(ip)) seen.add(ip);
  for (const row of virtualRows) {
    if (row.allocation_state === ALLOCATION_STATE.UNASSIGNED && row.is_online)
      seen.add(row.ip_address);
  }
  byState.seen = seen.size;
  const pool = dhcpPoolUse(db, subnet.id).get(subnet.id);

  const knownCount = counts.known + virtualRows.length;
  const assignedCount =
    counts.assigned +
    virtualRows.filter((row) => row.allocation_state !== ALLOCATION_STATE.UNASSIGNED).length;
  return {
    subnet_id: subnet.id,
    total_addresses: totalAddresses,
    known_count: knownCount,
    assigned_count: assignedCount,
    unassigned_count: totalAddresses == null ? null : totalAddresses - assignedCount,
    online_count: counts.online + virtualRows.filter((row) => Boolean(row.is_online)).length,
    rogue_count: rogue.size,
    by_state: byState,
    pool_size: pool?.pool_size ?? null,
    pool_in_use: pool?.pool_in_use ?? null,
  };
}
