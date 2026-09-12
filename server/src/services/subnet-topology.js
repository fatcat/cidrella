import { parseCidr, ipToLong, longToIp, applyNameTemplate } from '../utils/ip.js';
import {
  lifecycleRepository as IpAddress,
  reconcileTopologyAddresses,
} from './ip-lifecycle-service.js';
import { ALLOCATION_STATE } from '../models/ip-lifecycle.js';
import * as DnsTopology from './subnet-dns-topology.js';
import * as DhcpTopology from './subnet-dhcp-topology.js';

export function createSystemRanges(db, subnetId, parsed, gatewayAddress) {
  if (parsed.prefix >= 31) return;

  const types = db
    .prepare(
      "SELECT id, name FROM range_types WHERE is_system = 1 AND name IN ('Network', 'Gateway', 'Broadcast')",
    )
    .all();
  const typeMap = Object.fromEntries(types.map((t) => [t.name, t.id]));

  db.prepare(
    'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)',
  ).run(subnetId, typeMap['Network'], parsed.network, parsed.network, 'Network address');
  if (gatewayAddress) {
    db.prepare(
      'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)',
    ).run(subnetId, typeMap['Gateway'], gatewayAddress, gatewayAddress, 'Default gateway');
  }
  db.prepare(
    'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)',
  ).run(subnetId, typeMap['Broadcast'], parsed.broadcast, parsed.broadcast, 'Broadcast address');
}

export function reconcileSubnetTopology(db, subnetId) {
  const subnet = db.prepare('SELECT cidr, gateway_address FROM subnets WHERE id = ?').get(subnetId);
  if (!subnet) return;
  reconcileTopologyAddresses(db, subnetId, parseCidr(subnet.cidr), subnet.gateway_address);
}

export function repairDerivedNetworkDhcpState(db) {
  const repair = db.transaction(() => {
    const subnets = db
      .prepare("SELECT * FROM subnets WHERE status = 'allocated' ORDER BY id")
      .all();
    let scopesRebased = 0;
    for (const subnet of subnets) {
      const parsed = parseCidr(subnet.cidr);
      const gateway =
        subnet.gateway_policy === 'first'
          ? parsed.firstUsable
          : subnet.gateway_policy === 'last'
            ? parsed.lastUsable
            : subnet.gateway_policy === 'none'
              ? null
              : subnet.gateway_address;
      db.prepare(
        `
        UPDATE subnets SET network_address = ?, broadcast_address = ?, prefix_length = ?,
          total_addresses = ?, gateway_address = ?, updated_at = datetime('now') WHERE id = ?
      `,
      ).run(
        parsed.network,
        parsed.broadcast,
        parsed.prefix,
        parsed.totalAddresses,
        gateway,
        subnet.id,
      );
      db.prepare(
        `
        DELETE FROM ranges WHERE subnet_id = ? AND range_type_id IN (
          SELECT id FROM range_types
          WHERE is_system = 1 AND name IN ('Network', 'Gateway', 'Broadcast')
        )
      `,
      ).run(subnet.id);
      createSystemRanges(db, subnet.id, parsed, gateway);
      reconcileTopologyAddresses(db, subnet.id, parsed, gateway);
      const scopes = db.prepare('SELECT id FROM dhcp_scopes WHERE subnet_id = ?').all(subnet.id);
      for (const scope of scopes) {
        db.prepare(
          `
          INSERT INTO dhcp_scope_pools (scope_id, range_id, start_ip, end_ip)
          SELECT dhcp.id, range.id, range.start_ip, range.end_ip
          FROM dhcp_scopes dhcp JOIN ranges range ON range.id = dhcp.range_id
          WHERE dhcp.id = ? AND NOT EXISTS (
            SELECT 1 FROM dhcp_scope_pools pool WHERE pool.scope_id = dhcp.id
          )
        `,
        ).run(scope.id);
        DhcpTopology.rebaseScopeForNetwork(db, scope.id, parsed, gateway);
        scopesRebased++;
      }
    }
    db.prepare(
      `
      UPDATE ranges
      SET start_ip = (SELECT start_ip FROM dhcp_scope_pools WHERE range_id = ranges.id),
          end_ip = (SELECT end_ip FROM dhcp_scope_pools WHERE range_id = ranges.id),
          updated_at = datetime('now')
      WHERE id IN (SELECT range_id FROM dhcp_scope_pools)
    `,
    ).run();
    return { subnets_reconciled: subnets.length, scopes_rebased: scopesRebased };
  });
  return repair();
}

