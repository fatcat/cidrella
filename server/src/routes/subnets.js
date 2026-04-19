import { Router } from 'express';
import { getDb, getSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import {
  parseCidr, normalizeCidr, isValidCidr, calculateSubnets,
  ipToLong, longToIp, isIpInSubnet, subtractCidr, isSubnetOf, cidrsOverlap,
  validateSupernet, applyNameTemplate, canMergeCidrs, getServerIpForSubnet, isValidDomain
} from '../utils/ip.js';
import { generateReverseNames } from '../utils/dnsmasq.js';
import { FALLBACK_SECONDARY_DNS } from '../config/defaults.js';
import { lookupVendorBatch } from '../utils/mac-vendor.js';
import * as IpAddress from '../models/ip-address.js';
import { invalidateSubnetCache } from '../utils/ip-sync.js';

const router = Router();

// Invalidate subnet cache after any mutating request
router.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.on('finish', () => { if (res.statusCode < 400) invalidateSubnetCache(); });
  }
  next();
});


// Wrap route handlers to catch sync/async errors and return informative 500s
function asyncHandler(fn) {
  return (req, res, next) => {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === 'function') {
        result.catch(err => {
          console.error(`Route error [${req.method} ${req.originalUrl}]:`, err);
          if (!res.headersSent) {
            res.status(500).json({ error: err.message || 'Internal server error' });
          }
        });
      }
    } catch (err) {
      console.error(`Route error [${req.method} ${req.originalUrl}]:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Internal server error' });
      }
    }
  };
}

// Helper: build nested tree from flat rows
function buildTree(flatRows) {
  const map = new Map();
  const roots = [];

  for (const row of flatRows) {
    map.set(row.id, { ...row, children: [] });
  }
  for (const row of flatRows) {
    const node = map.get(row.id);
    if (row.parent_id && map.has(row.parent_id)) {
      map.get(row.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// Helper: create system ranges for an allocated subnet
function createSystemRanges(db, subnetId, parsed, gatewayAddress) {
  if (parsed.prefix >= 31) return;

  const types = db.prepare("SELECT id, name FROM range_types WHERE is_system = 1 AND name IN ('Network', 'Gateway', 'Broadcast')").all();
  const typeMap = Object.fromEntries(types.map(t => [t.name, t.id]));

  db.prepare('INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)').run(
    subnetId, typeMap['Network'], parsed.network, parsed.network, 'Network address'
  );
  if (gatewayAddress) {
    db.prepare('INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)').run(
      subnetId, typeMap['Gateway'], gatewayAddress, gatewayAddress, 'Default gateway'
    );
  }
  db.prepare('INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)').run(
    subnetId, typeMap['Broadcast'], parsed.broadcast, parsed.broadcast, 'Broadcast address'
  );
}

// Helper: nearest power of 2
function nearestPow2(n) {
  if (n <= 1) return 1;
  const lower = Math.pow(2, Math.floor(Math.log2(n)));
  const upper = lower * 2;
  return (n - lower) <= (upper - n) ? lower : upper;
}

// Helper: compute default DHCP range for /21–/26 subnets
function dhcpRangeDefaults(parsed) {
  const size = parsed.broadcastLong - parsed.networkLong + 1;
  const prefix = parsed.prefix;
  if (prefix < 21 || prefix > 26) return null;
  let poolEnd, poolSize;
  if (prefix <= 23) {
    poolEnd = parsed.networkLong + 128;
    poolSize = 64;
  } else {
    poolEnd = parsed.networkLong + nearestPow2(size * 0.35);
    poolSize = nearestPow2(size * 0.15);
  }
  let poolStart = poolEnd - poolSize + 1;
  poolStart = Math.max(poolStart, parsed.networkLong + 1);
  poolEnd = Math.min(poolEnd, parsed.broadcastLong - 1);
  return { startLong: poolStart, endLong: poolEnd };
}

// Helper: populate dhcp_scope_options from dhcp_option_defaults for a new scope
function insertScopeOptionsFromDefaults(db, scopeId, parsed, gateway, domain, cidr) {
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

// Helper: auto-create DHCP scope for a subnet if no existing hosts/leases/scopes
function autoCreateDhcpScope(db, subnetId, parsed, gateway, domainName) {
  const defaults = dhcpRangeDefaults(parsed);
  if (!defaults) return;

  // Skip if existing IP assignments, leases, reservations, or scopes
  const ipCount = db.prepare("SELECT COUNT(*) as c FROM ip_addresses WHERE subnet_id = ? AND status != 'available'").get(subnetId);
  if (ipCount.c > 0) return;
  const leaseCount = db.prepare('SELECT COUNT(*) as c FROM dhcp_leases WHERE subnet_id = ?').get(subnetId);
  if (leaseCount.c > 0) return;
  const resCount = db.prepare('SELECT COUNT(*) as c FROM dhcp_reservations WHERE subnet_id = ?').get(subnetId);
  if (resCount.c > 0) return;
  const existingScope = db.prepare(`
    SELECT r.id FROM ranges r JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.subnet_id = ? AND rt.name = 'DHCP Scope'
  `).get(subnetId);
  if (existingScope) return;

  const dhcpType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope' AND is_system = 1").get();
  if (!dhcpType) return;

  let { startLong, endLong } = defaults;
  const gwLong = gateway ? ipToLong(gateway) : null;
  if (gwLong === startLong) startLong++;
  else if (gwLong === endLong) endLong--;

  const rangeResult = db.prepare('INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)').run(
    subnetId, dhcpType.id, longToIp(startLong), longToIp(endLong), 'DHCP scope'
  );

  const effectiveDomain = domainName || null;
  const scopeResult = db.prepare(`
    INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, gateway, domain_name, description)
    VALUES (?, ?, ?, ?, ?, 'Auto-created DHCP scope')
  `).run(rangeResult.lastInsertRowid, subnetId, getSetting('default_lease_time'), gateway, effectiveDomain);

  // Populate scope options from defaults
  const scopeId = scopeResult.lastInsertRowid;
  insertScopeOptionsFromDefaults(db, scopeId, parsed, gateway, effectiveDomain, parsed.network + '/' + parsed.prefix);
}

// Helper: insert a subnet row
function insertSubnet(db, { cidr, name, description, vlan_id, gateway_address, parent_id, folder_id, status, depth, domain_name }) {
  const parsed = parseCidr(cidr);
  return db.prepare(`
    INSERT INTO subnets (cidr, name, description, vlan_id, network_address, broadcast_address,
      prefix_length, total_addresses, gateway_address, parent_id, folder_id, status, depth, domain_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cidr, name || cidr, description || null, vlan_id || null,
    parsed.network, parsed.broadcast, parsed.prefix, parsed.totalAddresses,
    gateway_address || null, parent_id || null, folder_id || null, status || 'unallocated', depth || 0,
    domain_name || null
  );
}


// Helper: consolidate intermediate subnets after divide
// If all children of a parent are unallocated containers (have children, no config),
// flatten by re-parenting grandchildren directly to the parent and removing intermediaries.
function consolidateIntermediate(db, parentId) {
  if (!parentId) return;

  const children = db.prepare('SELECT * FROM subnets WHERE parent_id = ?').all(parentId);
  if (children.length === 0) return;

  // Check if ALL children are unallocated and have their own children (are intermediaries)
  const allAreIntermediaries = children.every(c => {
    if (c.status !== 'unallocated') return false;
    const grandchildCount = db.prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?').get(c.id);
    return grandchildCount.c > 0;
  });

  if (!allAreIntermediaries) return;

  // Flatten: re-parent all grandchildren to this parent, then delete intermediaries
  const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);
  if (!parent) return;

  for (const child of children) {
    // Move grandchildren up
    db.prepare('UPDATE subnets SET parent_id = ?, depth = ? WHERE parent_id = ?')
      .run(parentId, child.depth, child.id);
    // Delete the intermediate child
    db.prepare('DELETE FROM subnets WHERE id = ?').run(child.id);
  }

  // Fix depth recursively for moved grandchildren (they keep the intermediate's depth, which is correct)
  // Recurse up in case the parent's parent can also be consolidated
  consolidateIntermediate(db, parent.parent_id);
}

// Helper: buddy-merge unallocated siblings after deletion
function buddyMerge(db, parentId) {
  if (!parentId) return;

  let merged = true;
  while (merged) {
    merged = false;
    const unallocLeaves = db.prepare(`
      SELECT s.* FROM subnets s
      WHERE s.parent_id = ? AND s.status = 'unallocated'
        AND NOT EXISTS (SELECT 1 FROM subnets c WHERE c.parent_id = s.id)
      ORDER BY s.network_address
    `).all(parentId);

    for (let i = 0; i < unallocLeaves.length && !merged; i++) {
      for (let j = i + 1; j < unallocLeaves.length && !merged; j++) {
        const a = unallocLeaves[i], b = unallocLeaves[j];
        if (a.prefix_length !== b.prefix_length) continue;

        const combinedPrefix = a.prefix_length - 1;
        const combinedMask = (0xFFFFFFFF << (32 - combinedPrefix)) >>> 0;
        const aNet = ipToLong(a.network_address);
        const bNet = ipToLong(b.network_address);

        if ((aNet & combinedMask) === (bNet & combinedMask)) {
          // They're buddies — merge.
          const combinedNet = Math.min(aNet, bNet);
          const combinedCidr = `${longToIp(combinedNet)}/${combinedPrefix}`;

          const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);

          // Determine destination id for any per-IP/zone state the buddies
          // might be carrying. Unallocated subnets shouldn't have meaningful
          // state, but we transfer anyway to avoid silent loss if callers
          // leave stragglers behind.
          let destId;
          if (parent && combinedCidr === parent.cidr) {
            destId = parent.id;
          } else {
            const ins = insertSubnet(db, {
              cidr: combinedCidr,
              name: combinedCidr,
              parent_id: parentId,
              status: 'unallocated',
              depth: a.depth
            });
            destId = ins.lastInsertRowid;
          }

          transferPerIpArtifactsToParent(db, [a.id, b.id], destId);
          migrateChildZonesToParent(db, [a.id, b.id], destId);

          // Now the buddies have no dangling rows pointing at them; safe to
          // delete. cleanupSubnetData covers ranges/scopes/leases/ip_addresses,
          // then the subnet row itself goes.
          cleanupSubnetData(db, a.id);
          cleanupSubnetData(db, b.id);
          db.prepare('DELETE FROM subnets WHERE id IN (?, ?)').run(a.id, b.id);

          merged = true;
        }
      }
    }
  }

  // If all children are gone, parent becomes a leaf again
  const remaining = db.prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?').get(parentId);
  if (remaining.c === 0) return;

  // If only one unallocated child left covering the full parent, remove it
  if (remaining.c === 1) {
    const onlyChild = db.prepare(`SELECT * FROM subnets WHERE parent_id = ?`).get(parentId);
    const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);
    if (onlyChild.status === 'unallocated' && onlyChild.cidr === parent.cidr.replace(/\/\d+$/, '') + '/' + onlyChild.prefix_length) {
      // Check if child covers the full parent
      if (onlyChild.network_address === parent.network_address && onlyChild.broadcast_address === parent.broadcast_address) {
        db.prepare('DELETE FROM subnets WHERE id = ?').run(onlyChild.id);
      }
    }
  }
}

// GET /api/subnets — return folder-grouped tree
router.get('/', requirePerm('subnets:read'), asyncHandler((req, res) => {
  const db = getDb();

  const folders = db.prepare(`
    SELECT f.* FROM folders f ORDER BY f.sort_order, f.name
  `).all();

  const rows = db.prepare(`
    WITH RECURSIVE subnet_tree AS (
      SELECT s.id FROM subnets s WHERE s.parent_id IS NULL
      UNION ALL
      SELECT s.id FROM subnets s JOIN subnet_tree st ON s.parent_id = st.id
    )
    SELECT s.*,
      (SELECT COUNT(*) FROM ranges WHERE subnet_id = s.id) as range_count,
      (SELECT COUNT(*) FROM ip_addresses WHERE subnet_id = s.id AND status != 'available') as used_count,
      (SELECT COUNT(*) FROM subnets WHERE parent_id = s.id) as child_count
    FROM subnets s
    WHERE s.id IN (SELECT id FROM subnet_tree)
    ORDER BY s.network_address, s.prefix_length
  `).all();

  const tree = buildTree(rows);

  // Group root subnets by folder
  const folderMap = new Map(folders.map(f => [f.id, { ...f, subnets: [] }]));
  const ungrouped = [];

  for (const node of tree) {
    if (node.folder_id && folderMap.has(node.folder_id)) {
      folderMap.get(node.folder_id).subnets.push(node);
    } else {
      ungrouped.push(node);
    }
  }

  const result = [...folderMap.values()];
  // Attach any ungrouped subnets (shouldn't happen normally)
  if (ungrouped.length > 0) {
    result.push({ id: null, name: 'Ungrouped', description: null, sort_order: 999, subnets: ungrouped });
  }

  res.json({ folders: result });
}));

