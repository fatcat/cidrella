import { Router } from 'express';
import { getDb, getSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import {
  parseCidr, normalizeCidr, isValidCidr, calculateSubnets,
  ipToLong, longToIp, isIpInSubnet, subtractCidr, isSubnetOf, cidrsOverlap,
  validateSupernet, applyNameTemplate, canMergeCidrs, isValidDomain,
  validateDisplayString, isValidIpv4
} from '../utils/ip.js';
import * as IpAddress from '../models/ip-address.js';
import { enrichIpViewRows } from '../models/ip-view.js';
import * as Range from '../models/range.js';
import { invalidateSubnetCache } from '../utils/ip-sync.js';
import { sanitizeForLog } from '../utils/validation.js';
import * as DhcpTopology from '../services/subnet-dhcp-topology.js';
import * as SubnetTopology from '../services/subnet-topology.js';
import * as DnsTopology from '../services/subnet-dns-topology.js';

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
          console.error('Route error [%s %s]:', req.method, sanitizeForLog(req.originalUrl), err);
          if (!res.headersSent) {
            res.status(500).json({ error: err.message || 'Internal server error' });
          }
        });
      }
    } catch (err) {
      console.error('Route error [%s %s]:', req.method, sanitizeForLog(req.originalUrl), err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Internal server error' });
      }
    }
  };
}

// Helper: build nested tree from flat rows
// Build the subnet tree with folder-aware promotion.
//
// Folders are an overlay: a subnet inherits its parent's effective folder
// unless it sets its own `folder_id` explicitly. If it does, it's PROMOTED
// to a root-level node of that folder — detaching it from the CIDR parent
// in the tree view. This lets a user put a /24 into a different folder
// than its /22 parent without having to move the whole parent.
//
// A subnet `node` ends up as a root iff:
//   (a) node.parent_id is NULL (traditional root), OR
//   (b) node.folder_id is set AND differs from its parent's effective folder.
// Otherwise it nests under its parent.
function buildTree(flatRows) {
  const map = new Map();
  for (const row of flatRows) {
    map.set(row.id, { ...row, children: [] });
  }

  // Effective folder = explicit folder_id, else inherit from parent.
  const effCache = new Map();
  function effectiveFolder(id) {
    if (effCache.has(id)) return effCache.get(id);
    const node = map.get(id);
    if (!node) return null;
    let res;
    if (node.folder_id != null) res = node.folder_id;
    else if (node.parent_id && map.has(node.parent_id)) res = effectiveFolder(node.parent_id);
    else res = null;
    effCache.set(id, res);
    return res;
  }

  const roots = [];
  for (const row of flatRows) {
    const node = map.get(row.id);
    if (!row.parent_id || !map.has(row.parent_id)) {
      roots.push(node);
      continue;
    }
    const parentFolder = effectiveFolder(row.parent_id);
    if (row.folder_id != null && row.folder_id !== parentFolder) {
      roots.push(node);
    } else {
      map.get(row.parent_id).children.push(node);
    }
  }
  return roots;
}