export function gatewayPolicyForAddress(parsed, gatewayAddress) {
  if (!gatewayAddress) return 'none';
  if (gatewayAddress === parsed.firstUsable) return 'first';
  if (gatewayAddress === parsed.lastUsable) return 'last';
  return 'custom';
}

export function resolveGatewayAddress(parsed, policy, customAddress = null) {
  if (policy === 'none') return null;
  if (policy === 'last') return parsed.lastUsable;
  if (policy === 'custom') return customAddress;
  return parsed.firstUsable;
}

export function backfillGatewayPolicies(db) {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(subnets)')
      .all()
      .map((row) => row.name),
  );
  if (!columns.has('gateway_policy')) return;
  const update = db.prepare('UPDATE subnets SET gateway_policy = ? WHERE id = ?');
  const rows = db.prepare('SELECT id, cidr, gateway_address, gateway_policy FROM subnets').all();
  const apply = db.transaction(() => {
    for (const row of rows) {
      const policy = gatewayPolicyForAddress(parseCidr(row.cidr), row.gateway_address);
      if (row.gateway_policy !== policy) update.run(policy, row.id);
    }
  });
  apply();
}

export function insertSubnet(
  db,
  {
    cidr,
    name,
    description,
    vlan_id,
    gateway_address,
    gateway_policy,
    parent_id,
    folder_id,
    status,
    depth,
    domain_name,
    scan_interval,
    scan_enabled,
  },
) {
  const parsed = parseCidr(cidr);
  const resolvedPolicy = gateway_policy || gatewayPolicyForAddress(parsed, gateway_address);
  return db
    .prepare(
      `
    INSERT INTO subnets (cidr, name, description, vlan_id, network_address, broadcast_address,
      prefix_length, total_addresses, gateway_address, gateway_policy, parent_id, folder_id, status, depth,
      domain_name, scan_interval, scan_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      cidr,
      name || cidr,
      description || null,
      vlan_id || null,
      parsed.network,
      parsed.broadcast,
      parsed.prefix,
      parsed.totalAddresses,
      gateway_address || null,
      resolvedPolicy,
      parent_id || null,
      folder_id || null,
      status || 'unallocated',
      depth || 0,
      domain_name || null,
      scan_interval ?? null,
      scan_enabled ?? null,
    );
}

export function copyUserRangesToChild(db, parentId, childId, childParsed) {
  const userRanges = db
    .prepare(
      `
    SELECT r.* FROM ranges r
    JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.subnet_id = ? AND rt.is_system = 0
  `,
    )
    .all(parentId);

  for (const ur of userRanges) {
    const urStart = ipToLong(ur.start_ip);
    const urEnd = ipToLong(ur.end_ip);
    const clippedStart = Math.max(urStart, childParsed.networkLong);
    const clippedEnd = Math.min(urEnd, childParsed.broadcastLong);
    if (clippedStart <= clippedEnd) {
      db.prepare(
        'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)',
      ).run(
        childId,
        ur.range_type_id,
        longToIp(clippedStart),
        longToIp(clippedEnd),
        ur.description,
      );
    }
  }
}

function moveCustomRangesToSubnet(db, sourceSubnetIds, targetSubnetId) {
  if (!sourceSubnetIds.length) return;
  const placeholders = sourceSubnetIds.map(() => '?').join(',');
  db.prepare(
    `
    UPDATE ranges SET subnet_id = ?
    WHERE subnet_id IN (${placeholders})
      AND range_type_id IN (SELECT id FROM range_types WHERE is_system = 0)
  `,
  ).run(targetSubnetId, ...sourceSubnetIds);

  const ranges = db
    .prepare(
      `
    SELECT * FROM ranges WHERE subnet_id = ?
      AND range_type_id IN (SELECT id FROM range_types WHERE is_system = 0)
    ORDER BY range_type_id, start_ip, end_ip, id
  `,
    )
    .all(targetSubnetId)
    .sort(
      (left, right) =>
        left.range_type_id - right.range_type_id ||
        ipToLong(left.start_ip) - ipToLong(right.start_ip),
    );
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (
      previous.range_type_id !== current.range_type_id ||
      previous.description !== current.description ||
      ipToLong(current.start_ip) > ipToLong(previous.end_ip) + 1
    )
      continue;
    const end = Math.max(ipToLong(previous.end_ip), ipToLong(current.end_ip));
    db.prepare("UPDATE ranges SET end_ip = ?, updated_at = datetime('now') WHERE id = ?").run(
      longToIp(end),
      previous.id,
    );
    db.prepare('DELETE FROM ranges WHERE id = ?').run(current.id);
    previous.end_ip = longToIp(end);
    ranges.splice(index, 1);
    index--;
  }
}

export function deleteRangesForSubnet(db, subnetId) {
  return db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(subnetId);
}

export function deleteSubnetData(db, subnetId) {
  DhcpTopology.deleteDhcpStateForSubnet(db, subnetId);
  deleteRangesForSubnet(db, subnetId);
  IpAddress.deleteBySubnet(db, subnetId);
}

export function setReverseDnsFlag(db, subnetId) {
  return db.prepare('UPDATE subnets SET has_reverse_dns = 1 WHERE id = ?').run(subnetId);
}

export function clearParentConfig(db, parentId) {
  deleteRangesForSubnet(db, parentId);
  return db
    .prepare(
      `
    UPDATE subnets SET status = 'unallocated', description = NULL, vlan_id = NULL,
      gateway_address = NULL, has_reverse_dns = 0, domain_name = NULL,
      topology_revision = topology_revision + 1, updated_at = datetime('now')
    WHERE id = ?
  `,
    )
    .run(parentId);
}

export function updateSubnetDetails(db, subnet, fields) {
  const update = db.transaction(() => {
    db.prepare(
      `
      UPDATE subnets SET name = ?, description = ?, vlan_id = ?, gateway_address = ?, gateway_policy = ?,
        topology_revision = topology_revision + 1,
        scan_interval = ?, folder_id = ?, domain_name = ?, scan_enabled = ?, updated_at = datetime('now')
      WHERE id = ?
    `,
    ).run(
      fields.name ?? subnet.name,
      fields.description !== undefined ? fields.description : subnet.description,
      fields.vlan_id !== undefined ? fields.vlan_id : subnet.vlan_id,
      fields.gateway_address !== undefined ? fields.gateway_address : subnet.gateway_address,
      fields.gateway_policy ||
        gatewayPolicyForAddress(
          parseCidr(subnet.cidr),
          fields.gateway_address !== undefined ? fields.gateway_address : subnet.gateway_address,
        ),
      fields.scan_interval !== undefined ? fields.scan_interval : subnet.scan_interval,
      fields.folder_id !== undefined ? fields.folder_id : subnet.folder_id,
      fields.domain_name !== undefined ? fields.domain_name : subnet.domain_name,
      fields.scan_enabled,
      subnet.id,
    );

    if (fields.gatewayChanged) {
      const gwType = db
        .prepare("SELECT id FROM range_types WHERE name = 'Gateway' AND is_system = 1")
        .get();
      if (gwType) {
        if (!fields.gateway_address) {
          db.prepare('DELETE FROM ranges WHERE subnet_id = ? AND range_type_id = ?').run(
            subnet.id,
            gwType.id,
          );
        } else {
          const result = db
            .prepare(
              "UPDATE ranges SET start_ip = ?, end_ip = ?, updated_at = datetime('now') WHERE subnet_id = ? AND range_type_id = ?",
            )
            .run(fields.gateway_address, fields.gateway_address, subnet.id, gwType.id);
          if (result.changes === 0) {
            db.prepare(
              'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)',
            ).run(
              subnet.id,
              gwType.id,
              fields.gateway_address,
              fields.gateway_address,
              'Default gateway',
            );
          }
        }
      }

      reconcileTopologyAddresses(db, subnet.id, parseCidr(subnet.cidr), fields.gateway_address);
    }

    DnsTopology.ensureForwardZoneForDomainChange(db, fields.domainChange);
  });

  update();
  return db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnet.id);
}

export function configureSubnet(db, subnet, parsed, fields) {
  const configure = db.transaction(() => {
    db.prepare(
      `
      UPDATE subnets SET status = 'allocated', name = ?, description = ?, vlan_id = ?,
        gateway_address = ?, gateway_policy = ?, topology_revision = topology_revision + 1,
        has_reverse_dns = ?, domain_name = ?, scan_interval = ?, scan_enabled = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `,
    ).run(
      fields.name,
      fields.description || null,
      fields.vlan_id || null,
      fields.gateway,
      fields.gateway_policy || gatewayPolicyForAddress(parsed, fields.gateway),
      fields.create_reverse_dns ? 1 : 0,
      fields.domain_name || null,
      fields.scan_interval !== undefined ? fields.scan_interval : subnet.scan_interval,
      fields.scan_enabled !== undefined
        ? fields.scan_enabled == null
          ? null
          : fields.scan_enabled
            ? 1
            : 0
        : subnet.scan_enabled,
      subnet.id,
    );

    if (fields.folder_id !== undefined) {
      db.prepare('UPDATE subnets SET folder_id = ? WHERE id = ?').run(fields.folder_id, subnet.id);
    }

    const sysTypes = db
      .prepare(
        "SELECT id FROM range_types WHERE is_system = 1 AND name IN ('Network', 'Gateway', 'Broadcast')",
      )
      .all();
    const sysTypeIds = sysTypes.map((t) => t.id);
    if (sysTypeIds.length > 0) {
      const placeholders = sysTypeIds.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM ranges WHERE subnet_id = ? AND range_type_id IN (${placeholders})`,
      ).run(subnet.id, ...sysTypeIds);
    }
    createSystemRanges(db, subnet.id, parsed, fields.gateway);
    reconcileTopologyAddresses(db, subnet.id, parsed, fields.gateway);

    if (fields.create_reverse_dns) {
      DnsTopology.createReverseZonesForSubnet(db, subnet);
    }

    if (parsed.prefix >= 20) {
      const ipStart = parsed.prefix >= 31 ? parsed.networkLong : parsed.networkLong + 1;
      const ipEnd = parsed.prefix >= 31 ? parsed.broadcastLong : parsed.broadcastLong - 1;
      const gwLong = fields.gateway ? ipToLong(fields.gateway) : null;
      const entries = [];

      for (let ipLong = ipStart; ipLong <= ipEnd; ipLong++) {
        const isGateway = gwLong !== null && ipLong === gwLong;
        entries.push({
          ip: longToIp(ipLong),
          allocation_state: isGateway ? ALLOCATION_STATE.GATEWAY : ALLOCATION_STATE.UNASSIGNED,
          reservation_note: isGateway ? 'Default gateway' : undefined,
        });
      }
      IpAddress.ensureAddresses(db, subnet.id, entries);
    }

    DnsTopology.ensureForwardZone(db, fields.domain_name);

    if (fields.create_dhcp_scope && parsed.prefix <= 29 && fields.dhcpPool) {
      DhcpTopology.createAutoScope(
        db,
        subnet.id,
        parsed,
        fields.gateway,
        fields.domain_name || null,
        fields.dhcpPool,
      );
    }
  });

  configure();
  return db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnet.id);
}