// GET /api/subnets/:id — single subnet with children
router.get('/:id', requirePerm('subnets:read'), asyncHandler((req, res) => {
  const db = getDb();
  const subnet = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM ranges WHERE subnet_id = s.id) as range_count,
      (SELECT COUNT(*) FROM ip_addresses WHERE subnet_id = s.id AND status != 'available') as used_count,
      (SELECT COUNT(*) FROM subnets WHERE parent_id = s.id) as child_count
    FROM subnets s WHERE s.id = ?
  `).get(req.params.id);

  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const children = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM subnets WHERE parent_id = s.id) as child_count
    FROM subnets s WHERE s.parent_id = ? ORDER BY s.network_address
  `).all(subnet.id);

  res.json({ ...subnet, children });
}));

// POST /api/subnets — create root supernet
router.post('/', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const { cidr, name, description, vlan_id, folder_id } = req.body;

  if (!cidr) return res.status(400).json({ error: 'CIDR is required' });
  if (!isValidCidr(cidr)) return res.status(400).json({ error: 'Invalid CIDR notation' });

  const normalized = normalizeCidr(cidr);
  const db = getDb();

  // Check duplicate
  const existing = db.prepare('SELECT id FROM subnets WHERE cidr = ?').get(normalized);
  if (existing) return res.status(409).json({ error: 'Subnet already exists' });

  // Validate against reserved range boundaries (RFC1918, etc.)
  const validation = validateSupernet(normalized);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  // Check overlap with existing root subnets
  const roots = db.prepare('SELECT cidr FROM subnets WHERE parent_id IS NULL').all();
  for (const root of roots) {
    if (cidrsOverlap(normalized, root.cidr)) {
      return res.status(409).json({ error: `Overlaps with existing supernet ${root.cidr}` });
    }
  }

  // Auto-generate name from template if not provided
  let subnetName = name;
  if (!subnetName) {
    const template = getSetting('subnet_name_template');
    subnetName = applyNameTemplate(template, normalized);
  }

  // Validate folder exists if provided
  if (folder_id) {
    const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folder_id);
    if (!folder) return res.status(400).json({ error: 'Folder not found' });
  }

  const result = insertSubnet(db, {
    cidr: normalized,
    name: subnetName,
    description,
    vlan_id,
    folder_id: folder_id || null,
    status: 'unallocated',
    depth: 0
  });

  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(result.lastInsertRowid);
  audit(req.user.id, 'subnet_created', 'subnet', subnet.id, { cidr: normalized });
  res.status(201).json(subnet);
}));

// POST /api/subnets/merge/preview — validate merge without committing
router.post('/merge/preview', requirePerm('subnets:read'), asyncHandler((req, res) => {
  const { subnet_ids } = req.body;
  if (!Array.isArray(subnet_ids) || subnet_ids.length < 2) {
    return res.status(400).json({ error: 'At least 2 subnet IDs required' });
  }

  const db = getDb();
  const subnets = subnet_ids.map(id => db.prepare('SELECT * FROM subnets WHERE id = ?').get(id)).filter(Boolean);
  if (subnets.length !== subnet_ids.length) {
    return res.status(404).json({ error: 'One or more subnets not found' });
  }

  const parentId = subnets[0].parent_id;
  if (!parentId || !subnets.every(s => s.parent_id === parentId)) {
    return res.status(400).json({ error: 'All subnets must be siblings (same parent)' });
  }

  for (const s of subnets) {
    const cc = db.prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?').get(s.id);
    if (cc.c > 0) return res.status(400).json({ error: `Subnet ${s.cidr} has children and cannot be merged` });
  }

  const mergeResult = canMergeCidrs(subnets.map(s => s.cidr));
  if (!mergeResult.valid) {
    return res.status(400).json({ error: mergeResult.error });
  }

  const allocated = subnets.filter(s => s.status === 'allocated');
  const gatewaySubnet = allocated.find(s => s.gateway_address);

  const { conflict: domainConflict, zones: forwardZones } = detectForwardZoneConflict(db, subnets.map(s => s.id));

  res.json({
    merged_cidr: mergeResult.merged_cidr,
    source_cidrs: subnets.map(s => s.cidr),
    allocated_count: allocated.length,
    gateway_preserved: gatewaySubnet ? { cidr: gatewaySubnet.cidr, gateway: gatewaySubnet.gateway_address } : null,
    config_loss: allocated.filter(s => s !== gatewaySubnet).map(s => s.cidr),
    forward_zone_conflict: domainConflict,
    forward_zones: forwardZones
  });
}));

// POST /api/subnets/merge — execute merge
router.post('/merge', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const { subnet_ids } = req.body;
  if (!Array.isArray(subnet_ids) || subnet_ids.length < 2) {
    return res.status(400).json({ error: 'At least 2 subnet IDs required' });
  }

  const db = getDb();
  const subnets = subnet_ids.map(id => db.prepare('SELECT * FROM subnets WHERE id = ?').get(id)).filter(Boolean);
  if (subnets.length !== subnet_ids.length) {
    return res.status(404).json({ error: 'One or more subnets not found' });
  }

  const parentId = subnets[0].parent_id;
  if (!parentId || !subnets.every(s => s.parent_id === parentId)) {
    return res.status(400).json({ error: 'All subnets must be siblings (same parent)' });
  }

  for (const s of subnets) {
    const cc = db.prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?').get(s.id);
    if (cc.c > 0) return res.status(400).json({ error: `Subnet ${s.cidr} has children and cannot be merged` });
  }

  const mergeResult = canMergeCidrs(subnets.map(s => s.cidr));
  if (!mergeResult.valid) {
    return res.status(400).json({ error: mergeResult.error });
  }

  const allocated = subnets.filter(s => s.status === 'allocated');
  const gatewaySubnet = allocated.find(s => s.gateway_address);

  // Forward-zone conflict gate: refuse to silently consolidate when the
  // children claim different forward-zone domains. The user must resolve the
  // clash themselves (rename or delete one of the zones) before merging.
  const childIds = subnets.map(s => s.id);
  const { conflict: domainConflict, zones: forwardZones } = detectForwardZoneConflict(db, childIds);
  if (domainConflict) {
    return res.status(409).json({
      error: 'Cannot merge: child subnets own forward zones with different domain names. Rename or delete one before merging.',
      forward_zones: forwardZones
    });
  }

  // Get name template
  const template = getSetting('subnet_name_template');

  try {
    const txn = db.transaction(() => {
      const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);
      const mergedParsed = parseCidr(mergeResult.merged_cidr);

      // Determine correct gateway for the merged network
      const gwPosition = getSetting('default_gateway_position');
      const mergedGateway = gwPosition === 'last' ? mergedParsed.lastUsable
        : gwPosition === 'none' ? null : mergedParsed.firstUsable;

      // Use the gateway subnet for config metadata, or fall back to any allocated subnet
      const configSource = gatewaySubnet || allocated[0] || null;

      // Check if merging reconstitutes the parent (merged CIDR equals parent CIDR)
      if (mergeResult.merged_cidr === parent.cidr) {
        // Transfer per-IP artifacts and DNS zones from children up to the
        // parent BEFORE deleting the child rows. Without this, all
        // reservations, ip_addresses rows, and dns_zones would be wiped by
        // the delete + cleanup calls below.
        transferPerIpArtifactsToParent(db, childIds, parent.id);
        migrateChildZonesToParent(db, childIds, parent.id);
        if (configSource) migrateChildScopesToParent(db, configSource.id, parent.id);

        // Now it's safe to tear down the children: their per-IP rows, zones,
        // and surviving scope already point at the parent. Competing (non-
        // configSource) scopes cascade-delete with the child row.
        for (const s of subnets) {
          db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(s.id);
          db.prepare('DELETE FROM subnets WHERE id = ?').run(s.id);
        }

        // Restore parent config from the allocated child if any
        if (allocated.length > 0) {
          db.prepare(`UPDATE subnets SET status = 'allocated', name = ?, description = ?,
            vlan_id = ?, gateway_address = ?, has_reverse_dns = ?, domain_name = ?, updated_at = datetime('now')
            WHERE id = ?`).run(
            configSource.name, configSource.description,
            configSource.vlan_id, mergedGateway,
            configSource.has_reverse_dns || 0, configSource.domain_name || null, parent.id
          );
          createSystemRanges(db, parent.id, mergedParsed, mergedGateway);
        } else {
          db.prepare(`UPDATE subnets SET status = 'unallocated', gateway_address = ?, updated_at = datetime('now') WHERE id = ?`).run(
            mergedGateway, parent.id
          );
          createSystemRanges(db, parent.id, mergedParsed, mergedGateway);
        }

        return parent.id;
      }

      // Normal case: merged CIDR is smaller than parent. Create the merged
      // subnet FIRST so we have an id to transfer per-IP artifacts and zones
      // into before the children are deleted.
      const result = insertSubnet(db, {
        cidr: mergeResult.merged_cidr,
        name: configSource ? configSource.name : applyNameTemplate(template, mergeResult.merged_cidr),
        description: configSource?.description || null,
        vlan_id: configSource?.vlan_id || null,
        gateway_address: mergedGateway,
        parent_id: parentId,
        status: allocated.length > 0 ? 'allocated' : 'unallocated',
        depth: parent.depth + 1,
        domain_name: configSource?.domain_name || null,
      });

      const mergedId = result.lastInsertRowid;

      transferPerIpArtifactsToParent(db, childIds, mergedId);
      migrateChildZonesToParent(db, childIds, mergedId);
      if (configSource) migrateChildScopesToParent(db, configSource.id, mergedId);

      // Now safe to remove the children: their per-IP rows, zones, and
      // surviving scope already point at mergedId. Competing scopes cascade.
      for (const s of subnets) {
        db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(s.id);
        db.prepare('DELETE FROM subnets WHERE id = ?').run(s.id);
      }

      createSystemRanges(db, mergedId, mergedParsed, mergedGateway);
      if (configSource?.has_reverse_dns) {
        db.prepare('UPDATE subnets SET has_reverse_dns = 1 WHERE id = ?').run(mergedId);
      }

      return mergedId;
    });

    const mergedId = txn();
    req.afterCommit('regenerate_dns');
    req.afterCommit('regenerate_dhcp');
    audit(req.user.id, 'subnets_merged', 'subnet', mergedId, {
      merged_cidrs: subnets.map(s => s.cidr),
      result_cidr: mergeResult.merged_cidr
    });

    const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);
    const children = db.prepare('SELECT * FROM subnets WHERE parent_id = ? ORDER BY network_address').all(parentId);
    res.json({ ...parent, children });
  } catch (err) {
    console.error('Merge error:', err);
    res.status(500).json({ error: `Merge failed: ${err.message}` });
  }
}));

// POST /api/subnets/apply-template — apply name template to selected subnets
router.post('/apply-template', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const { subnet_ids } = req.body;
  if (!Array.isArray(subnet_ids) || subnet_ids.length === 0) {
    return res.status(400).json({ error: 'At least 1 subnet ID required' });
  }

  const db = getDb();
  const template = getSetting('subnet_name_template');
  if (!template) {
    return res.status(400).json({ error: 'No name template configured' });
  }

  const updated = [];
  const txn = db.transaction(() => {
    for (const id of subnet_ids) {
      const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(id);
      if (!subnet) continue;
      const newName = applyNameTemplate(template, subnet.cidr);
      if (newName !== subnet.name) {
        db.prepare("UPDATE subnets SET name = ?, updated_at = datetime('now') WHERE id = ?").run(newName, id);
        updated.push({ id, cidr: subnet.cidr, old_name: subnet.name, new_name: newName });
      }
    }
  });

  txn();
  if (updated.length > 0) {
    audit(req.user.id, 'template_applied', 'subnet', null, { updated });
  }
  res.json({ updated, count: updated.length });
}));

