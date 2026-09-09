import { ipToLong, isValidIpv4, parseCidr } from '../utils/ip.js';

// The one definition of "this DHCP pool would swallow the subnet's gateway".
//
// dnsmasq serves the pool verbatim: utils/dhcp.js builds `dhcp-range=` from
// `dhcp_scopes JOIN ranges ON s.range_id = r.id`, so a gateway inside the pool
// gets handed to a client as a dynamic lease and collides with the router.
//
// This lives here because four separate routes can write a scope's pool
// (PUT /dhcp/scopes/:id, POST and PUT on /subnets/:id/ranges, and
// POST /subnets/:id/configure) and only one of them used to check.
//
// Returns null when the pool is safe, otherwise the details of the clash.
export function gatewayInPoolConflict(subnet, startIp, endIp) {
  if (!subnet?.gateway_address || !startIp || !endIp) return null;
  const gwLong = ipToLong(subnet.gateway_address);
  if (gwLong >= ipToLong(startIp) && gwLong <= ipToLong(endIp)) {
    return { gateway_address: subnet.gateway_address, start_ip: startIp, end_ip: endIp };
  }
  return null;
}

// Message for a gatewayInPoolConflict result, so every route rejects with the
// same wording instead of three near-identical strings.
export function gatewayInPoolError(conflict) {
  return `Pool ${conflict.start_ip}–${conflict.end_ip} would include the subnet gateway ` +
    `${conflict.gateway_address}. Shrink the pool or change the gateway first.`;
}

export function findEnabledScopeForIp(db, subnetId, ipAddress) {
  const ipLong = ipToLong(ipAddress);
  const scopes = db.prepare(`
    SELECT s.id, s.subnet_id, p.start_ip, p.end_ip
    FROM dhcp_scopes s
    JOIN dhcp_scope_pools p ON p.scope_id = s.id
    WHERE s.subnet_id = ? AND s.enabled = 1
  `).all(subnetId);
  return scopes.find(scope => {
    return ipLong >= ipToLong(scope.start_ip) && ipLong <= ipToLong(scope.end_ip);
  }) || null;
}

export function getScopePools(db, scopeId) {
  return db.prepare(`
    SELECT id, scope_id, range_id, start_ip, end_ip, sort_order
    FROM dhcp_scope_pools WHERE scope_id = ? ORDER BY sort_order, id
  `).all(scopeId);
}