function moveIpAddressesToSubnet(db, sourceSubnetIds, targetSubnetId) {
  if (!Array.isArray(sourceSubnetIds) || sourceSubnetIds.length === 0) return;
  const placeholders = sourceSubnetIds.map(() => '?').join(',');
  const ips = db
    .prepare(`SELECT id, ip_address FROM ip_addresses WHERE subnet_id IN (${placeholders})`)
    .all(...sourceSubnetIds);
  for (const ip of ips) {
    IpAddress.moveToSubnet(db, ip.id, ip.ip_address, targetSubnetId);
  }
}

function movePerIpArtifactsToSubnet(db, sourceSubnetIds, targetSubnetId) {
  DhcpTopology.moveReservationsToSubnet(db, sourceSubnetIds, targetSubnetId);
  DhcpTopology.moveLeasesToSubnet(db, sourceSubnetIds, targetSubnetId);
  moveIpAddressesToSubnet(db, sourceSubnetIds, targetSubnetId);
}

function deleteSubnetRowsWithRanges(db, subnets) {
  for (const subnet of subnets) {
    db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(subnet.id);
    db.prepare('DELETE FROM subnets WHERE id = ?').run(subnet.id);
  }
}

function deleteSubnetRow(db, subnetId) {
  return db.prepare('DELETE FROM subnets WHERE id = ?').run(subnetId);
}