// PUT /api/subnets/:id — update subnet config
router.put('/:id', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const { name, description, vlan_id, gateway_address, scan_interval, folder_id, domain_name, scan_enabled, cidr } = req.body;

  // CIDR changes aren't supported via PUT — use /divide or /merge. Rejecting
  // explicitly avoids silently ignoring a field the client thought it set.
  if (cidr !== undefined) {
    return res.status(400).json({
      error: 'CIDR cannot be changed via PUT. Use /api/subnets/:id/divide or /api/subnets/merge.'
    });
  }

  if (domain_name && !isValidDomain(domain_name)) {
    return res.status(400).json({ error: 'Invalid domain name format' });
  }
  const db = getDb();

  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  // Validate scan_interval if provided
  const validIntervals = [null, '5m', '15m', '30m', '1h', '4h'];
  if (scan_interval !== undefined && !validIntervals.includes(scan_interval)) {
    return res.status(400).json({ error: 'Invalid scan interval. Use: null, 5m, 15m, 30m, 1h, 4h' });
  }

  // Validate folder_id if provided (only for root subnets)
  if (folder_id !== undefined && !subnet.parent_id) {
    if (folder_id !== null) {
      const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folder_id);
      if (!folder) return res.status(400).json({ error: 'Folder not found' });
    }
  }

  // Forward-zone conflict check: if user is switching domain_name to one that
  // already names a DIFFERENT forward zone, refuse. We do this BEFORE any
  // UPDATE so a 409 leaves the row untouched. A detached zone (subnet_id
  // NULL) with the same name is adopted instead of blocked — mirrors the
  // configure endpoint's adoption behavior so detach+re-attach works as the
  // user would expect.
  let domainRename = null;  // { kind, oldZoneId?, newName? } | null
  if (domain_name !== undefined && domain_name !== subnet.domain_name) {
    const oldZone = subnet.domain_name
      ? db.prepare("SELECT id FROM dns_zones WHERE name = ? AND type = 'forward' AND subnet_id = ?")
          .get(subnet.domain_name, subnet.id)
      : null;

    if (domain_name) {
      const clash = db.prepare("SELECT id, subnet_id FROM dns_zones WHERE name = ? AND type = 'forward'")
        .get(domain_name);
      if (clash && clash.subnet_id != null && clash.subnet_id !== subnet.id && (!oldZone || clash.id !== oldZone.id)) {
        return res.status(409).json({
          error: `A forward zone named "${domain_name}" already belongs to another subnet. Pick a different domain name or detach the existing zone first.`
        });
      }
      if (clash && clash.subnet_id == null && (!oldZone || clash.id !== oldZone.id)) {
        domainRename = { kind: 'adopt', adoptZoneId: clash.id, oldZoneId: oldZone?.id };
      } else {
        domainRename = { kind: oldZone ? 'rename' : 'create', oldZoneId: oldZone?.id, newName: domain_name };
      }
    } else if (oldZone) {
      domainRename = { kind: 'detach', oldZoneId: oldZone.id };
    }
  }

  // Resolve scan_enabled: true→1, false→0, null→NULL, undefined→keep existing
  const scanEn = scan_enabled === undefined ? subnet.scan_enabled
    : scan_enabled === null ? null
    : scan_enabled ? 1 : 0;

  // Wrap all writes in a single transaction so a failure mid-sequence (zone
  // rename UNIQUE violation, a later INSERT error, etc.) rolls back the
  // subnet row update and the gateway range change together. Otherwise the
  // client can get a 500 with subnet.domain_name already changed on disk but
  // no corresponding zone rename, leaving the system in a split-brain state.
  const gatewayChanged = gateway_address && gateway_address !== subnet.gateway_address;

  // Refuse a gateway change that would place the router inside an existing
  // DHCP pool: dnsmasq would hand out the gateway IP as a dynamic lease and
  // clients would conflict with the router. Force the user to shrink the
  // pool first (or pick a gateway outside it).
  if (gatewayChanged) {
    const pools = db.prepare(`
      SELECT r.start_ip, r.end_ip FROM dhcp_scopes s
      JOIN ranges r ON s.range_id = r.id
      WHERE s.subnet_id = ?
    `).all(subnet.id);
    const gwLong = ipToLong(gateway_address);
    for (const p of pools) {
      if (gwLong >= ipToLong(p.start_ip) && gwLong <= ipToLong(p.end_ip)) {
        return res.status(409).json({
          error: `Gateway ${gateway_address} falls inside an existing DHCP pool (${p.start_ip}–${p.end_ip}). Shrink the pool or choose a gateway outside it.`,
          dhcp_pool: { start_ip: p.start_ip, end_ip: p.end_ip }
        });
      }
    }
  }

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE subnets SET name = ?, description = ?, vlan_id = ?, gateway_address = ?,
        scan_interval = ?, folder_id = ?, domain_name = ?, scan_enabled = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? subnet.name,
      description !== undefined ? description : subnet.description,
      vlan_id !== undefined ? vlan_id : subnet.vlan_id,
      gateway_address ?? subnet.gateway_address,
      scan_interval !== undefined ? scan_interval : subnet.scan_interval,
      folder_id !== undefined && !subnet.parent_id ? folder_id : subnet.folder_id,
      domain_name !== undefined ? domain_name : subnet.domain_name,
      scanEn,
      subnet.id
    );

    if (gatewayChanged) {
      const gwType = db.prepare("SELECT id FROM range_types WHERE name = 'Gateway' AND is_system = 1").get();
      if (gwType) {
        const result = db.prepare("UPDATE ranges SET start_ip = ?, end_ip = ?, updated_at = datetime('now') WHERE subnet_id = ? AND range_type_id = ?").run(
          gateway_address, gateway_address, subnet.id, gwType.id
        );
        if (result.changes === 0) {
          db.prepare('INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)').run(
            subnet.id, gwType.id, gateway_address, gateway_address, 'Default gateway'
          );
        }
      }

      // Release old gateway IP (set to available) if it was persisted
      if (subnet.gateway_address) {
        const oldGwIp = IpAddress.findBySubnetAndIp(db, subnet.id, subnet.gateway_address);
        if (oldGwIp) {
          IpAddress.setStatus(db, subnet.id, subnet.gateway_address, 'available', null);
        }
      }

      // Reserve new gateway IP
      IpAddress.setStatus(db, subnet.id, gateway_address, 'locked', 'Default gateway');
    }

    // Apply the domain-rename decision computed above. RENAME preserves all
    // records in the zone (dns_records.zone_id stays valid); DELETE would have
    // cascaded them away.
    if (domainRename) {
      if (domainRename.kind === 'rename') {
        db.prepare("UPDATE dns_zones SET name = ?, soa_serial = soa_serial + 1, updated_at = datetime('now') WHERE id = ?")
          .run(domainRename.newName, domainRename.oldZoneId);
      } else if (domainRename.kind === 'create') {
        db.prepare("INSERT INTO dns_zones (name, type, subnet_id, description, enabled) VALUES (?, 'forward', ?, ?, 1)")
          .run(domainRename.newName, subnet.id, `Forward zone for ${subnet.cidr}`);
      } else if (domainRename.kind === 'adopt') {
        // Detached same-name zone exists — re-attach to this subnet. If the
        // subnet had an oldZone (renaming TO the adopted zone's name), detach
        // the old one first so we don't end up with two zones owned by this
        // subnet.
        if (domainRename.oldZoneId) {
          db.prepare("UPDATE dns_zones SET subnet_id = NULL, updated_at = datetime('now') WHERE id = ?")
            .run(domainRename.oldZoneId);
        }
        db.prepare("UPDATE dns_zones SET subnet_id = ?, soa_serial = soa_serial + 1, updated_at = datetime('now') WHERE id = ?")
          .run(subnet.id, domainRename.adoptZoneId);
      } else if (domainRename.kind === 'detach') {
        db.prepare("UPDATE dns_zones SET subnet_id = NULL, updated_at = datetime('now') WHERE id = ?")
          .run(domainRename.oldZoneId);
      }
    }
  });
  txn();

  if (gatewayChanged) {
    req.afterCommit('regenerate_dhcp');
  }
  if (domainRename) {
    req.afterCommit('regenerate_dns');
  }

  const updated = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnet.id);
  audit(req.user.id, 'subnet_updated', 'subnet', subnet.id, { changes: req.body });
  res.json(updated);
}));