export function addScopePool(db, scopeId, subnetId, rangeTypeId, startIp, endIp,
  description = 'DHCP scope', sortOrder = null) {
  const range = db.prepare(`
    INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(subnetId, rangeTypeId, startIp, endIp, description);
  const order = sortOrder ?? db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM dhcp_scope_pools WHERE scope_id = ?'
  ).get(scopeId).value;
  db.prepare(`
    INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(scopeId, range.lastInsertRowid, startIp, endIp, order);
  return range.lastInsertRowid;
}

export function staticDnsConflictsInPool(db, startIp, endIp) {
  const startLong = ipToLong(startIp);
  const endLong = ipToLong(endIp);
  return db.prepare(`
    SELECT r.id, r.name, r.value AS ip_address, z.name AS zone_name
    FROM dns_records r
    JOIN dns_zones z ON z.id = r.zone_id
    WHERE r.type = 'A'
      AND r.enabled = 1
      AND z.enabled = 1
      AND z.type = 'forward'
      AND COALESCE(r.source, 'manual') = 'manual'
  `).all().filter(record => {
    if (!isValidIpv4(record.ip_address)) return false;
    const value = ipToLong(record.ip_address);
    return value >= startLong && value <= endLong;
  });
}

export function dynamicPoolConflict(db, subnet, startIp, endIp) {
  const parsed = parseCidr(subnet.cidr);
  const startLong = ipToLong(startIp);
  const endLong = ipToLong(endIp);
  if (startLong <= parsed.networkLong || endLong >= parsed.broadcastLong) {
    return {
      type: 'system',
      ip_address: startLong <= parsed.networkLong ? parsed.network : parsed.broadcast,
      error: 'DHCP pools may contain host addresses only'
    };
  }

  const gatewayConflict = gatewayInPoolConflict(subnet, startIp, endIp);
  if (gatewayConflict) {
    return {
      type: 'gateway',
      ip_address: gatewayConflict.gateway_address,
      error: gatewayInPoolError(gatewayConflict)
    };
  }

  const staticDns = staticDnsConflictsInPool(db, startIp, endIp)[0];
  if (staticDns) {
    return {
      type: 'static_dns',
      ip_address: staticDns.ip_address,
      record_id: staticDns.id,
      error: `DHCP pool conflicts with static DNS allocation ${staticDns.ip_address} (${staticDns.name}.${staticDns.zone_name})`
    };
  }

  const protectedRow = db.prepare(`
    SELECT ip_address, allocation_state
    FROM ip_addresses
    WHERE subnet_id = ? AND allocation_state IN ('system', 'gateway')
  `).all(subnet.id).find(row => {
    if (!isValidIpv4(row.ip_address)) return false;
    const value = ipToLong(row.ip_address);
    return value >= startLong && value <= endLong;
  });
  if (protectedRow) {
    return {
      type: protectedRow.allocation_state,
      ip_address: protectedRow.ip_address,
      error: `DHCP pool conflicts with protected ${protectedRow.allocation_state} address ${protectedRow.ip_address}`
    };
  }

  return null;
}

function computeInheritedOptions(subnet) {
  const inherited = {};
  if (subnet?.gateway_address) inherited[3] = subnet.gateway_address;
  if (subnet?.cidr) {
    const pfx = parseInt(subnet.cidr.split('/')[1], 10);
    if (pfx >= 0 && pfx <= 32) {
      const mask = pfx === 0 ? 0 : (0xFFFFFFFF << (32 - pfx)) >>> 0;
      inherited[1] = [
        (mask >>> 24) & 255,
        (mask >>> 16) & 255,
        (mask >>> 8) & 255,
        mask & 255
      ].join('.');
    }
  }
  if (subnet?.domain_name) {
    inherited[15] = subnet.domain_name;
    inherited[119] = subnet.domain_name;
  }
  return inherited;
}

export function resolveEffectiveScopeOptions(db, scope) {
  const values = new Map();
  const provenance = new Map();
  const set = (code, value, source) => {
    if (value == null || value === '') return;
    values.set(Number(code), String(value));
    provenance.set(Number(code), source);
  };
  for (const row of db.prepare(
    'SELECT option_code, value FROM dhcp_option_defaults WHERE value IS NOT NULL'
  ).all()) {
    if (Number(row.option_code) !== 51) set(row.option_code, row.value, 'global_default');
  }

  const explicit = scope.options || db.prepare(
    'SELECT option_code, value FROM dhcp_scope_options WHERE scope_id = ?'
  ).all(scope.id);
  for (const option of explicit) {
    if (Number(option.option_code) !== 51) set(option.option_code, option.value, 'scope');
  }

  if (explicit.length === 0) {
    set(3, scope.gateway, 'legacy_scope');
    set(15, scope.domain_name, 'legacy_scope');
    set(42, scope.ntp_servers, 'legacy_scope');
    set(119, scope.domain_search, 'legacy_scope');
  }

  const cidr = scope.subnet_cidr || scope.cidr;
  const gateway = scope.subnet_gateway ?? scope.gateway_address;
  if (cidr) {
    const parsed = parseCidr(cidr);
    set(1, parsed.mask, 'network');
    set(28, parsed.broadcast, 'network');
  }
  if (gateway) set(3, gateway, 'network');
  else {
    values.delete(3);
    provenance.set(3, 'network_none');
  }
  if (!values.has(15)) set(15, scope.subnet_domain_name, 'network');
  if (!values.has(119)) set(119, scope.subnet_domain_name, 'network');

  return {
    lease_time: scope.lease_time,
    router_suppressed: !gateway,
    options: [...values].map(([option_code, value]) => ({
      option_code, value, source: provenance.get(option_code)
    })).sort((a, b) => a.option_code - b.option_code)
  };
}

function saveScopeOptions(db, scopeId, subnet, options, { replace = false } = {}) {
  if (!Array.isArray(options)) return;
  if (replace) {
    db.prepare('DELETE FROM dhcp_scope_options WHERE scope_id = ?').run(scopeId);
  }

  const inherited = computeInheritedOptions(subnet);
  const insertOpt = db.prepare('INSERT INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)');
  for (const opt of options) {
    if (opt.code && opt.value != null && opt.value !== '') {
      if (Number(opt.code) === 51) {
        throw new Error('DHCP option 51 is represented by the scope lease_time field');
      }
      if (inherited[opt.code] && String(opt.value) === inherited[opt.code]) continue;
      insertOpt.run(scopeId, opt.code, String(opt.value));
    }
  }
}

function getScopeWithDetails(db, scopeId) {
  const scope = db.prepare(`
    SELECT s.*, r.start_ip, r.end_ip,
      sub.cidr as subnet_cidr, sub.name as subnet_name, sub.gateway_address as subnet_gateway,
      sub.domain_name as subnet_domain_name
    FROM dhcp_scopes s
    JOIN ranges r ON s.range_id = r.id
    JOIN subnets sub ON s.subnet_id = sub.id
    WHERE s.id = ?
  `).get(scopeId);

  if (scope) {
    scope.pools = getScopePools(db, scopeId);
    if (scope.pools.length) {
      scope.start_ip = scope.pools[0].start_ip;
      scope.end_ip = scope.pools[0].end_ip;
    }
    scope.options = db.prepare('SELECT option_code, value FROM dhcp_scope_options WHERE scope_id = ?').all(scopeId);
    scope.effective = resolveEffectiveScopeOptions(db, scope);
  }
  return scope;
}

export function createScope(db, fields, { subnet, defaultLeaseTime }) {
  const create = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, dns_servers, domain_name, gateway, ntp_servers, domain_search, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fields.range_id,
      fields.subnet_id,
      fields.lease_time || defaultLeaseTime,
      fields.dns_servers || null,
      fields.domain_name || null,
      fields.gateway || null,
      fields.ntp_servers || null,
      fields.domain_search || null,
      fields.description || null
    );

    saveScopeOptions(db, result.lastInsertRowid, subnet, fields.options);
    const range = db.prepare('SELECT start_ip, end_ip FROM ranges WHERE id = ?').get(fields.range_id);
    db.prepare(`
      INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
      VALUES (?, ?, ?, ?)
    `).run(result.lastInsertRowid, fields.range_id, range.start_ip, range.end_ip);
    return result.lastInsertRowid;
  });

  return getScopeWithDetails(db, create());
}

