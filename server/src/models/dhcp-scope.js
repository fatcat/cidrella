import { ipToLong, isValidIpv4, parseCidr } from '../utils/ip.js';
import { localIpv4Set } from '../utils/local-addresses.js';

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
    SELECT s.id, s.subnet_id, r.start_ip, r.end_ip
    FROM dhcp_scopes s
    JOIN ranges r ON r.id = s.range_id
    WHERE s.subnet_id = ? AND s.enabled = 1
  `).all(subnetId);
  return scopes.find(scope => {
    return ipLong >= ipToLong(scope.start_ip) && ipLong <= ipToLong(scope.end_ip);
  }) || null;
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

  const localAddress = [...localIpv4Set()].find(ip => {
    const value = ipToLong(ip);
    return value >= startLong && value <= endLong;
  });
  if (localAddress) {
    return {
      type: 'system',
      ip_address: localAddress,
      error: `DHCP pool conflicts with CIDRella service address ${localAddress}`
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

function saveScopeOptions(db, scopeId, subnet, options, { replace = false } = {}) {
  if (!Array.isArray(options)) return;
  if (replace) {
    db.prepare('DELETE FROM dhcp_scope_options WHERE scope_id = ?').run(scopeId);
  }

  const inherited = computeInheritedOptions(subnet);
  const insertOpt = db.prepare('INSERT INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)');
  for (const opt of options) {
    if (opt.code && opt.value != null && opt.value !== '') {
      if (inherited[opt.code] && String(opt.value) === inherited[opt.code]) continue;
      insertOpt.run(scopeId, opt.code, String(opt.value));
    }
  }
}

function getScopeWithDetails(db, scopeId) {
  const scope = db.prepare(`
    SELECT s.*, r.start_ip, r.end_ip,
      sub.cidr as subnet_cidr, sub.name as subnet_name, sub.gateway_address as subnet_gateway
    FROM dhcp_scopes s
    JOIN ranges r ON s.range_id = r.id
    JOIN subnets sub ON s.subnet_id = sub.id
    WHERE s.id = ?
  `).get(scopeId);

  if (scope) {
    scope.options = db.prepare('SELECT option_code, value FROM dhcp_scope_options WHERE scope_id = ?').all(scopeId);
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
      const range = db.prepare('SELECT * FROM ranges WHERE id = ?').get(scope.range_id);
      db.prepare("UPDATE ranges SET start_ip = ?, end_ip = ?, updated_at = datetime('now') WHERE id = ?").run(
        fields.start_ip || range.start_ip,
        fields.end_ip || range.end_ip,
        scope.range_id
      );
    }

    saveScopeOptions(db, scope.id, subnet, fields.options, { replace: true });
  });

  update();
  return getScopeWithDetails(db, scope.id);
}

export function deleteScope(db, scope) {
  const del = db.transaction(() => {
    db.prepare('DELETE FROM dhcp_scope_options WHERE scope_id = ?').run(scope.id);
    db.prepare('DELETE FROM dhcp_scopes WHERE id = ?').run(scope.id);
    db.prepare('DELETE FROM ranges WHERE id = ?').run(scope.range_id);
  });

  del();
}