// POST /api/subnets/:id/divide/preview — preview division without committing
router.post('/:id/divide/preview', requirePerm('subnets:read'), asyncHandler((req, res) => {
  const { cidr, new_prefix } = req.body;
  const db = getDb();
  const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Subnet not found' });

  // Must be a leaf
  const childCount = db.prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?').get(parent.id);
  if (childCount.c > 0) return res.status(400).json({ error: 'Subnet already has children. Cannot divide further.' });

  try {
    // Equal division mode (new_prefix)
    if (new_prefix !== undefined) {
      const targetPrefix = parseInt(new_prefix, 10);
      if (targetPrefix <= parseCidr(parent.cidr).prefix || targetPrefix > 32) {
        return res.status(400).json({ error: 'Invalid target prefix' });
      }
      const subnets = calculateSubnets(parent.cidr, targetPrefix);
      const count = subnets.length;
      if (count > 256) {
        return res.status(400).json({ error: 'Cannot divide into more than 256 subnets' });
      }
      let gatewaySubnet = null;
      if (parent.gateway_address) {
        gatewaySubnet = subnets.find(s => isIpInSubnet(parent.gateway_address, `${s.network}/${s.prefix}`));
      }
      const childCidrs = subnets.map(s => `${s.network}/${s.prefix}`);
      return res.json({
        parent: parent.cidr,
        mode: 'equal',
        subnets: childCidrs,
        count,
        is_allocated: parent.status === 'allocated',
        gateway_preserved: gatewaySubnet ? `${gatewaySubnet.network}/${gatewaySubnet.prefix}` : null,
        lossy: detectLossyIpsForDivision(db, parent.id, childCidrs)
      });
    }

    // Legacy carve mode (single child CIDR)
    if (!cidr) return res.status(400).json({ error: 'CIDR or new_prefix is required' });
    if (!isValidCidr(cidr)) return res.status(400).json({ error: 'Invalid CIDR notation' });
    const normalized = normalizeCidr(cidr);
    if (!isSubnetOf(normalized, parent.cidr)) {
      return res.status(400).json({ error: 'Child CIDR must be within parent subnet' });
    }
    const remainder = subtractCidr(parent.cidr, normalized);
    const childCidrs = [normalized, ...remainder];
    res.json({
      parent: parent.cidr,
      mode: 'carve',
      carved: normalized,
      remainder,
      is_allocated: parent.status === 'allocated',
      gateway_preserved: parent.gateway_address ? isIpInSubnet(parent.gateway_address, normalized) : null,
      lossy: detectLossyIpsForDivision(db, parent.id, childCidrs)
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Detect hosts that will lose meaning when the parent is divided: any IP
// carrying data (reservation or non-default ip_addresses state) that would
// fall on a new child's network or broadcast address. These rows would be
// migrated onto an unusable address, so we surface them and require an
// explicit force to proceed.
//
// childCidrs: ["10.0.0.0/21", "10.0.8.0/21", ...]
//
// If `childCidrs` is a PROPER SUBSET of the parent (selected_cidrs path in
// equal-mode divide), any host whose IP falls OUTSIDE every selected child
// is also flagged as lossy — the transfer helpers silently drop rows with
// no matching child, so without this check users lose reservations when
// doing partial divides.
function detectLossyIpsForDivision(db, parentId, childCidrs) {
  const boundaries = new Map(); // ipStr -> 'network' | 'broadcast'
  const childRanges = childCidrs.map(c => {
    const p = parseCidr(c);
    return { cidr: c, networkLong: p.networkLong, broadcastLong: p.broadcastLong };
  });
  for (const cr of childRanges) {
    const p = parseCidr(cr.cidr);
    // Skip /31 and /32 — no network/broadcast concept (point-to-point / host).
    if (p.prefix >= 31) continue;
    boundaries.set(longToIp(cr.networkLong), { reason: 'network', child_cidr: cr.cidr });
    boundaries.set(longToIp(cr.broadcastLong), { reason: 'broadcast', child_cidr: cr.cidr });
  }
  const isCovered = (ipLong) =>
    childRanges.some(c => ipLong >= c.networkLong && ipLong <= c.broadcastLong);

  const lossy = [];

  // classify(ipLong) returns a reason/child_cidr for the loss, or null if
  // the IP is safely covered by a non-boundary position in some child.
  const classify = (ipAddr, ipLong) => {
    const b = boundaries.get(ipAddr);
    if (b) return { reason: b.reason, child_cidr: b.child_cidr };
    if (!isCovered(ipLong)) return { reason: 'outside_selection', child_cidr: null };
    return null;
  };

  const reservations = db.prepare(
    'SELECT id, ip_address, mac_address, hostname FROM dhcp_reservations WHERE subnet_id = ?'
  ).all(parentId);
  for (const r of reservations) {
    const cls = classify(r.ip_address, ipToLong(r.ip_address));
    if (!cls) continue;
    lossy.push({
      ip: r.ip_address,
      child_cidr: cls.child_cidr,
      reason: cls.reason,
      carries: 'dhcp_reservation',
      hostname: r.hostname || null,
      mac: r.mac_address || null,
    });
  }

  // ip_addresses rows: only count rows that carry meaningful state. A bare
  // "available" row with no hostname/MAC/scan history is noise from the
  // sync scheduler and safe to drop.
  const ips = db.prepare(
    "SELECT ip_address, hostname, mac_address, status FROM ip_addresses WHERE subnet_id = ? AND (hostname IS NOT NULL OR mac_address IS NOT NULL OR status NOT IN ('available', 'locked'))"
  ).all(parentId);
  for (const ip of ips) {
    const cls = classify(ip.ip_address, ipToLong(ip.ip_address));
    if (!cls) continue;
    lossy.push({
      ip: ip.ip_address,
      child_cidr: cls.child_cidr,
      reason: cls.reason,
      carries: 'ip_address',
      hostname: ip.hostname || null,
      mac: ip.mac_address || null,
      status: ip.status || null,
    });
  }

  // DNS A records in any forward zone owned by this subnet: if the record
  // value lands on a boundary IP, the record stays queryable post-divide but
  // points at an unusable target. The migrateParentZonesToChildren helper
  // reassigns the zone but can't rewrite the values.
  const aRecords = db.prepare(`
    SELECT r.name AS name, r.value AS value, z.name AS zone_name
    FROM dns_records r
    JOIN dns_zones z ON r.zone_id = z.id
    WHERE z.subnet_id = ? AND z.type = 'forward' AND r.type = 'A' AND r.enabled = 1
  `).all(parentId);
  for (const rec of aRecords) {
    const cls = classify(rec.value, ipToLong(rec.value));
    if (!cls) continue;
    lossy.push({
      ip: rec.value,
      child_cidr: cls.child_cidr,
      reason: cls.reason,
      carries: 'dns_record',
      hostname: rec.name === '@' ? rec.zone_name : `${rec.name}.${rec.zone_name}`
    });
  }

  return lossy;
}

// Helper: migrate config from parent to inheriting child during division
function migrateConfigToChild(db, parentId, childId, childParsed, parentGateway, parentHasReverseDns) {
  createSystemRanges(db, childId, childParsed, parentGateway);

  // Migrate DHCP scope ranges (and their scope config + options) if they fit
  // and child is >= /29. Previously only the range row was moved — the
  // dhcp_scopes config (lease time, DNS, options) got dropped on the floor,
  // leaving the inheriting child with a DHCP range but no working scope.
  if (childParsed.prefix <= 29) {
    const dhcpRanges = db.prepare(`
      SELECT r.* FROM ranges r
      JOIN range_types rt ON r.range_type_id = rt.id
      WHERE r.subnet_id = ? AND rt.name = 'DHCP Scope'
    `).all(parentId);

    for (const dhcpRange of dhcpRanges) {
      const rStart = ipToLong(dhcpRange.start_ip);
      const rEnd = ipToLong(dhcpRange.end_ip);
      const clippedStart = Math.max(rStart, childParsed.networkLong + 1);
      const clippedEnd = Math.min(rEnd, childParsed.broadcastLong - 1);
      if (clippedStart > clippedEnd) continue;

      const dhcpType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope' AND is_system = 1").get();
      if (!dhcpType) continue;

      const newRange = db.prepare(
        'INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)'
      ).run(childId, dhcpType.id, longToIp(clippedStart), longToIp(clippedEnd), dhcpRange.description);

      // Copy every dhcp_scopes row attached to the parent's range into a new
      // row under the child, pointing at the clipped range. Then clone scope
      // options so lease time / DNS / NTP / etc. carry over.
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
  }

  // Migrate user-created ranges that fit entirely within the child
  const userRanges = db.prepare(`
    SELECT r.* FROM ranges r
    JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.subnet_id = ? AND rt.is_system = 0
  `).all(parentId);

  for (const ur of userRanges) {
    const urStart = ipToLong(ur.start_ip);
    const urEnd = ipToLong(ur.end_ip);
    if (urStart >= childParsed.networkLong && urEnd <= childParsed.broadcastLong) {
      db.prepare('INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)').run(
        childId, ur.range_type_id, ur.start_ip, ur.end_ip, ur.description
      );
    }
  }

  if (parentHasReverseDns) {
    db.prepare('UPDATE subnets SET has_reverse_dns = 1 WHERE id = ?').run(childId);
  }
}

// Helper: delete all subnet-scoped state during teardown. Covers ranges,
// ip_addresses, dhcp_leases, and dhcp_scopes (+ options). Most of these
// tables already ON DELETE CASCADE from subnets (via migration 007), but
// the explicit deletes keep the ordering stable and insulate the teardown
// path from future FK relaxations; the scope_options cleanup in particular
// guards against forgetting to re-add the cascade if that table is ever
// reshaped.
function cleanupSubnetData(db, subnetId) {
  db.prepare(
    'DELETE FROM dhcp_scope_options WHERE scope_id IN (SELECT id FROM dhcp_scopes WHERE subnet_id = ?)'
  ).run(subnetId);
  db.prepare('DELETE FROM dhcp_scopes WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(subnetId);
  db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(subnetId);
}

// Helper: delete DNS zones owned by a subnet (records cascade via FK).
// Before deletion, if any sibling subnet (same parent) shares this subnet's
// forward-zone domain_name, REASSIGN the forward zone to that sibling
// instead of deleting it. Divide copies `domain_name` to every child so all
// siblings share a zone, but only one owns it (schema 1:1 limitation).
// Without this reassignment, deleting the owning child wipes the forward
// zone for every sibling that was still using it via domain_name.
function cleanupSubnetZones(db, subnetId) {
  const subnet = db.prepare('SELECT parent_id, domain_name FROM subnets WHERE id = ?').get(subnetId);
  if (subnet?.parent_id && subnet.domain_name) {
    const heir = db.prepare(
      `SELECT id FROM subnets WHERE parent_id = ? AND id != ? AND domain_name = ? ORDER BY network_address LIMIT 1`
    ).get(subnet.parent_id, subnetId, subnet.domain_name);
    if (heir) {
      db.prepare(
        "UPDATE dns_zones SET subnet_id = ?, updated_at = datetime('now') WHERE subnet_id = ? AND type = 'forward' AND name = ?"
      ).run(heir.id, subnetId, subnet.domain_name);
    }
  }
  db.prepare('DELETE FROM dns_zones WHERE subnet_id = ?').run(subnetId);
}

// During divide: move per-IP rows (DHCP reservations, ip_addresses) from the
// parent to whichever new child's CIDR contains each row's IP. Without this,
// cleanupSubnetData() wipes the parent's ip_addresses (losing hostnames and
// scan state) and dhcp_reservations linger pointing at an unallocated parent.
function transferPerIpArtifactsToChildren(db, parentId) {
  const children = db.prepare('SELECT id, cidr FROM subnets WHERE parent_id = ?').all(parentId);
  if (children.length === 0) return;
  const childRanges = children.map(c => {
    const p = parseCidr(c.cidr);
    return { id: c.id, netLong: p.networkLong, bcastLong: p.broadcastLong };
  });
  const findChildForIp = (ipLong) =>
    childRanges.find(c => ipLong >= c.netLong && ipLong <= c.bcastLong);

  // Reservations (no range conflict — single-IP rows)
  const reservations = db.prepare(
    'SELECT id, ip_address FROM dhcp_reservations WHERE subnet_id = ?'
  ).all(parentId);
  const updRes = db.prepare('UPDATE dhcp_reservations SET subnet_id = ? WHERE id = ?');
  for (const r of reservations) {
    const c = findChildForIp(ipToLong(r.ip_address));
    if (c) updRes.run(c.id, r.id);
  }

  // ip_addresses: parent's row has the live state (hostname/mac/status/scan).
  // If a row already exists under the child for the same IP (auto-populated
  // after the child was inserted), prefer the parent's and drop the dup.
  const ips = db.prepare('SELECT id, ip_address FROM ip_addresses WHERE subnet_id = ?').all(parentId);
  const findDup = db.prepare('SELECT id FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?');
  const delIp = db.prepare('DELETE FROM ip_addresses WHERE id = ?');
  const updIp = db.prepare('UPDATE ip_addresses SET subnet_id = ? WHERE id = ?');
  for (const ip of ips) {
    const c = findChildForIp(ipToLong(ip.ip_address));
    if (!c) continue;
    const dup = findDup.get(c.id, ip.ip_address);
    if (dup && dup.id !== ip.id) delIp.run(dup.id);
    updIp.run(c.id, ip.id);
  }
}

// Helper: during divide, transfer the parent's DNS zones (forward + reverse)
// to the appropriate child instead of deleting them. Without this, a parent's
// forward zone ("the-mcnultys.org") and every reverse /24 zone it owned get
// wiped the moment it's divided, taking thousands of PTR records with them.
//
// Reverse zones are assigned to whichever child's CIDR fully contains the
// /24 (or /16/etc) the zone represents. Forward zones default to the first
// child (lowest network address) — good enough; users can reassign later.
function migrateParentZonesToChildren(db, parentId) {
  const zones = db.prepare('SELECT id, name, type FROM dns_zones WHERE subnet_id = ?').all(parentId);
  if (zones.length === 0) return;

  const children = db.prepare(
    'SELECT id, cidr, network_address, gateway_address, domain_name FROM subnets WHERE parent_id = ? ORDER BY network_address'
  ).all(parentId);
  if (children.length === 0) return;

  const childRanges = children.map(c => {
    const p = parseCidr(c.cidr);
    return {
      id: c.id, cidr: c.cidr,
      gateway_address: c.gateway_address, domain_name: c.domain_name,
      networkLong: p.networkLong, broadcastLong: p.broadcastLong
    };
  });

  const upd = db.prepare('UPDATE dns_zones SET subnet_id = ? WHERE id = ?');

  for (const zone of zones) {
    if (zone.type === 'forward') {
      // Prefer the child whose domain_name matches the zone (the "inheriting"
      // child also carried the parent's domain_name over during divide). If
      // multiple children share the domain, that's the post-divide expected
      // state; pick the one that inherited the parent's gateway first, else
      // fall back to lowest-address. Without this targeting, the zone lands
      // on an arbitrary child — so subsequent `PUT /api/subnets/:id` renames
      // on the inheriting child fail because a different child owns the zone.
      const byName = childRanges.filter(c => c.domain_name === zone.name);
      const pool = byName.length > 0 ? byName : childRanges;
      const owner = pool.find(c => c.gateway_address) || pool[0];
      upd.run(owner.id, zone.id);
      continue;
    }
    // Reverse: zone name is like "c.b.a.in-addr.arpa" (/24), "b.a.in-addr.arpa"
    // (/16), or "a.in-addr.arpa" (/8). Compute the IP range it represents and
    // find the child whose CIDR contains it.
    const bare = zone.name.replace(/\.in-addr\.arpa\.?$/, '');
    const octets = bare.split('.').map(Number).reverse(); // e.g. [a, b, c]
    if (octets.some(o => !Number.isFinite(o) || o < 0 || o > 255)) continue;
    let zoneNetLong, zoneBcastLong;
    if (octets.length === 3) {
      // /24
      zoneNetLong = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8)) >>> 0;
      zoneBcastLong = zoneNetLong | 0xFF;
    } else if (octets.length === 2) {
      // /16
      zoneNetLong = ((octets[0] << 24) | (octets[1] << 16)) >>> 0;
      zoneBcastLong = zoneNetLong | 0xFFFF;
    } else if (octets.length === 1) {
      // /8
      zoneNetLong = (octets[0] << 24) >>> 0;
      zoneBcastLong = zoneNetLong | 0xFFFFFF;
    } else {
      continue;
    }

    // Find the smallest child whose CIDR fully contains the zone's IP range.
    let winner = childRanges.find(c =>
      zoneNetLong >= c.networkLong && zoneBcastLong <= c.broadcastLong
    );
    // Fallback: if no child fully contains it (parent was subdivided smaller
    // than the reverse-zone scope), keep it with the first child so records
    // aren't lost. A human can clean it up.
    if (!winner) winner = childRanges[0];
    upd.run(winner.id, zone.id);
  }
}

// Inverse of transferPerIpArtifactsToChildren: during MERGE, move reservations
// and ip_addresses from the children being merged to the new/merged subnet.
// Without this, cleanupSubnetData() wipes everything the merging children knew
// about the IPs (hostnames, MACs, scan state, reservations).
//
// Reservations are constrained by UNIQUE(subnet_id, mac) AND UNIQUE(subnet_id, ip).
// A raw bulk UPDATE can hit those constraints when the destination already has
// a row with the same MAC or IP — e.g. buddyMerge targeting the parent, or a
// merge across siblings that legitimately have duplicate entries. Dedup
// upfront by deleting dest-side duplicates (child wins, per the same rule
// we use for ip_addresses).
function transferPerIpArtifactsToParent(db, childIds, mergedId) {
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

  // For ip_addresses, the child's row has the live state. If the merged
  // subnet already has a row for the same IP (rare — merged was just
  // created), dedup by preferring the child's row.
  const ips = db.prepare(
    `SELECT id, ip_address FROM ip_addresses WHERE subnet_id IN (${placeholders})`
  ).all(...childIds);
  const findDup = db.prepare('SELECT id FROM ip_addresses WHERE subnet_id = ? AND ip_address = ?');
  const delIp = db.prepare('DELETE FROM ip_addresses WHERE id = ?');
  const updIp = db.prepare('UPDATE ip_addresses SET subnet_id = ? WHERE id = ?');
  for (const ip of ips) {
    const dup = findDup.get(mergedId, ip.ip_address);
    if (dup && dup.id !== ip.id) delIp.run(dup.id);
    updIp.run(mergedId, ip.id);
  }
}

// Inverse of migrateParentZonesToChildren: during MERGE, move DNS zones
// (forward + reverse) attached to any of the children to the merged subnet.
// Records stay attached to their zone via zone_id, so no cascading loss.
function migrateChildZonesToParent(db, childIds, mergedId) {
  if (!Array.isArray(childIds) || childIds.length === 0) return;
  const placeholders = childIds.map(() => '?').join(',');
  db.prepare(
    `UPDATE dns_zones SET subnet_id = ? WHERE subnet_id IN (${placeholders})`
  ).run(mergedId, ...childIds);
}

// During MERGE, move the configSource child's DHCP scope (+ its backing
// range and scope options) to the merged subnet. configSource is the
// allocated child whose config metadata (name, gateway, domain_name, etc.)
// survives; its scope is the one we want to preserve. Other merging
// children's scopes are deliberately left to CASCADE-delete via
// dhcp_scopes.subnet_id ON DELETE CASCADE — they were competing
// narrower-scope definitions, not survivors.
//
// Ranges table has no ON DELETE cascade on subnet_id directly, but
// dhcp_scopes.range_id → ranges.id ON DELETE CASCADE means deleting the
// child's ranges cascade-wipes its scopes too. So we move BOTH the range
// and the scope together, before the child subnet deletion runs.
function migrateChildScopesToParent(db, configSourceId, mergedId) {
  if (!configSourceId || configSourceId === mergedId) return;

  // Move the user-owned DHCP Scope range row to the merged subnet.
  db.prepare(`
    UPDATE ranges SET subnet_id = ?
    WHERE subnet_id = ?
      AND range_type_id = (SELECT id FROM range_types WHERE name = 'DHCP Scope' AND is_system = 1)
  `).run(mergedId, configSourceId);

  // The scope row itself. Options are attached via scope_id (FK cascade)
  // so they travel automatically with the scope row UPDATE.
  db.prepare(
    `UPDATE dhcp_scopes SET subnet_id = ? WHERE subnet_id = ?`
  ).run(mergedId, configSourceId);
}

// Detect forward-zone domain conflicts among the subnets about to be merged.
// If two children have forward zones with different names, merging them would
// either collide (two rows with the same subnet_id but different names — fine
// in the schema but the user certainly didn't intend it) or force us to pick
// one and drop the other. Returns { conflict: bool, zones: [{subnet_id, name}] }.
function detectForwardZoneConflict(db, childIds) {
  if (!Array.isArray(childIds) || childIds.length === 0) return { conflict: false, zones: [] };
  const placeholders = childIds.map(() => '?').join(',');
  const zones = db.prepare(
    `SELECT subnet_id, name FROM dns_zones WHERE type = 'forward' AND subnet_id IN (${placeholders})`
  ).all(...childIds);
  const names = new Set(zones.map(z => z.name));
  return { conflict: names.size > 1, zones };
}

// Helper: wipe all derivative state (zones, leases, scopes + options) for
// every descendant of `parentId`. Called during subtree deletion. The
// recursive CTE builds the descendant id set once; we reuse it for each
// sub-table.
function cleanupSubtreeZones(db, parentId) {
  const tree = 'WITH RECURSIVE tree AS (SELECT id FROM subnets WHERE parent_id = ? UNION ALL SELECT s.id FROM subnets s JOIN tree t ON s.parent_id = t.id)';
  db.prepare(`${tree} DELETE FROM dns_zones WHERE subnet_id IN (SELECT id FROM tree)`).run(parentId);
  db.prepare(`${tree} DELETE FROM dhcp_scope_options WHERE scope_id IN (SELECT id FROM dhcp_scopes WHERE subnet_id IN (SELECT id FROM tree))`).run(parentId);
  db.prepare(`${tree} DELETE FROM dhcp_scopes WHERE subnet_id IN (SELECT id FROM tree)`).run(parentId);
  db.prepare(`${tree} DELETE FROM dhcp_leases WHERE subnet_id IN (SELECT id FROM tree)`).run(parentId);
}

// Helper: clear parent config after division. Assumes per-IP artifacts (IP
// addresses, reservations) and DNS zones have ALREADY been transferred to
// children via transferPerIpArtifactsToChildren() and migrateParentZonesToChildren().
// This call wipes parent-owned ranges, DHCP scopes (which migrateConfigToChild
// CLONED rather than moved — the parent's originals need to go), and resets
// the parent row's config fields.
function clearParentConfig(db, parentId) {
  db.prepare(
    'DELETE FROM dhcp_scope_options WHERE scope_id IN (SELECT id FROM dhcp_scopes WHERE subnet_id = ?)'
  ).run(parentId);
  db.prepare('DELETE FROM dhcp_scopes WHERE subnet_id = ?').run(parentId);
  db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ?').run(parentId);
  db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(parentId);
  db.prepare(`
    UPDATE subnets SET status = 'unallocated', description = NULL, vlan_id = NULL,
      gateway_address = NULL, has_reverse_dns = 0, domain_name = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(parentId);
}

// POST /api/subnets/:id/divide — execute division
// `force` accepts destruction of the parent's allocated config.
// `force_lossy` is a separate acknowledgement that any host IPs landing on
// new network/broadcast boundaries will become unusable. We keep these
// distinct so confirming "divide an allocated subnet" doesn't silently also
// accept "lose a reservation and some A records."
router.post('/:id/divide', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const { cidr, new_prefix, force, force_lossy, selected_cidrs } = req.body;
  const db = getDb();
  const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Subnet not found' });

  // Must be a leaf
  const childCount = db.prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?').get(parent.id);
  if (childCount.c > 0) return res.status(400).json({ error: 'Subnet already has children. Cannot divide further.' });

  // Check if parent is allocated — require confirmation
  if (parent.status === 'allocated' && !force) {
    return res.status(409).json({
      error: 'Subnet is allocated. Division will migrate or remove its configuration.',
      requires_confirmation: true,
      can_force: true
    });
  }

  const childDepth = parent.depth + 1;
  const parentParsed = parseCidr(parent.cidr);

  // Get name template
  const template = getSetting('subnet_name_template');

  try {
    // Equal division mode
    if (new_prefix !== undefined) {
      const targetPrefix = parseInt(new_prefix, 10);
      if (targetPrefix <= parentParsed.prefix || targetPrefix > 32) {
        return res.status(400).json({ error: 'Invalid target prefix' });
      }
      let subnets = calculateSubnets(parent.cidr, targetPrefix);
      if (subnets.length > 256) {
        return res.status(400).json({ error: 'Cannot divide into more than 256 subnets' });
      }

      // Filter to selected CIDRs if provided
      if (Array.isArray(selected_cidrs) && selected_cidrs.length > 0) {
        const allCidrs = new Set(subnets.map(s => `${s.network}/${s.prefix}`));
        const invalid = selected_cidrs.filter(c => !allCidrs.has(c));
        if (invalid.length > 0) {
          return res.status(400).json({ error: `Invalid selected CIDRs: ${invalid.join(', ')}` });
        }
        const selectedSet = new Set(selected_cidrs);
        subnets = subnets.filter(s => selectedSet.has(`${s.network}/${s.prefix}`));
      }

      // Lossy-IP gate: if any host's IP would fall on a new child's network
      // or broadcast, require explicit force_lossy. Distinct from `force`
      // (which covers the allocated-parent gate) — see route comment above.
      const childCidrList = subnets.map(s => `${s.network}/${s.prefix}`);
      const lossy = detectLossyIpsForDivision(db, parent.id, childCidrList);
      if (lossy.length > 0 && !force_lossy) {
        return res.status(409).json({
          error: `${lossy.length} host IP(s) would land on a new subnet's network/broadcast address and be unusable after divide.`,
          requires_confirmation: true,
          can_force_lossy: true,
          lossy
        });
      }

      const txn = db.transaction(() => {
        // Infer the parent's gateway POSITION (first / last / custom / none)
        // so children can inherit the same relative choice — prior code only
        // copied the parent's literal address into the one child that
        // happened to contain it, and fell back to a global setting for the
        // rest, producing divergent gateways within a single divide.
        let inheritedPosition = null;
        if (parent.status === 'allocated' && parent.gateway_address) {
          if (parent.gateway_address === parentParsed.firstUsable) inheritedPosition = 'first';
          else if (parent.gateway_address === parentParsed.lastUsable) inheritedPosition = 'last';
          // else: custom address — let the old exact-match logic handle it
        }

        // Only used when the parent's gateway doesn't match a clean first/last
        // boundary. Exactly one child's range will contain the literal address.
        let customInheritIdx = -1;
        if (inheritedPosition === null && parent.status === 'allocated' && parent.gateway_address) {
          const gwLong = ipToLong(parent.gateway_address);
          customInheritIdx = subnets.findIndex(s => gwLong >= s.networkLong && gwLong <= s.broadcastLong);
        }

        // Fallback position used when parent had no inferrable position and
        // no matching range (or for children that don't contain the custom IP).
        const fallbackPosition = inheritedPosition || getSetting('default_gateway_position') || 'first';

        const childIds = [];
        for (let i = 0; i < subnets.length; i++) {
          const s = subnets[i];
          const sCidr = `${s.network}/${s.prefix}`;
          const childParsed = parseCidr(sCidr);
          const isCustomInheriting = i === customInheritIdx;
          const isInheriting = inheritedPosition !== null || isCustomInheriting;
          let childGw;
          if (isCustomInheriting) {
            childGw = parent.gateway_address;
          } else if (fallbackPosition === 'none') {
            childGw = null;
          } else if (fallbackPosition === 'last') {
            childGw = childParsed.lastUsable;
          } else {
            childGw = childParsed.firstUsable;
          }

          const result = insertSubnet(db, {
            cidr: sCidr,
            name: applyNameTemplate(template, sCidr),
            description: isInheriting ? parent.description : null,
            vlan_id: isInheriting ? parent.vlan_id : null,
            gateway_address: childGw,
            parent_id: parent.id,
            status: parent.status === 'allocated' ? 'allocated' : 'unallocated',
            depth: childDepth,
            domain_name: parent.domain_name,
          });

          if (isInheriting) {
            migrateConfigToChild(db, parent.id, result.lastInsertRowid, s, parent.gateway_address, parent.has_reverse_dns);
          } else {
            // All children get Network/Broadcast/Gateway ranges
            createSystemRanges(db, result.lastInsertRowid, childParsed, childGw);
            // Auto-create DHCP scope for appropriately-sized allocated children
            if (parent.status === 'allocated') {
              autoCreateDhcpScope(db, result.lastInsertRowid, childParsed, childGw, parent.domain_name);
            }
          }
          childIds.push(result.lastInsertRowid);
        }

        // Transfer parent's per-IP artifacts (reservations, ip_addresses) and
        // DNS zones to the children BEFORE tearing down the parent config.
        transferPerIpArtifactsToChildren(db, parent.id);
        migrateParentZonesToChildren(db, parent.id);
        clearParentConfig(db, parent.id);

        // Consolidate: if all siblings of parent are also intermediaries, flatten
        consolidateIntermediate(db, parent.parent_id);

        return childIds;
      });

      txn();
      req.afterCommit('regenerate_dns');
      req.afterCommit('regenerate_dhcp');
      audit(req.user.id, 'subnet_divided', 'subnet', parent.id, {
        parent_cidr: parent.cidr,
        mode: 'equal',
        new_prefix: targetPrefix,
        count: subnets.length,
        config_migrated: parent.status === 'allocated'
      });

      const updated = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parent.id);
      const children = db.prepare('SELECT * FROM subnets WHERE parent_id = ? ORDER BY network_address').all(parent.id);
      return res.json({ ...updated, children });
    }

    // Legacy carve mode (single child CIDR)
    if (!cidr) return res.status(400).json({ error: 'CIDR or new_prefix is required' });
    if (!isValidCidr(cidr)) return res.status(400).json({ error: 'Invalid CIDR notation' });

    const normalized = normalizeCidr(cidr);
    if (!isSubnetOf(normalized, parent.cidr)) {
      return res.status(400).json({ error: 'Child CIDR must be within parent subnet' });
    }

    const remainder = subtractCidr(parent.cidr, normalized);
    const childParsed = parseCidr(normalized);

    // Lossy-IP gate: same guard as equal mode, gated on force_lossy (NOT force).
    {
      const lossy = detectLossyIpsForDivision(db, parent.id, [normalized, ...remainder]);
      if (lossy.length > 0 && !force_lossy) {
        return res.status(409).json({
          error: `${lossy.length} host IP(s) would land on a new subnet's network/broadcast address and be unusable after divide.`,
          requires_confirmation: true,
          can_force_lossy: true,
          lossy
        });
      }
    }

    const txn = db.transaction(() => {
      let inheritingCidr = null;
      if (parent.status === 'allocated' && parent.gateway_address) {
        const gwLong = ipToLong(parent.gateway_address);
        if (gwLong >= childParsed.networkLong && gwLong <= childParsed.broadcastLong) {
          inheritingCidr = normalized;
        } else {
          for (const rCidr of remainder) {
            const rParsed = parseCidr(rCidr);
            if (gwLong >= rParsed.networkLong && gwLong <= rParsed.broadcastLong) {
              inheritingCidr = rCidr;
              break;
            }
          }
        }
      }

      // Determine default gateway position for non-inheriting children
      const gwPosition = getSetting('default_gateway_position');

      // All children in the division
      const allCidrs = [normalized, ...remainder];
      for (const aCidr of allCidrs) {
        const aParsed = parseCidr(aCidr);
        const isInheriting = inheritingCidr === aCidr;
        const childGw = isInheriting ? parent.gateway_address
          : gwPosition === 'none' ? null
          : (gwPosition === 'last' ? aParsed.lastUsable : aParsed.firstUsable);

        const result = insertSubnet(db, {
          cidr: aCidr,
          name: applyNameTemplate(template, aCidr),
          description: isInheriting ? parent.description : null,
          vlan_id: isInheriting ? parent.vlan_id : null,
          gateway_address: childGw,
          parent_id: parent.id,
          status: parent.status === 'allocated' ? 'allocated' : 'unallocated',
          depth: childDepth,
          domain_name: parent.domain_name,
        });

        if (isInheriting) {
          migrateConfigToChild(db, parent.id, result.lastInsertRowid, aParsed, parent.gateway_address, parent.has_reverse_dns);
        } else {
          // All children get Network/Broadcast/Gateway ranges
          createSystemRanges(db, result.lastInsertRowid, aParsed, childGw);
          // Auto-create DHCP scope for appropriately-sized allocated children
          if (parent.status === 'allocated') {
            autoCreateDhcpScope(db, result.lastInsertRowid, aParsed, childGw, parent.domain_name);
          }
        }
      }

      transferPerIpArtifactsToChildren(db, parent.id);
      migrateParentZonesToChildren(db, parent.id);
      clearParentConfig(db, parent.id);

      // Consolidate: if all siblings of parent are also intermediaries, flatten
      consolidateIntermediate(db, parent.parent_id);
    });

    txn();
    req.afterCommit('regenerate_dns');
    req.afterCommit('regenerate_dhcp');
    audit(req.user.id, 'subnet_divided', 'subnet', parent.id, {
      parent_cidr: parent.cidr,
      mode: 'carve',
      carved_cidr: normalized,
      remainder,
      config_migrated: parent.status === 'allocated'
    });

    const updated = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parent.id);
    const children = db.prepare('SELECT * FROM subnets WHERE parent_id = ? ORDER BY network_address').all(parent.id);
    res.json({ ...updated, children });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// POST /api/subnets/:id/configure — allocate a subnet
router.post('/:id/configure', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const { name, description, vlan_id, gateway_address, create_dhcp_scope, create_reverse_dns, folder_id, domain_name, dhcp_start_ip, dhcp_end_ip } = req.body;

  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (domain_name && !isValidDomain(domain_name)) {
    return res.status(400).json({ error: 'Invalid domain name format' });
  }

  const db = getDb();
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const parsed = parseCidr(subnet.cidr);

  // Determine gateway
  let gw = gateway_address;
  if (!gw) {
    const targetFolder = folder_id || subnet.folder_id;
    const gwPosition = getSetting('default_gateway_position');
    gw = gwPosition === 'none' ? null
      : gwPosition === 'last' ? parsed.lastUsable : parsed.firstUsable;
  }

  // Validate folder_id if provided
  if (folder_id !== undefined && folder_id !== null) {
    const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folder_id);
    if (!folder) return res.status(400).json({ error: 'Folder not found' });
  }

  // Forward-zone conflict: if domain_name names an EXISTING zone owned by a
  // different subnet, refuse. If it exists but is detached (subnet_id NULL),
  // we'll adopt it inside the txn. This mirrors the PUT /:id rename logic.
  let adoptForwardZoneId = null;
  if (domain_name) {
    const clash = db.prepare("SELECT id, subnet_id FROM dns_zones WHERE name = ? AND type = 'forward'")
      .get(domain_name);
    if (clash && clash.subnet_id !== null && clash.subnet_id !== subnet.id) {
      return res.status(409).json({
        error: `A forward zone named "${domain_name}" already belongs to another subnet. Pick a different domain name or detach the existing zone first.`
      });
    }
    if (clash && clash.subnet_id === null) {
      adoptForwardZoneId = clash.id;
    }
  }

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE subnets SET status = 'allocated', name = ?, description = ?, vlan_id = ?,
        gateway_address = ?, has_reverse_dns = ?, domain_name = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name, description || null, vlan_id || null, gw, create_reverse_dns ? 1 : 0, domain_name || null, subnet.id);

    // Move to specified folder if provided (root subnets only)
    if (folder_id !== undefined && !subnet.parent_id) {
      db.prepare('UPDATE subnets SET folder_id = ? WHERE id = ?').run(folder_id, subnet.id);
    }

    // Recreate system ranges (Network/Gateway/Broadcast) with correct gateway
    const sysTypes = db.prepare("SELECT id FROM range_types WHERE is_system = 1 AND name IN ('Network', 'Gateway', 'Broadcast')").all();
    const sysTypeIds = sysTypes.map(t => t.id);
    if (sysTypeIds.length > 0) {
      const placeholders = sysTypeIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM ranges WHERE subnet_id = ? AND range_type_id IN (${placeholders})`).run(subnet.id, ...sysTypeIds);
    }
    createSystemRanges(db, subnet.id, parsed, gw);

    // Auto-create reverse DNS zone(s) if requested
    if (create_reverse_dns) {
      const reverseNames = generateReverseNames(subnet.cidr);
      const startIp = parsed.prefix >= 31 ? parsed.networkLong : parsed.networkLong + 1;
      const endIp = parsed.prefix >= 31 ? parsed.broadcastLong : parsed.broadcastLong - 1;

      const insertRecord = db.prepare(
        'INSERT INTO dns_records (zone_id, name, type, value, enabled) VALUES (?, ?, ?, ?, 1)'
      );

      for (const reverseName of reverseNames) {
        const existingZone = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(reverseName);
        let zoneId;
        if (!existingZone) {
          const zoneResult = db.prepare(`
            INSERT INTO dns_zones (name, type, subnet_id, description) VALUES (?, 'reverse', ?, ?)
          `).run(reverseName, subnet.id, `Reverse zone for ${subnet.cidr}`);
          zoneId = zoneResult.lastInsertRowid;
        } else {
          zoneId = existingZone.id;
        }

        // Determine which IPs belong in this /24 zone
        // Parse the zone's 3rd octet from the zone name (e.g., "2.0.10.in-addr.arpa" → 3rd octet = 2)
        const zoneParts = reverseName.replace('.in-addr.arpa', '').split('.').map(Number);
        const zoneThirdOctet = zoneParts.length === 3 ? zoneParts[0] : null;

        const existingPtrs = db.prepare('SELECT name FROM dns_records WHERE zone_id = ? AND type = ?').all(zoneId, 'PTR');
        const existingNames = new Set(existingPtrs.map(r => r.name));

        for (let ipLong = startIp; ipLong <= endIp; ipLong++) {
          // For /24 zones, only include IPs whose 3rd octet matches
          if (zoneThirdOctet !== null && ((ipLong >>> 8) & 255) !== zoneThirdOctet) continue;

          const ptrName = zoneParts.length === 3
            ? String(ipLong & 255)                                          // /24 zone: last octet
            : zoneParts.length === 2
              ? `${ipLong & 255}.${(ipLong >>> 8) & 255}`                   // /16 zone: last.3rd
              : `${ipLong & 255}.${(ipLong >>> 8) & 255}.${(ipLong >>> 16) & 255}`; // /8 zone

          if (!existingNames.has(ptrName)) {
            // Pre-populated PTR stubs have no hostname yet; they're filled in
            // when a DHCP reservation or DNS A-record is created for the IP.
            // (Older code wrote the IP itself as `value`, which is nonsense.)
            insertRecord.run(zoneId, ptrName, 'PTR', '');
          }
        }

        // Increment SOA serial
        db.prepare("UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime('now') WHERE id = ?").run(zoneId);
      }
    }

    // Auto-populate ip_addresses for all usable IPs (up to /20 = 4096 IPs)
    if (parsed.prefix >= 20) {
      const ipStart = parsed.prefix >= 31 ? parsed.networkLong : parsed.networkLong + 1;
      const ipEnd = parsed.prefix >= 31 ? parsed.broadcastLong : parsed.broadcastLong - 1;
      const insertIp = db.prepare('INSERT OR IGNORE INTO ip_addresses (subnet_id, ip_address, status) VALUES (?, ?, ?)');
      const gwLong = gw ? ipToLong(gw) : null;

      for (let ipLong = ipStart; ipLong <= ipEnd; ipLong++) {
        const ipStatus = (gwLong !== null && ipLong === gwLong) ? 'locked' : 'available';
        insertIp.run(subnet.id, longToIp(ipLong), ipStatus);
      }
    }

    // Forward DNS zone: adopt a detached same-name zone if one exists,
    // otherwise create. The conflict case (zone owned by a different subnet)
    // was rejected upfront before the transaction opened.
    if (domain_name) {
      if (adoptForwardZoneId) {
        db.prepare("UPDATE dns_zones SET subnet_id = ?, updated_at = datetime('now') WHERE id = ?")
          .run(subnet.id, adoptForwardZoneId);
      } else {
        const existingOwn = db.prepare(
          "SELECT id FROM dns_zones WHERE name = ? AND type = 'forward' AND subnet_id = ?"
        ).get(domain_name, subnet.id);
        if (!existingOwn) {
          db.prepare(
            "INSERT INTO dns_zones (name, type, subnet_id, description, enabled) VALUES (?, 'forward', ?, ?, 1)"
          ).run(domain_name, subnet.id, `Forward zone for ${subnet.cidr}`);
        }
      }
    }

    // Create DHCP scope if requested and subnet is >= /29
    if (create_dhcp_scope && parsed.prefix <= 29) {
      const dhcpType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope' AND is_system = 1").get();
      if (dhcpType) {
        // Use client-provided start/end or fall back to formula defaults
        const gwLong = ipToLong(gw);
        let poolStart, poolEnd;
        if (dhcp_start_ip && dhcp_end_ip) {
          poolStart = ipToLong(dhcp_start_ip);
          poolEnd = ipToLong(dhcp_end_ip);
        } else {
          const defaults = dhcpRangeDefaults(parsed);
          if (defaults) {
            poolStart = defaults.startLong;
            poolEnd = defaults.endLong;
          } else {
            poolStart = parsed.networkLong + 1;
            poolEnd = parsed.broadcastLong - 1;
          }
          if (gwLong === poolStart) poolStart++;
          else if (gwLong === poolEnd) poolEnd--;
        }

        if (poolStart <= poolEnd) {
          const rangeResult = db.prepare('INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)').run(
            subnet.id, dhcpType.id, longToIp(poolStart), longToIp(poolEnd), 'DHCP scope'
          );

          // Auto-create DHCP scope with defaults
          const effectiveDomain = domain_name || null;
          const scopeResult = db.prepare(`
            INSERT INTO dhcp_scopes (range_id, subnet_id, lease_time, gateway, domain_name, description)
            VALUES (?, ?, ?, ?, ?, 'Auto-created DHCP scope')
          `).run(rangeResult.lastInsertRowid, subnet.id, getSetting('default_lease_time'), gw, effectiveDomain);

          // Populate scope options from enabled defaults + network-derived values
          const scopeId = scopeResult.lastInsertRowid;
          insertScopeOptionsFromDefaults(db, scopeId, parsed, gw, effectiveDomain, subnet.cidr);
        }
      }
    }
  });

  txn();
  audit(req.user.id, 'subnet_configured', 'subnet', subnet.id, { name, cidr: subnet.cidr, dhcp: !!create_dhcp_scope, reverse_dns: !!create_reverse_dns });

  if (create_dhcp_scope) {
    req.afterCommit('regenerate_dhcp');
  }
  // Forward/reverse zones may have been created — always regen DNS after configure
  req.afterCommit('regenerate_dns');

  const updated = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnet.id);
  res.json(updated);
}));

// DELETE /api/subnets/:id — hierarchy-aware deletion with reconsolidation
router.delete('/:id', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const db = getDb();
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const hasChildren = db.prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?').get(subnet.id).c > 0;

  const txn = db.transaction(() => {
    if (subnet.status === 'allocated') {
      // Allocated: convert to unallocated (clear config, ranges, IPs, zones, delete children)
      if (hasChildren) {
        cleanupSubtreeZones(db, subnet.id);
        db.prepare(`
          WITH RECURSIVE tree AS (
            SELECT id FROM subnets WHERE parent_id = ?
            UNION ALL
            SELECT s.id FROM subnets s JOIN tree t ON s.parent_id = t.id
          )
          DELETE FROM subnets WHERE id IN (SELECT id FROM tree)
        `).run(subnet.id);
      }

      // cleanupSubnetData now covers ranges, ip_addresses, dhcp_leases,
      // dhcp_scopes, and dhcp_scope_options in one go.
      cleanupSubnetZones(db, subnet.id);
      cleanupSubnetData(db, subnet.id);
      db.prepare(`
        UPDATE subnets SET status = 'unallocated', name = ?, description = NULL,
          vlan_id = NULL, gateway_address = NULL, has_reverse_dns = 0, domain_name = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(subnet.cidr, subnet.id);

      if (subnet.parent_id) buddyMerge(db, subnet.parent_id);
      return 'deallocated';
    }

    if (!subnet.parent_id) {
      // Root unallocated node: delete entirely with subtree
      cleanupSubnetZones(db, subnet.id);
      cleanupSubnetData(db, subnet.id);
      if (hasChildren) cleanupSubtreeZones(db, subnet.id);
      db.prepare('DELETE FROM subnets WHERE id = ?').run(subnet.id);
      return 'deleted';
    }

    // Unallocated leaf: delete the row, then try to merge
    if (!hasChildren) {
      cleanupSubnetZones(db, subnet.id);
      cleanupSubnetData(db, subnet.id);
      db.prepare('DELETE FROM subnets WHERE id = ?').run(subnet.id);
      buddyMerge(db, subnet.parent_id);
      return 'deleted';
    }

    // Unallocated with children: delete children, making it a leaf again
    cleanupSubtreeZones(db, subnet.id);
    db.prepare(`
      WITH RECURSIVE tree AS (
        SELECT id FROM subnets WHERE parent_id = ?
        UNION ALL
        SELECT s.id FROM subnets s JOIN tree t ON s.parent_id = t.id
      )
      DELETE FROM subnets WHERE id IN (SELECT id FROM tree)
    `).run(subnet.id);
    return 'children_deleted';
  });

  const action = txn();
  req.afterCommit('regenerate_dns');
  req.afterCommit('regenerate_dhcp');
  audit(req.user.id, 'subnet_deleted', 'subnet', subnet.id, { cidr: subnet.cidr, action });
  res.json({ message: 'Subnet deleted', action });
}));