// Helper: create system ranges for an allocated subnet
function createSystemRanges(db, subnetId, parsed, gatewayAddress) {
  return SubnetTopology.createSystemRanges(db, subnetId, parsed, gatewayAddress);
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

function validateDhcpScopeBounds(parsed, startIp, endIp) {
  if (!startIp || !endIp) return 'DHCP Scope Start IP and DHCP Scope End IP are required';
  if (!isValidIpv4(startIp)) return 'DHCP Scope Start IP must be a valid IPv4 address';
  if (!isValidIpv4(endIp)) return 'DHCP Scope End IP must be a valid IPv4 address';

  const firstUsableLong = ipToLong(parsed.firstUsable);
  const lastUsableLong = ipToLong(parsed.lastUsable);
  const startLong = ipToLong(startIp);
  const endLong = ipToLong(endIp);

  if (startLong > endLong) {
    return 'DHCP Scope Start IP must be less than or equal to DHCP Scope End IP';
  }

  if (startLong < firstUsableLong || startLong > lastUsableLong) {
    return `DHCP Scope Start IP must be within usable range ${parsed.firstUsable} - ${parsed.lastUsable}`;
  }

  if (endLong < firstUsableLong || endLong > lastUsableLong) {
    return `DHCP Scope End IP must be within usable range ${parsed.firstUsable} - ${parsed.lastUsable}`;
  }

  return null;
}

function validateGatewayForSubnet(parsed, gateway) {
  if (gateway === undefined || gateway === null || gateway === '') return null;
  if (typeof gateway !== 'string' || !isValidIpv4(gateway)) return 'gateway_address must be a valid IPv4 address';
  const gwLong = ipToLong(gateway);
  const firstUsableLong = ipToLong(parsed.firstUsable);
  const lastUsableLong = ipToLong(parsed.lastUsable);
  if (gwLong < firstUsableLong || gwLong > lastUsableLong) {
    return `gateway_address must be within usable range ${parsed.firstUsable} - ${parsed.lastUsable}`;
  }
  return null;
}

// Helper: auto-create DHCP scope for a subnet if no existing hosts/leases/scopes
function autoCreateDhcpScope(db, subnetId, parsed, gateway, domainName) {
  const defaults = dhcpRangeDefaults(parsed);
  return DhcpTopology.autoCreateDhcpScope(db, subnetId, parsed, gateway, domainName, defaults);
}

// Helper: detect whether the given `vlan_id` is already assigned to one or
// more other subnets. Same VLAN on different L3 subnets is legal in some
// topologies (e.g. a VLAN spanning multiple IP supernets), but in practice
// it's almost always a misconfiguration — so we surface a non-blocking
// warning to the caller. Returns `{ vlan_id, peers: [{id, cidr, name}] }`
// when there's a conflict, or null when the VLAN is unique (or null).
function detectVlanCollision(db, vlanId, currentSubnetId) {
  if (vlanId == null) return null;
  const rows = db.prepare(
    'SELECT id, cidr, name FROM subnets WHERE vlan_id = ? AND id != ?'
  ).all(vlanId, currentSubnetId || 0);
  return rows.length > 0 ? { vlan_id: vlanId, peers: rows } : null;
}

// Helper: insert a subnet row
function insertSubnet(db, { cidr, name, description, vlan_id, gateway_address, parent_id, folder_id, status, depth, domain_name }) {
  return SubnetTopology.insertSubnet(db, {
    cidr, name, description, vlan_id, gateway_address, parent_id, folder_id, status, depth, domain_name
  });
}


// Helper: consolidate intermediate subnets after divide
// If all children of a parent are unallocated containers (have children, no config),
// flatten by re-parenting grandchildren directly to the parent and removing intermediaries.
function consolidateIntermediate(db, parentId) {
  return SubnetTopology.consolidateIntermediate(db, parentId);
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
  const body = req.body || {};
  const { cidr, name, description, vlan_id, folder_id } = body;

  // v0.4.15 type guards: in v0.4.14, sending `vlan_id: true`, `vlan_id: []`,
  // or `vlan_id: {x:1}` produced raw SQLite bind errors. Now we reject
  // up front with clean 400s.
  if (typeof cidr !== 'string' || !cidr) return res.status(400).json({ error: 'CIDR is required' });
  if (!isValidCidr(cidr)) return res.status(400).json({ error: 'Invalid CIDR notation' });
  if (name !== undefined) {
    const err = validateDisplayString(name, { maxLength: 255 });
    if (err) return res.status(400).json({ error: `name ${err}` });
  }
  if (description !== undefined) {
    const err = validateDisplayString(description, { maxLength: 1024 });
    if (err) return res.status(400).json({ error: `description ${err}` });
  }
  if (vlan_id !== undefined && vlan_id !== null && vlan_id !== '') {
    if (!Number.isInteger(vlan_id) || vlan_id < 0 || vlan_id > 4094) {
      return res.status(400).json({ error: 'vlan_id must be an integer 0-4094' });
    }
  }
  if (folder_id !== undefined && folder_id !== null) {
    if (!Number.isInteger(folder_id) && typeof folder_id !== 'string') {
      return res.status(400).json({ error: 'folder_id must be an integer or null' });
    }
  }

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
  const vlan_warning = detectVlanCollision(db, subnet.vlan_id, subnet.id);
  res.status(201).json({ ...subnet, ...(vlan_warning ? { vlan_warning } : {}) });
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

  try {
    const mergedId = SubnetTopology.mergeSubnets(db, subnets, mergeResult, {
      defaultGatewayPosition: getSetting('default_gateway_position'),
      nameTemplate: getSetting('subnet_name_template')
    });
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

  const updated = SubnetTopology.applyNameTemplateToSubnets(db, subnet_ids, template);
  if (updated.length > 0) {
    audit(req.user.id, 'template_applied', 'subnet', null, { updated });
  }
  res.json({ updated, count: updated.length });
}));