function deleteDescendantSubnets(db, subnetId) {
  DhcpTopology.deleteDhcpStateForSubtree(db, subnetId);
  return db
    .prepare(
      `
    WITH RECURSIVE tree AS (
      SELECT id FROM subnets WHERE parent_id = ?
      UNION ALL
      SELECT s.id FROM subnets s JOIN tree t ON s.parent_id = t.id
    )
    DELETE FROM subnets WHERE id IN (SELECT id FROM tree)
  `,
    )
    .run(subnetId);
}

function deallocateSubnetRow(db, subnet) {
  return db
    .prepare(
      `
    UPDATE subnets SET status = 'unallocated', name = ?, description = NULL,
      vlan_id = NULL, gateway_address = NULL, has_reverse_dns = 0, domain_name = NULL, updated_at = datetime('now')
    WHERE id = ?
  `,
    )
    .run(subnet.cidr, subnet.id);
}

export function consolidateIntermediate(db, parentId) {
  if (!parentId) return;

  const children = db.prepare('SELECT * FROM subnets WHERE parent_id = ?').all(parentId);
  if (children.length === 0) return;

  const allAreIntermediaries = children.every((c) => {
    if (c.status !== 'unallocated') return false;
    const grandchildCount = db
      .prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?')
      .get(c.id);
    return grandchildCount.c > 0;
  });
  if (!allAreIntermediaries) return;

  const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);
  if (!parent) return;

  for (const child of children) {
    db.prepare('UPDATE subnets SET parent_id = ?, depth = ? WHERE parent_id = ?').run(
      parentId,
      child.depth,
      child.id,
    );
    deleteSubnetRow(db, child.id);
  }

  consolidateIntermediate(db, parent.parent_id);
}

