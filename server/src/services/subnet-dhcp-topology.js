import { getSetting } from '../db/init.js';
import { FALLBACK_SECONDARY_DNS } from '../config/defaults.js';
import {
  parseNetwork,
  ipToLong,
  longToIp,
  addressToBig,
  bigToAddress,
  addressAtOffset,
  getServerIpForSubnet,
} from '../utils/ip.js';
import { addressFamily } from '../utils/address.js';
import { dynamicPoolConflict } from '../models/dhcp-scope.js';
import { dhcpV6ModesFor } from '../utils/cidr.js';

function nearestPow2(n) {
  if (n <= 1) return 1;
  const lower = 2 ** Math.floor(Math.log2(n));
  const upper = lower * 2;
  return n - lower <= upper - n ? lower : upper;
}

export function defaultDhcpPoolForSubnet(parsed, gateway = null) {
  // IPv4 only: the automatic pool is sized from the address count. IPv6
  // scopes are created by mode (slaac, stateless, stateful) instead.
  if (parsed.family !== 4) return null;
  if (parsed.prefix < 16 || parsed.prefix > 29) return null;
  const size = parsed.totalAddresses;
  let poolEnd;
  let poolSize;
  if (parsed.prefix >= 21 && parsed.prefix <= 23) {
    poolEnd = parsed.networkLong + 128;
    poolSize = 64;
  } else {
    poolEnd = parsed.networkLong + nearestPow2(size * 0.35);
    poolSize = Math.max(2, nearestPow2(size * 0.15));
  }
  let startLong = Math.max(poolEnd - poolSize + 1, parsed.networkLong + 1);
  let endLong = Math.min(poolEnd, parsed.broadcastLong - 1);
  const gatewayLong = gateway ? ipToLong(gateway) : null;
  if (gatewayLong === startLong) startLong++;
  else if (gatewayLong === endLong) endLong--;
  return startLong <= endLong ? { startLong, endLong } : null;
}

/**
 * The default stateful DHCPv6 pool: 4096 addresses starting at offset 0x1000
 * of the prefix, well clear of the low addresses operators hand out by hand.
 * A prefix too small to hold that offset gets its whole usable range. A
 * prefix shorter than /64 gets none (no DHCPv6 scope fits it, see
 * dhcpV6ModesFor). Like the IPv4 default, the pool is shaped around the
 * gateway rather than refused for containing it: at an end it steps past it,
 * in the middle it keeps the larger side.
 */
export function defaultDhcpV6PoolForSubnet(parsed, gateway = null) {
  if (parsed.family !== 6) return null;
  if (parsed.prefix < 64 || parsed.prefix >= parsed.bits - 1) return null;
  const pool =
    parsed.sizeBig > 0x2000n
      ? {
          start: addressToBig(addressAtOffset(parsed, 0x1000)).value,
          end: addressToBig(addressAtOffset(parsed, 0x1fff)).value,
        }
      : {
          start: addressToBig(parsed.firstUsable).value,
          end: addressToBig(parsed.lastUsable).value,
        };
  const gw = gateway && addressFamily(gateway) === 6 ? addressToBig(gateway).value : null;
  if (gw !== null && gw >= pool.start && gw <= pool.end) {
    if (gw === pool.start) pool.start += 1n;
    else if (gw === pool.end) pool.end -= 1n;
    else if (pool.end - gw >= gw - pool.start) pool.start = gw + 1n;
    else pool.end = gw - 1n;
  }
  if (pool.start > pool.end) return null;
  return { start_ip: bigToAddress(pool.start, 6), end_ip: bigToAddress(pool.end, 6) };
}

/**
 * Create the DHCPv6 scope for a network. `mode` is slaac, stateless or
 * stateful. The scope's range covers the pool for stateful, and the usable
 * prefix for the two SLAAC modes (a display projection dnsmasq never sees
 * as a pool). No router, mask or broadcast options exist in DHCPv6.
 */
