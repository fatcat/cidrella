import crypto from 'crypto';
import {
  calculateSubnets,
  ipToLong,
  isIpInSubnet,
  isValidIpv4,
  longToIp,
  parseCidr,
  subtractCidr
} from '../utils/ip.js';
import { resolveGatewayAddress } from './subnet-topology.js';

function stableRows(db, sql, ids) {
  if (!ids.length) return [];
  return db.prepare(sql.replace(':ids', ids.map(() => '?').join(','))).all(...ids);
}

export function transformationDependencyToken(db, sourceIds) {
  const ids = [...new Set(sourceIds.map(Number))].sort((a, b) => a - b);
  const state = {
    subnets: stableRows(db, 'SELECT * FROM subnets WHERE id IN (:ids) ORDER BY id', ids),
    ranges: stableRows(db, 'SELECT * FROM ranges WHERE subnet_id IN (:ids) ORDER BY id', ids),
    scopes: stableRows(db, 'SELECT * FROM dhcp_scopes WHERE subnet_id IN (:ids) ORDER BY id', ids),
    reservations: stableRows(db, 'SELECT * FROM dhcp_reservations WHERE subnet_id IN (:ids) ORDER BY id', ids),
    leases: stableRows(db, 'SELECT * FROM dhcp_leases WHERE subnet_id IN (:ids) ORDER BY id', ids),
    ips: stableRows(db, 'SELECT * FROM ip_addresses WHERE subnet_id IN (:ids) ORDER BY id', ids),
    defaults: db.prepare(`
      SELECT key, value FROM settings
      WHERE key IN ('default_gateway_position', 'default_lease_time') ORDER BY key
    `).all(),
    dhcp_defaults: db.prepare(`
      SELECT * FROM dhcp_option_defaults ORDER BY option_code
    `).all()
  };
  const scopeIds = state.scopes.map(scope => scope.id);
  state.scope_options = stableRows(
    db, 'SELECT * FROM dhcp_scope_options WHERE scope_id IN (:ids) ORDER BY scope_id, option_code', scopeIds
  );
  state.scope_pools = stableRows(
    db, 'SELECT * FROM dhcp_scope_pools WHERE scope_id IN (:ids) ORDER BY scope_id, sort_order, id', scopeIds
  );
  const sourceCidrs = state.subnets.map(subnet => subnet.cidr);
  state.dns_records = db.prepare(`
    SELECT record.*, zone.name AS zone_name, zone.type AS zone_type, zone.enabled AS zone_enabled
    FROM dns_records record JOIN dns_zones zone ON zone.id = record.zone_id
    WHERE record.type IN ('A', 'AAAA') ORDER BY record.id
  `).all().filter(record => isValidIpv4(record.value)
    && sourceCidrs.some(cidr => isIpInSubnet(record.value, cidr)));
  return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function targetGateway(parent, cidr, override = null) {
  const parsed = parseCidr(cidr);
  if (override) {
    if (!['first', 'last', 'custom', 'none'].includes(override.policy)) {
      throw new Error(`Invalid gateway policy for ${cidr}`);
    }
    if (override.policy === 'custom') {
      if (!override.address || !isValidIpv4(override.address)
          || !isIpInSubnet(override.address, cidr)
          || [parsed.network, parsed.broadcast].includes(override.address)) {
        throw new Error(`Custom gateway for ${cidr} must be a usable address in that network`);
      }
    }
    return {
      policy: override.policy,
      address: resolveGatewayAddress(parsed, override.policy, override.address || null)
    };
  }
  const policy = parent.gateway_policy || 'none';
  if (policy === 'custom') {
    const gateway = parent.gateway_address;
    const value = gateway ? parseCidr(`${gateway}/32`).networkLong : null;
    const contained = value != null && value >= parsed.networkLong && value <= parsed.broadcastLong;
    return { policy: contained ? 'custom' : null, address: contained ? gateway : null };
  }
  return { policy, address: resolveGatewayAddress(parsed, policy) };
}

function projectedScopesForTarget(db, sourceIds, target) {
  const parsed = parseCidr(target.cidr);
  if (parsed.prefix >= 31) return [];
  const scopes = stableRows(
    db,
    'SELECT * FROM dhcp_scopes WHERE subnet_id IN (:ids) ORDER BY id',
    sourceIds
  );
  const results = [];
  for (const scope of scopes) {
    const intervals = [];
    for (const pool of stableRows(
      db,
      'SELECT * FROM dhcp_scope_pools WHERE scope_id IN (:ids) ORDER BY sort_order, id',
      [scope.id]
    )) {
      const start = Math.max(ipToLong(pool.start_ip), parsed.networkLong + 1);
      const end = Math.min(ipToLong(pool.end_ip), parsed.broadcastLong - 1);
      if (start > end) continue;
      const gateway = target.gateway.address ? ipToLong(target.gateway.address) : null;
      if (gateway == null || gateway < start || gateway > end) {
        intervals.push({ source_pool_id: pool.id, start_ip: longToIp(start), end_ip: longToIp(end) });
      } else {
        if (start < gateway) intervals.push({
          source_pool_id: pool.id, start_ip: longToIp(start), end_ip: longToIp(gateway - 1)
        });
        if (gateway < end) intervals.push({
          source_pool_id: pool.id, start_ip: longToIp(gateway + 1), end_ip: longToIp(end)
        });
      }
    }
    if (intervals.length) results.push({
      source_scope_id: scope.id,
      enabled: !!scope.enabled,
      lease_time: scope.lease_time,
      intervals
    });
  }
  return results;
}

function sealPlan(plan) {
  return {
    ...plan,
    plan_id: crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex')
  };
}

function gatewayClaimConflicts(db, targets, sourceIds) {
  const gateways = new Map(targets
    .filter(target => target.gateway.address)
    .map(target => [target.gateway.address, target.cidr]));
  if (gateways.size === 0) return [];
  const ids = [...new Set(sourceIds.map(Number))];
  const conflicts = [];
  const add = (code, row, ip, details = {}) => conflicts.push({
    code,
    target_cidr: gateways.get(ip),
    ip_address: ip,
    record_id: row.id,
    ...details
  });
  for (const row of stableRows(db, `
    SELECT id, ip_address, allocation_state FROM ip_addresses
    WHERE subnet_id IN (:ids)
      AND allocation_source_type != 'topology'
      AND allocation_state NOT IN ('unassigned', 'static_dns')
    ORDER BY id
  `, ids)) {
    if (gateways.has(row.ip_address)) {
      add('gateway_allocation_conflict', row, row.ip_address, {
        allocation_state: row.allocation_state
      });
    }
  }
  for (const row of stableRows(db, `
    SELECT id, ip_address, mac_address FROM dhcp_reservations
    WHERE subnet_id IN (:ids) AND enabled = 1 ORDER BY id
  `, ids)) {
    if (gateways.has(row.ip_address)) {
      add('gateway_dhcp_reservation_conflict', row, row.ip_address, { mac_address: row.mac_address });
    }
  }
  for (const row of stableRows(db, `
    SELECT id, ip_address, mac_address FROM dhcp_leases
    WHERE subnet_id IN (:ids)
      AND (expires_at = 'infinite' OR datetime(expires_at) > datetime('now'))
    ORDER BY id
  `, ids)) {
    if (gateways.has(row.ip_address)) {
      add('gateway_active_lease_conflict', row, row.ip_address, { mac_address: row.mac_address });
    }
  }
  return conflicts;
}

export function buildDividePlan(db, parent, { newPrefix, cidr, selectedCidrs, targetGateways } = {}) {
  let targets;
  let mode;
  if (newPrefix !== undefined) {
    mode = 'equal';
    const calculated = calculateSubnets(parent.cidr, Number(newPrefix), 256)
      .map(parsed => `${parsed.network}/${parsed.prefix}`);
    if (selectedCidrs?.length) {
      const selected = new Set(selectedCidrs);
      const invalid = [...selected].filter(value => !calculated.includes(value));
      if (invalid.length) throw new Error(`Invalid selected CIDRs: ${invalid.join(', ')}`);
      // Preserve every remainder as an explicit child. Selection controls
      // requested allocation, never ownership of the omitted address space.
      targets = calculated.map(value => ({ cidr: value, selected: selected.has(value) }));
    } else {
      targets = calculated.map(value => ({ cidr: value, selected: true }));
    }
  } else {
    mode = 'carve';
    targets = [cidr, ...subtractCidr(parent.cidr, cidr)]
      .map(value => ({ cidr: value, selected: value === cidr }));
  }
  const overrides = new Map((targetGateways || []).map(item => [item.cidr, item]));
  const unknownOverrides = [...overrides.keys()].filter(value => !targets.some(target => target.cidr === value));
  if (unknownOverrides.length) throw new Error(`Gateway resolution targets are not in the plan: ${unknownOverrides.join(', ')}`);
  const plannedTargets = targets.map(target => ({
    ...target,
    gateway: targetGateway(parent, target.cidr, overrides.get(target.cidr))
  }));
  for (const target of plannedTargets) {
    target.scopes = projectedScopesForTarget(db, [parent.id], target);
  }
  const customMissing = plannedTargets.some(target => target.gateway.policy === null);
  const conflicts = customMissing ? [{ code: 'custom_gateway_policy_required' }] : [];
  conflicts.push(...gatewayClaimConflicts(db, plannedTargets, [parent.id]));
  return sealPlan({
    operation: 'divide',
    mode,
    source_ids: [parent.id],
    source_cidrs: [parent.cidr],
    targets: plannedTargets,
    conflicts,
    dependency_token: transformationDependencyToken(db, [parent.id])
  });
}

export function buildMergePlan(db, subnets, mergedCidr) {
  const allocated = subnets.filter(subnet => subnet.status === 'allocated');
  const policies = [...new Set(allocated.map(subnet => subnet.gateway_policy))];
  const customAddresses = [...new Set(allocated.filter(subnet => subnet.gateway_policy === 'custom')
    .map(subnet => subnet.gateway_address))];
  const gatewayConflict = policies.length > 1 || customAddresses.length > 1;
  const policy = gatewayConflict ? null : (policies[0] || 'none');
  const parsed = parseCidr(mergedCidr);
  const gateway = policy ? resolveGatewayAddress(parsed, policy, customAddresses[0] || null) : null;
  const conflicts = gatewayConflict ? [{ code: 'gateway_policy_conflict' }] : [];
  for (const field of ['vlan_id', 'folder_id', 'domain_name', 'scan_interval', 'scan_enabled', 'has_reverse_dns']) {
    const values = [...new Set(allocated.map(subnet => subnet[field] ?? null))];
    if (values.length > 1) conflicts.push({ code: 'network_policy_conflict', field, values });
  }
  const ids = subnets.map(subnet => subnet.id);
  const reservations = stableRows(
    db,
    'SELECT id, subnet_id, mac_address, ip_address FROM dhcp_reservations WHERE subnet_id IN (:ids) ORDER BY id',
    ids
  );
  for (const field of ['mac_address', 'ip_address']) {
    const groups = new Map();
    for (const reservation of reservations) {
      const value = reservation[field];
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(reservation);
    }
    for (const [value, rows] of groups) {
      if (rows.length > 1) {
        conflicts.push({
          code: 'dhcp_reservation_identity_conflict',
          field,
          value,
          record_ids: rows.map(row => row.id)
        });
      }
    }
  }
  conflicts.push(...gatewayClaimConflicts(
    db,
    [{ cidr: mergedCidr, gateway: { policy, address: gateway } }],
    ids
  ));
  const target = { cidr: mergedCidr, gateway: { policy, address: gateway } };
  target.scopes = projectedScopesForTarget(db, ids, target);
  return sealPlan({
    operation: 'merge',
    source_ids: subnets.map(subnet => subnet.id),
    source_cidrs: subnets.map(subnet => subnet.cidr),
    targets: [target],
    conflicts,
    dependency_token: transformationDependencyToken(db, subnets.map(subnet => subnet.id))
  });
}

export function isCurrentTransformationPlan(db, plan) {
  if (!plan?.dependency_token) return false;
  if (transformationDependencyToken(db, plan.source_ids) !== plan.dependency_token) return false;
  if (!plan.plan_id || !plan.current_plan) return true;
  return plan.plan_id === plan.current_plan.plan_id;
}