export function buddyMerge(db, parentId) {
  if (!parentId) return;

  let merged = true;
  while (merged) {
    merged = false;
    const unallocLeaves = db
      .prepare(
        `
      SELECT s.* FROM subnets s
      WHERE s.parent_id = ? AND s.status = 'unallocated'
        AND NOT EXISTS (SELECT 1 FROM subnets c WHERE c.parent_id = s.id)
      ORDER BY s.network_address
    `,
      )
      .all(parentId);

    for (let i = 0; i < unallocLeaves.length && !merged; i++) {
      for (let j = i + 1; j < unallocLeaves.length && !merged; j++) {
        const a = unallocLeaves[i];
        const b = unallocLeaves[j];
        if (a.prefix_length !== b.prefix_length) continue;

        const combinedPrefix = a.prefix_length - 1;
        const combinedMask = (0xffffffff << (32 - combinedPrefix)) >>> 0;
        const aNet = ipToLong(a.network_address);
        const bNet = ipToLong(b.network_address);
        if ((aNet & combinedMask) !== (bNet & combinedMask)) continue;

        const combinedNet = Math.min(aNet, bNet);
        const combinedCidr = `${longToIp(combinedNet)}/${combinedPrefix}`;
        const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);

        let destId;
        if (parent && combinedCidr === parent.cidr) {
          destId = parent.id;
        } else {
          destId = insertSubnet(db, {
            cidr: combinedCidr,
            name: combinedCidr,
            parent_id: parentId,
            status: 'unallocated',
            depth: a.depth,
          }).lastInsertRowid;
        }

        movePerIpArtifactsToSubnet(db, [a.id, b.id], destId);
        deleteSubnetData(db, a.id);
        deleteSubnetData(db, b.id);
        db.prepare('DELETE FROM subnets WHERE id IN (?, ?)').run(a.id, b.id);
        merged = true;
      }
    }
  }

  const remaining = db
    .prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?')
    .get(parentId);
  if (remaining.c === 0) return;

  if (remaining.c === 1) {
    const onlyChild = db.prepare('SELECT * FROM subnets WHERE parent_id = ?').get(parentId);
    const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);
    if (
      onlyChild.status === 'unallocated' &&
      onlyChild.cidr === parent.cidr.replace(/\/\d+$/, '') + '/' + onlyChild.prefix_length
    ) {
      if (
        onlyChild.network_address === parent.network_address &&
        onlyChild.broadcast_address === parent.broadcast_address
      ) {
        deleteSubnetRow(db, onlyChild.id);
      }
    }
  }
}