export function createAutoScopeV6(db, subnetId, parsed, domainName, { mode, pool = null }) {
  const dhcpType = db
    .prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope' AND is_system = 1")
    .get();
  if (!dhcpType) return null;
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
  const interval =
    mode === 'stateful'
      ? pool || defaultDhcpV6PoolForSubnet(parsed, subnet.gateway_address)
      : { start_ip: parsed.firstUsable, end_ip: parsed.lastUsable };
  if (!interval) return null;
  if (mode === 'stateful') {
    const conflict = dynamicPoolConflict(db, subnet, interval.start_ip, interval.end_ip);
    // A conflict is the operator's to resolve (409), not a server fault.
    if (conflict) throw Object.assign(new Error(conflict.error), { status: 409 });
  }

  const rangeResult = db
    .prepare(
      'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)',
    )
    .run(
      subnetId,
      dhcpType.id,
      interval.start_ip,
      interval.end_ip,
      mode === 'stateful' ? 'DHCPv6 pool' : `DHCPv6 ${mode}`,
    );
  const scopeResult = db
    .prepare(
      `
    INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, domain_name, description,
      address_family, v6_mode)
    VALUES (?, ?, ?, ?, 'Auto-created DHCPv6 scope', 6, ?)
  `,
    )
    .run(
      rangeResult.lastInsertRowid,
      subnetId,
      getSetting('default_lease_time'),
      domainName || null,
      mode,
    );
  db.prepare(
    `
    INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
    VALUES (?, ?, ?, ?)
  `,
  ).run(
    scopeResult.lastInsertRowid,
    rangeResult.lastInsertRowid,
    interval.start_ip,
    interval.end_ip,
  );
  // Every mode inherits the IPv6 defaults, including slaac where dnsmasq
  // sends no options: switching the scope to stateful later then needs no
  // repair, and the config writer already emits nothing for slaac.
  insertScopeOptionsFromDefaults(
    db,
    scopeResult.lastInsertRowid,
    parsed,
    null,
    domainName || null,
    subnet.cidr,
  );
  return scopeResult.lastInsertRowid;
}

/**
 * Copy the family's enabled-by-default options into a new scope, filling the
 * ones that default to a network fact (see fillScopeOptions).
 */
export function insertScopeOptionsFromDefaults(db, scopeId, parsed, gateway, domain, cidr) {
  const family = parsed.family === 6 ? 6 : 4;
  const enabledRows = db
    .prepare(
      'SELECT option_code, value FROM dhcp_option_defaults WHERE enabled_by_default = 1 AND address_family = ?',
    )
    .all(family);
  const optionValues = fillScopeOptions(
    enabledRows.map((row) => ({ code: row.option_code, value: row.value })),
    { parsed, gateway, domain, serverIp: getServerIpForSubnet(cidr) },
  );
  writeScopeOptionRows(db, scopeId, family, optionValues);
}

/**
 * The option set a scope gets from a list of enabled options, the way a new
 * scope gets it: a blank value that defaults to a network fact is filled.
 * IPv4 gets mask, router, broadcast, domain and DNS (CIDRella's address plus
 * the fallback resolver); IPv6 gets the search list (24) from the domain and
 * DNS (23) from CIDRella's IPv6 address on the network, with no fallback
 * since routers, prefixes and the rest come from Router Advertisements.
 * Returns a Map of code to value; a code still blank has a null value.
 */
export function fillScopeOptions(enabled, { parsed, gateway, domain, serverIp }) {
  const family = parsed.family === 6 ? 6 : 4;
  const optionValues = new Map();
  for (const { code, value } of enabled) {
    optionValues.set(Number(code), value != null && value !== '' ? String(value) : null);
  }
  const unset = (code) => !optionValues.get(code);
  if (family === 6) {
    if (domain && unset(24)) optionValues.set(24, domain);
    if (serverIp && unset(23)) optionValues.set(23, serverIp);
  } else {
    if (gateway) optionValues.set(3, gateway);
    optionValues.set(1, parsed.mask);
    optionValues.set(28, parsed.broadcast);
    if (domain) {
      if (unset(15)) optionValues.set(15, domain);
      if (unset(119)) optionValues.set(119, domain);
    }
    if (serverIp && unset(6)) {
      optionValues.set(6, `${serverIp}, ${FALLBACK_SECONDARY_DNS}`);
    }
  }
  return optionValues;
}

/** Store a scope's option rows from fillScopeOptions; blank values are skipped. */
export function writeScopeOptionRows(db, scopeId, family, optionValues) {
  const insertOpt = db.prepare(
    'INSERT INTO dhcp_scope_options (scope_id, option_code, value, address_family) VALUES (?, ?, ?, ?)',
  );
  for (const [code, value] of optionValues) {
    if (value != null && value !== '') insertOpt.run(scopeId, code, String(value), family);
  }
}

