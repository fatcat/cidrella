import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import {
  parseCidr, normalizeCidr, isValidCidr, calculateSubnets,
  ipToLong, longToIp, isIpInSubnet, subtractCidr, isSubnetOf, cidrsOverlap,
  validateSupernet, applyNameTemplate, canMergeCidrs
} from '../utils/ip.js';
import { generateReverseName } from '../utils/dnsmasq.js';

const router = Router();

function requirePerm(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
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

// Helper: insert a subnet row
function insertSubnet(db, { cidr, name, description, vlan_id, gateway_address, parent_id, status, depth }) {
  const parsed = parseCidr(cidr);
  return db.prepare(`
    INSERT INTO subnets (cidr, name, description, vlan_id, network_address, broadcast_address,
      prefix_length, total_addresses, gateway_address, parent_id, status, depth)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cidr, name, description || null, vlan_id || null,
    parsed.network, parsed.broadcast, parsed.prefix, parsed.totalAddresses,
    gateway_address || null, parent_id || null, status || 'unallocated', depth || 0
  );
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
          const combinedParsed = parseCidr(combinedCidr);

          db.prepare('DELETE FROM subnets WHERE id IN (?, ?)').run(a.id, b.id);
          insertSubnet(db, {
            cidr: combinedCidr,
            name: combinedCidr,
            parent_id: parentId,
            status: 'unallocated',
            depth: a.depth
          });
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

// GET /api/subnets — return full tree
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
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

  res.json({ tree: buildTree(rows) });
});

// GET /api/subnets/:id — single subnet with children
router.get('/:id', requirePerm('subnets:read'), (req, res) => {
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
});

// POST /api/subnets — create root supernet
router.post('/', requirePerm('subnets:write'), (req, res) => {
  const { cidr, name, description, vlan_id } = req.body;

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

  const result = insertSubnet(db, {
    cidr: normalized,
    name: subnetName,
    description,
    vlan_id,
    status: 'unallocated',
    depth: 0
  });

  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(result.lastInsertRowid);
  audit(req.user.id, 'subnet_created', 'subnet', subnet.id, { cidr: normalized });
  res.status(201).json(subnet);
});

// POST /api/subnets/merge/preview — validate merge without committing
router.post('/merge/preview', requirePerm('subnets:read'), (req, res) => {
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
});

// POST /api/subnets/merge — execute merge
router.post('/merge', requirePerm('subnets:write'), (req, res) => {
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

  const txn = db.transaction(() => {
    // Delete all selected subnets and their data
    for (const s of subnets) {
      db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(s.id);
      db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(s.id);
      db.prepare('DELETE FROM subnets WHERE id = ?').run(s.id);
    }

    // Create merged subnet
    const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);
    const mergedParsed = parseCidr(mergeResult.merged_cidr);

    const result = insertSubnet(db, {
      cidr: mergeResult.merged_cidr,
      name: gatewaySubnet ? gatewaySubnet.name : applyNameTemplate(template, mergeResult.merged_cidr),
      description: gatewaySubnet?.description || null,
      vlan_id: gatewaySubnet?.vlan_id || null,
      gateway_address: gatewaySubnet?.gateway_address || null,
      parent_id: parentId,
      status: gatewaySubnet ? 'allocated' : 'unallocated',
      depth: parent.depth + 1
    });

    const mergedId = result.lastInsertRowid;

    if (gatewaySubnet) {
      createSystemRanges(db, mergedId, mergedParsed, gatewaySubnet.gateway_address);
      if (gatewaySubnet.has_reverse_dns) {
        db.prepare('UPDATE subnets SET has_reverse_dns = 1 WHERE id = ?').run(mergedId);
      }
    }

    // Try buddy-merge with remaining siblings
    buddyMerge(db, parentId);

    return mergedId;
  });

  const mergedId = txn();
  audit(req.user.id, 'subnets_merged', 'subnet', mergedId, {
    merged_cidrs: subnets.map(s => s.cidr),
    result_cidr: mergeResult.merged_cidr
  });

  const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);
  const children = db.prepare('SELECT * FROM subnets WHERE parent_id = ? ORDER BY network_address').all(parentId);
  res.json({ ...parent, children });
});

// POST /api/subnets/apply-template — apply name template to selected subnets
router.post('/apply-template', requirePerm('subnets:write'), (req, res) => {
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
});

// PUT /api/subnets/:id — update subnet config
router.put('/:id', requirePerm('subnets:write'), (req, res) => {
  const { name, description, vlan_id, gateway_address } = req.body;
  const db = getDb();

  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  db.prepare(`
    UPDATE subnets SET name = ?, description = ?, vlan_id = ?, gateway_address = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? subnet.name,
    description !== undefined ? description : subnet.description,
    vlan_id !== undefined ? vlan_id : subnet.vlan_id,
    gateway_address ?? subnet.gateway_address,
    subnet.id
  );

  if (gateway_address && gateway_address !== subnet.gateway_address) {
    const gwType = db.prepare("SELECT id FROM range_types WHERE name = 'Gateway' AND is_system = 1").get();
    if (gwType) {
      db.prepare("UPDATE ranges SET start_ip = ?, end_ip = ?, updated_at = datetime('now') WHERE subnet_id = ? AND range_type_id = ?").run(
        gateway_address, gateway_address, subnet.id, gwType.id
      );
    }
  }

  const updated = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnet.id);
  audit(req.user.id, 'subnet_updated', 'subnet', subnet.id, { changes: req.body });
  res.json(updated);
});

