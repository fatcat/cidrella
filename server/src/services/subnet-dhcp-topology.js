import { getSetting } from '../db/init.js';
import { FALLBACK_SECONDARY_DNS } from '../config/defaults.js';
import { parseCidr, ipToLong, longToIp, getServerIpForSubnet } from '../utils/ip.js';
import { addScopePool, dynamicPoolConflict, getScopePools } from '../models/dhcp-scope.js';

export function insertScopeOptionsFromDefaults(db, scopeId, parsed, gateway, domain, cidr) {
  const enabledRows = db.prepare('SELECT option_code, value FROM dhcp_option_defaults WHERE enabled_by_default = 1').all();
  const optionValues = new Map();
  for (const row of enabledRows) {
    optionValues.set(row.option_code, row.value != null ? row.value : null);
  }
  if (gateway) optionValues.set(3, gateway);
  optionValues.set(1, parsed.mask);
  optionValues.set(28, parsed.broadcast);
  if (domain) {
    if (!optionValues.has(15) || !optionValues.get(15)) optionValues.set(15, domain);
    if (!optionValues.has(119) || !optionValues.get(119)) optionValues.set(119, domain);
  }
  const serverIp = getServerIpForSubnet(cidr);
  if (serverIp && (!optionValues.has(6) || !optionValues.get(6))) {
    optionValues.set(6, `${serverIp}, ${FALLBACK_SECONDARY_DNS}`);
  }
  const insertOpt = db.prepare('INSERT INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)');
  for (const [code, value] of optionValues) {
    if (value != null && value !== '') insertOpt.run(scopeId, code, String(value));
  }
}

export function createAutoScope(db, subnetId, parsed, gateway, domainName, pool) {
  const dhcpType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope' AND is_system = 1").get();
  if (!dhcpType) return null;
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
  const conflict = dynamicPoolConflict(
    db,
    { ...subnet, gateway_address: gateway },
    longToIp(pool.startLong),
    longToIp(pool.endLong)
  );
  if (conflict) throw new Error(conflict.error);

  const rangeResult = db.prepare(
    'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)'
  ).run(subnetId, dhcpType.id, longToIp(pool.startLong), longToIp(pool.endLong), 'DHCP scope');

  const effectiveDomain = domainName || null;
  const scopeResult = db.prepare(`
    INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, gateway, domain_name, description)
    VALUES (?, ?, ?, ?, ?, 'Auto-created DHCP scope')
  `).run(rangeResult.lastInsertRowid, subnetId, getSetting('default_lease_time'), gateway, effectiveDomain);
  db.prepare(`
    INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
    VALUES (?, ?, ?, ?)
  `).run(scopeResult.lastInsertRowid, rangeResult.lastInsertRowid,
    longToIp(pool.startLong), longToIp(pool.endLong));

  insertScopeOptionsFromDefaults(db, scopeResult.lastInsertRowid, parsed, gateway, effectiveDomain, `${parsed.network}/${parsed.prefix}`);
  return scopeResult.lastInsertRowid;
}

export function autoCreateDhcpScope(db, subnetId, parsed, gateway, domainName, defaults) {
  if (!defaults) return null;

  const ipCount = db.prepare("SELECT COUNT(*) as c FROM ip_addresses WHERE subnet_id = ? AND allocation_state != 'unassigned'").get(subnetId);
  if (ipCount.c > 0) return null;
  const leaseCount = db.prepare('SELECT COUNT(*) as c FROM dhcp_leases WHERE subnet_id = ?').get(subnetId);
  if (leaseCount.c > 0) return null;
  const resCount = db.prepare('SELECT COUNT(*) as c FROM dhcp_reservations WHERE subnet_id = ?').get(subnetId);
  if (resCount.c > 0) return null;
  const existingScope = db.prepare(`
    SELECT r.id FROM ranges r JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.subnet_id = ? AND rt.name = 'DHCP Scope'
  `).get(subnetId);
  if (existingScope) return null;

  let { startLong, endLong } = defaults;
  const gwLong = gateway ? ipToLong(gateway) : null;
  if (gwLong === startLong) startLong++;
  else if (gwLong === endLong) endLong--;
  if (startLong > endLong) return null;

  return createAutoScope(db, subnetId, parsed, gateway, domainName, { startLong, endLong });
}