export function createAutoScope(db, subnetId, parsed, gateway, domainName, pool) {
  const dhcpType = db
    .prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope' AND is_system = 1")
    .get();
  if (!dhcpType) return null;
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnetId);
  const conflict = dynamicPoolConflict(
    db,
    { ...subnet, gateway_address: gateway },
    longToIp(pool.startLong),
    longToIp(pool.endLong),
  );
  if (conflict) throw new Error(conflict.error);

  const rangeResult = db
    .prepare(
      'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)',
    )
    .run(subnetId, dhcpType.id, longToIp(pool.startLong), longToIp(pool.endLong), 'DHCP scope');

  const effectiveDomain = domainName || null;
  const scopeResult = db
    .prepare(
      `
    INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, gateway, domain_name, description)
    VALUES (?, ?, ?, ?, ?, 'Auto-created DHCP scope')
  `,
    )
    .run(
      rangeResult.lastInsertRowid,
      subnetId,
      getSetting('default_lease_time'),
      gateway,
      effectiveDomain,
    );
  db.prepare(
    `
    INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
    VALUES (?, ?, ?, ?)
  `,
  ).run(
    scopeResult.lastInsertRowid,
    rangeResult.lastInsertRowid,
    longToIp(pool.startLong),
    longToIp(pool.endLong),
  );

  insertScopeOptionsFromDefaults(
    db,
    scopeResult.lastInsertRowid,
    parsed,
    gateway,
    effectiveDomain,
    `${parsed.network}/${parsed.prefix}`,
  );
  return scopeResult.lastInsertRowid;
}

export function autoCreateDhcpScope(db, subnetId, parsed, gateway, domainName, defaults) {
  if (!defaults) return null;

  const ipCount = db
    .prepare(
      "SELECT COUNT(*) as c FROM ip_addresses WHERE subnet_id = ? AND allocation_state != 'unassigned'",
    )
    .get(subnetId);
  if (ipCount.c > 0) return null;
  const leaseCount = db
    .prepare('SELECT COUNT(*) as c FROM dhcp_leases WHERE subnet_id = ?')
    .get(subnetId);
  if (leaseCount.c > 0) return null;
  const resCount = db
    .prepare('SELECT COUNT(*) as c FROM dhcp_reservations WHERE subnet_id = ?')
    .get(subnetId);
  if (resCount.c > 0) return null;
  const existingScope = db
    .prepare(
      `
    SELECT r.id FROM ranges r JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.subnet_id = ? AND rt.name = 'DHCP Scope'
  `,
    )
    .get(subnetId);
  if (existingScope) return null;

  let { startLong, endLong } = defaults;
  const gwLong = gateway ? ipToLong(gateway) : null;
  if (gwLong === startLong) startLong++;
  else if (gwLong === endLong) endLong--;
  if (startLong > endLong) return null;

  return createAutoScope(db, subnetId, parsed, gateway, domainName, { startLong, endLong });
}

function firstScopeForSubnets(db, subnetIds) {
  const ids = [...new Set((Array.isArray(subnetIds) ? subnetIds : [subnetIds]).map(Number))]
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  if (!ids.length) return null;
  const source =
    db
      .prepare(
        `SELECT * FROM dhcp_scopes
    WHERE subnet_id IN (${ids.map(() => '?').join(',')})
    ORDER BY subnet_id, id LIMIT 1`,
      )
      .get(...ids) || null;
  if (!source) return null;
  return {
    ...source,
    options: db
      .prepare(
        `SELECT option_code, value FROM dhcp_scope_options
      WHERE scope_id = ? ORDER BY option_code`,
      )
      .all(source.id),
  };
}

/**
 * The DHCPv6 scope a divide or merge target gets from its source scope: the
 * source's mode when the target's prefix allows it, with a default pool for
 * stateful; none when it does not (a SLAAC scope cannot follow a /64 split
 * into /65s, and no DHCPv6 scope fits a prefix shorter than /64). Mirrors the
 * IPv4 rule that a target too small for a default pool gets no scope.
 */
export function defaultV6ScopeForTarget(sourceMode, parsed, gateway) {
  if (!dhcpV6ModesFor(parsed.prefix).includes(sourceMode)) return null;
  if (sourceMode !== 'stateful') {
    return {
      mode: sourceMode,
      pool: null,
      interval: { start_ip: parsed.firstUsable, end_ip: parsed.lastUsable },
    };
  }
  const pool = defaultDhcpV6PoolForSubnet(parsed, gateway);
  return pool ? { mode: 'stateful', pool, interval: pool } : null;
}