// PUT /api/subnets/:id — update subnet config
router.put('/:id', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const body = req.body || {};
  const { name, description, vlan_id, gateway_address, scan_interval, folder_id, domain_name, scan_enabled, cidr } = body;

  // v0.4.15 type guards. gateway_address as a number in v0.4.14 crashed
  // `ip.split is not a function`; the remaining fields fell into the same
  // "raw err.message leaked" bucket from the API tester.
  if (cidr !== undefined && cidr !== null && typeof cidr !== 'string') {
    return res.status(400).json({ error: 'cidr must be a string' });
  }
  if (name !== undefined) {
    const err = validateDisplayString(name, { maxLength: 255 });
    if (err) return res.status(400).json({ error: `name ${err}` });
  }
  if (description !== undefined) {
    const err = validateDisplayString(description, { maxLength: 1024 });
    if (err) return res.status(400).json({ error: `description ${err}` });
  }
  if (gateway_address !== undefined && gateway_address !== null && typeof gateway_address !== 'string') {
    return res.status(400).json({ error: 'gateway_address must be a string' });
  }
  if (vlan_id !== undefined && vlan_id !== null && vlan_id !== '') {
    if (!Number.isInteger(vlan_id) || vlan_id < 0 || vlan_id > 4094) {
      return res.status(400).json({ error: 'vlan_id must be an integer 0-4094' });
    }
  }
  if (domain_name !== undefined && domain_name !== null && domain_name !== '') {
    if (typeof domain_name !== 'string') {
      return res.status(400).json({ error: 'domain_name must be a string' });
    }
    if (!isValidDomain(domain_name)) {
      return res.status(400).json({ error: 'Invalid domain name format' });
    }
  }
  if (scan_enabled !== undefined && scan_enabled !== null && typeof scan_enabled !== 'boolean') {
    return res.status(400).json({ error: 'scan_enabled must be boolean' });
  }
  const db = getDb();

  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  // CIDR can't be changed here — use /divide or /merge. The edit dialog
  // echoes the current CIDR back in the body, so we only reject when the
  // value actually DIFFERS from what's stored; a matching value is a
  // harmless no-op.
  if (cidr !== undefined && cidr !== subnet.cidr) {
    return res.status(400).json({
      error: 'CIDR cannot be changed via PUT. Use /api/subnets/:id/divide or /api/subnets/merge.'
    });
  }

  // Validate scan_interval if provided
  const validIntervals = [null, '5m', '15m', '30m', '1h', '4h'];
  if (scan_interval !== undefined && !validIntervals.includes(scan_interval)) {
    return res.status(400).json({ error: 'Invalid scan interval. Use: null, 5m, 15m, 30m, 1h, 4h' });
  }

  // Validate folder_id if provided. Any subnet (root or child) can be
  // assigned to a folder — children in the tree view are promoted to a
  // root-level node of the chosen folder, detached from their CIDR parent.
  if (folder_id !== undefined && folder_id !== null) {
    const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folder_id);
    if (!folder) return res.status(400).json({ error: 'Folder not found' });
  }

  // Post-decouple: `domain_name` is just a pointer to a forward zone by
  // name. Multiple subnets may share the same value. If the zone doesn't
  // exist yet, auto-create it on commit. Clearing `domain_name` does NOT
  // delete the zone — other subnets may still reference it; the user must
  // delete via the DNS UI if they want the zone gone.
  const domainChange = (domain_name !== undefined && domain_name !== subnet.domain_name)
    ? {
        autoCreate: !!(domain_name && !db.prepare(
          "SELECT id FROM dns_zones WHERE name = ? AND type = 'forward'"
        ).get(domain_name)),
        newName: domain_name
      }
    : null;

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

  const updated = SubnetTopology.updateSubnetDetails(db, subnet, {
    name,
    description,
    vlan_id,
    gateway_address,
    scan_interval,
    folder_id,
    domain_name,
    scan_enabled: scanEn,
    gatewayChanged,
    domainChange
  });

  if (gatewayChanged) {
    req.afterCommit('regenerate_dhcp');
  }
  if (domainChange) {
    req.afterCommit('regenerate_dns');
  }

  audit(req.user.id, 'subnet_updated', 'subnet', subnet.id, { changes: req.body });
  // Surface a VLAN collision when the caller just assigned a VLAN that
  // another subnet already uses. Non-blocking; client toasts as warning.
  const vlan_warning = (vlan_id !== undefined && vlan_id !== null)
    ? detectVlanCollision(db, vlan_id, subnet.id) : null;
  res.json({ ...updated, ...(vlan_warning ? { vlan_warning } : {}) });
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

  // DNS A records in the forward zone named by this subnet's domain_name:
  // if the record value lands on a boundary IP, the record stays queryable
  // post-divide but points at an unusable target. Post-decouple, the link
  // from subnet → zone is via `subnets.domain_name = dns_zones.name`, so
  // we join by name. A subnet with no domain_name simply has no records
  // to flag here.
  const aRecords = db.prepare(`
    SELECT r.name AS name, r.value AS value, z.name AS zone_name
    FROM dns_records r
    JOIN dns_zones z ON r.zone_id = z.id
    JOIN subnets s ON s.domain_name = z.name
    WHERE s.id = ? AND z.type = 'forward' AND r.type = 'A' AND r.enabled = 1
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

// Helper: given a clipped pool range and the child's gateway, shrink the
// pool to exclude the gateway IP. Returns { start, end, adjusted }. For the
// rare case where the gateway sits strictly in the middle, truncate the
// smaller side and keep the larger contiguous segment.
function excludeGatewayFromPool(clippedStart, clippedEnd, gwLong) {
  if (gwLong == null || gwLong < clippedStart || gwLong > clippedEnd) {
    return { start: clippedStart, end: clippedEnd, adjusted: false };
  }
  if (gwLong === clippedStart) return { start: clippedStart + 1, end: clippedEnd, adjusted: true };
  if (gwLong === clippedEnd)   return { start: clippedStart, end: clippedEnd - 1, adjusted: true };
  // Strictly in the middle — keep the larger contiguous side.
  const leftSize = gwLong - clippedStart;    // size of pool before gw
  const rightSize = clippedEnd - gwLong;     // size of pool after gw
  if (rightSize >= leftSize) return { start: gwLong + 1, end: clippedEnd, adjusted: true };
  return { start: clippedStart, end: gwLong - 1, adjusted: true };
}

// Helper: migrate config from parent to inheriting child during division.
// `childGw` is the new child's gateway IP (not the parent's — the divide
// handler computes it per-child, e.g. firstUsable of each /24 after a /22
// split). Returns a list of pool adjustments we had to make so the handler
// can surface them in the response for user-facing warnings.
function migrateConfigToChild(db, parentId, childId, childParsed, childGw, parentHasReverseDns) {
  createSystemRanges(db, childId, childParsed, childGw);

  const poolAdjustments = [];

  // Migrate DHCP scope ranges (and their scope config + options) if they fit
  // and child is >= /29. Previously only the range row was moved — the
  // dhcp_scopes config (lease time, DNS, options) got dropped on the floor,
  // leaving the inheriting child with a DHCP range but no working scope.
  poolAdjustments.push(...DhcpTopology.cloneParentScopesToChild(
    db, parentId, childId, childParsed, childGw, excludeGatewayFromPool
  ));

  SubnetTopology.copyUserRangesToChild(db, parentId, childId, childParsed);

  if (parentHasReverseDns) {
    SubnetTopology.setReverseDnsFlag(db, childId);
  }

  return poolAdjustments;
}

// During divide: move per-IP rows (DHCP reservations, ip_addresses) from the
// parent to whichever new child's CIDR contains each row's IP. Without this,
// cleanupSubnetData() wipes the parent's ip_addresses (losing hostnames and
// scan state) and dhcp_reservations linger pointing at an unallocated parent.
function transferPerIpArtifactsToChildren(db, parentId) {
  DhcpTopology.moveReservationsToChildren(db, parentId);
  const children = db.prepare('SELECT id, cidr FROM subnets WHERE parent_id = ?').all(parentId);
  if (children.length === 0) return;
  const childRanges = children.map(c => {
    const p = parseCidr(c.cidr);
    return { id: c.id, netLong: p.networkLong, bcastLong: p.broadcastLong };
  });
  const findChildForIp = (ipLong) =>
    childRanges.find(c => ipLong >= c.netLong && ipLong <= c.bcastLong);

  // ip_addresses: parent's row has the live state (hostname/mac/status/scan).
  // If a row already exists under the child for the same IP (auto-populated
  // after the child was inserted), prefer the parent's and drop the dup.
  // We also rewrite `ip_events.subnet_id` for each moved row so history
  // queries that filter by subnet_id return the new child's events.
  const ips = db.prepare('SELECT id, ip_address FROM ip_addresses WHERE subnet_id = ?').all(parentId);
  for (const ip of ips) {
    const c = findChildForIp(ipToLong(ip.ip_address));
    if (!c) continue;
    IpAddress.moveToSubnet(db, ip.id, ip.ip_address, c.id);
  }
}

// After divide, when the user has consented via `force_lossy`, delete the
// artifacts the lossy detector flagged. Their IPs are now on new children's
// network/broadcast boundaries (or outside the selected children entirely)
// and can't be valid hosts anymore.
//
//   - DHCP reservations on a boundary IP: delete. The reservation was for
//     a host; the host can't live on a network/broadcast.
//   - DNS A records pointing at a boundary IP: delete. The record resolves
//     but the target is unusable.
//   - ip_addresses rows on a boundary IP: delete. Next sync will recreate
//     an appropriate 'locked' row via createSystemRanges.
//   - dhcp_leases on a boundary IP: delete the DB row. dnsmasq's on-disk
//     lease remains valid until its client renews; dnsmasq will then
//     refuse (IP is now outside the active pool) and the client gets a
//     fresh IP. No connection drop.
//
// `lossy` is the exact list returned by detectLossyIpsForDivision, so we
// only touch rows that were surfaced (and user-acknowledged) upfront.
// Returns a summary for the response body so the client can toast what
// got removed.
function cleanupLossyArtifactsAfterDivide(db, lossy) {
  if (!Array.isArray(lossy) || lossy.length === 0) {
    return { ips: [], removed: { reservations: 0, ip_addresses: 0, dns_records: 0, leases: 0 } };
  }
  const ipSet = new Set(lossy.map(l => l.ip));
  const removed = { reservations: 0, ip_addresses: 0, dns_records: 0, leases: 0 };
  const dhcpRemoved = DhcpTopology.deleteReservationsAndLeasesByIps(db, ipSet);
  removed.reservations += dhcpRemoved.reservations;
  removed.leases += dhcpRemoved.leases;
  removed.dns_records += DnsTopology.deleteARecordsByIps(db, ipSet);
  for (const ip of ipSet) {
    removed.ip_addresses += IpAddress.deleteByIpAddress(db, ip).changes;
  }
  return { ips: [...ipSet], removed };
}

// Post-decouple no-op. Zones are subnet-agnostic: they survive parent divide
// automatically because no `subnet_id` reference to fix up. Retained as an
// empty function so divide call sites stay readable and bisectable.
function migrateParentZonesToChildren(_db, _parentId) {
  // intentionally empty — see migration 045
}

// Detect forward-zone domain conflicts among the subnets being merged.
// Post-decouple we look at each subnet's `domain_name` (the pointer to its
// forward zone) rather than at `dns_zones.subnet_id`. Two merging subnets
// with different domain_names is still a real conflict — the merged subnet
// can only hold one domain_name — so we surface it for user resolution.
function detectForwardZoneConflict(db, childIds) {
  if (!Array.isArray(childIds) || childIds.length === 0) return { conflict: false, zones: [] };
  const placeholders = childIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id AS subnet_id, domain_name AS name FROM subnets WHERE id IN (${placeholders}) AND domain_name IS NOT NULL`
  ).all(...childIds);
  const names = new Set(rows.map(r => r.name));
  return { conflict: names.size > 1, zones: rows };
}

