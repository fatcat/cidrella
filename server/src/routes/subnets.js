import { Router } from 'express';
import { getDb, getSetting, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import {
  parseCidr, normalizeCidr, isValidCidr, calculateSubnets,
  ipToLong, longToIp, isIpInSubnet, subtractCidr, isSubnetOf, cidrsOverlap,
  validateSupernet, applyNameTemplate, canMergeCidrs, getServerIpForSubnet
} from '../utils/ip.js';
import { generateReverseNames, regenerateConfigs } from '../utils/dnsmasq.js';
import { regenerateDhcpConfigs } from '../utils/dhcp.js';
import { FALLBACK_SECONDARY_DNS } from '../config/defaults.js';
import { lookupVendorBatch } from '../utils/mac-vendor.js';
import * as IpAddress from '../models/ip-address.js';

const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
function isValidDomainName(name) {
  return typeof name === 'string' && DOMAIN_RE.test(name) && name.length <= 253;
}

const router = Router();

/**
 * Get gateway position from global setting, falling back to 'first'.
 */
function getGatewayPosition(db) {
  const gwPref = db.prepare("SELECT value FROM settings WHERE key = 'default_gateway_position'").get();
  return gwPref?.value || 'first';
}

function requirePerm(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

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
  const enabledRows = db.prepare('SELECT option_code, value FROM dhcp_option_defaults WHERE enabled_by_default = 1').all();
  const optionValues = new Map();
  for (const row of enabledRows) {
    optionValues.set(row.option_code, row.value != null ? row.value : null);
  }
  if (gateway) optionValues.set(3, gateway);
  optionValues.set(1, parsed.mask);
  optionValues.set(28, parsed.broadcast);
  if (effectiveDomain) {
    if (!optionValues.has(15) || !optionValues.get(15)) optionValues.set(15, effectiveDomain);
    if (!optionValues.has(119) || !optionValues.get(119)) optionValues.set(119, effectiveDomain);
  }
  const serverIp = getServerIpForSubnet(parsed.network + '/' + parsed.prefix);
  if (serverIp && (!optionValues.has(6) || !optionValues.get(6))) {
    optionValues.set(6, `${serverIp}, ${FALLBACK_SECONDARY_DNS}`);
  }
  const insertOpt = db.prepare('INSERT INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)');
  for (const [code, value] of optionValues) {
    if (value != null && value !== '') insertOpt.run(scopeId, code, String(value));
  }
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
          // They're buddies — merge
          const combinedNet = Math.min(aNet, bNet);
          const combinedCidr = `${longToIp(combinedNet)}/${combinedPrefix}`;

          // Check if combined CIDR equals the parent — if so, just delete children
          const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);
          if (parent && combinedCidr === parent.cidr) {
            db.prepare('DELETE FROM subnets WHERE id IN (?, ?)').run(a.id, b.id);
          } else {
            db.prepare('DELETE FROM subnets WHERE id IN (?, ?)').run(a.id, b.id);
            insertSubnet(db, {
              cidr: combinedCidr,
              name: combinedCidr,
              parent_id: parentId,
              status: 'unallocated',
              depth: a.depth
            });
          }
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
    const templateRow = db.prepare("SELECT value FROM settings WHERE key = 'subnet_name_template'").get();
    const template = templateRow?.value || '%1.%2.%3.%4/%bitmask';
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

  res.json({
    merged_cidr: mergeResult.merged_cidr,
    source_cidrs: subnets.map(s => s.cidr),
    allocated_count: allocated.length,
    gateway_preserved: gatewaySubnet ? { cidr: gatewaySubnet.cidr, gateway: gatewaySubnet.gateway_address } : null,
    config_loss: allocated.filter(s => s !== gatewaySubnet).map(s => s.cidr)
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

  // Get name template
  const templateRow = db.prepare("SELECT value FROM settings WHERE key = 'subnet_name_template'").get();
  const template = templateRow?.value || '%1.%2.%3.%4/%bitmask';

  try {
    const txn = db.transaction(() => {
      const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);
      const mergedParsed = parseCidr(mergeResult.merged_cidr);

      // Determine correct gateway for the merged network
      const gwPosition = getGatewayPosition(db);
      const mergedGateway = gwPosition === 'last' ? mergedParsed.lastUsable
        : gwPosition === 'none' ? null : mergedParsed.firstUsable;

      // Use the gateway subnet for config metadata, or fall back to any allocated subnet
      const configSource = gatewaySubnet || allocated[0] || null;

      // Check if merging reconstitutes the parent (merged CIDR equals parent CIDR)
      if (mergeResult.merged_cidr === parent.cidr) {
        // Just delete the children — parent becomes a leaf again
        for (const s of subnets) {
          cleanupSubnetZones(db, s.id);
          db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(s.id);
          db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(s.id);
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

      // Normal case: merged CIDR is smaller than parent
      // Delete all selected subnets and their data
      for (const s of subnets) {
        cleanupSubnetZones(db, s.id);
        db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(s.id);
        db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(s.id);
        db.prepare('DELETE FROM subnets WHERE id = ?').run(s.id);
      }

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

      createSystemRanges(db, mergedId, mergedParsed, mergedGateway);
      if (configSource?.has_reverse_dns) {
        db.prepare('UPDATE subnets SET has_reverse_dns = 1 WHERE id = ?').run(mergedId);
      }

      return mergedId;
    });

    const mergedId = txn();
    regenerateConfigs(db);
    regenerateDhcpConfigs(db);
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
  const templateRow = db.prepare("SELECT value FROM settings WHERE key = 'subnet_name_template'").get();
  const template = templateRow?.value;
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
  const { name, description, vlan_id, gateway_address, scan_interval, folder_id, domain_name, scan_enabled } = req.body;
  if (domain_name && !isValidDomainName(domain_name)) {
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

  // Resolve scan_enabled: true→1, false→0, null→NULL, undefined→keep existing
  const scanEn = scan_enabled === undefined ? subnet.scan_enabled
    : scan_enabled === null ? null
    : scan_enabled ? 1 : 0;

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

  if (gateway_address && gateway_address !== subnet.gateway_address) {
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

  // Regenerate DHCP configs if gateway changed (scope fallback uses subnet gateway)
  if (gateway_address && gateway_address !== subnet.gateway_address) {
    regenerateDhcpConfigs(db);
  }

  // Clean up old forward DNS zone if domain_name changed
  if (domain_name !== undefined && subnet.domain_name && domain_name !== subnet.domain_name) {
    db.prepare("DELETE FROM dns_zones WHERE name = ? AND type = 'forward' AND subnet_id = ?")
      .run(subnet.domain_name, subnet.id);
  }

  // Auto-create forward DNS zone if domain_name is newly set
  if (domain_name && domain_name !== subnet.domain_name) {
    const existingFwdZone = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(domain_name);
    if (!existingFwdZone) {
      db.prepare(`
        INSERT INTO dns_zones (name, type, subnet_id, description, enabled) VALUES (?, 'forward', ?, ?, 1)
      `).run(domain_name, subnet.id, `Forward zone for ${subnet.cidr}`);
    }
  }

  // Regenerate DNS configs if domain changed
  if (domain_name !== undefined && domain_name !== subnet.domain_name) {
    regenerateConfigs(db);
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
      return res.json({
        parent: parent.cidr,
        mode: 'equal',
        subnets: subnets.map(s => `${s.network}/${s.prefix}`),
        count,
        is_allocated: parent.status === 'allocated',
        gateway_preserved: gatewaySubnet ? `${gatewaySubnet.network}/${gatewaySubnet.prefix}` : null
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
    res.json({
      parent: parent.cidr,
      mode: 'carve',
      carved: normalized,
      remainder,
      is_allocated: parent.status === 'allocated',
      gateway_preserved: parent.gateway_address ? isIpInSubnet(parent.gateway_address, normalized) : null
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Helper: migrate config from parent to inheriting child during division
function migrateConfigToChild(db, parentId, childId, childParsed, parentGateway, parentHasReverseDns) {
  createSystemRanges(db, childId, childParsed, parentGateway);

  // Migrate DHCP scope ranges if they fit and child is >= /29
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
      if (clippedStart <= clippedEnd) {
        const dhcpType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Scope' AND is_system = 1").get();
        if (dhcpType) {
          db.prepare('INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)').run(
            childId, dhcpType.id, longToIp(clippedStart), longToIp(clippedEnd), dhcpRange.description
          );
        }
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

// Helper: delete DNS zones owned by a subnet (records cascade via FK)
function cleanupSubnetZones(db, subnetId) {
  db.prepare('DELETE FROM dns_zones WHERE subnet_id = ?').run(subnetId);
}

// Helper: delete DNS zones for all descendants of a subnet
function cleanupSubtreeZones(db, parentId) {
  db.prepare(`
    WITH RECURSIVE tree AS (
      SELECT id FROM subnets WHERE parent_id = ?
      UNION ALL
      SELECT s.id FROM subnets s JOIN tree t ON s.parent_id = t.id
    )
    DELETE FROM dns_zones WHERE subnet_id IN (SELECT id FROM tree)
  `).run(parentId);
}

// Helper: clear parent config after division
function clearParentConfig(db, parentId) {
  db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(parentId);
  db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(parentId);
  cleanupSubnetZones(db, parentId);
  db.prepare(`
    UPDATE subnets SET status = 'unallocated', description = NULL, vlan_id = NULL,
      gateway_address = NULL, has_reverse_dns = 0, domain_name = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(parentId);
}

// POST /api/subnets/:id/divide — execute division
router.post('/:id/divide', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const { cidr, new_prefix, force, selected_cidrs } = req.body;
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
  const templateRow = db.prepare("SELECT value FROM settings WHERE key = 'subnet_name_template'").get();
  const template = templateRow?.value || '%1.%2.%3.%4/%bitmask';

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

      const txn = db.transaction(() => {
        // Find which child gets the parent's gateway
        let inheritIdx = -1;
        if (parent.status === 'allocated' && parent.gateway_address) {
          const gwLong = ipToLong(parent.gateway_address);
          inheritIdx = subnets.findIndex(s => gwLong >= s.networkLong && gwLong <= s.broadcastLong);
        }

        // Determine default gateway position for non-inheriting children
        const gwPosition = getGatewayPosition(db);

        const childIds = [];
        for (let i = 0; i < subnets.length; i++) {
          const s = subnets[i];
          const sCidr = `${s.network}/${s.prefix}`;
          const isInheriting = i === inheritIdx;
          const childParsed = parseCidr(sCidr);
          const childGw = isInheriting ? parent.gateway_address
            : gwPosition === 'none' ? null
            : (gwPosition === 'last' ? childParsed.lastUsable : childParsed.firstUsable);

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

        clearParentConfig(db, parent.id);

        // Consolidate: if all siblings of parent are also intermediaries, flatten
        consolidateIntermediate(db, parent.parent_id);

        return childIds;
      });

      txn();
      regenerateConfigs(db);
      regenerateDhcpConfigs(db);
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
      const gwPosition = getGatewayPosition(db);

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

      clearParentConfig(db, parent.id);

      // Consolidate: if all siblings of parent are also intermediaries, flatten
      consolidateIntermediate(db, parent.parent_id);
    });

    txn();
    regenerateConfigs(db);
    regenerateDhcpConfigs(db);
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
  if (domain_name && !isValidDomainName(domain_name)) {
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
    const gwPosition = getGatewayPosition(db);
    gw = gwPosition === 'none' ? null
      : gwPosition === 'last' ? parsed.lastUsable : parsed.firstUsable;
  }

  // Validate folder_id if provided
  if (folder_id !== undefined && folder_id !== null) {
    const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folder_id);
    if (!folder) return res.status(400).json({ error: 'Folder not found' });
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
      db.prepare(`DELETE FROM ranges WHERE subnet_id = ? AND range_type_id IN (${sysTypeIds.join(',')})`).run(subnet.id);
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
            insertRecord.run(zoneId, ptrName, 'PTR', longToIp(ipLong));
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

    // Auto-create forward DNS zone if domain_name is set
    if (domain_name) {
      const existingFwdZone = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(domain_name);
      if (!existingFwdZone) {
        db.prepare(`
          INSERT INTO dns_zones (name, type, subnet_id, description, enabled) VALUES (?, 'forward', ?, ?, 1)
        `).run(domain_name, subnet.id, `Forward zone for ${subnet.cidr}`);
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
          const enabledRows = db.prepare(
            'SELECT option_code, value FROM dhcp_option_defaults WHERE enabled_by_default = 1'
          ).all();
          const optionValues = new Map();
          for (const row of enabledRows) {
            if (row.value != null) optionValues.set(row.option_code, row.value);
            else optionValues.set(row.option_code, null); // enabled but no explicit default
          }
          // Network-derived values
          if (gw) optionValues.set(3, gw);                         // Router/Gateway
          optionValues.set(1, parsed.mask);                        // Subnet Mask
          optionValues.set(28, parsed.broadcast);                  // Broadcast
          if (effectiveDomain) {
            if (!optionValues.has(15) || !optionValues.get(15)) optionValues.set(15, effectiveDomain);
            if (!optionValues.has(119) || !optionValues.get(119)) optionValues.set(119, effectiveDomain);
          }
          const serverIp = getServerIpForSubnet(subnet.cidr);
          if (serverIp && (!optionValues.has(6) || !optionValues.get(6))) {
            optionValues.set(6, `${serverIp}, ${FALLBACK_SECONDARY_DNS}`);
          }
          const insertOpt = db.prepare(
            'INSERT INTO dhcp_scope_options (scope_id, option_code, value) VALUES (?, ?, ?)'
          );
          for (const [code, value] of optionValues) {
            if (value != null && value !== '') insertOpt.run(scopeId, code, String(value));
          }
        }
      }
    }
  });

  txn();
  audit(req.user.id, 'subnet_configured', 'subnet', subnet.id, { name, cidr: subnet.cidr, dhcp: !!create_dhcp_scope, reverse_dns: !!create_reverse_dns });

  if (create_dhcp_scope) {
    regenerateDhcpConfigs(db);
  }

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

      cleanupSubnetZones(db, subnet.id);
      db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(subnet.id);
      db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(subnet.id);
      db.prepare('DELETE FROM dhcp_leases WHERE subnet_id = ?').run(subnet.id);
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
      if (hasChildren) cleanupSubtreeZones(db, subnet.id);
      db.prepare('DELETE FROM subnets WHERE id = ?').run(subnet.id);
      return 'deleted';
    }

    // Unallocated leaf: delete the row, then try to merge
    if (!hasChildren) {
      cleanupSubnetZones(db, subnet.id);
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
  regenerateConfigs(db);
  regenerateDhcpConfigs(db);
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

// GET /api/subnets/:id/ips — IP addresses with server-side pagination and virtual IPs
router.get('/:id/ips', requirePerm('subnets:read'), asyncHandler((req, res) => {
  const db = getDb();
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const parsed = parseCidr(subnet.cidr);
  const totalIps = parsed.broadcastLong - parsed.networkLong + 1;
  const search = (req.query.search || '').trim().toLowerCase();

  // Sort params
  const SORTABLE_FIELDS = new Set(['ip_address', 'status', 'hostname', 'mac_address', 'vendor', 'is_online', 'last_seen_at', 'dhcp_expires_at']);
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
  }

  res.json({ subnet, ips, ranges, totalIps, page, pageSize, totalPages });
}));

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

  const bulkUpdate = db.transaction(() => {
    for (let long = startLong; long <= endLong; long++) {
      const ip = longToIp(long);
      IpAddress.setStatus(db, subnet.id, ip, status, reservationNote);
      updated.push(ip);
    }
  });
  bulkUpdate();

  audit(req.user.id, 'ip_status_changed', 'ip_address', subnet.id, { start_ip, end_ip, count: updated.length, status, note: reservationNote });
  res.json({ count: updated.length, status, reservation_note: reservationNote });
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

// Error handler for all subnet routes
router.use((err, req, res, _next) => {
  console.error(`Subnet route error [${req.method} ${req.originalUrl}]:`, err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

export default router;