export function cloneParentScopesToChild(db, parentId, childId, childParsed, childGw) {
  const poolAdjustments = [];

  const parentScopes = db.prepare('SELECT * FROM dhcp_scopes WHERE subnet_id = ?').all(parentId);

  const gwLong = childGw ? ipToLong(childGw) : null;

  for (const ps of parentScopes) {
    const segments = [];
    const sourcePools = getScopePools(db, ps.id);
    for (const pool of sourcePools) {
      const rStart = ipToLong(pool.start_ip);
      const rEnd = ipToLong(pool.end_ip);
      const clippedStart = Math.max(rStart, childParsed.networkLong + 1);
      const clippedEnd = Math.min(rEnd, childParsed.broadcastLong - 1);
      if (clippedStart > clippedEnd) continue;
      const parts = gwLong == null || gwLong < clippedStart || gwLong > clippedEnd
        ? [{ start: clippedStart, end: clippedEnd }]
        : [{ start: clippedStart, end: gwLong - 1 }, { start: gwLong + 1, end: clippedEnd }]
          .filter(segment => segment.start <= segment.end);
      segments.push(...parts);
      if (parts.length !== 1 || parts[0]?.start !== clippedStart || parts[0]?.end !== clippedEnd) {
      poolAdjustments.push({
        child_id: childId,
        child_cidr: `${childParsed.network}/${childParsed.prefix}`,
        gateway: childGw,
        pool_was: { start_ip: longToIp(clippedStart), end_ip: longToIp(clippedEnd) },
        pool_now: parts[0]
          ? { start_ip: longToIp(parts[0].start), end_ip: longToIp(parts[0].end) }
          : null,
        additional_pools: parts.slice(1).map(segment => ({
          start_ip: longToIp(segment.start), end_ip: longToIp(segment.end)
        }))
      });
      }
    }
    if (!segments.length) continue;
    const dhcpType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope' AND is_system = 1").get();
    if (!dhcpType) continue;
    const first = segments[0];
    const newRange = db.prepare(
      'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)'
    ).run(childId, dhcpType.id, longToIp(first.start), longToIp(first.end), ps.description);
    const newScope = db.prepare(`
          INSERT INTO dhcp_scopes
            (range_id, subnet_id, lease_time, dns_servers, domain_name, gateway,
             enabled, description, ntp_servers, domain_search)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newRange.lastInsertRowid, childId, ps.lease_time, ps.dns_servers,
      ps.domain_name, childGw, ps.enabled, ps.description, ps.ntp_servers, ps.domain_search);
    db.prepare(`INSERT INTO dhcp_scope_pools
      (scope_id, range_id, start_ip, end_ip, sort_order) VALUES (?, ?, ?, ?, 0)`)
      .run(newScope.lastInsertRowid, newRange.lastInsertRowid,
        longToIp(first.start), longToIp(first.end));
    for (const [index, segment] of segments.slice(1).entries()) {
      addScopePool(db, newScope.lastInsertRowid, childId, dhcpType.id,
        longToIp(segment.start), longToIp(segment.end), ps.description, index + 1);
    }
    db.prepare('INSERT INTO dhcp_scope_options (scope_id, option_code, value) SELECT ?, option_code, value FROM dhcp_scope_options WHERE scope_id = ?')
      .run(newScope.lastInsertRowid, ps.id);
    rebaseScopeTopologyOptions(db, newScope.lastInsertRowid, childParsed, childGw);
  }

  return poolAdjustments;
}

export function deleteDhcpStateForSubnet(db, subnetId) {
  db.prepare(
    'DELETE FROM dhcp_scope_options WHERE scope_id IN (SELECT id FROM dhcp_scopes WHERE subnet_id = ?)'
  ).run(subnetId);
  db.prepare('DELETE FROM dhcp_scopes WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ?').run(subnetId);
}

export function moveReservationsToChildren(db, parentId) {
  const children = db.prepare('SELECT id, cidr FROM subnets WHERE parent_id = ?').all(parentId);
  if (children.length === 0) return;
  const childRanges = children.map(c => {
    const p = parseCidr(c.cidr);
    return { id: c.id, netLong: p.networkLong, bcastLong: p.broadcastLong };
  });
  const findChildForIp = (ipLong) =>
    childRanges.find(c => ipLong >= c.netLong && ipLong <= c.bcastLong);

  const reservations = db.prepare(
    'SELECT id, ip_address FROM dhcp_reservations WHERE subnet_id = ?'
  ).all(parentId);
  const updRes = db.prepare('UPDATE dhcp_reservations SET subnet_id = ? WHERE id = ?');
  for (const r of reservations) {
    const c = findChildForIp(ipToLong(r.ip_address));
    if (c) updRes.run(c.id, r.id);
  }
}

export function moveLeasesToChildren(db, parentId) {
  const children = db.prepare('SELECT id, cidr FROM subnets WHERE parent_id = ?').all(parentId);
  const childRanges = children.map(child => {
    const parsed = parseCidr(child.cidr);
    return { id: child.id, start: parsed.networkLong, end: parsed.broadcastLong };
  });
  const leases = db.prepare('SELECT id, ip_address FROM dhcp_leases WHERE subnet_id = ?').all(parentId);
  const update = db.prepare('UPDATE dhcp_leases SET subnet_id = ? WHERE id = ?');
  for (const lease of leases) {
    const value = ipToLong(lease.ip_address);
    const child = childRanges.find(range => value >= range.start && value <= range.end);
    if (child) update.run(child.id, lease.id);
  }
}

export function deleteReservationsAndLeasesByIps(db, ips) {
  const removed = { reservations: 0, leases: 0 };
  const delRes = db.prepare('DELETE FROM dhcp_reservations WHERE ip_address = ?');
  const delLease = db.prepare('DELETE FROM dhcp_leases WHERE ip_address = ?');
  for (const ip of ips) {
    removed.reservations += delRes.run(ip).changes;
    removed.leases += delLease.run(ip).changes;
  }
  return removed;
}

export function deleteChildReservationById(db, parentId, id) {
  return db.prepare(`
    DELETE FROM dhcp_reservations WHERE id = ?
      AND subnet_id IN (SELECT id FROM subnets WHERE parent_id = ?)
  `).run(id, parentId);
}

export function deleteChildLeaseById(db, parentId, id) {
  return db.prepare(`
    DELETE FROM dhcp_leases WHERE id = ?
      AND subnet_id IN (SELECT id FROM subnets WHERE parent_id = ?)
  `).run(id, parentId);
}

export function moveReservationsToSubnet(db, childIds, mergedId) {
  if (!Array.isArray(childIds) || childIds.length === 0) return;
  const placeholders = childIds.map(() => '?').join(',');
  // The merge planner rejects duplicate MAC/IP identities before mutation.
  // Let the database uniqueness constraints abort the transaction if a caller
  // ever bypasses that preflight; never delete a competing reservation here.
  db.prepare(`
    UPDATE dhcp_reservations SET subnet_id = ?
    WHERE subnet_id IN (${placeholders})
  `).run(mergedId, ...childIds);
}

export function moveLeasesToSubnet(db, childIds, mergedId) {
  if (!Array.isArray(childIds) || childIds.length === 0) return;
  const placeholders = childIds.map(() => '?').join(',');
  db.prepare(`UPDATE dhcp_leases SET subnet_id = ? WHERE subnet_id IN (${placeholders})`)
    .run(mergedId, ...childIds);
}

export function rebaseScopeTopologyOptions(db, scopeId, parsed, gateway) {
  db.prepare('DELETE FROM dhcp_scope_options WHERE scope_id = ? AND option_code IN (1, 3, 28)')
    .run(scopeId);
  const insert = db.prepare(
    'INSERT INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)'
  );
  insert.run(scopeId, 1, parsed.mask);
  if (gateway) insert.run(scopeId, 3, gateway);
  insert.run(scopeId, 28, parsed.broadcast);
}

export function rebaseScopeForNetwork(db, scopeId, parsed, gateway) {
  rebaseScopeTopologyOptions(db, scopeId, parsed, gateway);
  return db.prepare('UPDATE dhcp_scopes SET gateway = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(gateway, scopeId);
}

export function moveScopesToSubnet(db, sourceIds, mergedId, parsed, gateway) {
  const ids = (Array.isArray(sourceIds) ? sourceIds : [sourceIds])
    .filter(id => id && id !== mergedId);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');

  db.prepare(`
    UPDATE ranges SET subnet_id = ?
    WHERE subnet_id IN (${placeholders})
      AND range_type_id = (SELECT id FROM range_types WHERE name = 'DHCP Scope' AND is_system = 1)
  `).run(mergedId, ...ids);

  db.prepare(
    `UPDATE dhcp_scopes SET subnet_id = ?, gateway = ? WHERE subnet_id IN (${placeholders})`
  ).run(mergedId, gateway, ...ids);
  const scopes = db.prepare('SELECT id FROM dhcp_scopes WHERE subnet_id = ?').all(mergedId);
  for (const scope of scopes) rebaseScopeTopologyOptions(db, scope.id, parsed, gateway);
}

export function deleteDhcpStateForSubtree(db, parentId) {
  const tree = 'WITH RECURSIVE tree AS (SELECT id FROM subnets WHERE parent_id = ? UNION ALL SELECT s.id FROM subnets s JOIN tree t ON s.parent_id = t.id)';
  db.prepare(`${tree} DELETE FROM dhcp_scope_options WHERE scope_id IN (SELECT id FROM dhcp_scopes WHERE subnet_id IN (SELECT id FROM tree))`).run(parentId);
  db.prepare(`${tree} DELETE FROM dhcp_scopes WHERE subnet_id IN (SELECT id FROM tree)`).run(parentId);
  db.prepare(`${tree} DELETE FROM dhcp_leases WHERE subnet_id IN (SELECT id FROM tree)`).run(parentId);
}