function restoreMergedParent(
  db,
  parent,
  mergedParsed,
  mergedGateway,
  mergedPolicy,
  configSource,
  allocatedCount,
) {
  if (allocatedCount > 0) {
    db.prepare(
      `
      UPDATE subnets SET status = 'allocated', name = ?, description = ?,
        vlan_id = ?, gateway_address = ?, gateway_policy = ?, topology_revision = topology_revision + 1,
        has_reverse_dns = ?, domain_name = ?, folder_id = ?, scan_interval = ?, scan_enabled = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `,
    ).run(
      configSource.name,
      configSource.description,
      configSource.vlan_id,
      mergedGateway,
      mergedPolicy,
      configSource.has_reverse_dns || 0,
      configSource.domain_name || null,
      configSource.folder_id || null,
      configSource.scan_interval ?? null,
      configSource.scan_enabled ?? null,
      parent.id,
    );
  } else {
    db.prepare(
      "UPDATE subnets SET status = 'unallocated', gateway_address = ?, gateway_policy = ?, topology_revision = topology_revision + 1, updated_at = datetime('now') WHERE id = ?",
    ).run(mergedGateway, mergedPolicy, parent.id);
  }
  createSystemRanges(db, parent.id, mergedParsed, mergedGateway);
}

export function mergeSubnets(db, subnets, mergeResult, options = {}) {
  const merge = db.transaction(() => {
    const parentId = subnets[0].parent_id;
    const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);
    const mergedParsed = parseCidr(mergeResult.merged_cidr);
    const allocated = subnets.filter((s) => s.status === 'allocated');
    const mergedPolicy =
      allocated[0]?.gateway_policy ||
      parent.gateway_policy ||
      options.defaultGatewayPosition ||
      'first';
    const customGateway = mergedPolicy === 'custom' ? allocated[0]?.gateway_address : null;
    const mergedGateway = resolveGatewayAddress(mergedParsed, mergedPolicy, customGateway);
    const gatewaySubnet = allocated.find((s) => s.gateway_address);
    const configSource = gatewaySubnet || allocated[0] || null;
    const childIds = subnets.map((s) => s.id);
    const dhcpScopeTemplate = DhcpTopology.captureScopeTemplate(db, childIds);

    if (mergeResult.merged_cidr === parent.cidr) {
      movePerIpArtifactsToSubnet(db, childIds, parent.id);
      moveCustomRangesToSubnet(db, childIds, parent.id);
      deleteSubnetRowsWithRanges(db, subnets);
      restoreMergedParent(
        db,
        parent,
        mergedParsed,
        mergedGateway,
        mergedPolicy,
        configSource,
        allocated.length,
      );
      reconcileSubnetTopology(db, parent.id);
      DhcpTopology.createMergedDefaultScope(
        db,
        dhcpScopeTemplate,
        parent.id,
        mergedParsed,
        mergedGateway,
      );
      return parent.id;
    }

    const result = insertSubnet(db, {
      cidr: mergeResult.merged_cidr,
      name: configSource
        ? configSource.name
        : applyNameTemplate(options.nameTemplate, mergeResult.merged_cidr),
      description: configSource?.description || null,
      vlan_id: configSource?.vlan_id || null,
      gateway_address: mergedGateway,
      gateway_policy: mergedPolicy,
      parent_id: parentId,
      status: allocated.length > 0 ? 'allocated' : 'unallocated',
      depth: parent.depth + 1,
      domain_name: configSource?.domain_name || null,
      folder_id: configSource?.folder_id || parent.folder_id || null,
      scan_interval: configSource?.scan_interval ?? parent.scan_interval,
      scan_enabled: configSource?.scan_enabled ?? parent.scan_enabled,
    });

    const mergedId = result.lastInsertRowid;
    movePerIpArtifactsToSubnet(db, childIds, mergedId);
    moveCustomRangesToSubnet(db, childIds, mergedId);
    deleteSubnetRowsWithRanges(db, subnets);
    createSystemRanges(db, mergedId, mergedParsed, mergedGateway);
    reconcileSubnetTopology(db, mergedId);
    DhcpTopology.createMergedDefaultScope(
      db,
      dhcpScopeTemplate,
      mergedId,
      mergedParsed,
      mergedGateway,
    );
    if (configSource?.has_reverse_dns) {
      setReverseDnsFlag(db, mergedId);
    }
    return mergedId;
  });

  return merge();
}

