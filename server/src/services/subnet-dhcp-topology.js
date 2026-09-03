import { getSetting } from '../db/init.js';
import { FALLBACK_SECONDARY_DNS } from '../config/defaults.js';
import { parseCidr, ipToLong, longToIp, getServerIpForSubnet } from '../utils/ip.js';
import { dynamicPoolConflict } from '../models/dhcp-scope.js';

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

  insertScopeOptionsFromDefaults(db, scopeResult.lastInsertRowid, parsed, gateway, effectiveDomain, `${parsed.network}/${parsed.prefix}`);
  return scopeResult.lastInsertRowid;
}

export function autoCreateDhcpScope(db, subnetId, parsed, gateway, domainName, defaults) {
  if (!defaults) return null;

  const ipCount = db.prepare("SELECT COUNT(*) as c FROM ip_addresses WHERE subnet_id = ? AND status != 'available'").get(subnetId);
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

export function cloneParentScopesToChild(db, parentId, childId, childParsed, childGw, excludeGatewayFromPool) {
  const poolAdjustments = [];
  if (childParsed.prefix > 29) return poolAdjustments;

  const dhcpRanges = db.prepare(`
    SELECT r.* FROM ranges r
    JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.subnet_id = ? AND rt.name = 'DHCP Scope'
  `).all(parentId);

  const gwLong = childGw ? ipToLong(childGw) : null;

  for (const dhcpRange of dhcpRanges) {
    const rStart = ipToLong(dhcpRange.start_ip);
    const rEnd = ipToLong(dhcpRange.end_ip);
    let clippedStart = Math.max(rStart, childParsed.networkLong + 1);
    let clippedEnd = Math.min(rEnd, childParsed.broadcastLong - 1);
    if (clippedStart > clippedEnd) continue;

    const beforeStart = clippedStart;
    const beforeEnd = clippedEnd;
    const adj = excludeGatewayFromPool(clippedStart, clippedEnd, gwLong);
    clippedStart = adj.start;
    clippedEnd = adj.end;
    if (adj.adjusted) {
      poolAdjustments.push({
        child_id: childId,
        child_cidr: `${childParsed.network}/${childParsed.prefix}`,
        gateway: childGw,
        pool_was: { start_ip: longToIp(beforeStart), end_ip: longToIp(beforeEnd) },
        pool_now: clippedStart > clippedEnd
          ? null
          : { start_ip: longToIp(clippedStart), end_ip: longToIp(clippedEnd) },
      });
    }
    if (clippedStart > clippedEnd) continue;

    const dhcpType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope' AND is_system = 1").get();
    if (!dhcpType) continue;

    const newRange = db.prepare(
      'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)'
    ).run(childId, dhcpType.id, longToIp(clippedStart), longToIp(clippedEnd), dhcpRange.description);

    const parentScopes = db.prepare(
      'SELECT * FROM dhcp_scopes WHERE subnet_id = ? AND range_id = ?'
    ).all(parentId, dhcpRange.id);
    for (const ps of parentScopes) {
      const newScope = db.prepare(`
        INSERT INTO dhcp_scopes
          (range_id, subnet_id, lease_time, dns_servers, domain_name, gateway,
           enabled, description, ntp_servers, domain_search)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newRange.lastInsertRowid, childId,
        ps.lease_time, ps.dns_servers, ps.domain_name, ps.gateway,
        ps.enabled, ps.description, ps.ntp_servers, ps.domain_search
      );
      db.prepare(
        'INSERT INTO dhcp_scope_options (scope_id, option_code, value) SELECT ?, option_code, value FROM dhcp_scope_options WHERE scope_id = ?'
      ).run(newScope.lastInsertRowid, ps.id);
    }
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

export function moveReservationsToSubnet(db, childIds, mergedId) {
  if (!Array.isArray(childIds) || childIds.length === 0) return;
  const placeholders = childIds.map(() => '?').join(',');

  const childRes = db.prepare(
    `SELECT id, mac_address, ip_address FROM dhcp_reservations WHERE subnet_id IN (${placeholders})`
  ).all(...childIds);
  const findMacDup = db.prepare(
    'SELECT id FROM dhcp_reservations WHERE subnet_id = ? AND mac_address = ?'
  );
  const findIpDup = db.prepare(
    'SELECT id FROM dhcp_reservations WHERE subnet_id = ? AND ip_address = ?'
  );
  const delRes = db.prepare('DELETE FROM dhcp_reservations WHERE id = ?');
  const updRes = db.prepare('UPDATE dhcp_reservations SET subnet_id = ? WHERE id = ?');
  for (const r of childRes) {
    const macDup = findMacDup.get(mergedId, r.mac_address);
    if (macDup && macDup.id !== r.id) delRes.run(macDup.id);
    const ipDup = findIpDup.get(mergedId, r.ip_address);
    if (ipDup && ipDup.id !== r.id) delRes.run(ipDup.id);
    updRes.run(mergedId, r.id);
  }
}

export function moveScopesToSubnet(db, configSourceId, mergedId) {
  if (!configSourceId || configSourceId === mergedId) return;

  db.prepare(`
    UPDATE ranges SET subnet_id = ?
    WHERE subnet_id = ?
      AND range_type_id = (SELECT id FROM range_types WHERE name = 'DHCP Scope' AND is_system = 1)
  `).run(mergedId, configSourceId);

  db.prepare(
    `UPDATE dhcp_scopes SET subnet_id = ? WHERE subnet_id = ?`
  ).run(mergedId, configSourceId);
}

export function deleteDhcpStateForSubtree(db, parentId) {
  const tree = 'WITH RECURSIVE tree AS (SELECT id FROM subnets WHERE parent_id = ? UNION ALL SELECT s.id FROM subnets s JOIN tree t ON s.parent_id = t.id)';
  db.prepare(`${tree} DELETE FROM dhcp_scope_options WHERE scope_id IN (SELECT id FROM dhcp_scopes WHERE subnet_id IN (SELECT id FROM tree))`).run(parentId);
  db.prepare(`${tree} DELETE FROM dhcp_scopes WHERE subnet_id IN (SELECT id FROM tree)`).run(parentId);
  db.prepare(`${tree} DELETE FROM dhcp_leases WHERE subnet_id IN (SELECT id FROM tree)`).run(parentId);
}