// POST /api/subnets/calculate — standalone calculator (unchanged)
router.post('/calculate', requirePerm('subnets:read'), asyncHandler((req, res) => {
  const { cidr, new_prefix } = req.body;

  if (!cidr || new_prefix === undefined) {
    return res.status(400).json({ error: 'CIDR and new_prefix are required' });
  }
  if (!isValidCidr(cidr)) {
    return res.status(400).json({ error: 'Invalid CIDR notation' });
  }

  try {
    const results = calculateSubnets(cidr, new_prefix);
    res.json({ parent: parseCidr(cidr), subnets: results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

/**
 * Compute the display type for an IP address (mirrors client computeIpState logic).
 * Returns a sortable string: system, gateway, rogue, reservation, dynamic, dhcp, locked, dns assigned, or available.
 */
function computeIpType(ip) {
  if (ip.range_type_name === 'Network' || ip.range_type_name === 'Broadcast') return 'system';
  if (ip.range_type_name === 'Gateway') return 'gateway';
  const isDhcpScope = ip.range_type_name === 'DHCP Scope';
  const isLeaseExpired = ip.dhcp_expires_at && ip.dhcp_expires_at !== 'infinite'
    && new Date(ip.dhcp_expires_at) < new Date();
  const hasActiveLease = ip.dhcp_expires_at && !isLeaseExpired;
  if (ip.is_rogue) return 'rogue';
  if (ip.is_online && ip.status === 'available' && !ip.has_dhcp_reservation && !ip.hostname && !hasActiveLease) return 'rogue';
  if (ip.has_dhcp_reservation) return 'reservation';
  if (isDhcpScope) {
    if (ip.dhcp_expires_at && !isLeaseExpired) return 'dynamic';
    return 'dhcp';
  }
  if (ip.status === 'locked') return 'locked';
  if ((ip.status === 'assigned' || ip.hostname) && !isDhcpScope) return 'dns assigned';
  return 'available';
}

// GET /api/subnets/:id/ips — IP addresses with server-side pagination and virtual IPs
router.get('/:id/ips', requirePerm('subnets:read'), asyncHandler((req, res) => {
  const db = getDb();
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const parsed = parseCidr(subnet.cidr);
  const totalIps = parsed.broadcastLong - parsed.networkLong + 1;
  const search = (req.query.search || '').trim().toLowerCase();

  // Sort params
  const SORTABLE_FIELDS = new Set(['ip_address', 'status', 'hostname', 'mac_address', 'vendor', 'is_online', 'last_seen_at', 'dhcp_expires_at', 'computed_type']);
  const reqSortField = SORTABLE_FIELDS.has(req.query.sortField) ? req.query.sortField : null;
  const reqSortOrder = req.query.sortOrder === 'desc' ? -1 : 1;

  function sortIps(arr, field, order) {
    if (!field) return;
    arr.sort((a, b) => {
      let va, vb;
      if (field === 'ip_address') {
        va = ipToLong(a.ip_address);
        vb = ipToLong(b.ip_address);
      } else {
        va = a[field];
        vb = b[field];
      }
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return -1 * order;
      if (va > vb) return 1 * order;
      return 0;
    });
  }

  // ── Search mode: return only matching persisted IPs (no virtual fill) ──
  if (search) {
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 256, 1), 512);

    const allPersisted = db.prepare(`
      SELECT ip.*,
        CASE WHEN dr.id IS NOT NULL THEN 1 ELSE 0 END as has_dhcp_reservation,
        dl.expires_at as dhcp_expires_at
      FROM ip_addresses ip
      LEFT JOIN dhcp_reservations dr ON dr.subnet_id = ip.subnet_id AND dr.ip_address = ip.ip_address
      LEFT JOIN dhcp_leases dl ON dl.subnet_id = ip.subnet_id AND dl.ip_address = ip.ip_address
      WHERE ip.subnet_id = ?
    `).all(req.params.id);

    // Load ranges
    const ranges = db.prepare(`
      SELECT r.*, rt.name as range_type_name, rt.color as range_type_color, rt.is_system as range_type_is_system
      FROM ranges r JOIN range_types rt ON r.range_type_id = rt.id
      WHERE r.subnet_id = ? ORDER BY r.start_ip
    `).all(req.params.id);

    const rangeLookup = ranges.map(r => ({
      ...r, startLong: ipToLong(r.start_ip), endLong: ipToLong(r.end_ip)
    })).sort((a, b) => a.startLong - b.startLong);

    // Vendor lookup
    const allMacs = allPersisted.map(ip => ip.mac_address || ip.last_seen_mac).filter(Boolean);
    const vendorMap = lookupVendorBatch([...new Set(allMacs)]);

    // Filter and enrich
    const matched = [];
    for (const ip of allPersisted) {
      const mac = ip.mac_address || ip.last_seen_mac;
      ip.vendor = mac ? (vendorMap.get(mac) || null) : null;
      const ipLong = ipToLong(ip.ip_address);
      const range = rangeLookup.find(r => ipLong >= r.startLong && ipLong <= r.endLong);
      ip.range_type_id = range?.range_type_id || null;
      ip.range_type_name = range?.range_type_name || null;
      ip.range_type_color = range?.range_type_color || null;
      ip.computed_type = computeIpType(ip);

      if (ip.ip_address.includes(search) ||
          (ip.hostname && ip.hostname.toLowerCase().includes(search)) ||
          (ip.mac_address && ip.mac_address.toLowerCase().includes(search)) ||
          (ip.last_seen_mac && ip.last_seen_mac.toLowerCase().includes(search)) ||
          (ip.vendor && ip.vendor.toLowerCase().includes(search)) ||
          (ip.status && ip.status.toLowerCase().includes(search))) {
        matched.push(ip);
      }
    }

    // Sort results
    sortIps(matched, reqSortField || 'ip_address', reqSortField ? reqSortOrder : 1);

    const searchTotal = matched.length;
    const searchTotalPages = Math.ceil(searchTotal / pageSize) || 1;
    const page = Math.min(Math.max(parseInt(req.query.page) || 1, 1), searchTotalPages);
    const start = (page - 1) * pageSize;
    const ips = matched.slice(start, start + pageSize);

    return res.json({ subnet, ips, ranges, totalIps: searchTotal, page, pageSize, totalPages: searchTotalPages, search });
  }

  // ── Sorted mode (non-IP field): persisted IPs only ──
  if (reqSortField && reqSortField !== 'ip_address') {
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 256, 1), 512);

    const allPersisted = db.prepare(`
      SELECT ip.*,
        CASE WHEN dr.id IS NOT NULL THEN 1 ELSE 0 END as has_dhcp_reservation,
        dl.expires_at as dhcp_expires_at
      FROM ip_addresses ip
      LEFT JOIN dhcp_reservations dr ON dr.subnet_id = ip.subnet_id AND dr.ip_address = ip.ip_address
      LEFT JOIN dhcp_leases dl ON dl.subnet_id = ip.subnet_id AND dl.ip_address = ip.ip_address
      WHERE ip.subnet_id = ?
    `).all(req.params.id);

    // Ranges
    const ranges = db.prepare(`
      SELECT r.*, rt.name as range_type_name, rt.color as range_type_color, rt.is_system as range_type_is_system
      FROM ranges r JOIN range_types rt ON r.range_type_id = rt.id
      WHERE r.subnet_id = ? ORDER BY r.start_ip
    `).all(req.params.id);

    const rangeLookup = ranges.map(r => ({
      ...r, startLong: ipToLong(r.start_ip), endLong: ipToLong(r.end_ip)
    })).sort((a, b) => a.startLong - b.startLong);

    // Vendor lookup + range enrichment
    const allMacs = allPersisted.map(ip => ip.mac_address || ip.last_seen_mac).filter(Boolean);
    const vendorMap = lookupVendorBatch([...new Set(allMacs)]);
    for (const ip of allPersisted) {
      const mac = ip.mac_address || ip.last_seen_mac;
      ip.vendor = mac ? (vendorMap.get(mac) || null) : null;
      const ipLong = ipToLong(ip.ip_address);
      const range = rangeLookup.find(r => ipLong >= r.startLong && ipLong <= r.endLong);
      ip.range_type_id = range?.range_type_id || null;
      ip.range_type_name = range?.range_type_name || null;
      ip.range_type_color = range?.range_type_color || null;
      ip.computed_type = computeIpType(ip);
    }

    sortIps(allPersisted, reqSortField, reqSortOrder);

    const sortedTotal = allPersisted.length;
    const sortedTotalPages = Math.ceil(sortedTotal / pageSize) || 1;
    const page = Math.min(Math.max(parseInt(req.query.page) || 1, 1), sortedTotalPages);
    const start = (page - 1) * pageSize;
    const ips = allPersisted.slice(start, start + pageSize);

    return res.json({ subnet, ips, ranges, totalIps: sortedTotal, page, pageSize, totalPages: sortedTotalPages, sorted: true });
  }

  // ── Normal mode: virtual IPs with pagination ──
  // Pagination params
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 256, 1), 512);
  const totalPages = Math.ceil(totalIps / pageSize);
  const page = Math.min(Math.max(parseInt(req.query.page) || 1, 1), totalPages);

  // Compute IP range for this page
  const pageStartLong = parsed.networkLong + (page - 1) * pageSize;
  const pageEndLong = Math.min(pageStartLong + pageSize - 1, parsed.broadcastLong);
  const pageStartIp = longToIp(pageStartLong);
  const pageEndIp = longToIp(pageEndLong);

  // Load persisted ip_addresses for this subnet and filter to page range in JS
  // (ip_address is text so SQL string comparison on dotted-decimal is unreliable)
  const allPersisted = db.prepare(`
    SELECT ip.*,
      CASE WHEN dr.id IS NOT NULL THEN 1 ELSE 0 END as has_dhcp_reservation,
      dl.expires_at as dhcp_expires_at
    FROM ip_addresses ip
    LEFT JOIN dhcp_reservations dr ON dr.subnet_id = ip.subnet_id AND dr.ip_address = ip.ip_address
    LEFT JOIN dhcp_leases dl ON dl.subnet_id = ip.subnet_id AND dl.ip_address = ip.ip_address
    WHERE ip.subnet_id = ?
  `).all(req.params.id);

  // Build lookup of persisted IPs by long value, filtering to page range
  const persistedMap = new Map();
  for (const ip of allPersisted) {
    const long = ipToLong(ip.ip_address);
    if (long >= pageStartLong && long <= pageEndLong) {
      persistedMap.set(long, ip);
    }
  }

  // Load ranges for this subnet
  const ranges = db.prepare(`
    SELECT r.*, rt.name as range_type_name, rt.color as range_type_color, rt.is_system as range_type_is_system
    FROM ranges r
    JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.subnet_id = ?
    ORDER BY r.start_ip
  `).all(req.params.id);

  // Pre-compute range lookup: sorted by startLong for binary search
  const rangeLookup = ranges.map(r => ({
    ...r,
    startLong: ipToLong(r.start_ip),
    endLong: ipToLong(r.end_ip)
  })).sort((a, b) => a.startLong - b.startLong);

  // Build a flat array mapping each IP long to its range info (O(n) sweep)
  // Only covers the page range to keep it small
  const rangeForIp = new Array(pageEndLong - pageStartLong + 1);
  for (const r of rangeLookup) {
    const lo = Math.max(r.startLong, pageStartLong) - pageStartLong;
    const hi = Math.min(r.endLong, pageEndLong) - pageStartLong;
    for (let i = lo; i <= hi; i++) {
      rangeForIp[i] = r;
    }
  }

  // Generate virtual IPs for this page, merging with persisted data
  const gwLong = subnet.gateway_address ? ipToLong(subnet.gateway_address) : null;
  const ips = [];

  for (let ipLong = pageStartLong; ipLong <= pageEndLong; ipLong++) {
    const persisted = persistedMap.get(ipLong);
    const match = rangeForIp[ipLong - pageStartLong] || null;

    if (persisted) {
      persisted.range_type_id = match?.range_type_id || null;
      persisted.range_type_name = match?.range_type_name || null;
      persisted.range_type_color = match?.range_type_color || null;
      ips.push(persisted);
    } else {
      // Virtual IP entry — no persisted record
      const addr = longToIp(ipLong);
      const isGw = gwLong !== null && ipLong === gwLong;
      const isNetwork = ipLong === parsed.networkLong;
      const isBroadcast = ipLong === parsed.broadcastLong;
      ips.push({
        ip_address: addr,
        subnet_id: subnet.id,
        status: (isGw || isNetwork || isBroadcast) ? 'locked' : 'available',
        hostname: null,
        mac_address: null,
        is_online: 0,
        last_seen_at: null,
        last_seen_mac: null,
        is_rogue: 0,
        rogue_reason: null,
        has_dhcp_reservation: 0,
        dhcp_expires_at: null,
        range_type_id: match?.range_type_id || null,
        range_type_name: match?.range_type_name || null,
        range_type_color: match?.range_type_color || null
      });
    }
  }

  // Batch vendor lookup for all MACs on this page
  const allMacs = ips.map(ip => ip.mac_address || ip.last_seen_mac).filter(Boolean);
  const vendorMap = lookupVendorBatch([...new Set(allMacs)]);
  for (const ip of ips) {
    const mac = ip.mac_address || ip.last_seen_mac;
    ip.vendor = mac ? (vendorMap.get(mac) || null) : null;
    ip.computed_type = computeIpType(ip);
  }

  res.json({ subnet, ips, ranges, totalIps, page, pageSize, totalPages });
}));