// POST /api/subnets/:id/divide/preview — preview division without committing
router.post('/:id/divide/preview', requirePerm('subnets:read'), (req, res) => {
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
});

// Helper: migrate config from parent to inheriting child during division
function migrateConfigToChild(db, parentId, childId, childParsed, parentGateway, parentHasReverseDns) {
  createSystemRanges(db, childId, childParsed, parentGateway);

  // Migrate DHCP pool ranges if they fit and child is >= /29
  if (childParsed.prefix <= 29) {
    const dhcpRanges = db.prepare(`
      SELECT r.* FROM ranges r
      JOIN range_types rt ON r.range_type_id = rt.id
      WHERE r.subnet_id = ? AND rt.name = 'DHCP Pool'
    `).all(parentId);

    for (const dhcpRange of dhcpRanges) {
      const rStart = ipToLong(dhcpRange.start_ip);
      const rEnd = ipToLong(dhcpRange.end_ip);
      const clippedStart = Math.max(rStart, childParsed.networkLong + 1);
      const clippedEnd = Math.min(rEnd, childParsed.broadcastLong - 1);
      if (clippedStart <= clippedEnd) {
        const dhcpType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Pool' AND is_system = 1").get();
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

// Helper: clear parent config after division
function clearParentConfig(db, parentId) {
  db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(parentId);
  db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(parentId);
  db.prepare(`
    UPDATE subnets SET status = 'unallocated', description = NULL, vlan_id = NULL,
      gateway_address = NULL, has_reverse_dns = 0, updated_at = datetime('now')
    WHERE id = ?
  `).run(parentId);
}

// POST /api/subnets/:id/divide — execute division
router.post('/:id/divide', requirePerm('subnets:write'), (req, res) => {
  const { cidr, new_prefix, force } = req.body;
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
      const subnets = calculateSubnets(parent.cidr, targetPrefix);
      if (subnets.length > 256) {
        return res.status(400).json({ error: 'Cannot divide into more than 256 subnets' });
      }

      const txn = db.transaction(() => {
        // Find which child gets the gateway
        let inheritIdx = -1;
        if (parent.status === 'allocated' && parent.gateway_address) {
          const gwLong = ipToLong(parent.gateway_address);
          inheritIdx = subnets.findIndex(s => gwLong >= s.networkLong && gwLong <= s.broadcastLong);
        }

        const childIds = [];
        for (let i = 0; i < subnets.length; i++) {
          const s = subnets[i];
          const sCidr = `${s.network}/${s.prefix}`;
          const isInheriting = i === inheritIdx;

          const result = insertSubnet(db, {
            cidr: sCidr,
            name: applyNameTemplate(template, sCidr),
            description: isInheriting ? parent.description : null,
            vlan_id: isInheriting ? parent.vlan_id : null,
            gateway_address: isInheriting ? parent.gateway_address : null,
            parent_id: parent.id,
            status: isInheriting ? 'allocated' : 'unallocated',
            depth: childDepth
          });

          if (isInheriting) {
            migrateConfigToChild(db, parent.id, result.lastInsertRowid, s, parent.gateway_address, parent.has_reverse_dns);
          }
          childIds.push(result.lastInsertRowid);
        }

        clearParentConfig(db, parent.id);
        return childIds;
      });

      txn();
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

      // All children in the division
      const allCidrs = [normalized, ...remainder];
      for (const aCidr of allCidrs) {
        const aParsed = parseCidr(aCidr);
        const isInheriting = inheritingCidr === aCidr;

        const result = insertSubnet(db, {
          cidr: aCidr,
          name: applyNameTemplate(template, aCidr),
          description: isInheriting ? parent.description : null,
          vlan_id: isInheriting ? parent.vlan_id : null,
          gateway_address: isInheriting ? parent.gateway_address : null,
          parent_id: parent.id,
          status: isInheriting ? 'allocated' : 'unallocated',
          depth: childDepth
        });

        if (isInheriting) {
          migrateConfigToChild(db, parent.id, result.lastInsertRowid, aParsed, parent.gateway_address, parent.has_reverse_dns);
        }
      }

      clearParentConfig(db, parent.id);
    });

    txn();
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
});

// POST /api/subnets/:id/configure — allocate a subnet
router.post('/:id/configure', requirePerm('subnets:write'), (req, res) => {
  const { name, description, vlan_id, gateway_address, create_dhcp_scope, create_reverse_dns } = req.body;

  if (!name) return res.status(400).json({ error: 'Name is required' });

  const db = getDb();
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const parsed = parseCidr(subnet.cidr);

  // Determine gateway
  let gw = gateway_address;
  if (!gw) {
    const gwPref = db.prepare("SELECT value FROM settings WHERE key = 'default_gateway_position'").get();
    gw = gwPref?.value === 'last' ? parsed.lastUsable : parsed.firstUsable;
  }

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE subnets SET status = 'allocated', name = ?, description = ?, vlan_id = ?,
        gateway_address = ?, has_reverse_dns = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name, description || null, vlan_id || null, gw, create_reverse_dns ? 1 : 0, subnet.id);

    // Create system ranges if they don't already exist
    const existingRanges = db.prepare('SELECT COUNT(*) as c FROM ranges WHERE subnet_id = ?').get(subnet.id);
    if (existingRanges.c === 0) {
      createSystemRanges(db, subnet.id, parsed, gw);
    }

    // Auto-create reverse DNS zone if requested
    if (create_reverse_dns) {
      const reverseName = generateReverseName(subnet.cidr);
      const existingZone = db.prepare('SELECT id FROM dns_zones WHERE name = ?').get(reverseName);
      if (!existingZone) {
        db.prepare(`
          INSERT INTO dns_zones (name, type, subnet_id, description) VALUES (?, 'reverse', ?, ?)
        `).run(reverseName, subnet.id, `Reverse zone for ${subnet.cidr}`);
      }
    }

    // Create DHCP scope if requested and subnet is >= /29
    if (create_dhcp_scope && parsed.prefix <= 29) {
      const dhcpType = db.prepare("SELECT id FROM range_types WHERE name = 'DHCP Pool' AND is_system = 1").get();
      if (dhcpType) {
        // DHCP pool = all usable IPs minus gateway
        const gwLong = ipToLong(gw);
        let poolStart = parsed.networkLong + 1;
        let poolEnd = parsed.broadcastLong - 1;

        if (gwLong === poolStart) {
          poolStart++;
        } else if (gwLong === poolEnd) {
          poolEnd--;
        }

        if (poolStart <= poolEnd) {
          db.prepare('INSERT INTO ranges (subnet_id, range_type_id, start_ip, end_ip, description) VALUES (?, ?, ?, ?, ?)').run(
            subnet.id, dhcpType.id, longToIp(poolStart), longToIp(poolEnd), 'DHCP pool'
          );
        }
      }
    }
  });

  txn();
  audit(req.user.id, 'subnet_configured', 'subnet', subnet.id, { name, cidr: subnet.cidr, dhcp: !!create_dhcp_scope, reverse_dns: !!create_reverse_dns });

  const updated = db.prepare('SELECT * FROM subnets WHERE id = ?').get(subnet.id);
  res.json(updated);
});