function createDefaultScopeFromSource(db, source, targetId, parsed, gateway) {
  if (!source) return null;
  if (parsed.family === 6)
    return createDefaultV6ScopeFromSource(db, source, targetId, parsed, gateway);
  const pool = defaultDhcpPoolForSubnet(parsed, gateway);
  if (!pool) return null;
  const scopeId = createAutoScope(db, targetId, parsed, gateway, source.domain_name, pool);
  db.prepare(
    `
    UPDATE dhcp_scopes SET lease_time = ?, dns_servers = ?, domain_name = ?,
      gateway = ?, enabled = ?, description = ?, ntp_servers = ?,
      domain_search = ?, updated_at = datetime('now')
    WHERE id = ?
  `,
  ).run(
    source.lease_time,
    source.dns_servers,
    source.domain_name,
    gateway,
    source.enabled,
    source.description,
    source.ntp_servers,
    source.domain_search,
    scopeId,
  );
  db.prepare('DELETE FROM dhcp_scope_options WHERE scope_id = ?').run(scopeId);
  const insertOption = db.prepare(`
    INSERT INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)
  `);
  for (const option of source.options || []) {
    insertOption.run(scopeId, option.option_code, option.value);
  }
  rebaseScopeTopologyOptions(db, scopeId, parsed, gateway);
  return {
    scopeId,
    interval: { start_ip: longToIp(pool.startLong), end_ip: longToIp(pool.endLong) },
  };
}

// IPV6-10: divide and merge used to drop a DHCPv6 scope, because the IPv4
// default pool exists only for IPv4.
function createDefaultV6ScopeFromSource(db, source, targetId, parsed, gateway) {
  const plan = defaultV6ScopeForTarget(source.v6_mode, parsed, gateway);
  if (!plan) return null;
  const scopeId = createAutoScopeV6(db, targetId, parsed, source.domain_name, {
    mode: plan.mode,
    pool: plan.pool,
  });
  if (!scopeId) return null;
  db.prepare(
    `
    UPDATE dhcp_scopes SET lease_time = ?, domain_name = ?, enabled = ?, description = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `,
  ).run(source.lease_time, source.domain_name, source.enabled, source.description, scopeId);
  // The source's DHCPv6 options, in their own namespace, replace the defaults.
  db.prepare('DELETE FROM dhcp_scope_options WHERE scope_id = ?').run(scopeId);
  const insertOption = db.prepare(
    'INSERT INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)',
  );
  for (const option of source.options || []) {
    insertOption.run(scopeId, option.option_code, option.value);
  }
  return { scopeId, interval: plan.interval, mode: plan.mode };
}

export function createDefaultScopeForChild(db, parentId, childId, childParsed, childGw) {
  const source = firstScopeForSubnets(db, parentId);
  const created = createDefaultScopeFromSource(db, source, childId, childParsed, childGw);
  if (!created) return [];
  return [
    {
      child_id: childId,
      child_cidr: `${childParsed.network}/${childParsed.prefix}`,
      gateway: childGw,
      reason: 'default_scope_created',
      pool_was: null,
      pool_now: created.interval,
      additional_pools: [],
    },
  ];
}

export function deleteDhcpStateForSubnet(db, subnetId) {
  db.prepare(
    'DELETE FROM dhcp_scope_options WHERE scope_id IN (SELECT id FROM dhcp_scopes WHERE subnet_id = ?)',
  ).run(subnetId);
  db.prepare('DELETE FROM dhcp_scopes WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ?').run(subnetId);
}

export function moveReservationsToChildren(db, parentId) {
  const children = db.prepare('SELECT id, cidr FROM subnets WHERE parent_id = ?').all(parentId);
  if (children.length === 0) return;
  const childRanges = children.map((c) => ({ id: c.id, parsed: parseNetwork(c.cidr) }));
  const reservations = db
    .prepare('SELECT id, ip_address FROM dhcp_reservations WHERE subnet_id = ?')
    .all(parentId);
  const updRes = db.prepare('UPDATE dhcp_reservations SET subnet_id = ? WHERE id = ?');
  for (const r of reservations) {
    const c = childContaining(childRanges, r.ip_address);
    if (c) updRes.run(c.id, r.id);
  }
}

// The child whose prefix holds the address, or undefined. Unparseable rows
// (bad data from an old install) simply stay where they are.
function childContaining(childRanges, ip) {
  let address;
  try {
    address = addressToBig(ip);
  } catch {
    return undefined;
  }
  return childRanges.find(
    (c) =>
      c.parsed.family === address.family &&
      address.value >= c.parsed.networkBig &&
      address.value <= c.parsed.lastBig,
  );
}