// Helper: clear parent config after division. Assumes per-IP artifacts (IP
// addresses, reservations) and DNS zones have ALREADY been transferred to
// children via transferPerIpArtifactsToChildren() and migrateParentZonesToChildren().
// This call wipes parent-owned ranges, DHCP scopes (which migrateConfigToChild
// CLONED rather than moved — the parent's originals need to go), and resets
// the parent row's config fields.
function clearParentConfig(db, parentId) {
  DhcpTopology.deleteDhcpStateForSubnet(db, parentId);
  SubnetTopology.clearParentConfig(db, parentId);
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

      // Collected across child loop inside the txn so the response can
      // surface "we shrank your pool to keep the gateway out" notices.
      let txnPoolAdjustments = [];
      let txnLossyCleanup = { ips: [], removed: { reservations: 0, ip_addresses: 0, dns_records: 0, leases: 0 } };
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
        const poolAdjustmentsAll = [];
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
            const adj = migrateConfigToChild(db, parent.id, result.lastInsertRowid, s, childGw, parent.has_reverse_dns);
            if (Array.isArray(adj) && adj.length) poolAdjustmentsAll.push(...adj);
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
        // Pool adjustments bubble up via a closure variable — the return
        // value of txn() is the child id list, and we read the outer
        // variable after.
        txnPoolAdjustments = poolAdjustmentsAll;

        // Transfer parent's per-IP artifacts (reservations, ip_addresses) and
        // DNS zones to the children BEFORE tearing down the parent config.
        transferPerIpArtifactsToChildren(db, parent.id);
        migrateParentZonesToChildren(db, parent.id);

        // Now that artifacts live under children, delete the ones the user
        // acknowledged via force_lossy — their IPs sit on new boundaries
        // and can't be valid hosts.
        if (lossy.length > 0) {
          txnLossyCleanup = cleanupLossyArtifactsAfterDivide(db, lossy);
        }

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
        config_migrated: parent.status === 'allocated',
        lossy_cleanup: txnLossyCleanup
      });

      const updated = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parent.id);
      const children = db.prepare('SELECT * FROM subnets WHERE parent_id = ? ORDER BY network_address').all(parent.id);
      return res.json({
        ...updated,
        children,
        pool_adjustments: txnPoolAdjustments,
        lossy_cleanup: txnLossyCleanup
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
    const childParsed = parseCidr(normalized);

    // Lossy-IP gate: same guard as equal mode, gated on force_lossy (NOT force).
    // Capture the list so the transaction can delete the flagged artifacts.
    const carveLossy = detectLossyIpsForDivision(db, parent.id, [normalized, ...remainder]);
    if (carveLossy.length > 0 && !force_lossy) {
      return res.status(409).json({
        error: `${carveLossy.length} host IP(s) would land on a new subnet's network/broadcast address and be unusable after divide.`,
        requires_confirmation: true,
        can_force_lossy: true,
        lossy: carveLossy
      });
    }

    let carvePoolAdjustments = [];
    let carveLossyCleanup = { ips: [], removed: { reservations: 0, ip_addresses: 0, dns_records: 0, leases: 0 } };
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
          const adj = migrateConfigToChild(db, parent.id, result.lastInsertRowid, aParsed, childGw, parent.has_reverse_dns);
          if (Array.isArray(adj) && adj.length) carvePoolAdjustments.push(...adj);
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
      if (carveLossy.length > 0) {
        carveLossyCleanup = cleanupLossyArtifactsAfterDivide(db, carveLossy);
      }
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
      config_migrated: parent.status === 'allocated',
      lossy_cleanup: carveLossyCleanup
    });

    const updated = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parent.id);
    const children = db.prepare('SELECT * FROM subnets WHERE parent_id = ? ORDER BY network_address').all(parent.id);
    res.json({
      ...updated,
      children,
      pool_adjustments: carvePoolAdjustments,
      lossy_cleanup: carveLossyCleanup
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// POST /api/subnets/:id/configure — allocate a subnet
router.post('/:id/configure', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const { name, description, vlan_id, gateway_address, create_dhcp_scope, create_reverse_dns, folder_id, domain_name, dhcp_start_ip, dhcp_end_ip } = req.body;

  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  {
    const err = validateDisplayString(name, { maxLength: 255 });
    if (err) return res.status(400).json({ error: `name ${err}` });
  }
  if (description !== undefined) {
    const err = validateDisplayString(description, { maxLength: 1024 });
    if (err) return res.status(400).json({ error: `description ${err}` });
  }
  if (vlan_id !== undefined && vlan_id !== null && vlan_id !== '') {
    if (!Number.isInteger(vlan_id) || vlan_id < 0 || vlan_id > 4094) {
      return res.status(400).json({ error: 'vlan_id must be an integer 0-4094' });
    }
  }
  if (create_dhcp_scope !== undefined && typeof create_dhcp_scope !== 'boolean') {
    return res.status(400).json({ error: 'create_dhcp_scope must be boolean' });
  }
  if (create_reverse_dns !== undefined && typeof create_reverse_dns !== 'boolean') {
    return res.status(400).json({ error: 'create_reverse_dns must be boolean' });
  }
  if (domain_name !== undefined && domain_name !== null && domain_name !== '' && typeof domain_name !== 'string') {
    return res.status(400).json({ error: 'domain_name must be a string' });
  }
  if (domain_name && !isValidDomain(domain_name)) {
    return res.status(400).json({ error: 'Invalid domain name format' });
  }
  if (folder_id !== undefined && folder_id !== null && !Number.isInteger(folder_id)) {
    return res.status(400).json({ error: 'folder_id must be an integer' });
  }

  const db = getDb();
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const parsed = parseCidr(subnet.cidr);
  {
    const err = validateGatewayForSubnet(parsed, gateway_address);
    if (err) return res.status(400).json({ error: err });
  }

  // Determine gateway
  let gw = gateway_address;
  if (!gw) {
    const gwPosition = getSetting('default_gateway_position');
    gw = gwPosition === 'none' ? null
      : gwPosition === 'last' ? parsed.lastUsable : parsed.firstUsable;
  }

  // Validate folder_id if provided
  if (folder_id !== undefined && folder_id !== null) {
    const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folder_id);
    if (!folder) return res.status(400).json({ error: 'Folder not found' });
  }

  // Post-decouple: no forward-zone ownership conflict possible. A subnet's
  // domain_name is just a pointer; any number of subnets may share a zone.
  // We auto-create the zone inside the txn if it doesn't exist yet.

  let dhcpPool = null;
  if (create_dhcp_scope && parsed.prefix <= 29) {
    const gwLong = gw && isValidIpv4(gw) ? ipToLong(gw) : null;
    let poolStart, poolEnd;
    const explicitPool = dhcp_start_ip || dhcp_end_ip;
    if (explicitPool) {
      const defaults = dhcpRangeDefaults(parsed);
      const startIp = dhcp_start_ip || (defaults ? longToIp(defaults.startLong) : parsed.firstUsable);
      const endIp = dhcp_end_ip || (defaults ? longToIp(defaults.endLong) : parsed.lastUsable);
      const error = validateDhcpScopeBounds(parsed, startIp, endIp);
      if (error) return res.status(400).json({ error });
      poolStart = ipToLong(startIp);
      poolEnd = ipToLong(endIp);
    } else {
      const defaults = dhcpRangeDefaults(parsed);
      if (defaults) {
        poolStart = defaults.startLong;
        poolEnd = defaults.endLong;
      } else {
        poolStart = parsed.networkLong + 1;
        poolEnd = parsed.broadcastLong - 1;
      }
      if (gwLong != null && gwLong === poolStart) poolStart++;
      else if (gwLong === poolEnd) poolEnd--;
    }
    if (poolStart <= poolEnd) {
      dhcpPool = { startLong: poolStart, endLong: poolEnd };
    }
  }

  const updated = SubnetTopology.configureSubnet(db, subnet, parsed, {
    name,
    description,
    vlan_id,
    gateway: gw,
    create_reverse_dns,
    domain_name,
    folder_id,
    create_dhcp_scope,
    dhcpPool
  });

  audit(req.user.id, 'subnet_configured', 'subnet', subnet.id, { name, cidr: subnet.cidr, dhcp: !!create_dhcp_scope, reverse_dns: !!create_reverse_dns });

  if (create_dhcp_scope) {
    req.afterCommit('regenerate_dhcp');
  }
  // Forward/reverse zones may have been created — always regen DNS after configure
  req.afterCommit('regenerate_dns');

  const vlan_warning = detectVlanCollision(db, updated.vlan_id, subnet.id);
  res.json({ ...updated, ...(vlan_warning ? { vlan_warning } : {}) });
}));

