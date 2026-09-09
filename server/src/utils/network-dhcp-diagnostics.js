import { ipToLong, isIpInSubnet, parseCidr } from './ip.js';

export function getNetworkDhcpDiagnostics(db) {
  const issues = [];
  const subnets = db.prepare("SELECT * FROM subnets WHERE status = 'allocated'").all();
  for (const subnet of subnets) {
    const parsed = parseCidr(subnet.cidr);
    if (subnet.network_address !== parsed.network
        || subnet.broadcast_address !== parsed.broadcast
        || subnet.prefix_length !== parsed.prefix
        || subnet.total_addresses !== parsed.totalAddresses) {
      issues.push({
        code: 'network_derivative_mismatch', subnet_id: subnet.id, cidr: subnet.cidr,
        expected: {
          network_address: parsed.network,
          broadcast_address: parsed.broadcast,
          prefix_length: parsed.prefix,
          total_addresses: parsed.totalAddresses
        },
        safe_repair: true
      });
    }
    const expectedGateway = subnet.gateway_policy === 'first' ? parsed.firstUsable
      : subnet.gateway_policy === 'last' ? parsed.lastUsable
        : subnet.gateway_policy === 'none' ? null : subnet.gateway_address;
    const customInvalid = subnet.gateway_policy === 'custom'
      && (!subnet.gateway_address || !isIpInSubnet(subnet.gateway_address, subnet.cidr)
        || [parsed.network, parsed.broadcast].includes(subnet.gateway_address));
    if (customInvalid || subnet.gateway_address !== expectedGateway) {
      issues.push({
        code: 'gateway_policy_mismatch', subnet_id: subnet.id, cidr: subnet.cidr,
        gateway_policy: subnet.gateway_policy, configured: subnet.gateway_address,
        expected: customInvalid ? null : expectedGateway, safe_repair: !customInvalid
      });
    }
    const expected = new Map();
    if (parsed.prefix < 31) {
      expected.set(parsed.network, 'system');
      expected.set(parsed.broadcast, 'system');
    }
    if (subnet.gateway_address) expected.set(subnet.gateway_address, 'gateway');
    for (const [ip, state] of expected) {
      const row = db.prepare(`
        SELECT id, allocation_state, allocation_source_type FROM ip_addresses
        WHERE subnet_id = ? AND ip_address = ?
      `).get(subnet.id, ip);
      if (!row || row.allocation_state !== state || row.allocation_source_type !== 'topology') {
        issues.push({
          code: 'topology_ip_mismatch', subnet_id: subnet.id, cidr: subnet.cidr,
          ip_address: ip, expected_state: state, actual_state: row?.allocation_state || null,
          ip_row_id: row?.id || null, safe_repair: !row || row.allocation_state === 'unassigned'
        });
      }
    }
    const stale = db.prepare(`
      SELECT id, ip_address, allocation_state FROM ip_addresses
      WHERE subnet_id = ? AND allocation_source_type = 'topology'
    `).all(subnet.id).filter(row => !expected.has(row.ip_address));
    for (const row of stale) {
      issues.push({
        code: 'stale_topology_ip', subnet_id: subnet.id, cidr: subnet.cidr,
        ip_address: row.ip_address, actual_state: row.allocation_state,
        ip_row_id: row.id, safe_repair: true
      });
    }
  }

  const scopes = db.prepare(`
    SELECT scope.id, scope.subnet_id, scope.gateway,
      subnet.cidr, subnet.gateway_address,
      (SELECT value FROM dhcp_scope_options option
       WHERE option.scope_id = scope.id AND option.option_code = 3) AS router_option
    FROM dhcp_scopes scope
    LEFT JOIN subnets subnet ON subnet.id = scope.subnet_id
  `).all();
  for (const scope of scopes) {
    if (!scope.cidr) {
      issues.push({ code: 'orphan_scope', scope_id: scope.id, subnet_id: scope.subnet_id, safe_repair: false });
      continue;
    }
    const parsed = parseCidr(scope.cidr);
    const pools = db.prepare(`SELECT pool.id, pool.range_id, pool.start_ip, pool.end_ip,
        range.start_ip AS range_start_ip, range.end_ip AS range_end_ip
      FROM dhcp_scope_pools pool LEFT JOIN ranges range ON range.id = pool.range_id
      WHERE pool.scope_id = ? ORDER BY pool.sort_order, pool.id`).all(scope.id);
    if (!pools.length) {
      issues.push({
        code: 'scope_without_pool', scope_id: scope.id, subnet_id: scope.subnet_id,
        safe_repair: false
      });
    }
    for (const pool of pools) {
      const start = ipToLong(pool.start_ip);
      const end = ipToLong(pool.end_ip);
      if (start <= parsed.networkLong || end >= parsed.broadcastLong || start > end) {
        issues.push({
          code: 'scope_outside_usable_range', scope_id: scope.id, pool_id: pool.id,
          subnet_id: scope.subnet_id, start_ip: pool.start_ip, end_ip: pool.end_ip,
          safe_repair: false
        });
      }
      if (scope.gateway_address) {
        const gateway = ipToLong(scope.gateway_address);
        if (gateway >= start && gateway <= end) {
          issues.push({
            code: 'gateway_inside_pool', scope_id: scope.id, pool_id: pool.id,
            subnet_id: scope.subnet_id, ip_address: scope.gateway_address,
            safe_repair: false
          });
        }
      }
      if (pool.range_start_ip !== pool.start_ip || pool.range_end_ip !== pool.end_ip) {
        issues.push({
          code: 'pool_range_projection_mismatch', scope_id: scope.id, pool_id: pool.id,
          range_id: pool.range_id, subnet_id: scope.subnet_id,
          configured: { start_ip: pool.start_ip, end_ip: pool.end_ip },
          projected: { start_ip: pool.range_start_ip, end_ip: pool.range_end_ip },
          safe_repair: true
        });
      }
    }
    if (scope.router_option && scope.router_option !== scope.gateway_address) {
      issues.push({
        code: 'stale_router_option', scope_id: scope.id, subnet_id: scope.subnet_id,
        configured: scope.router_option, expected: scope.gateway_address, safe_repair: true
      });
    }
  }

  const enabledPools = db.prepare(`
    SELECT pool.id, pool.scope_id, scope.subnet_id, pool.start_ip, pool.end_ip
    FROM dhcp_scope_pools pool JOIN dhcp_scopes scope ON scope.id = pool.scope_id
    WHERE scope.enabled = 1 ORDER BY scope.subnet_id, pool.id
  `).all();
  for (let leftIndex = 0; leftIndex < enabledPools.length; leftIndex++) {
    const left = enabledPools[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < enabledPools.length; rightIndex++) {
      const right = enabledPools[rightIndex];
      if (right.subnet_id !== left.subnet_id) break;
      if (ipToLong(left.start_ip) <= ipToLong(right.end_ip)
          && ipToLong(right.start_ip) <= ipToLong(left.end_ip)) {
        issues.push({
          code: 'overlapping_enabled_pools', subnet_id: left.subnet_id,
          pool_ids: [left.id, right.id], scope_ids: [left.scope_id, right.scope_id],
          safe_repair: false
        });
      }
    }
  }

  for (const lease of db.prepare(`
    SELECT id, subnet_id, ip_address, mac_address, expires_at
    FROM dhcp_leases WHERE subnet_id IS NULL
  `).all()) {
    issues.push({ code: 'detached_lease', lease_id: lease.id, ...lease, safe_repair: false });
  }

  for (const lease of db.prepare(`
    SELECT lease.id, lease.subnet_id, lease.ip_address, subnet.cidr, subnet.status
    FROM dhcp_leases lease JOIN subnets subnet ON subnet.id = lease.subnet_id
  `).all()) {
    if (lease.status !== 'allocated' || !isIpInSubnet(lease.ip_address, lease.cidr)) {
      issues.push({
        code: 'lease_owner_mismatch', lease_id: lease.id, subnet_id: lease.subnet_id,
        ip_address: lease.ip_address, owner_cidr: lease.cidr, safe_repair: false
      });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    summary: {
      total: issues.length,
      safe_repairs: issues.filter(issue => issue.safe_repair).length,
      review_required: issues.filter(issue => !issue.safe_repair).length
    },
    issues
  };
}