// Returns a rejection string if the IP status change would violate subnet
// invariants (network/broadcast must stay locked; gateway must not be
// unlocked while it is the configured gateway), or null if the change is
// allowed.
function ipStatusRejectionReason(subnet, ip, status) {
  const parsed = parseCidr(subnet.cidr);
  const ipLong = ipToLong(ip);
  if ((ipLong === parsed.networkLong || ipLong === parsed.broadcastLong) && status !== 'locked') {
    return 'Network and broadcast addresses must remain locked';
  }
  if (subnet.gateway_address && ip === subnet.gateway_address && status !== 'locked') {
    return 'Gateway address must remain locked while configured as the gateway';
  }
  return null;
}

// PUT /api/subnets/:id/ips/bulk-status — reserve or unreserve a range of IPs
router.put('/:id/ips/bulk-status', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const db = getDb();
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const { start_ip, end_ip, status, note } = req.body;
  if (!start_ip || !end_ip) return res.status(400).json({ error: 'start_ip and end_ip are required' });
  if (!['available', 'locked', 'assigned'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const startLong = ipToLong(start_ip);
  const endLong = ipToLong(end_ip);
  if (startLong > endLong) return res.status(400).json({ error: 'start_ip must be <= end_ip' });
  if (endLong - startLong > 1024) return res.status(400).json({ error: 'Range too large (max 1024 IPs)' });

  const reservationNote = status === 'locked' ? (note || null) : null;
  const updated = [];
  const skipped = [];

  const bulkUpdate = db.transaction(() => {
    for (let long = startLong; long <= endLong; long++) {
      const ip = longToIp(long);
      // Silently skip protected IPs (network/broadcast/gateway) so a bulk
      // "mark this /24 as assigned" doesn't fail wholesale on three IPs.
      if (ipStatusRejectionReason(subnet, ip, status)) {
        skipped.push(ip);
        continue;
      }
      IpAddress.setStatus(db, subnet.id, ip, status, reservationNote);
      updated.push(ip);
    }
  });
  bulkUpdate();

  audit(req.user.id, 'ip_status_changed', 'ip_address', subnet.id, {
    start_ip, end_ip, count: updated.length, skipped: skipped.length, status, note: reservationNote
  });
  res.json({ count: updated.length, skipped: skipped.length, status, reservation_note: reservationNote });
}));