export function deleteSubnet(db, subnet) {
  const remove = db.transaction(() => {
    const hasChildren =
      db.prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?').get(subnet.id).c > 0;

    if (subnet.status === 'allocated') {
      if (hasChildren) {
        deleteDescendantSubnets(db, subnet.id);
      }
      deleteSubnetData(db, subnet.id);
      deallocateSubnetRow(db, subnet);
      if (subnet.parent_id) buddyMerge(db, subnet.parent_id);
      return 'deallocated';
    }

    if (!subnet.parent_id) {
      deleteSubnetData(db, subnet.id);
      if (hasChildren) {
        DhcpTopology.deleteDhcpStateForSubtree(db, subnet.id);
      }
      deleteSubnetRow(db, subnet.id);
      return 'deleted';
    }

    if (!hasChildren) {
      deleteSubnetData(db, subnet.id);
      deleteSubnetRow(db, subnet.id);
      buddyMerge(db, subnet.parent_id);
      return 'deleted';
    }

    deleteDescendantSubnets(db, subnet.id);
    return 'children_deleted';
  });

  return remove();
}

export function applyNameTemplateToSubnets(db, subnetIds, template) {
  const updated = [];
  const apply = db.transaction(() => {
    for (const id of subnetIds) {
      const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(id);
      if (!subnet) continue;
      const newName = applyNameTemplate(template, subnet.cidr);
      if (newName !== subnet.name) {
        db.prepare("UPDATE subnets SET name = ?, updated_at = datetime('now') WHERE id = ?").run(
          newName,
          id,
        );
        updated.push({ id, cidr: subnet.cidr, old_name: subnet.name, new_name: newName });
      }
    }
  });

  apply();
  return updated;
}

export function assignVlan(db, subnetId, vlanId) {
  return db.prepare('UPDATE subnets SET vlan_id = ? WHERE id = ?').run(vlanId, subnetId);
}

export function replaceVlanAssignments(db, oldVlanId, newVlanId) {
  return db.prepare('UPDATE subnets SET vlan_id = ? WHERE vlan_id = ?').run(newVlanId, oldVlanId);
}

export function clearVlanAssignments(db, vlanId) {
  return db.prepare('UPDATE subnets SET vlan_id = NULL WHERE vlan_id = ?').run(vlanId);
}

export function clearFolderAssignments(db, folderId) {
  return db.prepare('UPDATE subnets SET folder_id = NULL WHERE folder_id = ?').run(folderId);
}