export function updateScope(db, scope, fields, { subnet }) {
  const update = db.transaction(() => {
    db.prepare(`
      UPDATE dhcp_scopes SET lease_time = ?, dns_servers = ?, domain_name = ?,
        gateway = ?, ntp_servers = ?, domain_search = ?, enabled = ?, description = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      fields.lease_time ?? scope.lease_time,
      fields.dns_servers !== undefined ? fields.dns_servers : scope.dns_servers,
      fields.domain_name !== undefined ? fields.domain_name : scope.domain_name,
      fields.gateway !== undefined ? (fields.gateway || null) : scope.gateway,
      fields.ntp_servers !== undefined ? (fields.ntp_servers || null) : scope.ntp_servers,
      fields.domain_search !== undefined ? (fields.domain_search || null) : scope.domain_search,
      fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : scope.enabled,
      fields.description !== undefined ? fields.description : scope.description,
      scope.id
    );

    if (fields.start_ip !== undefined || fields.end_ip !== undefined) {
      const pool = getScopePools(db, scope.id)[0];
      db.prepare("UPDATE dhcp_scope_pools SET start_ip = ?, end_ip = ?, updated_at = datetime('now') WHERE id = ?").run(
        fields.start_ip || pool.start_ip,
        fields.end_ip || pool.end_ip,
        pool.id
      );
    }

    saveScopeOptions(db, scope.id, subnet, fields.options, { replace: true });
  });

  update();
  return getScopeWithDetails(db, scope.id);
}

export function deleteScope(db, scope) {
  const del = db.transaction(() => {
    const rangeIds = getScopePools(db, scope.id).map(pool => pool.range_id);
    db.prepare('DELETE FROM dhcp_scope_options WHERE scope_id = ?').run(scope.id);
    db.prepare('DELETE FROM dhcp_scopes WHERE id = ?').run(scope.id);
    const deleteRange = db.prepare('DELETE FROM ranges WHERE id = ?');
    for (const rangeId of rangeIds) deleteRange.run(rangeId);
  });

  del();
}