// PUT /api/subnets/:id/ips/:ip/status — reserve or unreserve an IP
router.put('/:id/ips/:ip/status', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const db = getDb();
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const ipAddress = req.params.ip;
  const { status, note } = req.body;
  if (!['available', 'locked', 'assigned'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const rejection = ipStatusRejectionReason(subnet, ipAddress, status);
  if (rejection) return res.status(400).json({ error: rejection });

  // When locking, store the note; when unlocking, clear it
  const reservationNote = status === 'locked' ? (note || null) : null;

  IpAddress.setStatus(db, subnet.id, ipAddress, status, reservationNote);

  audit(req.user.id, 'ip_status_changed', 'ip_address', subnet.id, { ip_address: ipAddress, status, note: reservationNote });
  res.json({ ip_address: ipAddress, status, reservation_note: reservationNote });
}));

// PUT /:id/ips/:ip/scan-enabled — set per-IP liveness scan override
router.put('/:id/ips/:ip/scan-enabled', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const db = getDb();
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const ipAddress = req.params.ip;
  const { scan_enabled } = req.body;
  const scanEn = scan_enabled === null ? null : scan_enabled ? 1 : 0;

  IpAddress.setScanEnabled(db, subnet.id, ipAddress, scanEn);

  res.json({ ip_address: ipAddress, scan_enabled: scanEn });
}));

// GET /:id/ips/:ip/events — IP lifecycle event history
router.get('/:id/ips/:ip/events', requirePerm('subnets:read'), asyncHandler((req, res) => {
  const db = getDb();
  const subnet = db.prepare('SELECT id FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const existing = IpAddress.findBySubnetAndIp(db, subnet.id, req.params.ip);
  if (!existing) return res.json({ events: [] });

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
  const events = IpAddress.getEvents(db, existing.id, { limit });
  res.json({ events });
}));

// Error handler for all subnet routes
router.use((err, req, res, _next) => {
  console.error(`Subnet route error [${req.method} ${req.originalUrl}]:`, err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

export default router;