// DELETE /api/subnets/:id — hierarchy-aware deletion with reconsolidation
router.delete('/:id', requirePerm('subnets:write'), (req, res) => {
  const db = getDb();
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const hasChildren = db.prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?').get(subnet.id).c > 0;

  const txn = db.transaction(() => {
    if (!subnet.parent_id) {
      // Root node: delete entirely with subtree
      db.prepare('DELETE FROM subnets WHERE id = ?').run(subnet.id);
      return 'deleted';
    }

    if (subnet.status === 'allocated') {
      // Allocated: convert to unallocated (clear config, ranges, IPs, delete children)
      if (hasChildren) {
        // Delete entire subtree under this node first (CASCADE handles ranges/IPs)
        // We need to recursively delete children
        const deleteSubtree = db.prepare(`
          WITH RECURSIVE tree AS (
            SELECT id FROM subnets WHERE parent_id = ?
            UNION ALL
            SELECT s.id FROM subnets s JOIN tree t ON s.parent_id = t.id
          )
          DELETE FROM subnets WHERE id IN (SELECT id FROM tree)
        `);
        deleteSubtree.run(subnet.id);
      }

      db.prepare('DELETE FROM ranges WHERE subnet_id = ?').run(subnet.id);
      db.prepare('DELETE FROM ip_addresses WHERE subnet_id = ?').run(subnet.id);
      db.prepare(`
        UPDATE subnets SET status = 'unallocated', name = ?, description = NULL,
          vlan_id = NULL, gateway_address = NULL, has_reverse_dns = 0, updated_at = datetime('now')
        WHERE id = ?
      `).run(subnet.cidr, subnet.id);

      // Try buddy-merge
      buddyMerge(db, subnet.parent_id);
      return 'deallocated';
    }

    // Unallocated leaf: delete the row, then try to merge
    if (!hasChildren) {
      db.prepare('DELETE FROM subnets WHERE id = ?').run(subnet.id);
      buddyMerge(db, subnet.parent_id);
      return 'deleted';
    }

    // Unallocated with children: delete children, making it a leaf again
    const deleteSubtree = db.prepare(`
      WITH RECURSIVE tree AS (
        SELECT id FROM subnets WHERE parent_id = ?
        UNION ALL
        SELECT s.id FROM subnets s JOIN tree t ON s.parent_id = t.id
      )
      DELETE FROM subnets WHERE id IN (SELECT id FROM tree)
    `);
    deleteSubtree.run(subnet.id);
    return 'children_deleted';
  });

  const action = txn();
  audit(req.user.id, 'subnet_deleted', 'subnet', subnet.id, { cidr: subnet.cidr, action });
  res.json({ message: 'Subnet deleted', action });
});

// POST /api/subnets/calculate — standalone calculator (unchanged)
router.post('/calculate', requirePerm('subnets:read'), (req, res) => {
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
});

// GET /api/subnets/:id/ips — IP addresses for IP grid (allocated subnets only)
router.get('/:id/ips', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const ips = db.prepare(`
    SELECT ip.*, r.range_type_id, rt.name as range_type_name, rt.color as range_type_color
    FROM ip_addresses ip
    LEFT JOIN ranges r ON ip.range_id = r.id
    LEFT JOIN range_types rt ON r.range_type_id = rt.id
    WHERE ip.subnet_id = ?
    ORDER BY ip.ip_address
  `).all(req.params.id);

  const ranges = db.prepare(`
    SELECT r.*, rt.name as range_type_name, rt.color as range_type_color, rt.is_system as range_type_is_system
    FROM ranges r
    JOIN range_types rt ON r.range_type_id = rt.id
    WHERE r.subnet_id = ?
    ORDER BY r.start_ip
  `).all(req.params.id);

  res.json({ subnet, ips, ranges });
});

export default router;