// DELETE /api/subnets/:id — hierarchy-aware deletion with reconsolidation
router.delete('/:id', requirePerm('subnets:write'), asyncHandler((req, res) => {
  const db = getDb();
  const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
  if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

  const action = SubnetTopology.deleteSubnet(db, subnet);
  req.afterCommit('regenerate_dns');
  req.afterCommit('regenerate_dhcp');
  audit(req.user.id, 'subnet_deleted', 'subnet', subnet.id, { cidr: subnet.cidr, action });
  res.json({ message: 'Subnet deleted', action });
}));

// POST /api/subnets/calculate — standalone calculator.
// v0.4.15: refuse divides that would return more than MAX_CALCULATE_CHILDREN
// subnets. In v0.4.14 the endpoint would happily emit 1M+ rows (~60 MB JSON)
// and block the event loop for 30s. The practical UI cap is much lower; this
// bound (65k, a /16-into-/32 divide's worth) is generous but finite.
router.post('/calculate', requirePerm('subnets:read'), asyncHandler((req, res) => {
  const body = req.body || {};
  const { cidr, new_prefix } = body;

  if (typeof cidr !== 'string' || !cidr) {
    return res.status(400).json({ error: 'cidr must be a non-empty string' });
  }
  if (!Number.isInteger(new_prefix) || new_prefix < 0 || new_prefix > 32) {
    return res.status(400).json({ error: 'new_prefix must be an integer 0-32' });
  }
  if (!isValidCidr(cidr)) {
    return res.status(400).json({ error: 'Invalid CIDR notation' });
  }

  const MAX_CALCULATE_CHILDREN = 65536;
  let parent;
  try {
    parent = parseCidr(cidr);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (new_prefix <= parent.prefix) {
    return res.status(400).json({ error: `new_prefix /${new_prefix} must be larger than /${parent.prefix}` });
  }
  const childCount = 1 << (new_prefix - parent.prefix);
  if (childCount > MAX_CALCULATE_CHILDREN) {
    return res.status(400).json({
      error: `Would produce ${childCount} subnets; maximum is ${MAX_CALCULATE_CHILDREN}. Pick a narrower new_prefix or a smaller cidr.`
    });
  }

  try {
    const results = calculateSubnets(cidr, new_prefix);
    res.json({ parent, subnets: results });
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
  const showAvailable = req.query.showAvailable !== 'false';

  // Sort params
  const SORTABLE_FIELDS = new Set(['ip_address', 'ip_display_status', 'status', 'hostname', 'mac_address', 'vendor', 'is_online', 'last_seen_at', 'dhcp_expires_at', 'computed_type']);
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
      if (typeof va === 'string') va = va.trim() ? va.toLowerCase() : null;
      if (typeof vb === 'string') vb = vb.trim() ? vb.toLowerCase() : null;
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return -1 * order;
      if (va > vb) return 1 * order;
      return 0;
    });
  }

  function makeVirtualIpRow(ipLong, range, gwLong) {
    const addr = longToIp(ipLong);
    const isGw = gwLong !== null && ipLong === gwLong;
    const isNetwork = ipLong === parsed.networkLong;
    const isBroadcast = ipLong === parsed.broadcastLong;
    return {
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
      has_static_dns: 0,
      dhcp_expires_at: null,
      range_type_id: range?.range_type_id || null,
      range_type_name: range?.range_type_name || null,
      range_type_color: range?.range_type_color || null
    };
  }

  function buildRangeLookup(ranges) {
    return ranges.map(r => ({
      ...r,
      startLong: ipToLong(r.start_ip),
      endLong: ipToLong(r.end_ip)
    })).sort((a, b) => a.startLong - b.startLong);
  }

  function rangeForIpLong(rangeLookup, ipLong) {
    return rangeLookup.find(r => ipLong >= r.startLong && ipLong <= r.endLong) || null;
  }

  function isAvailableIpRow(row) {
    return (row.ip_display_status || row.status || 'available') === 'available';
  }

  function enrichPersistedRows(rows, rangeLookup) {
    for (const ip of rows) {
      const ipLong = ipToLong(ip.ip_address);
      const range = rangeForIpLong(rangeLookup, ipLong);
      ip.range_type_id = range?.range_type_id || null;
      ip.range_type_name = range?.range_type_name || null;
      ip.range_type_color = range?.range_type_color || null;
    }
    enrichIpViewRows(db, rows);
  }

  // ── Search mode: return only matching persisted IPs (no virtual fill) ──
  if (search) {
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 256, 1), 512);

    const allPersisted = db.prepare(`
      SELECT ip.*,
        CASE WHEN dr.id IS NOT NULL THEN 1 ELSE 0 END as has_dhcp_reservation,
        dl.expires_at as dhcp_expires_at,
        CASE WHEN EXISTS (
          SELECT 1
          FROM dns_records r
          JOIN dns_zones z ON z.id = r.zone_id
          WHERE r.type = 'A'
            AND r.enabled = 1
            AND z.enabled = 1
            AND z.type = 'forward'
            AND r.value = ip.ip_address
            AND COALESCE(r.source, 'manual') = 'manual'
        ) THEN 1 ELSE 0 END as has_static_dns
      FROM ip_addresses ip
      LEFT JOIN dhcp_reservations dr ON dr.subnet_id = ip.subnet_id AND dr.ip_address = ip.ip_address
      LEFT JOIN dhcp_leases dl
        ON dl.subnet_id = ip.subnet_id
       AND dl.ip_address = ip.ip_address
       AND (dl.expires_at = 'infinite' OR datetime(dl.expires_at) > datetime('now'))
      WHERE ip.subnet_id = ?
    `).all(req.params.id);

    // Load ranges
    const ranges = Range.listSubnetDetailRanges(db, req.params.id);

    // Filter and enrich
    const rangeLookup = buildRangeLookup(ranges);
    enrichPersistedRows(allPersisted, rangeLookup);
    const matched = [];
    for (const ip of allPersisted) {
      if (!showAvailable && isAvailableIpRow(ip)) continue;

      if (ip.ip_address.includes(search) ||
          (ip.hostname && ip.hostname.toLowerCase().includes(search)) ||
          (ip.mac_address && ip.mac_address.toLowerCase().includes(search)) ||
          (ip.last_seen_mac && ip.last_seen_mac.toLowerCase().includes(search)) ||
          (ip.vendor && ip.vendor.toLowerCase().includes(search)) ||
          (ip.ip_display_status && ip.ip_display_status.toLowerCase().includes(search)) ||
          (ip.address_type && ip.address_type.toLowerCase().includes(search)) ||
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

  // ── Suppressed-available mode: return persisted occupied rows and synthesized locked rows only ──
  if (!showAvailable) {
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 256, 1), 512);

    const allPersisted = db.prepare(`
      SELECT ip.*,
        CASE WHEN dr.id IS NOT NULL THEN 1 ELSE 0 END as has_dhcp_reservation,
        dl.expires_at as dhcp_expires_at,
        CASE WHEN EXISTS (
          SELECT 1
          FROM dns_records r
          JOIN dns_zones z ON z.id = r.zone_id
          WHERE r.type = 'A'
            AND r.enabled = 1
            AND z.enabled = 1
            AND z.type = 'forward'
            AND r.value = ip.ip_address
            AND COALESCE(r.source, 'manual') = 'manual'
        ) THEN 1 ELSE 0 END as has_static_dns
      FROM ip_addresses ip
      LEFT JOIN dhcp_reservations dr ON dr.subnet_id = ip.subnet_id AND dr.ip_address = ip.ip_address
      LEFT JOIN dhcp_leases dl
        ON dl.subnet_id = ip.subnet_id
       AND dl.ip_address = ip.ip_address
       AND (dl.expires_at = 'infinite' OR datetime(dl.expires_at) > datetime('now'))
      WHERE ip.subnet_id = ?
    `).all(req.params.id);

    // Ranges
    const ranges = Range.listSubnetDetailRanges(db, req.params.id);

    const rangeLookup = buildRangeLookup(ranges);

    enrichPersistedRows(allPersisted, rangeLookup);
    const persistedByLong = new Map(allPersisted.map(ip => [ipToLong(ip.ip_address), ip]));
    const displayRows = allPersisted.filter(row => !isAvailableIpRow(row));

    const gwLong = subnet.gateway_address ? ipToLong(subnet.gateway_address) : null;
    const lockedLongs = new Set([parsed.networkLong, parsed.broadcastLong]);
    if (gwLong !== null && gwLong >= parsed.networkLong && gwLong <= parsed.broadcastLong) {
      lockedLongs.add(gwLong);
    }

    for (const ipLong of lockedLongs) {
      if (!persistedByLong.has(ipLong)) {
        const row = makeVirtualIpRow(ipLong, rangeForIpLong(rangeLookup, ipLong), gwLong);
        enrichIpViewRows(db, [row]);
        if (!isAvailableIpRow(row)) displayRows.push(row);
      }
    }

    sortIps(displayRows, reqSortField || 'ip_address', reqSortField ? reqSortOrder : 1);

    const sortedTotal = displayRows.length;
    const sortedTotalPages = Math.ceil(sortedTotal / pageSize) || 1;
    const page = Math.min(Math.max(parseInt(req.query.page) || 1, 1), sortedTotalPages);
    const start = (page - 1) * pageSize;
    const ips = displayRows.slice(start, start + pageSize);

    return res.json({ subnet, ips, ranges, totalIps: sortedTotal, page, pageSize, totalPages: sortedTotalPages, sorted: true });
  }

  // ── Full-row mode: needed for non-IP sorting when available rows are visible ──
  if (reqSortField && reqSortField !== 'ip_address') {
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 256, 1), 512);

    const allPersisted = db.prepare(`
      SELECT ip.*,
        CASE WHEN dr.id IS NOT NULL THEN 1 ELSE 0 END as has_dhcp_reservation,
        dl.expires_at as dhcp_expires_at,
        CASE WHEN EXISTS (
          SELECT 1
          FROM dns_records r
          JOIN dns_zones z ON z.id = r.zone_id
          WHERE r.type = 'A'
            AND r.enabled = 1
            AND z.enabled = 1
            AND z.type = 'forward'
            AND r.value = ip.ip_address
            AND COALESCE(r.source, 'manual') = 'manual'
        ) THEN 1 ELSE 0 END as has_static_dns
      FROM ip_addresses ip
      LEFT JOIN dhcp_reservations dr ON dr.subnet_id = ip.subnet_id AND dr.ip_address = ip.ip_address
      LEFT JOIN dhcp_leases dl
        ON dl.subnet_id = ip.subnet_id
       AND dl.ip_address = ip.ip_address
       AND (dl.expires_at = 'infinite' OR datetime(dl.expires_at) > datetime('now'))
      WHERE ip.subnet_id = ?
    `).all(req.params.id);

    const ranges = Range.listSubnetDetailRanges(db, req.params.id);
    const rangeLookup = buildRangeLookup(ranges);
    const persistedMap = new Map();
    enrichPersistedRows(allPersisted, rangeLookup);
    for (const ip of allPersisted) {
      persistedMap.set(ipToLong(ip.ip_address), ip);
    }

    const gwLong = subnet.gateway_address ? ipToLong(subnet.gateway_address) : null;
    const sortedRows = [];
    for (let ipLong = parsed.networkLong; ipLong <= parsed.broadcastLong; ipLong++) {
      const persisted = persistedMap.get(ipLong);
      sortedRows.push(persisted || makeVirtualIpRow(ipLong, rangeForIpLong(rangeLookup, ipLong), gwLong));
    }

    enrichIpViewRows(db, sortedRows);
    sortIps(sortedRows, reqSortField, reqSortOrder);

    const sortedTotal = sortedRows.length;
    const sortedTotalPages = Math.ceil(sortedTotal / pageSize) || 1;
    const page = Math.min(Math.max(parseInt(req.query.page) || 1, 1), sortedTotalPages);
    const start = (page - 1) * pageSize;
    const ips = sortedRows.slice(start, start + pageSize);

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

  // Load persisted ip_addresses for this subnet and filter to page range in JS
  // (ip_address is text so SQL string comparison on dotted-decimal is unreliable)
  const allPersisted = db.prepare(`
    SELECT ip.*,
      CASE WHEN dr.id IS NOT NULL THEN 1 ELSE 0 END as has_dhcp_reservation,
      dl.expires_at as dhcp_expires_at,
      CASE WHEN EXISTS (
        SELECT 1
        FROM dns_records r
        JOIN dns_zones z ON z.id = r.zone_id
        WHERE r.type = 'A'
          AND r.enabled = 1
          AND z.enabled = 1
          AND z.type = 'forward'
          AND r.value = ip.ip_address
          AND COALESCE(r.source, 'manual') = 'manual'
      ) THEN 1 ELSE 0 END as has_static_dns
    FROM ip_addresses ip
    LEFT JOIN dhcp_reservations dr ON dr.subnet_id = ip.subnet_id AND dr.ip_address = ip.ip_address
    LEFT JOIN dhcp_leases dl
      ON dl.subnet_id = ip.subnet_id
     AND dl.ip_address = ip.ip_address
     AND (dl.expires_at = 'infinite' OR datetime(dl.expires_at) > datetime('now'))
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
  const ranges = Range.listSubnetDetailRanges(db, req.params.id);

  // Pre-compute range lookup: sorted by startLong for binary search
  const rangeLookup = buildRangeLookup(ranges);

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
      ips.push(makeVirtualIpRow(ipLong, match, gwLong));
    }
  }

  // Shared IP view for all rows on this page
  enrichIpViewRows(db, ips);

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
  if (typeof start_ip !== 'string' || !isValidIpv4(start_ip)) return res.status(400).json({ error: 'start_ip must be a valid IPv4 address' });
  if (typeof end_ip !== 'string' || !isValidIpv4(end_ip)) return res.status(400).json({ error: 'end_ip must be a valid IPv4 address' });
  if (!['available', 'locked', 'assigned'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (!isIpInSubnet(start_ip, subnet.cidr) || !isIpInSubnet(end_ip, subnet.cidr)) {
    return res.status(400).json({ error: 'IP range must be within the subnet' });
  }
  if (note !== undefined) {
    const err = validateDisplayString(note, { maxLength: 1024 });
    if (err) return res.status(400).json({ error: `note ${err}` });
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
  if (!isValidIpv4(ipAddress)) return res.status(400).json({ error: 'Invalid IP address' });
  if (!isIpInSubnet(ipAddress, subnet.cidr)) return res.status(400).json({ error: 'IP address must be within the subnet' });
  if (!['available', 'locked', 'assigned'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (note !== undefined) {
    const err = validateDisplayString(note, { maxLength: 1024 });
    if (err) return res.status(400).json({ error: `note ${err}` });
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
  if (!isValidIpv4(ipAddress)) return res.status(400).json({ error: 'Invalid IP address' });
  if (!isIpInSubnet(ipAddress, subnet.cidr)) return res.status(400).json({ error: 'IP address must be within the subnet' });
  if (scan_enabled !== null && typeof scan_enabled !== 'boolean') {
    return res.status(400).json({ error: 'scan_enabled must be boolean or null' });
  }
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
  console.error('Subnet route error [%s %s]:', req.method, sanitizeForLog(req.originalUrl), err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

export default router;