export function moveLeasesToChildren(db, parentId) {
  const children = db.prepare('SELECT id, cidr FROM subnets WHERE parent_id = ?').all(parentId);
  const childRanges = children.map((child) => ({ id: child.id, parsed: parseNetwork(child.cidr) }));
  const leases = db
    .prepare('SELECT id, ip_address FROM dhcp_leases WHERE subnet_id = ?')
    .all(parentId);
  const update = db.prepare('UPDATE dhcp_leases SET subnet_id = ? WHERE id = ?');
  for (const lease of leases) {
    const child = childContaining(childRanges, lease.ip_address);
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
  return db
    .prepare(
      `
    DELETE FROM dhcp_reservations WHERE id = ?
      AND subnet_id IN (SELECT id FROM subnets WHERE parent_id = ?)
  `,
    )
    .run(id, parentId);
}

export function deleteChildLeaseById(db, parentId, id) {
  return db
    .prepare(
      `
    DELETE FROM dhcp_leases WHERE id = ?
      AND subnet_id IN (SELECT id FROM subnets WHERE parent_id = ?)
  `,
    )
    .run(id, parentId);
}

export function moveReservationsToSubnet(db, childIds, mergedId) {
  if (!Array.isArray(childIds) || childIds.length === 0) return;
  const placeholders = childIds.map(() => '?').join(',');
  // The merge planner rejects duplicate MAC/IP identities before mutation.
  // Let the database uniqueness constraints abort the transaction if a caller
  // ever bypasses that preflight; never delete a competing reservation here.
  db.prepare(
    `
    UPDATE dhcp_reservations SET subnet_id = ?
    WHERE subnet_id IN (${placeholders})
  `,
  ).run(mergedId, ...childIds);
}

export function moveLeasesToSubnet(db, childIds, mergedId) {
  if (!Array.isArray(childIds) || childIds.length === 0) return;
  const placeholders = childIds.map(() => '?').join(',');
  db.prepare(`UPDATE dhcp_leases SET subnet_id = ? WHERE subnet_id IN (${placeholders})`).run(
    mergedId,
    ...childIds,
  );
}

export function rebaseScopeTopologyOptions(db, scopeId, parsed, gateway) {
  // Subnet mask, router and broadcast are DHCPv4 options. A DHCPv6 scope
  // carries no network-derived options: routers come from RAs.
  if (parsed.family !== 4) return;
  db.prepare('DELETE FROM dhcp_scope_options WHERE scope_id = ? AND option_code IN (1, 3, 28)').run(
    scopeId,
  );
  const insert = db.prepare(
    'INSERT INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)',
  );
  insert.run(scopeId, 1, parsed.mask);
  if (gateway) insert.run(scopeId, 3, gateway);
  insert.run(scopeId, 28, parsed.broadcast);
}

export function rebaseScopeForNetwork(db, scopeId, parsed, gateway) {
  rebaseScopeTopologyOptions(db, scopeId, parsed, gateway);
  return db
    .prepare("UPDATE dhcp_scopes SET gateway = ?, updated_at = datetime('now') WHERE id = ?")
    .run(gateway, scopeId);
}

export function captureScopeTemplate(db, sourceIds) {
  return firstScopeForSubnets(db, sourceIds);
}

export function createMergedDefaultScope(db, source, mergedId, parsed, gateway) {
  return createDefaultScopeFromSource(db, source, mergedId, parsed, gateway);
}

export function deleteDhcpStateForSubtree(db, parentId) {
  const tree =
    'WITH RECURSIVE tree AS (SELECT id FROM subnets WHERE parent_id = ? UNION ALL SELECT s.id FROM subnets s JOIN tree t ON s.parent_id = t.id)';
  db.prepare(
    `${tree} DELETE FROM dhcp_scope_options WHERE scope_id IN (SELECT id FROM dhcp_scopes WHERE subnet_id IN (SELECT id FROM tree))`,
  ).run(parentId);
  db.prepare(`${tree} DELETE FROM dhcp_scopes WHERE subnet_id IN (SELECT id FROM tree)`).run(
    parentId,
  );
  db.prepare(`${tree} DELETE FROM dhcp_leases WHERE subnet_id IN (SELECT id FROM tree)`).run(
    parentId,
  );
}
