import { activeLeaseSql } from '../utils/lease-sql.js';
import { ipToLong, isIpInSubnet, longToIp, parseCidr } from '../utils/ip.js';
import { staticDnsClaimSql } from './dns-record.js';
import { ADDRESS_TYPE, buildVirtualSubnetIpRow, enrichIpViewRows } from './ip-view.js';
import * as Range from './range.js';

function functionalRangeLookup(ranges) {
  return ranges
    .filter((range) => range.range_type_is_system)
    .map((range) => ({
      ...range,
      startLong: ipToLong(range.start_ip),
      endLong: ipToLong(range.end_ip),
    }))
    .sort((left, right) => left.startLong - right.startLong);
}

export function functionalRangeForIp(rangeLookup, ip) {
  const ipLong = typeof ip === 'number' ? ip : ipToLong(ip);
  return rangeLookup.find((range) => ipLong >= range.startLong && ipLong <= range.endLong) || null;
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

export function projectPersistedSubnetIpRows(
  db,
  subnet,
  { ipAddress = null, context = null } = {},
) {
  const readContext = context || getSubnetIpReadContext(db, subnet);
  const params = [subnet.id];
  const identityFilter = ipAddress ? 'AND ip.ip_address = ?' : '';
  if (ipAddress) params.push(ipAddress);
  const rows = db
    .prepare(
      `
      SELECT ip.*,
        CASE WHEN dr.id IS NOT NULL THEN 1 ELSE 0 END as has_dhcp_reservation,
        dl.expires_at as dhcp_expires_at,
        CASE WHEN ${staticDnsClaimSql('ip.ip_address')} THEN 1 ELSE 0 END as has_static_dns
      FROM ip_addresses ip
      LEFT JOIN dhcp_reservations dr ON dr.subnet_id = ip.subnet_id AND dr.ip_address = ip.ip_address
      LEFT JOIN dhcp_leases dl
        ON dl.subnet_id = ip.subnet_id
       AND dl.ip_address = ip.ip_address
       AND ${activeLeaseSql('dl')}
      WHERE ip.subnet_id = ? ${identityFilter}
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

export function summarizeCanonicalSubnetIps(db, subnet) {
  const parsed = parseCidr(subnet.cidr);
  const totalAddresses = parsed.broadcastLong - parsed.networkLong + 1;
  const context = getSubnetIpReadContext(db, subnet);
  const persistedRows = projectPersistedSubnetIpRows(db, subnet, { context });
  const rowsByAddress = new Map(persistedRows.map((row) => [row.ip_address, row]));
  const protectedAddresses = new Set([
    longToIp(parsed.networkLong),
    longToIp(parsed.broadcastLong),
  ]);
  if (subnet.gateway_address && isIpInSubnet(subnet.gateway_address, subnet.cidr)) {
    protectedAddresses.add(subnet.gateway_address);
  }
  for (const ipAddress of protectedAddresses) {
    if (!rowsByAddress.has(ipAddress)) {
      rowsByAddress.set(ipAddress, projectVirtualSubnetIpRow(db, subnet, ipAddress, context));
    }
  }

  const canonicalRows = [...rowsByAddress.values()];
  const assignedCount = canonicalRows.filter((row) => row.allocation_state !== 'unassigned').length;
  return {
    subnet_id: subnet.id,
    total_addresses: totalAddresses,
    assigned_count: assignedCount,
    unassigned_count: totalAddresses - assignedCount,
    online_count: canonicalRows.filter((row) => Boolean(row.is_online)).length,
    rogue_count: canonicalRows.filter((row) => row.address_type === ADDRESS_TYPE.ROGUE).length,
  };
}
