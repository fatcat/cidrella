import { attachDhcpFacts, attachDnsFacts } from '../models/ip-row-facts.js';
import {
  IP_COLUMNS,
  columnFacets,
  columnSortValue,
  facetFields,
  matchesColumnFilters,
  parseColumnFilters,
} from '../utils/ip-columns.js';
import { Router } from 'express';
import { getDb, getSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import {
  parseNetwork,
  normalizeNetwork,
  isValidNetwork,
  splitNetwork,
  mergeNetworks,
  subtractNetwork,
  isNetworkWithin,
  networksOverlap,
  networkContains,
  parsedNetworkContains,
  validateNetworkBounds,
  networkNameFromTemplate,
  addressToBig,
  bigToAddress,
  addressInRange,
  isValidAddress,
  topologyAddresses,
  ipToLong,
  longToIp,
  isIpInSubnet,
  isValidDomain,
  validateDisplayString,
  isValidIpv4,
} from '../utils/ip.js';
import { canonicalizeIp, sortKey } from '../utils/address.js';
import { refuseIpv6Unless } from '../utils/ipv6-support.js';
import {
  lifecycleRepository as IpAddress,
  setManualReservation,
} from '../services/ip-lifecycle-service.js';
import {
  getCanonicalSubnetIpRow,
  getSubnetIpReadContext,
  projectPersistedSubnetIpRows,
  projectVirtualSubnetIpRow,
  summarizeCanonicalSubnetIps,
} from '../models/subnet-ip-read.js';
import { enrichIpViewRows } from '../models/ip-view.js';
import { invalidateSubnetCache } from '../utils/ip-sync.js';
import { sanitizeForLog, vlanIdError } from '../utils/validation.js';
import * as DhcpTopology from '../services/subnet-dhcp-topology.js';
import * as SubnetTopology from '../services/subnet-topology.js';
import * as DnsTopology from '../services/subnet-dns-topology.js';
import {
  buildDividePlan,
  buildMergePlan,
  isCurrentTransformationPlan,
} from '../services/network-transformation-plan.js';
import {
  gatewayInPoolConflict,
  gatewayInPoolError,
  dynamicPoolConflict,
} from '../models/dhcp-scope.js';

// One page of an address read. The table pages at 32 to 512; the grid asks
// for the whole network at once, which is a /20 at most.
export const IPS_PAGE_SIZE_MAX = 4096;
function clampPageSize(value) {
  return Math.min(Math.max(parseInt(value) || 256, 1), IPS_PAGE_SIZE_MAX);
}

const router = Router();

// Invalidate subnet cache after any mutating request
router.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.on('finish', () => {
      if (res.statusCode < 400) invalidateSubnetCache();
    });
  }
  next();
});

// Wrap route handlers to catch sync/async errors and return informative 500s
function asyncHandler(fn) {
  return (req, res, next) => {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          console.error(
            'Route error [%s]:',
            sanitizeForLog(`${req.method} ${req.originalUrl}`),
            err,
          );
          if (!res.headersSent) {
            res.status(500).json({ error: err.message || 'Internal server error' });
          }
        });
      }
    } catch (err) {
      console.error('Route error [%s]:', sanitizeForLog(`${req.method} ${req.originalUrl}`), err);
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
// to a root-level node of that folder, detaching it from the CIDR parent
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

// Keep API-created defaults and transformation-created defaults identical.
function dhcpRangeDefaults(parsed) {
  return DhcpTopology.defaultDhcpPoolForSubnet(parsed);
}

// One rule for folder_id, shared by POST /, PUT /:id and POST /:id/configure.
// The three used to disagree in two separate ways. On type, {"folder_id": "3"}
// was accepted by POST, accepted by PUT and rejected by /configure, though all
// three then hit the same lookup, which SQLite resolves under integer affinity
// anyway. On existence, POST gated its lookup on `if (folder_id)` (so 0 skipped
// it), PUT did the lookup with no type check, and /configure did both but as
// two separate blocks. Both checks matter, so both run here, once.
// The client binds this to a Select over folder objects, so it sends an integer.
// See REVIEW.md, duplicate-logic audit #22.
function folderIdError(db, folderId) {
  if (folderId === undefined || folderId === null) return null;
  if (!Number.isInteger(folderId)) return 'folder_id must be an integer or null';
  const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId);
  if (!folder) return 'Folder not found';
  return null;
}

// An address of the network's own family, as a BigInt value, or null.
function familyAddress(parsed, ip) {
  if (typeof ip !== 'string' || !isValidAddress(ip)) return null;
  const address = addressToBig(ip);
  return address.family === parsed.family ? address.value : null;
}

function validateDhcpScopeBounds(parsed, startIp, endIp) {
  if (!startIp || !endIp) return 'DHCP Scope Start IP and DHCP Scope End IP are required';
  const start = familyAddress(parsed, startIp);
  const end = familyAddress(parsed, endIp);
  if (start === null) return `DHCP Scope Start IP must be a valid IPv${parsed.family} address`;
  if (end === null) return `DHCP Scope End IP must be a valid IPv${parsed.family} address`;

  const firstUsable = addressToBig(parsed.firstUsable).value;
  const lastUsable = addressToBig(parsed.lastUsable).value;

  if (start > end) {
    return 'DHCP Scope Start IP must be less than or equal to DHCP Scope End IP';
  }

  if (start < firstUsable || start > lastUsable) {
    return `DHCP Scope Start IP must be within usable range ${parsed.firstUsable} - ${parsed.lastUsable}`;
  }

  if (end < firstUsable || end > lastUsable) {
    return `DHCP Scope End IP must be within usable range ${parsed.firstUsable} - ${parsed.lastUsable}`;
  }

  return null;
}

function validateGatewayForSubnet(parsed, gateway) {
  if (gateway === undefined || gateway === null || gateway === '') return null;
  const value = familyAddress(parsed, gateway);
  if (value === null) return `gateway_address must be a valid IPv${parsed.family} address`;
  const firstUsable = addressToBig(parsed.firstUsable).value;
  const lastUsable = addressToBig(parsed.lastUsable).value;
  if (value < firstUsable || value > lastUsable) {
    return `gateway_address must be within usable range ${parsed.firstUsable} - ${parsed.lastUsable}`;
  }
  return null;
}

// Helper: detect whether the given `vlan_id` is already assigned to one or
// more other subnets. Same VLAN on different L3 subnets is legal in some
// topologies (e.g. a VLAN spanning multiple IP supernets), but in practice
// it's almost always a misconfiguration, so we surface a non-blocking
// warning to the caller. Returns `{ vlan_id, peers: [{id, cidr, name}] }`
// when there's a conflict, or null when the VLAN is unique (or null).
function detectVlanCollision(db, vlanId, currentSubnetId) {
  if (vlanId == null) return null;
  const rows = db
    .prepare('SELECT id, cidr, name FROM subnets WHERE vlan_id = ? AND id != ?')
    .all(vlanId, currentSubnetId || 0);
  return rows.length > 0 ? { vlan_id: vlanId, peers: rows } : null;
}

// Helper: insert a subnet row
function insertSubnet(
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
  return SubnetTopology.insertSubnet(db, {
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
  });
}

// Helper: consolidate intermediate subnets after divide
// If all children of a parent are unallocated containers (have children, no config),
// flatten by re-parenting grandchildren directly to the parent and removing intermediaries.
function consolidateIntermediate(db, parentId) {
  return SubnetTopology.consolidateIntermediate(db, parentId);
}

// Mixed-family ordering: the shared sort key puts every IPv4 network before
// every IPv6 network and orders numerically within a family.
function sortSubnetsNumerically(rows) {
  const keys = new Map(rows.map((row) => [row, sortKey(row.network_address) || '']));
  return rows.sort(
    (left, right) =>
      (keys.get(left) < keys.get(right) ? -1 : keys.get(left) > keys.get(right) ? 1 : 0) ||
      left.prefix_length - right.prefix_length ||
      left.id - right.id,
  );
}

// GET /api/subnets: return folder-grouped tree
router.get(
  '/',
  requirePerm('subnets:read'),
  asyncHandler((req, res) => {
    const db = getDb();

    const folders = db
      .prepare(
        `
    SELECT f.* FROM folders f ORDER BY f.sort_order, f.name
  `,
      )
      .all();

    const rows = db
      .prepare(
        `
    WITH RECURSIVE subnet_tree AS (
      SELECT s.id FROM subnets s WHERE s.parent_id IS NULL
      UNION ALL
      SELECT s.id FROM subnets s JOIN subnet_tree st ON s.parent_id = st.id
    )
    SELECT s.*,
      (SELECT COUNT(*) FROM ranges WHERE subnet_id = s.id) as range_count,
      (SELECT COUNT(*) FROM ip_addresses WHERE subnet_id = s.id AND allocation_state != 'unassigned') as used_count,
      (SELECT COUNT(*) FROM subnets WHERE parent_id = s.id) as child_count
    FROM subnets s
    WHERE s.id IN (SELECT id FROM subnet_tree)
    ORDER BY s.network_address, s.prefix_length
  `,
      )
      .all();
    sortSubnetsNumerically(rows);

    const tree = buildTree(rows);

    // Group root subnets by folder
    const folderMap = new Map(folders.map((f) => [f.id, { ...f, subnets: [] }]));
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
      result.push({
        id: null,
        name: 'Ungrouped',
        description: null,
        sort_order: 999,
        subnets: ungrouped,
      });
    }

    res.json({ folders: result });
  }),
);

// POST /api/subnets/configuration-preview: resolve server-owned creation defaults
// without creating a subnet, range, scope, or scan.
router.post(
  '/configuration-preview',
  requirePerm('subnets:read'),
  asyncHandler((req, res) => {
    const { cidr, gateway_policy, gateway_address } = req.body || {};
    if (typeof cidr !== 'string' || !cidr.trim()) {
      return res.status(400).json({ error: 'CIDR is required' });
    }
    if (!isValidNetwork(cidr)) return res.status(400).json({ error: 'Invalid CIDR notation' });
    if (
      gateway_policy !== undefined &&
      !['first', 'last', 'custom', 'none'].includes(gateway_policy)
    ) {
      return res.status(400).json({ error: 'gateway_policy must be first, last, custom, or none' });
    }

    const normalized = normalizeNetwork(cidr);
    const parsed = parseNetwork(normalized);
    const gatewayError = validateGatewayForSubnet(parsed, gateway_address);
    if (gatewayError) return res.status(400).json({ error: gatewayError });
    const resolvedPolicy =
      gateway_policy ||
      (gateway_address
        ? SubnetTopology.gatewayPolicyForAddress(parsed, gateway_address)
        : getSetting('default_gateway_position'));
    if (resolvedPolicy === 'custom' && !gateway_address) {
      return res
        .status(400)
        .json({ error: 'gateway_address is required for custom gateway policy' });
    }
    const resolvedGateway = SubnetTopology.resolveGatewayAddress(
      parsed,
      resolvedPolicy,
      gateway_address,
    );
    const pool =
      parsed.family === 6
        ? DhcpTopology.defaultDhcpV6PoolForSubnet(parsed)
        : DhcpTopology.defaultDhcpPoolForSubnet(parsed, resolvedGateway);

    res.json({
      cidr: normalized,
      address_family: parsed.family,
      gateway_policy: resolvedPolicy,
      gateway_address: resolvedGateway,
      suggested_name: networkNameFromTemplate(getSetting('subnet_name_template'), normalized),
      default_dhcp_pool: pool
        ? parsed.family === 6
          ? pool
          : { start_ip: longToIp(pool.startLong), end_ip: longToIp(pool.endLong) }
        : null,
      default_dhcp_pool_explanation: pool
        ? null
        : 'No automatic DHCP pool fits this prefix. Configure a supported pool explicitly if needed.',
      // The modes this prefix can use, the same rule resolveV6Mode enforces
      // on configure: the SLAAC modes need a /64, stateful works anywhere.
      dhcp_v6_modes:
        parsed.family === 6
          ? parsed.prefix === 64
            ? ['slaac', 'stateless', 'stateful']
            : ['stateful']
          : null,
    });
  }),
);

// GET /api/subnets/:id: single subnet with children
router.get(
  '/:id',
  requirePerm('subnets:read'),
  asyncHandler((req, res) => {
    const db = getDb();
    const subnet = db
      .prepare(
        `
    SELECT s.*,
      (SELECT COUNT(*) FROM ranges WHERE subnet_id = s.id) as range_count,
      (SELECT COUNT(*) FROM ip_addresses WHERE subnet_id = s.id AND allocation_state != 'unassigned') as used_count,
      (SELECT COUNT(*) FROM subnets WHERE parent_id = s.id) as child_count
    FROM subnets s WHERE s.id = ?
  `,
      )
      .get(req.params.id);

    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

    const children = db
      .prepare(
        `
    SELECT s.*,
      (SELECT COUNT(*) FROM subnets WHERE parent_id = s.id) as child_count
    FROM subnets s WHERE s.parent_id = ? ORDER BY s.network_address
  `,
      )
      .all(subnet.id);
    sortSubnetsNumerically(children);

    res.json({ ...subnet, children });
  }),
);

// POST /api/subnets: create root supernet
router.post(
  '/',
  requirePerm('subnets:write'),
  asyncHandler((req, res) => {
    const body = req.body || {};
    const { cidr, name, description, vlan_id, folder_id } = body;

    // v0.4.15 type guards: in v0.4.14, sending `vlan_id: true`, `vlan_id: []`,
    // or `vlan_id: {x:1}` produced raw SQLite bind errors. Now we reject
    // up front with clean 400s.
    if (typeof cidr !== 'string' || !cidr)
      return res.status(400).json({ error: 'CIDR is required' });
    if (!isValidNetwork(cidr)) return res.status(400).json({ error: 'Invalid CIDR notation' });
    if (parseNetwork(cidr).family === 6 && refuseIpv6Unless(res)) return;
    if (name !== undefined) {
      const err = validateDisplayString(name, { maxLength: 255 });
      if (err) return res.status(400).json({ error: `name ${err}` });
    }
    if (description !== undefined) {
      const err = validateDisplayString(description, { maxLength: 1024 });
      if (err) return res.status(400).json({ error: `description ${err}` });
    }
    if (vlan_id !== undefined && vlan_id !== null && vlan_id !== '') {
      const vlanErr = vlanIdError(vlan_id);
      if (vlanErr) {
        return res.status(400).json({ error: vlanErr });
      }
    }

    const normalized = normalizeNetwork(cidr);
    const db = getDb();

    // Check duplicate
    const existing = db.prepare('SELECT id FROM subnets WHERE cidr = ?').get(normalized);
    if (existing) return res.status(409).json({ error: 'Subnet already exists' });

    // Validate against reserved range boundaries (RFC1918, ULA, etc.)
    const validation = validateNetworkBounds(normalized);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    // Check overlap with existing root subnets
    const roots = db.prepare('SELECT cidr FROM subnets WHERE parent_id IS NULL').all();
    for (const root of roots) {
      if (networksOverlap(normalized, root.cidr)) {
        return res.status(409).json({ error: `Overlaps with existing supernet ${root.cidr}` });
      }
    }

    // Auto-generate name from template if not provided
    let subnetName = name;
    if (!subnetName) {
      const template = getSetting('subnet_name_template');
      subnetName = networkNameFromTemplate(template, normalized);
    }

    // Validate folder exists if provided
    {
      const err = folderIdError(db, folder_id);
      if (err) return res.status(400).json({ error: err });
    }

    const result = insertSubnet(db, {
      cidr: normalized,
      name: subnetName,
      description,
      vlan_id,
      folder_id: folder_id || null,
      status: 'unallocated',
      depth: 0,
    });

    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(result.lastInsertRowid);
    audit(req.user.id, 'subnet_created', 'subnet', subnet.id, { cidr: normalized });
    const vlan_warning = detectVlanCollision(db, subnet.vlan_id, subnet.id);
    res.status(201).json({ ...subnet, ...(vlan_warning ? { vlan_warning } : {}) });
  }),
);

// POST /api/subnets/merge/preview: validate merge without committing
router.post(
  '/merge/preview',
  requirePerm('subnets:read'),
  asyncHandler((req, res) => {
    const { subnet_ids } = req.body;
    if (!Array.isArray(subnet_ids) || subnet_ids.length < 2) {
      return res.status(400).json({ error: 'At least 2 subnet IDs required' });
    }

    const db = getDb();
    const subnets = subnet_ids
      .map((id) => db.prepare('SELECT * FROM subnets WHERE id = ?').get(id))
      .filter(Boolean);
    if (subnets.length !== subnet_ids.length) {
      return res.status(404).json({ error: 'One or more subnets not found' });
    }

    const parentId = subnets[0].parent_id;
    if (!parentId || !subnets.every((s) => s.parent_id === parentId)) {
      return res.status(400).json({ error: 'All subnets must be siblings (same parent)' });
    }

    for (const s of subnets) {
      const cc = db.prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?').get(s.id);
      if (cc.c > 0)
        return res
          .status(400)
          .json({ error: `Subnet ${s.cidr} has children and cannot be merged` });
    }

    const mergeResult = mergeNetworks(subnets.map((s) => s.cidr));
    if (!mergeResult.valid) {
      return res.status(400).json({ error: mergeResult.error });
    }

    const allocated = subnets.filter((s) => s.status === 'allocated');
    const gatewaySubnet = allocated.find((s) => s.gateway_address);
    const gatewayPolicies = [...new Set(allocated.map((s) => s.gateway_policy))];
    const gatewayConflict =
      gatewayPolicies.length > 1 ||
      (gatewayPolicies[0] === 'custom' &&
        new Set(allocated.map((s) => s.gateway_address)).size > 1);

    const { conflict: domainConflict, zones: forwardZones } = detectForwardZoneConflict(
      db,
      subnets.map((s) => s.id),
    );
    const plan = buildMergePlan(db, subnets, mergeResult.merged_cidr);

    res.json({
      merged_cidr: mergeResult.merged_cidr,
      source_cidrs: subnets.map((s) => s.cidr),
      allocated_count: allocated.length,
      gateway_preserved: gatewaySubnet
        ? { cidr: gatewaySubnet.cidr, gateway: gatewaySubnet.gateway_address }
        : null,
      config_loss: allocated.filter((s) => s !== gatewaySubnet).map((s) => s.cidr),
      gateway_policy: gatewayConflict ? null : gatewayPolicies[0] || null,
      gateway_policy_conflict: gatewayConflict,
      forward_zone_conflict: domainConflict,
      forward_zones: forwardZones,
      plan,
    });
  }),
);

// POST /api/subnets/merge: execute merge
router.post(
  '/merge',
  requirePerm('subnets:write'),
  asyncHandler((req, res) => {
    const { subnet_ids, plan_token, plan_id } = req.body;
    if (!Array.isArray(subnet_ids) || subnet_ids.length < 2) {
      return res.status(400).json({ error: 'At least 2 subnet IDs required' });
    }

    const db = getDb();
    const subnets = subnet_ids
      .map((id) => db.prepare('SELECT * FROM subnets WHERE id = ?').get(id))
      .filter(Boolean);
    if (subnets.length !== subnet_ids.length) {
      return res.status(404).json({ error: 'One or more subnets not found' });
    }

    const parentId = subnets[0].parent_id;
    if (!parentId || !subnets.every((s) => s.parent_id === parentId)) {
      return res.status(400).json({ error: 'All subnets must be siblings (same parent)' });
    }

    for (const s of subnets) {
      const cc = db.prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?').get(s.id);
      if (cc.c > 0)
        return res
          .status(400)
          .json({ error: `Subnet ${s.cidr} has children and cannot be merged` });
    }

    const mergeResult = mergeNetworks(subnets.map((s) => s.cidr));
    if (!mergeResult.valid) {
      return res.status(400).json({ error: mergeResult.error });
    }
    const currentPlan = buildMergePlan(db, subnets, mergeResult.merged_cidr);
    if (
      plan_token &&
      !isCurrentTransformationPlan(db, {
        source_ids: currentPlan.source_ids,
        dependency_token: plan_token,
        plan_id,
        current_plan: currentPlan,
      })
    ) {
      return res
        .status(409)
        .json({ error: 'Transformation plan is stale', stale_plan: true, plan: currentPlan });
    }

    // Forward-zone conflict gate: refuse to silently consolidate when the
    // children claim different forward-zone domains. The user must resolve the
    // clash themselves (rename or delete one of the zones) before merging.
    const childIds = subnets.map((s) => s.id);
    const allocated = subnets.filter((s) => s.status === 'allocated');
    const gatewayPolicies = [...new Set(allocated.map((s) => s.gateway_policy))];
    if (
      gatewayPolicies.length > 1 ||
      (gatewayPolicies[0] === 'custom' && new Set(allocated.map((s) => s.gateway_address)).size > 1)
    ) {
      return res.status(409).json({
        error:
          'Cannot merge networks with conflicting gateway policies. Resolve the gateway policy first.',
      });
    }
    const { conflict: domainConflict, zones: forwardZones } = detectForwardZoneConflict(
      db,
      childIds,
    );
    if (domainConflict) {
      return res.status(409).json({
        error:
          'Cannot merge: child subnets own forward zones with different domain names. Rename or delete one before merging.',
        forward_zones: forwardZones,
      });
    }
    if (currentPlan.conflicts.length > 0) {
      return res.status(409).json({
        error: 'Cannot merge until all network and reservation conflicts are resolved.',
        conflicts: currentPlan.conflicts,
        plan: currentPlan,
      });
    }

    try {
      const mergedId = SubnetTopology.mergeSubnets(db, subnets, mergeResult, {
        defaultGatewayPosition: getSetting('default_gateway_position'),
        nameTemplate: getSetting('subnet_name_template'),
      });
      req.afterCommit('regenerate_dns');
      req.afterCommit('regenerate_dhcp');
      audit(req.user.id, 'subnets_merged', 'subnet', mergedId, {
        merged_cidrs: subnets.map((s) => s.cidr),
        result_cidr: mergeResult.merged_cidr,
      });

      const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parentId);
      const children = sortSubnetsNumerically(
        db.prepare('SELECT * FROM subnets WHERE parent_id = ?').all(parentId),
      );
      res.json({ ...parent, children });
    } catch (err) {
      console.error('Merge error:', err);
      res.status(500).json({ error: `Merge failed: ${err.message}` });
    }
  }),
);

// POST /api/subnets/apply-template: apply name template to selected subnets
router.post(
  '/apply-template',
  requirePerm('subnets:write'),
  asyncHandler((req, res) => {
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
  }),
);

// PUT /api/subnets/:id: update subnet config
router.put(
  '/:id',
  requirePerm('subnets:write'),
  asyncHandler((req, res) => {
    const body = req.body || {};
    const {
      name,
      description,
      vlan_id,
      gateway_address,
      gateway_policy,
      scan_interval,
      folder_id,
      domain_name,
      scan_enabled,
      cidr,
    } = body;

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
    if (
      gateway_address !== undefined &&
      gateway_address !== null &&
      typeof gateway_address !== 'string'
    ) {
      return res.status(400).json({ error: 'gateway_address must be a string' });
    }
    if (
      gateway_policy !== undefined &&
      !['first', 'last', 'custom', 'none'].includes(gateway_policy)
    ) {
      return res.status(400).json({ error: 'gateway_policy must be first, last, custom, or none' });
    }
    if (vlan_id !== undefined && vlan_id !== null && vlan_id !== '') {
      const vlanErr = vlanIdError(vlan_id);
      if (vlanErr) {
        return res.status(400).json({ error: vlanErr });
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
    const parsedSubnet = parseNetwork(subnet.cidr);
    const requestedPolicy =
      gateway_policy ||
      (gateway_address !== undefined
        ? SubnetTopology.gatewayPolicyForAddress(parsedSubnet, gateway_address)
        : subnet.gateway_policy);
    if (requestedPolicy === 'custom' && !gateway_address) {
      return res
        .status(400)
        .json({ error: 'gateway_address is required for custom gateway policy' });
    }
    const requestedGateway = gateway_policy
      ? SubnetTopology.resolveGatewayAddress(parsedSubnet, requestedPolicy, gateway_address)
      : gateway_address;
    {
      const err = validateGatewayForSubnet(parsedSubnet, requestedGateway);
      if (err) return res.status(400).json({ error: err });
    }

    // CIDR can't be changed here, use /divide or /merge. The edit dialog
    // echoes the current CIDR back in the body, so we only reject when the
    // value actually DIFFERS from what's stored; a matching value is a
    // harmless no-op.
    if (cidr !== undefined && cidr !== subnet.cidr) {
      return res.status(400).json({
        error: 'CIDR cannot be changed via PUT. Use /api/subnets/:id/divide or /api/subnets/merge.',
      });
    }

    // Validate scan_interval if provided
    const validIntervals = [null, '5m', '15m', '30m', '1h', '4h'];
    if (scan_interval !== undefined && !validIntervals.includes(scan_interval)) {
      return res
        .status(400)
        .json({ error: 'Invalid scan interval. Use: null, 5m, 15m, 30m, 1h, 4h' });
    }

    // Validate folder_id if provided. Any subnet (root or child) can be
    // assigned to a folder, children in the tree view are promoted to a
    // root-level node of the chosen folder, detached from their CIDR parent.
    {
      const err = folderIdError(db, folder_id);
      if (err) return res.status(400).json({ error: err });
    }

    // Post-decouple: `domain_name` is just a pointer to a forward zone by
    // name. Multiple subnets may share the same value. If the zone doesn't
    // exist yet, auto-create it on commit. Clearing `domain_name` does NOT
    // delete the zone, other subnets may still reference it; the user must
    // delete via the DNS UI if they want the zone gone.
    const domainChange =
      domain_name !== undefined && domain_name !== subnet.domain_name
        ? {
            autoCreate: !!(
              domain_name &&
              !db
                .prepare("SELECT id FROM dns_zones WHERE name = ? AND type = 'forward'")
                .get(domain_name)
            ),
            newName: domain_name,
          }
        : null;

    // Resolve scan_enabled: true→1, false→0, null→NULL, undefined→keep existing
    const scanEn =
      scan_enabled === undefined
        ? subnet.scan_enabled
        : scan_enabled === null
          ? null
          : scan_enabled
            ? 1
            : 0;

    // Wrap all writes in a single transaction so a failure mid-sequence (zone
    // rename UNIQUE violation, a later INSERT error, etc.) rolls back the
    // subnet row update and the gateway range change together. Otherwise the
    // client can get a 500 with subnet.domain_name already changed on disk but
    // no corresponding zone rename, leaving the system in a split-brain state.
    const gatewayChanged =
      requestedGateway !== undefined &&
      (requestedGateway !== subnet.gateway_address || requestedPolicy !== subnet.gateway_policy);

    // Refuse a gateway change that would place the router inside an existing
    // DHCP pool: dnsmasq would hand out the gateway IP as a dynamic lease and
    // clients would conflict with the router. Force the user to shrink the
    // pool first (or pick a gateway outside it).
    if (gatewayChanged) {
      const pools = db
        .prepare(
          `
      SELECT r.start_ip, r.end_ip FROM dhcp_scopes s
      JOIN ranges r ON s.range_id = r.id
      WHERE s.subnet_id = ?
    `,
        )
        .all(subnet.id);
      for (const p of pools) {
        if (requestedGateway && addressInRange(requestedGateway, p.start_ip, p.end_ip)) {
          return res.status(409).json({
            error: `Gateway ${requestedGateway} falls inside an existing DHCP pool (${p.start_ip}–${p.end_ip}). Shrink the pool or choose a gateway outside it.`,
            dhcp_pool: { start_ip: p.start_ip, end_ip: p.end_ip },
          });
        }
      }
    }

    const updated = SubnetTopology.updateSubnetDetails(db, subnet, {
      name,
      description,
      vlan_id,
      gateway_address: requestedGateway,
      gateway_policy: requestedPolicy,
      scan_interval,
      folder_id,
      domain_name,
      scan_enabled: scanEn,
      gatewayChanged,
      domainChange,
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
    const vlan_warning =
      vlan_id !== undefined && vlan_id !== null
        ? detectVlanCollision(db, vlan_id, subnet.id)
        : null;
    res.json({ ...updated, ...(vlan_warning ? { vlan_warning } : {}) });
  }),
);

// POST /api/subnets/:id/divide/preview: preview division without committing
router.post(
  '/:id/divide/preview',
  requirePerm('subnets:read'),
  asyncHandler((req, res) => {
    const { cidr, new_prefix, selected_cidrs, target_gateways } = req.body;
    const db = getDb();
    const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
    if (!parent) return res.status(404).json({ error: 'Subnet not found' });

    // Must be a leaf
    const childCount = db
      .prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?')
      .get(parent.id);
    if (childCount.c > 0)
      return res.status(400).json({ error: 'Subnet already has children. Cannot divide further.' });

    try {
      // Equal division mode (new_prefix)
      if (new_prefix !== undefined) {
        const targetPrefix = parseInt(new_prefix, 10);
        const parentParsed = parseNetwork(parent.cidr);
        if (targetPrefix <= parentParsed.prefix || targetPrefix > parentParsed.bits) {
          return res.status(400).json({ error: 'Invalid target prefix' });
        }
        const subnets = splitNetwork(parent.cidr, targetPrefix, 256);
        const count = subnets.length;
        if (count > 256) {
          return res.status(400).json({ error: 'Cannot divide into more than 256 subnets' });
        }
        let gatewaySubnet = null;
        if (parent.gateway_address) {
          gatewaySubnet = subnets.find((s) => parsedNetworkContains(s, parent.gateway_address));
        }
        const childCidrs = subnets.map((s) => s.cidr);
        const plan = buildDividePlan(db, parent, {
          newPrefix: targetPrefix,
          selectedCidrs: selected_cidrs,
          targetGateways: target_gateways,
        });
        return res.json({
          parent: parent.cidr,
          mode: 'equal',
          subnets: childCidrs,
          count,
          is_allocated: parent.status === 'allocated',
          gateway_preserved: gatewaySubnet
            ? `${gatewaySubnet.network}/${gatewaySubnet.prefix}`
            : null,
          lossy: detectLossyIpsForDivision(db, parent.id, childCidrs),
          plan,
        });
      }

      // Legacy carve mode (single child CIDR)
      if (!cidr) return res.status(400).json({ error: 'CIDR or new_prefix is required' });
      if (!isValidNetwork(cidr)) return res.status(400).json({ error: 'Invalid CIDR notation' });
      const normalized = normalizeNetwork(cidr);
      if (!isNetworkWithin(normalized, parent.cidr)) {
        return res.status(400).json({ error: 'Child CIDR must be within parent subnet' });
      }
      const remainder = subtractNetwork(parent.cidr, normalized);
      const childCidrs = [normalized, ...remainder];
      const plan = buildDividePlan(db, parent, {
        cidr: normalized,
        targetGateways: target_gateways,
      });
      res.json({
        parent: parent.cidr,
        mode: 'carve',
        carved: normalized,
        remainder,
        is_allocated: parent.status === 'allocated',
        gateway_preserved: parent.gateway_address
          ? networkContains(normalized, parent.gateway_address)
          : null,
        lossy: detectLossyIpsForDivision(db, parent.id, childCidrs),
        plan,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }),
);

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
// is also flagged as lossy, the transfer helpers silently drop rows with
// no matching child, so without this check users lose reservations when
// doing partial divides.
function detectLossyIpsForDivision(db, parentId, childCidrs) {
  const boundaries = new Map(); // canonical ip -> { reason, child_cidr }
  const childRanges = childCidrs.map((c) => parseNetwork(c));
  for (const child of childRanges) {
    // Point-to-point and host prefixes reserve nothing. IPv6 reserves only
    // the network (subnet-router anycast) address, IPv4 network and broadcast.
    const [network, broadcast] = topologyAddresses(child);
    if (network) boundaries.set(network, { reason: 'network', child_cidr: child.cidr });
    if (broadcast) boundaries.set(broadcast, { reason: 'broadcast', child_cidr: child.cidr });
  }
  const isCovered = (ip) => childRanges.some((child) => parsedNetworkContains(child, ip));

  const lossy = [];

  // classify(ip) returns a reason/child_cidr for the loss, or null if the IP
  // is safely covered by a non-boundary position in some child. Rows holding
  // an unparseable address are left alone: nothing can be said about them.
  const classify = (ipAddr) => {
    const canonical = canonicalizeIp(ipAddr);
    if (!canonical) return null;
    const b = boundaries.get(canonical);
    if (b) return { reason: b.reason, child_cidr: b.child_cidr };
    if (!isCovered(canonical)) return { reason: 'outside_selection', child_cidr: null };
    return null;
  };

  const reservations = db
    .prepare(
      'SELECT id, ip_address, mac_address, hostname FROM dhcp_reservations WHERE subnet_id = ?',
    )
    .all(parentId);
  for (const r of reservations) {
    const cls = classify(r.ip_address);
    if (!cls) continue;
    lossy.push({
      record_id: r.id,
      ip: r.ip_address,
      child_cidr: cls.child_cidr,
      reason: cls.reason,
      carries: 'dhcp_reservation',
      hostname: r.hostname || null,
      mac: r.mac_address || null,
    });
  }

  // ip_addresses rows: only count rows that carry meaningful state. A bare
  // unassigned row with no hostname/MAC/scan history is noise from the
  // sync scheduler and safe to drop.
  const ips = db
    .prepare(
      "SELECT id, ip_address, hostname, mac_address, allocation_state, allocation_source_type FROM ip_addresses WHERE subnet_id = ? AND (hostname IS NOT NULL OR mac_address IS NOT NULL OR allocation_state != 'unassigned')",
    )
    .all(parentId);
  for (const ip of ips) {
    const cls = classify(ip.ip_address);
    if (!cls) continue;
    // Existing network/broadcast/gateway rows are topology projections, not
    // host facts. The post-transfer topology reconciler will retain, change,
    // or release them according to the target CIDR.
    if (ip.allocation_source_type === 'topology') continue;
    lossy.push({
      record_id: ip.id,
      ip: ip.ip_address,
      child_cidr: cls.child_cidr,
      reason: cls.reason,
      carries: 'ip_address',
      hostname: ip.hostname || null,
      mac: ip.mac_address || null,
      allocation_state: ip.allocation_state,
    });
  }

  const parent = db.prepare('SELECT cidr FROM subnets WHERE id = ?').get(parentId);
  // Manual A records may live in any forward zone, including a shared zone.
  // Restrict by the source CIDR before classifying so unrelated records in
  // that shared zone never become part of this operation.
  const aRecords = db
    .prepare(
      `
    SELECT r.id, r.name AS name, r.value AS value, z.name AS zone_name
    FROM dns_records r
    JOIN dns_zones z ON r.zone_id = z.id
    WHERE z.type = 'forward' AND z.enabled = 1
      AND r.type IN ('A', 'AAAA') AND r.enabled = 1
      AND COALESCE(r.source, 'manual') = 'manual'
  `,
    )
    .all()
    .filter(
      (record) =>
        isValidAddress(record.value) && parent && networkContains(parent.cidr, record.value),
    );
  for (const rec of aRecords) {
    const cls = classify(rec.value);
    if (!cls) continue;
    lossy.push({
      record_id: rec.id,
      ip: rec.value,
      child_cidr: cls.child_cidr,
      reason: cls.reason,
      carries: 'dns_record',
      hostname: rec.name === '@' ? rec.zone_name : `${rec.name}.${rec.zone_name}`,
    });
  }

  const leases = db
    .prepare(
      `
    SELECT id, ip_address, mac_address, hostname, expires_at
    FROM dhcp_leases
    WHERE subnet_id = ?
      AND (expires_at = 'infinite' OR datetime(expires_at) > datetime('now'))
  `,
    )
    .all(parentId);
  for (const lease of leases) {
    const cls = classify(lease.ip_address);
    if (!cls) continue;
    lossy.push({
      record_id: lease.id,
      ip: lease.ip_address,
      child_cidr: cls.child_cidr,
      reason: cls.reason,
      carries: 'dhcp_lease',
      hostname: lease.hostname || null,
      mac: lease.mac_address || null,
      expires_at: lease.expires_at,
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
  if (gwLong === clippedEnd) return { start: clippedStart, end: clippedEnd - 1, adjusted: true };
  // Strictly in the middle, keep the larger contiguous side.
  const leftSize = gwLong - clippedStart; // size of pool before gw
  const rightSize = clippedEnd - gwLong; // size of pool after gw
  if (rightSize >= leftSize) return { start: gwLong + 1, end: clippedEnd, adjusted: true };
  return { start: clippedStart, end: gwLong - 1, adjusted: true };
}

// Helper: migrate config from parent to inheriting child during division.
// `childGw` is the new child's gateway IP (not the parent's, the divide
// handler computes it per-child, e.g. firstUsable of each /24 after a /22
// split). Scope presence is inherited, but the pool is deliberately recreated
// with the normal default sizing for the child CIDR. Returns the disclosed
// replacement pool for the response and confirmation UI.
function migrateConfigToChild(db, parentId, childId, childParsed, childGw, parentHasReverseDns) {
  createSystemRanges(db, childId, childParsed, childGw);

  const poolAdjustments = [];

  // Preserve scope presence and policy, while giving the child a newly sized
  // default pool and target-specific topology options.
  poolAdjustments.push(
    ...DhcpTopology.createDefaultScopeForChild(db, parentId, childId, childParsed, childGw),
  );

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
  DhcpTopology.moveLeasesToChildren(db, parentId);
  const children = db.prepare('SELECT id, cidr FROM subnets WHERE parent_id = ?').all(parentId);
  if (children.length === 0) return;
  const childRanges = children.map((c) => ({ id: c.id, parsed: parseNetwork(c.cidr) }));
  const findChildForIp = (ip) => childRanges.find((c) => parsedNetworkContains(c.parsed, ip));

  // ip_addresses: parent's row has the live state and observed metadata.
  // If a row already exists under the child for the same IP (auto-populated
  // after the child was inserted), prefer the parent's and drop the dup.
  // We also rewrite `ip_events.subnet_id` for each moved row so history
  // queries that filter by subnet_id return the new child's events.
  const ips = db
    .prepare('SELECT id, ip_address FROM ip_addresses WHERE subnet_id = ?')
    .all(parentId);
  for (const ip of ips) {
    const c = findChildForIp(ip.ip_address);
    if (!c) continue;
    IpAddress.moveToSubnet(db, ip.id, ip.ip_address, c.id);
  }
}

function reconcileChildTopology(db, parentId) {
  const children = db.prepare('SELECT id FROM subnets WHERE parent_id = ?').all(parentId);
  for (const child of children) SubnetTopology.reconcileSubnetTopology(db, child.id);
}

function conflictResolutionKey(item) {
  return `${item.carries}:${Number(item.record_id)}`;
}

function validateConflictResolutions(lossy, resolutions) {
  if (lossy.length === 0) return [];
  if (!Array.isArray(resolutions)) return null;
  const expected = new Map(lossy.map((item) => [conflictResolutionKey(item), item]));
  const accepted = new Map();
  for (const resolution of resolutions) {
    if (resolution?.action !== 'delete') throw new Error('Unsupported conflict resolution action');
    const key = conflictResolutionKey(resolution || {});
    if (!expected.has(key))
      throw new Error(`Conflict resolution ${key} is not part of the current plan`);
    if (accepted.has(key)) throw new Error(`Duplicate conflict resolution ${key}`);
    accepted.set(key, expected.get(key));
  }
  if (accepted.size !== expected.size) return null;
  return [...accepted.values()];
}

// After divide, delete only artifacts identified by the current plan and
// individually accepted by record identity.
// artifacts the lossy detector flagged. Their IPs are now on new children's
// network/broadcast boundaries (or outside the selected children entirely)
// and can't be valid hosts anymore.
//
//   - DHCP reservations on a boundary IP: delete. The reservation was for
//     a host; the host can't live on a network/broadcast.
//   - DNS A records pointing at a boundary IP: delete. The record resolves
//     but the target is unusable.
//   - ip_addresses rows on a boundary IP: delete. Next sync will recreate
//     an appropriate protected allocation via createSystemRanges.
//   - dhcp_leases on a boundary IP: delete the DB row. dnsmasq's on-disk
//     lease remains valid until its client renews; dnsmasq will then
//     refuse (IP is now outside the active pool) and the client gets a
//     fresh IP. No connection drop.
//
// `lossy` is the exact resolved list validated against the current plan.
// Returns a summary for the response body so the client can toast what
// got removed.
function cleanupLossyArtifactsAfterDivide(db, parentId, lossy) {
  if (!Array.isArray(lossy) || lossy.length === 0) {
    return { ips: [], removed: { reservations: 0, ip_addresses: 0, dns_records: 0, leases: 0 } };
  }
  const ipSet = new Set(lossy.map((l) => l.ip));
  const removed = { reservations: 0, ip_addresses: 0, dns_records: 0, leases: 0 };
  for (const item of lossy) {
    if (!item.record_id) continue;
    let result;
    if (item.carries === 'dhcp_reservation') {
      result = DhcpTopology.deleteChildReservationById(db, parentId, item.record_id);
    } else if (item.carries === 'dhcp_lease') {
      result = DhcpTopology.deleteChildLeaseById(db, parentId, item.record_id);
    } else if (item.carries === 'dns_record') {
      result = DnsTopology.deleteARecordByIdentity(db, item.record_id, item.ip);
    } else if (item.carries === 'ip_address') {
      result = IpAddress.deleteById(db, item.record_id);
    } else continue;
    if (item.carries === 'dhcp_reservation') removed.reservations += result.changes;
    if (item.carries === 'dhcp_lease') removed.leases += result.changes;
    if (item.carries === 'dns_record') removed.dns_records += result.changes;
    if (item.carries === 'ip_address') removed.ip_addresses += result.changes;
  }
  return { ips: [...ipSet], removed };
}

// Post-decouple no-op. Zones are subnet-agnostic: they survive parent divide
// automatically because no `subnet_id` reference to fix up. Retained as an
// empty function so divide call sites stay readable and bisectable.
function migrateParentZonesToChildren(_db, _parentId) {
  // intentionally empty, see migration 045
}

// Detect forward-zone domain conflicts among the subnets being merged.
// Post-decouple we look at each subnet's `domain_name` (the pointer to its
// forward zone) rather than at `dns_zones.subnet_id`. Two merging subnets
// with different domain_names is still a real conflict, the merged subnet
// can only hold one domain_name, so we surface it for user resolution.
function detectForwardZoneConflict(db, childIds) {
  if (!Array.isArray(childIds) || childIds.length === 0) return { conflict: false, zones: [] };
  const placeholders = childIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id AS subnet_id, domain_name AS name FROM subnets WHERE id IN (${placeholders}) AND domain_name IS NOT NULL`,
    )
    .all(...childIds);
  const names = new Set(rows.map((r) => r.name));
  return { conflict: names.size > 1, zones: rows };
}

// Helper: clear parent config after division. Assumes per-IP artifacts (IP
// addresses, reservations) and DNS zones have ALREADY been transferred to
// children via transferPerIpArtifactsToChildren() and migrateParentZonesToChildren().
// This call wipes parent-owned ranges, DHCP scopes (migrateConfigToChild
// created replacements on the children), and resets
// the parent row's config fields.
function clearParentConfig(db, parentId) {
  DhcpTopology.deleteDhcpStateForSubnet(db, parentId);
  SubnetTopology.clearParentConfig(db, parentId);
}

// POST /api/subnets/:id/divide: execute division
// `force` accepts destruction of the parent's allocated config.
// Destructive conflicts require one explicit record-identity resolution each.
router.post(
  '/:id/divide',
  requirePerm('subnets:write'),
  asyncHandler((req, res) => {
    const {
      cidr,
      new_prefix,
      force,
      conflict_resolutions,
      selected_cidrs,
      target_gateways,
      plan_token,
      plan_id,
    } = req.body;
    const db = getDb();
    const parent = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
    if (!parent) return res.status(404).json({ error: 'Subnet not found' });

    // Must be a leaf
    const childCount = db
      .prepare('SELECT COUNT(*) as c FROM subnets WHERE parent_id = ?')
      .get(parent.id);
    if (childCount.c > 0)
      return res.status(400).json({ error: 'Subnet already has children. Cannot divide further.' });

    // Check if parent is allocated, require confirmation
    if (parent.status === 'allocated' && !force) {
      return res.status(409).json({
        error: 'Subnet is allocated. Division will migrate or remove its configuration.',
        requires_confirmation: true,
        can_force: true,
      });
    }

    const childDepth = parent.depth + 1;
    const parentParsed = parseNetwork(parent.cidr);
    let currentPlan;
    try {
      currentPlan = buildDividePlan(db, parent, {
        newPrefix: new_prefix,
        cidr: cidr ? normalizeNetwork(cidr) : undefined,
        selectedCidrs: selected_cidrs,
        targetGateways: target_gateways,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (currentPlan.conflicts.length) {
      return res.status(409).json({
        error: 'Transformation conflicts must be resolved before execution.',
        conflicts: currentPlan.conflicts,
        plan: currentPlan,
      });
    }
    if (
      plan_token &&
      !isCurrentTransformationPlan(db, {
        source_ids: currentPlan.source_ids,
        dependency_token: plan_token,
        plan_id,
        current_plan: currentPlan,
      })
    ) {
      return res
        .status(409)
        .json({ error: 'Transformation plan is stale', stale_plan: true, plan: currentPlan });
    }

    // Get name template
    const template = getSetting('subnet_name_template');

    try {
      // Equal division mode
      if (new_prefix !== undefined) {
        const targetPrefix = parseInt(new_prefix, 10);
        if (targetPrefix <= parentParsed.prefix || targetPrefix > parentParsed.bits) {
          return res.status(400).json({ error: 'Invalid target prefix' });
        }
        let subnets = splitNetwork(parent.cidr, targetPrefix, 256);
        if (subnets.length > 256) {
          return res.status(400).json({ error: 'Cannot divide into more than 256 subnets' });
        }

        // Validate selected CIDRs, but retain every result as explicit ownership
        // so a partial selection cannot strand or delete the remainder.
        if (Array.isArray(selected_cidrs) && selected_cidrs.length > 0) {
          const allCidrs = new Set(subnets.map((s) => s.cidr));
          const invalid = selected_cidrs.filter((c) => !allCidrs.has(c));
          if (invalid.length > 0) {
            return res.status(400).json({ error: `Invalid selected CIDRs: ${invalid.join(', ')}` });
          }
        }

        // Any host fact that becomes unusable needs its own reviewed action.
        const childCidrList = subnets.map((s) => s.cidr);
        const lossy = detectLossyIpsForDivision(db, parent.id, childCidrList);
        const acceptedLossy = validateConflictResolutions(lossy, conflict_resolutions);
        if (lossy.length > 0 && !acceptedLossy) {
          return res.status(409).json({
            error: `${lossy.length} host IP(s) would land on a new subnet's network/broadcast address and be unusable after divide.`,
            requires_confirmation: true,
            requires_conflict_resolutions: true,
            lossy,
          });
        }

        // Collected across the child loop so the response can surface every
        // default-sized replacement pool disclosed by preview.
        let txnPoolAdjustments = [];
        let txnLossyCleanup = {
          ips: [],
          removed: { reservations: 0, ip_addresses: 0, dns_records: 0, leases: 0 },
        };
        const txn = db.transaction(() => {
          const childIds = [];
          const poolAdjustmentsAll = [];
          const targetsByCidr = new Map(currentPlan.targets.map((target) => [target.cidr, target]));
          for (const s of subnets) {
            const sCidr = s.cidr;
            const target = targetsByCidr.get(sCidr);
            const childGw = target.gateway.address;

            const result = insertSubnet(db, {
              cidr: sCidr,
              name: networkNameFromTemplate(template, sCidr),
              description: parent.description,
              vlan_id: parent.vlan_id,
              gateway_address: childGw,
              gateway_policy: target.gateway.policy,
              parent_id: parent.id,
              status: parent.status === 'allocated' ? 'allocated' : 'unallocated',
              depth: childDepth,
              domain_name: parent.domain_name,
              folder_id: parent.folder_id,
              scan_interval: parent.scan_interval,
              scan_enabled: parent.scan_enabled,
            });

            const adj = migrateConfigToChild(
              db,
              parent.id,
              result.lastInsertRowid,
              s,
              childGw,
              parent.has_reverse_dns,
            );
            if (Array.isArray(adj) && adj.length) poolAdjustmentsAll.push(...adj);
            childIds.push(result.lastInsertRowid);
          }
          // Pool adjustments bubble up via a closure variable, the return
          // value of txn() is the child id list, and we read the outer
          // variable after.
          txnPoolAdjustments = poolAdjustmentsAll;

          // Transfer parent's per-IP artifacts (reservations, ip_addresses) and
          // DNS zones to the children BEFORE tearing down the parent config.
          transferPerIpArtifactsToChildren(db, parent.id);
          migrateParentZonesToChildren(db, parent.id);

          // Now that artifacts live under children, delete the ones the user
          // The accepted list was matched to this freshly computed plan by
          // record identity, so no unrelated row is authorized for deletion.
          if (acceptedLossy.length > 0) {
            txnLossyCleanup = cleanupLossyArtifactsAfterDivide(db, parent.id, acceptedLossy);
          }
          reconcileChildTopology(db, parent.id);

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
          lossy_cleanup: txnLossyCleanup,
        });

        const updated = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parent.id);
        const children = sortSubnetsNumerically(
          db.prepare('SELECT * FROM subnets WHERE parent_id = ?').all(parent.id),
        );
        return res.json({
          ...updated,
          children,
          pool_adjustments: txnPoolAdjustments,
          lossy_cleanup: txnLossyCleanup,
        });
      }

      // Legacy carve mode (single child CIDR)
      if (!cidr) return res.status(400).json({ error: 'CIDR or new_prefix is required' });
      if (!isValidNetwork(cidr)) return res.status(400).json({ error: 'Invalid CIDR notation' });

      const normalized = normalizeNetwork(cidr);
      if (!isNetworkWithin(normalized, parent.cidr)) {
        return res.status(400).json({ error: 'Child CIDR must be within parent subnet' });
      }

      const remainder = subtractNetwork(parent.cidr, normalized);
      // Same exact-resolution gate as equal division.
      const carveLossy = detectLossyIpsForDivision(db, parent.id, [normalized, ...remainder]);
      const acceptedCarveLossy = validateConflictResolutions(carveLossy, conflict_resolutions);
      if (carveLossy.length > 0 && !acceptedCarveLossy) {
        return res.status(409).json({
          error: `${carveLossy.length} host IP(s) would land on a new subnet's network/broadcast address and be unusable after divide.`,
          requires_confirmation: true,
          requires_conflict_resolutions: true,
          lossy: carveLossy,
        });
      }

      let carvePoolAdjustments = [];
      let carveLossyCleanup = {
        ips: [],
        removed: { reservations: 0, ip_addresses: 0, dns_records: 0, leases: 0 },
      };
      const txn = db.transaction(() => {
        for (const target of currentPlan.targets) {
          const aCidr = target.cidr;
          const aParsed = parseNetwork(aCidr);
          const childGw = target.gateway.address;

          const result = insertSubnet(db, {
            cidr: aCidr,
            name: networkNameFromTemplate(template, aCidr),
            description: parent.description,
            vlan_id: parent.vlan_id,
            gateway_address: childGw,
            gateway_policy: target.gateway.policy,
            parent_id: parent.id,
            status: parent.status === 'allocated' ? 'allocated' : 'unallocated',
            depth: childDepth,
            domain_name: parent.domain_name,
            folder_id: parent.folder_id,
            scan_interval: parent.scan_interval,
            scan_enabled: parent.scan_enabled,
          });

          const adj = migrateConfigToChild(
            db,
            parent.id,
            result.lastInsertRowid,
            aParsed,
            childGw,
            parent.has_reverse_dns,
          );
          if (Array.isArray(adj) && adj.length) carvePoolAdjustments.push(...adj);
        }

        transferPerIpArtifactsToChildren(db, parent.id);
        migrateParentZonesToChildren(db, parent.id);
        if (acceptedCarveLossy.length > 0) {
          carveLossyCleanup = cleanupLossyArtifactsAfterDivide(db, parent.id, acceptedCarveLossy);
        }
        reconcileChildTopology(db, parent.id);
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
        lossy_cleanup: carveLossyCleanup,
      });

      const updated = db.prepare('SELECT * FROM subnets WHERE id = ?').get(parent.id);
      const children = sortSubnetsNumerically(
        db.prepare('SELECT * FROM subnets WHERE parent_id = ?').all(parent.id),
      );
      res.json({
        ...updated,
        children,
        pool_adjustments: carvePoolAdjustments,
        lossy_cleanup: carveLossyCleanup,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }),
);

// POST /api/subnets/:id/configure: allocate a subnet
router.post(
  '/:id/configure',
  requirePerm('subnets:write'),
  asyncHandler((req, res) => {
    const {
      name,
      description,
      vlan_id,
      gateway_address,
      gateway_policy,
      create_dhcp_scope,
      create_reverse_dns,
      folder_id,
      domain_name,
      dhcp_start_ip,
      dhcp_end_ip,
      dhcp_v6_mode,
      scan_interval,
      scan_enabled,
    } = req.body;

    if (typeof name !== 'string' || !name.trim())
      return res.status(400).json({ error: 'Name is required' });
    if (
      dhcp_v6_mode !== undefined &&
      dhcp_v6_mode !== null &&
      !['slaac', 'stateless', 'stateful'].includes(dhcp_v6_mode)
    ) {
      return res.status(400).json({ error: 'dhcp_v6_mode must be slaac, stateless, or stateful' });
    }
    {
      const err = validateDisplayString(name, { maxLength: 255 });
      if (err) return res.status(400).json({ error: `name ${err}` });
    }
    if (description !== undefined) {
      const err = validateDisplayString(description, { maxLength: 1024 });
      if (err) return res.status(400).json({ error: `description ${err}` });
    }
    if (vlan_id !== undefined && vlan_id !== null && vlan_id !== '') {
      const vlanErr = vlanIdError(vlan_id);
      if (vlanErr) {
        return res.status(400).json({ error: vlanErr });
      }
    }
    if (create_dhcp_scope !== undefined && typeof create_dhcp_scope !== 'boolean') {
      return res.status(400).json({ error: 'create_dhcp_scope must be boolean' });
    }
    if (create_reverse_dns !== undefined && typeof create_reverse_dns !== 'boolean') {
      return res.status(400).json({ error: 'create_reverse_dns must be boolean' });
    }
    if (scan_enabled !== undefined && scan_enabled !== null && typeof scan_enabled !== 'boolean') {
      return res.status(400).json({ error: 'scan_enabled must be boolean or null' });
    }
    if (
      scan_interval !== undefined &&
      scan_interval !== null &&
      (!Number.isInteger(scan_interval) || scan_interval < 0)
    ) {
      return res
        .status(400)
        .json({ error: 'scan_interval must be a non-negative integer or null' });
    }
    if (
      domain_name !== undefined &&
      domain_name !== null &&
      domain_name !== '' &&
      typeof domain_name !== 'string'
    ) {
      return res.status(400).json({ error: 'domain_name must be a string' });
    }
    if (domain_name && !isValidDomain(domain_name)) {
      return res.status(400).json({ error: 'Invalid domain name format' });
    }
    if (
      gateway_policy !== undefined &&
      !['first', 'last', 'custom', 'none'].includes(gateway_policy)
    ) {
      return res.status(400).json({ error: 'gateway_policy must be first, last, custom, or none' });
    }

    const db = getDb();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });
    // Configuring creates the gateway, reverse zone and DHCP scope of an
    // IPv6 network; editing the name or description goes through PUT /:id.
    if (subnet.address_family === 6 && refuseIpv6Unless(res)) return;

    const parsed = parseNetwork(subnet.cidr);
    {
      const err = validateGatewayForSubnet(parsed, gateway_address);
      if (err) return res.status(400).json({ error: err });
    }

    // Determine gateway
    const resolvedPolicy =
      gateway_policy ||
      (gateway_address
        ? SubnetTopology.gatewayPolicyForAddress(parsed, gateway_address)
        : getSetting('default_gateway_position'));
    if (resolvedPolicy === 'custom' && !gateway_address) {
      return res
        .status(400)
        .json({ error: 'gateway_address is required for custom gateway policy' });
    }
    const gw = SubnetTopology.resolveGatewayAddress(parsed, resolvedPolicy, gateway_address);

    // Validate folder_id if provided
    {
      const err = folderIdError(db, folder_id);
      if (err) return res.status(400).json({ error: err });
    }

    // Post-decouple: no forward-zone ownership conflict possible. A subnet's
    // domain_name is just a pointer; any number of subnets may share a zone.
    // We auto-create the zone inside the txn if it doesn't exist yet.

    // DHCPv4 pools are sized from the address count below. IPv6 scopes are
    // created by mode instead: slaac (RA only), stateless (SLAAC plus options
    // over DHCPv6) or stateful (addresses from a pool). The SLAAC modes need a
    // /64. A stateful pool may be given explicitly or defaults to 4096
    // addresses at offset 0x1000 of the prefix.
    let dhcpPool = null;
    let dhcpV6 = null;
    if (create_dhcp_scope && parsed.family === 6) {
      const mode = dhcp_v6_mode || 'stateful';
      if (mode !== 'stateful' && parsed.prefix !== 64) {
        return res.status(400).json({
          error: `dhcp_v6_mode ${mode} requires a /64 network (SLAAC needs 64 host bits)`,
        });
      }
      let pool = null;
      if (mode === 'stateful' && (dhcp_start_ip || dhcp_end_ip)) {
        const defaults = DhcpTopology.defaultDhcpV6PoolForSubnet(parsed);
        const startIp = dhcp_start_ip || defaults?.start_ip || parsed.firstUsable;
        const endIp = dhcp_end_ip || defaults?.end_ip || parsed.lastUsable;
        const error = validateDhcpScopeBounds(parsed, startIp, endIp);
        if (error) return res.status(400).json({ error });
        const conflict = gatewayInPoolConflict({ gateway_address: gw }, startIp, endIp);
        if (conflict) {
          return res.status(409).json({
            error: gatewayInPoolError(conflict),
            gateway_address: conflict.gateway_address,
          });
        }
        pool = { start_ip: canonicalizeIp(startIp), end_ip: canonicalizeIp(endIp) };
      }
      dhcpV6 = { mode, pool };
    }
    if (create_dhcp_scope && parsed.family === 4 && parsed.prefix <= 29) {
      const gwLong = gw && isValidIpv4(gw) ? ipToLong(gw) : null;
      let poolStart, poolEnd;
      const explicitPool = dhcp_start_ip || dhcp_end_ip;
      if (explicitPool) {
        const defaults = dhcpRangeDefaults(parsed);
        const startIp =
          dhcp_start_ip || (defaults ? longToIp(defaults.startLong) : parsed.firstUsable);
        const endIp = dhcp_end_ip || (defaults ? longToIp(defaults.endLong) : parsed.lastUsable);
        const error = validateDhcpScopeBounds(parsed, startIp, endIp);
        if (error) return res.status(400).json({ error });
        // validateDhcpScopeBounds checks subnet bounds and ordering only, never
        // the gateway. An explicitly requested pool is rejected rather than
        // silently adjusted, matching the scope and range routes.
        const conflict = gatewayInPoolConflict({ gateway_address: gw }, startIp, endIp);
        if (conflict) {
          return res.status(409).json({
            error: gatewayInPoolError(conflict),
            gateway_address: conflict.gateway_address,
          });
        }
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
        // A derived pool is adjusted, not rejected: the user did not choose it.
        // excludeGatewayFromPool also handles a gateway strictly inside the
        // pool, which the old boundary-only check let straight through.
        const adjusted = excludeGatewayFromPool(poolStart, poolEnd, gwLong);
        poolStart = adjusted.start;
        poolEnd = adjusted.end;
      }
      if (poolStart <= poolEnd) {
        dhcpPool = { startLong: poolStart, endLong: poolEnd };
        const conflict = dynamicPoolConflict(
          db,
          { ...subnet, gateway_address: gw },
          longToIp(poolStart),
          longToIp(poolEnd),
        );
        if (conflict) {
          return res.status(409).json({
            error: conflict.error,
            conflict_type: conflict.type,
            ip_address: conflict.ip_address,
          });
        }
      }
    }

    const updated = SubnetTopology.configureSubnet(db, subnet, parsed, {
      name,
      description,
      vlan_id,
      gateway: gw,
      gateway_policy: resolvedPolicy,
      create_reverse_dns,
      domain_name,
      folder_id,
      scan_interval,
      scan_enabled,
      create_dhcp_scope,
      dhcpPool,
      dhcpV6,
    });

    audit(req.user.id, 'subnet_configured', 'subnet', subnet.id, {
      name,
      cidr: subnet.cidr,
      dhcp: !!create_dhcp_scope,
      dhcp_v6_mode: dhcpV6?.mode || null,
      reverse_dns: !!create_reverse_dns,
    });

    if (create_dhcp_scope) {
      req.afterCommit('regenerate_dhcp');
    }
    // Forward/reverse zones may have been created, always regen DNS after configure
    req.afterCommit('regenerate_dns');

    const vlan_warning = detectVlanCollision(db, updated.vlan_id, subnet.id);
    res.json({ ...updated, ...(vlan_warning ? { vlan_warning } : {}) });
  }),
);

// DELETE /api/subnets/:id: hierarchy-aware deletion with reconsolidation
// Reservations in the network or anything below it. A reservation is a
// promise someone made on purpose, so deallocation refuses while any exist
// rather than deleting them along with the leases.
function subtreeReservationCount(db, subnetId) {
  return db
    .prepare(
      `
    WITH RECURSIVE tree AS (
      SELECT id FROM subnets WHERE id = ?
      UNION ALL
      SELECT s.id FROM subnets s JOIN tree t ON s.parent_id = t.id
    )
    SELECT COUNT(*) AS c FROM dhcp_reservations WHERE subnet_id IN (SELECT id FROM tree)
  `,
    )
    .get(subnetId).c;
}

function reservationsBlockResponse(res, count) {
  return res.status(409).json({
    error: `Remove the ${count} DHCP reservation${count === 1 ? '' : 's'} in this network first.`,
    reason_code: 'reservations_present',
    reservation_count: count,
  });
}

// GET /api/subnets/:id/deallocation-preview: what deallocating (or deleting)
// this network removes, disables and keeps, so the confirmation dialog can say
// so before the user commits. Read only; the same selection drives the cleanup.
router.get(
  '/:id/deallocation-preview',
  requirePerm('subnets:read'),
  asyncHandler((req, res) => {
    const db = getDb();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });
    res.json(SubnetTopology.deallocationPreview(db, subnet));
  }),
);

router.delete(
  '/:id',
  requirePerm('subnets:write'),
  asyncHandler((req, res) => {
    const db = getDb();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

    if (subnet.status === 'allocated') {
      const reservations = subtreeReservationCount(db, subnet.id);
      if (reservations > 0) return reservationsBlockResponse(res, reservations);
    }

    const { action, dns } = SubnetTopology.deleteSubnet(db, subnet);
    req.afterCommit('regenerate_dns');
    req.afterCommit('regenerate_dhcp');
    audit(req.user.id, 'subnet_deleted', 'subnet', subnet.id, {
      cidr: subnet.cidr,
      action,
      ...dns,
    });
    res.json({ message: 'Subnet deleted', action, dns });
  }),
);

// POST /api/subnets/calculate: standalone calculator.
// v0.4.15: refuse divides that would return more than MAX_CALCULATE_CHILDREN
// subnets. In v0.4.14 the endpoint would happily emit 1M+ rows (~60 MB JSON)
// and block the event loop for 30s. The practical UI cap is much lower; this
// bound (65k, a /16-into-/32 divide's worth) is generous but finite.
router.post(
  '/calculate',
  requirePerm('subnets:read'),
  asyncHandler((req, res) => {
    const body = req.body || {};
    const { cidr, new_prefix } = body;

    if (typeof cidr !== 'string' || !cidr) {
      return res.status(400).json({ error: 'cidr must be a non-empty string' });
    }
    if (!Number.isInteger(new_prefix) || new_prefix < 0 || new_prefix > 128) {
      return res.status(400).json({ error: 'new_prefix must be an integer 0-128' });
    }
    if (!isValidNetwork(cidr)) {
      return res.status(400).json({ error: 'Invalid CIDR notation' });
    }

    const MAX_CALCULATE_CHILDREN = 65536;
    const parent = parseNetwork(cidr);
    if (new_prefix > parent.bits) {
      return res
        .status(400)
        .json({ error: `new_prefix must be an integer 0-${parent.bits} for this address family` });
    }
    if (new_prefix <= parent.prefix) {
      return res
        .status(400)
        .json({ error: `new_prefix /${new_prefix} must be larger than /${parent.prefix}` });
    }
    const childCount = 1n << BigInt(new_prefix - parent.prefix);
    if (childCount > BigInt(MAX_CALCULATE_CHILDREN)) {
      return res.status(400).json({
        error: `Would produce ${childCount} subnets; maximum is ${MAX_CALCULATE_CHILDREN}. Pick a narrower new_prefix or a smaller cidr.`,
      });
    }

    try {
      const results = splitNetwork(cidr, new_prefix, MAX_CALCULATE_CHILDREN);
      res.json({ parent, subnets: results });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }),
);

// GET /api/subnets/:id/ips: IP addresses with server-side pagination and virtual IPs
router.get(
  '/:id/ips',
  requirePerm('subnets:read'),
  asyncHandler((req, res) => {
    const db = getDb();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

    const parsed = parseNetwork(subnet.cidr);
    // Null for an IPv6 prefix larger than a Number represents.
    const totalIps = parsed.size;
    const search = (req.query.search || '').trim().toLowerCase();
    const showAvailable = req.query.showAvailable !== 'false';
    const readContext = getSubnetIpReadContext(db, subnet);
    const ranges = readContext.ranges;

    // Sort params
    const SORTABLE_FIELDS = new Set([
      'ip_address',
      'ip_display_status',
      'allocation_state',
      'allocation_source_type',
      'hostname',
      'mac_address',
      'vendor',
      'is_online',
      'last_seen_at',
      'dhcp_expires_at',
      'computed_type',
      'scanning_enabled',
      'network_range_type',
      'os_family',
      'device_type',
      'device_confidence',
      'dhcp_fingerprint',
      'dhcp_vendor_class',
      'dhcp_fingerprint_hostname',
      'device_fingerprint_source',
      'name',
      'record_type',
      'value',
      'priority',
      'port',
      'ttl',
      'enabled',
      'dns_source',
      'lease_status',
      'subnet_name',
    ]);
    const reqSortField = SORTABLE_FIELDS.has(req.query.sortField) ? req.query.sortField : null;
    const reqSortOrder = req.query.sortOrder === 'desc' ? -1 : 1;

    function sortIps(arr, field, order) {
      if (!field) return;
      arr.sort((a, b) => {
        let va, vb;
        if (field === 'ip_address') {
          va = addressToBig(a.ip_address).value;
          vb = addressToBig(b.ip_address).value;
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

    // Sort on any column of the one IP table model, empty values last and
    // the address as the tie-breaker.
    function sortByColumn(arr) {
      arr.sort((a, b) => compareSortValues(a, b) || compareAddresses(a, b));
    }
    function compareSortValues(a, b) {
      const left = columnSortValue(a, sortColumn, 'addresses');
      const right = columnSortValue(b, sortColumn, 'addresses');
      if (left == null && right == null) return 0;
      if (left == null) return 1;
      if (right == null) return -1;
      if (left < right) return -1 * reqSortOrder;
      if (left > right) return reqSortOrder;
      return 0;
    }
    function compareAddresses(a, b) {
      const left = addressToBig(a.ip_address).value;
      const right = addressToBig(b.ip_address).value;
      return left < right ? -1 : left > right ? 1 : 0;
    }

    // `ip` is an address string, or a numeric value when the IPv4 engine
    // below walks the prefix by offset.
    function makeVirtualIpRow(ip) {
      const row = projectVirtualSubnetIpRow(db, subnet, ip, readContext);
      row.subnet_name = subnet.name || subnet.cidr;
      row.dns_record = null;
      row.dhcp = null;
      return row;
    }

    function buildRangeLookup(ranges) {
      // `range_type_*` remains the functional range projection used for DHCP
      // scope and topology behavior. Custom organizational classifications are
      // projected separately by ip-view as `network_range_type*`.
      return ranges
        .filter((range) => range.range_type_is_system)
        .map((r) => ({
          ...r,
          startLong: ipToLong(r.start_ip),
          endLong: ipToLong(r.end_ip),
        }))
        .sort((a, b) => a.startLong - b.startLong);
    }

    function isAvailableIpRow(row) {
      return (row.ip_display_status || 'available') === 'available';
    }

    // Any column any IP table has: the DNS record and DHCP reservation or
    // lease behind each address, and the network it is in.
    function loadPersistedRows() {
      const rows = projectPersistedSubnetIpRows(db, subnet, { context: readContext });
      for (const row of rows) row.subnet_name = subnet.name || subnet.cidr;
      attachDnsFacts(db, rows);
      attachDhcpFacts(db, rows);
      return rows;
    }

    const tableSearch = (req.query.table_search || '').trim().toLowerCase();
    const exactExplorerSearch =
      Boolean(search) && isValidAddress(search) && parsedNetworkContains(parsed, search);
    // Any column of the one IP table model (utils/ip-columns.js), whether to
    // count each column's values for the filter menu, and a column to sort by.
    const parsedFilters = parseColumnFilters(req.query.filters);
    if (parsedFilters.error) return res.status(400).json({ error: parsedFilters.error });
    const columnFilters = parsedFilters.value;
    const wantFacets = req.query.facets === '1' || req.query.facets === 'true';
    const sortColumn = req.query.sort_column;
    if (sortColumn !== undefined && !IP_COLUMNS[sortColumn]) {
      return res.status(400).json({ error: 'sort_column is not a known column' });
    }
    const matchesColumns = (row) => matchesColumnFilters(row, columnFilters, 'addresses');
    const hasExplicitFilters =
      Object.keys(columnFilters).length > 0 ||
      wantFacets ||
      sortColumn !== undefined ||
      [
        'display_status',
        'address_type',
        'online',
        'network_range_type_id',
        'allocation_source_type',
        'scanning_enabled',
      ].some((name) => req.query[name] !== undefined);

    function parseBooleanFilter(name) {
      const value = req.query[name];
      if (value === undefined) return null;
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
      return undefined;
    }

    const onlineFilter = parseBooleanFilter('online');
    const scanningFilter = parseBooleanFilter('scanning_enabled');
    if (onlineFilter === undefined || scanningFilter === undefined) {
      return res.status(400).json({ error: 'Boolean filters must be true, false, 1, or 0' });
    }

    let rangeTypeFilter = null;
    if (req.query.network_range_type_id !== undefined) {
      rangeTypeFilter = Number(req.query.network_range_type_id);
      if (!Number.isInteger(rangeTypeFilter) || rangeTypeFilter < 1) {
        return res.status(400).json({ error: 'network_range_type_id must be a positive integer' });
      }
    }
    const allocationSourceTypeFilter = String(req.query.allocation_source_type || '')
      .trim()
      .toLowerCase();
    if (allocationSourceTypeFilter.length > 64) {
      return res
        .status(400)
        .json({ error: 'allocation_source_type must be at most 64 characters' });
    }

    function matchesSearch(row, query) {
      if (!query) return true;
      return [
        row.ip_address,
        row.hostname,
        row.mac_address,
        row.last_seen_mac,
        row.vendor,
        row.ip_display_status,
        row.address_type,
        row.allocation_state,
        row.allocation_source_type,
        row.network_range_type,
        row.os_family,
        row.device_type,
        row.device_confidence,
        row.dhcp_fingerprint,
        row.dhcp_vendor_class,
        row.dhcp_fingerprint_hostname,
        row.device_fingerprint_source,
        row.scanning_enabled,
      ].some((value) =>
        String(value ?? '')
          .toLowerCase()
          .includes(query),
      );
    }

    const displayStatusFilter = String(req.query.display_status || '').toLowerCase();
    const addressTypeFilter = String(req.query.address_type || '').toLowerCase();
    const rowMatches = (row) => {
      if (!showAvailable && isAvailableIpRow(row)) return false;
      if (!matchesSearch(row, search) || !matchesSearch(row, tableSearch)) return false;
      if (
        displayStatusFilter &&
        String(row.ip_display_status || '').toLowerCase() !== displayStatusFilter
      ) {
        return false;
      }
      if (addressTypeFilter && String(row.address_type || '').toLowerCase() !== addressTypeFilter) {
        return false;
      }
      if (onlineFilter !== null && Boolean(row.is_online) !== onlineFilter) return false;
      if (scanningFilter !== null && Boolean(row.scanning_enabled) !== scanningFilter) return false;
      // Range filters select the user-owned network classification. The
      // functional range projection (DHCP pool, gateway, and so on) remains
      // an independent fact and must not stand in for an organizational tag.
      if (rangeTypeFilter !== null && row.network_range_type_id !== rangeTypeFilter) return false;
      // Protocol ownership is a server-projected canonical fact. Filtering
      // it here avoids reconstructing ownership from record shape in clients.
      if (
        allocationSourceTypeFilter &&
        String(row.allocation_source_type || '').toLowerCase() !== allocationSourceTypeFilter
      ) {
        return false;
      }
      return true;
    };

    // IPv6 networks never materialize rows and are never walked. The listing
    // is the persisted rows plus the protected topology addresses, filtered,
    // sorted and paged in memory.
    if (parsed.family === 6) {
      const pageSize = clampPageSize(req.query.pageSize);
      const rowsByAddress = new Map(loadPersistedRows().map((row) => [row.ip_address, row]));
      const protectedAddresses = [parsed.network];
      if (subnet.gateway_address && parsedNetworkContains(parsed, subnet.gateway_address)) {
        protectedAddresses.push(subnet.gateway_address);
      }
      for (const ip of protectedAddresses) {
        if (!rowsByAddress.has(ip)) rowsByAddress.set(ip, makeVirtualIpRow(ip));
      }
      const base = [...rowsByAddress.values()].filter(rowMatches);
      const facets = wantFacets
        ? columnFacets(
            base.map((row) => ({ row })),
            columnFilters,
            'addresses',
          )
        : undefined;
      const rows = base.filter(matchesColumns);
      if (sortColumn) sortByColumn(rows);
      else sortIps(rows, reqSortField || 'ip_address', reqSortField ? reqSortOrder : 1);
      const filteredTotal = rows.length;
      const totalPages = Math.ceil(filteredTotal / pageSize) || 1;
      const page = Math.min(Math.max(parseInt(req.query.page) || 1, 1), totalPages);
      const start = (page - 1) * pageSize;
      return res.json({
        subnet,
        ips: rows.slice(start, start + pageSize),
        ranges,
        totalIps,
        filteredTotal,
        page,
        pageSize,
        totalPages,
        search,
        table_search: tableSearch,
        sorted: Boolean(reqSortField || sortColumn),
        sparse: true,
        ...facetFields(facets),
      });
    }

    // Workspace filters operate on the canonical projection before pagination.
    // Persisted rows are finite, while virtual rows can cover almost all of an
    // IPv4 prefix. Represent matching virtual rows as intervals so a /8 does not
    // turn into millions of objects merely to answer a filter.
    if (
      tableSearch ||
      hasExplicitFilters ||
      exactExplorerSearch ||
      (reqSortField && reqSortField !== 'ip_address')
    ) {
      const pageSize = clampPageSize(req.query.pageSize);
      const allPersisted = loadPersistedRows();
      const gwLong = subnet.gateway_address ? ipToLong(subnet.gateway_address) : null;
      const basePersisted = allPersisted.filter(rowMatches);
      const matchedPersisted = basePersisted.filter(matchesColumns);
      const persistedLongs = new Set(allPersisted.map((row) => ipToLong(row.ip_address)));

      // Text searches historically search persisted metadata. A synthetically
      // available row is included only when the query is itself one exact IP.
      const searchTerms = [search, tableSearch].filter(Boolean);
      const exactSearchIps = searchTerms.map((term) =>
        isValidIpv4(term) && isIpInSubnet(term, subnet.cidr) ? ipToLong(term) : null,
      );
      const mayMatchVirtual =
        exactExplorerSearch &&
        !tableSearch &&
        searchTerms.every((term, index) =>
          exactSearchIps[index] === null ? false : exactSearchIps[index] === exactSearchIps[0],
        );

      // Segments of identical free addresses. Every one the other filters
      // allow is counted for the filter menu; the page keeps those whose
      // sample also matches the column filters.
      const baseIntervals = [];
      if (!searchTerms.length || mayMatchVirtual) {
        const boundaries = new Set([parsed.networkLong, parsed.broadcastLong + 1]);
        for (const range of ranges) {
          const start = Math.max(parsed.networkLong, ipToLong(range.start_ip));
          const end = Math.min(parsed.broadcastLong, ipToLong(range.end_ip));
          if (start <= end) {
            boundaries.add(start);
            boundaries.add(end + 1);
          }
        }
        if (gwLong !== null) {
          boundaries.add(gwLong);
          boundaries.add(gwLong + 1);
        }
        boundaries.add(parsed.networkLong + 1);
        boundaries.add(parsed.broadcastLong);

        const ordered = [...boundaries]
          .filter((value) => value >= parsed.networkLong && value <= parsed.broadcastLong + 1)
          .sort((a, b) => a - b);
        for (let index = 0; index < ordered.length - 1; index += 1) {
          const segmentStart = ordered[index];
          const segmentEnd = ordered[index + 1] - 1;
          const startLong = searchTerms.length ? exactSearchIps[0] : segmentStart;
          const endLong = searchTerms.length ? exactSearchIps[0] : segmentEnd;
          if (startLong < segmentStart || startLong > segmentEnd) continue;
          const sample = makeVirtualIpRow(startLong);
          enrichIpViewRows(db, [sample]);
          if (rowMatches(sample)) baseIntervals.push({ startLong, endLong, sortRow: sample });
          if (searchTerms.length) break;
        }
      }

      const persistedInIntervals = (intervals) => {
        let count = 0;
        for (const ipLong of persistedLongs) {
          if (
            intervals.some(({ startLong, endLong }) => ipLong >= startLong && ipLong <= endLong)
          ) {
            count += 1;
          }
        }
        return count;
      };
      const virtualIntervals = baseIntervals.filter((interval) => matchesColumns(interval.sortRow));
      const facets = wantFacets
        ? columnFacets(
            [
              ...basePersisted.map((row) => ({ row })),
              ...baseIntervals.map((interval) => ({
                row: interval.sortRow,
                weight:
                  interval.endLong - interval.startLong + 1 - persistedInIntervals([interval]),
              })),
            ],
            columnFilters,
            'addresses',
          )
        : undefined;
      const virtualTotal =
        virtualIntervals.reduce(
          (sum, interval) => sum + interval.endLong - interval.startLong + 1,
          0,
        ) - persistedInIntervals(virtualIntervals);
      const filteredTotal = matchedPersisted.length + virtualTotal;
      const totalPages = Math.ceil(filteredTotal / pageSize) || 1;
      const page = Math.min(Math.max(parseInt(req.query.page) || 1, 1), totalPages);
      const start = (page - 1) * pageSize;

      // IP ordering lets us seek over virtual intervals arithmetically. Other
      // columns have identical null/default values for virtual rows, so use IP
      // as their deterministic tie-breaker and merge only the requested page.
      const entries = matchedPersisted.map((row) => ({
        startLong: ipToLong(row.ip_address),
        endLong: ipToLong(row.ip_address),
        row,
      }));
      for (const interval of virtualIntervals) {
        let cursor = interval.startLong;
        const occupied = [...persistedLongs]
          .filter((value) => value >= interval.startLong && value <= interval.endLong)
          .sort((a, b) => a - b);
        for (const value of occupied) {
          if (cursor < value) {
            entries.push({ startLong: cursor, endLong: value - 1, sortRow: interval.sortRow });
          }
          cursor = value + 1;
        }
        if (cursor <= interval.endLong) {
          entries.push({
            startLong: cursor,
            endLong: interval.endLong,
            sortRow: interval.sortRow,
          });
        }
      }
      const sortField = sortColumn || reqSortField || 'ip_address';
      entries.sort((a, b) => {
        if (sortField === 'ip_address') return (a.startLong - b.startLong) * reqSortOrder;
        if (sortColumn) {
          return (
            compareSortValues(a.row || a.sortRow, b.row || b.sortRow) || a.startLong - b.startLong
          );
        }
        let left = (a.row || a.sortRow)?.[sortField];
        let right = (b.row || b.sortRow)?.[sortField];
        if (typeof left === 'string') left = left.trim() ? left.toLowerCase() : null;
        if (typeof right === 'string') right = right.trim() ? right.toLowerCase() : null;
        if (left == null && right != null) return 1;
        if (left != null && right == null) return -1;
        if (left != null && right != null && left !== right) {
          return (left < right ? -1 : 1) * reqSortOrder;
        }
        return a.startLong - b.startLong;
      });

      const ips = [];
      let skipped = 0;
      for (const entry of entries) {
        const length = entry.endLong - entry.startLong + 1;
        if (skipped + length <= start) {
          skipped += length;
          continue;
        }
        const offset = Math.max(0, start - skipped);
        for (let index = offset; index < length && ips.length < pageSize; index += 1) {
          const descendingIp = sortField === 'ip_address' && reqSortOrder === -1;
          const ipLong = descendingIp ? entry.endLong - index : entry.startLong + index;
          const row = entry.row || makeVirtualIpRow(ipLong);
          if (!entry.row) enrichIpViewRows(db, [row]);
          ips.push(row);
        }
        skipped += length;
        if (ips.length === pageSize) break;
      }
      return res.json({
        subnet,
        ips,
        ranges,
        totalIps,
        filteredTotal,
        page,
        pageSize,
        totalPages,
        search,
        table_search: tableSearch,
        sorted: Boolean(reqSortField || sortColumn),
        ...facetFields(facets),
      });
    }

    // ── Search mode: return only matching persisted IPs (no virtual fill) ──
    if (search) {
      const pageSize = clampPageSize(req.query.pageSize);

      const allPersisted = loadPersistedRows();

      const matched = [];
      for (const ip of allPersisted) {
        if (!showAvailable && isAvailableIpRow(ip)) continue;

        if (
          ip.ip_address.includes(search) ||
          (ip.hostname && ip.hostname.toLowerCase().includes(search)) ||
          (ip.mac_address && ip.mac_address.toLowerCase().includes(search)) ||
          (ip.last_seen_mac && ip.last_seen_mac.toLowerCase().includes(search)) ||
          (ip.vendor && ip.vendor.toLowerCase().includes(search)) ||
          (ip.ip_display_status && ip.ip_display_status.toLowerCase().includes(search)) ||
          (ip.address_type && ip.address_type.toLowerCase().includes(search)) ||
          (ip.allocation_state && ip.allocation_state.toLowerCase().includes(search)) ||
          (ip.allocation_source_type && ip.allocation_source_type.toLowerCase().includes(search)) ||
          (ip.network_range_type && ip.network_range_type.toLowerCase().includes(search)) ||
          (ip.os_family && ip.os_family.toLowerCase().includes(search)) ||
          (ip.device_type && ip.device_type.toLowerCase().includes(search)) ||
          String(ip.device_confidence ?? '').includes(search) ||
          (ip.dhcp_fingerprint && ip.dhcp_fingerprint.includes(search)) ||
          (ip.dhcp_vendor_class && ip.dhcp_vendor_class.toLowerCase().includes(search)) ||
          (ip.dhcp_fingerprint_hostname &&
            ip.dhcp_fingerprint_hostname.toLowerCase().includes(search)) ||
          (ip.device_fingerprint_source && ip.device_fingerprint_source.includes(search)) ||
          String(ip.scanning_enabled).includes(search)
        ) {
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

      return res.json({
        subnet,
        ips,
        ranges,
        totalIps: searchTotal,
        filteredTotal: searchTotal,
        page,
        pageSize,
        totalPages: searchTotalPages,
        search,
      });
    }

    // ── Suppressed-available mode: return occupied and protected rows only ──
    if (!showAvailable) {
      const pageSize = clampPageSize(req.query.pageSize);

      const allPersisted = loadPersistedRows();

      const persistedByLong = new Map(allPersisted.map((ip) => [ipToLong(ip.ip_address), ip]));
      const displayRows = allPersisted.filter((row) => !isAvailableIpRow(row));

      const gwLong = subnet.gateway_address ? ipToLong(subnet.gateway_address) : null;
      const protectedLongs = new Set([parsed.networkLong, parsed.broadcastLong]);
      if (gwLong !== null && gwLong >= parsed.networkLong && gwLong <= parsed.broadcastLong) {
        protectedLongs.add(gwLong);
      }

      for (const ipLong of protectedLongs) {
        if (!persistedByLong.has(ipLong)) {
          const row = makeVirtualIpRow(ipLong);
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

      return res.json({
        subnet,
        ips,
        ranges,
        totalIps: sortedTotal,
        filteredTotal: sortedTotal,
        page,
        pageSize,
        totalPages: sortedTotalPages,
        sorted: true,
      });
    }

    // ── Normal mode: virtual IPs with pagination ──
    // Pagination params
    const pageSize = clampPageSize(req.query.pageSize);
    const totalPages = Math.ceil(totalIps / pageSize);
    const page = Math.min(Math.max(parseInt(req.query.page) || 1, 1), totalPages);

    // Compute IP range for this page
    const pageStartLong = parsed.networkLong + (page - 1) * pageSize;
    const pageEndLong = Math.min(pageStartLong + pageSize - 1, parsed.broadcastLong);

    const allPersisted = loadPersistedRows();

    // Build lookup of persisted IPs by long value, filtering to page range
    const persistedMap = new Map();
    for (const ip of allPersisted) {
      const long = ipToLong(ip.ip_address);
      if (long >= pageStartLong && long <= pageEndLong) {
        persistedMap.set(long, ip);
      }
    }

    // Load ranges for this subnet
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
        // Virtual IP entry, no persisted record
        ips.push(makeVirtualIpRow(ipLong));
      }
    }

    // Shared IP view for all rows on this page
    enrichIpViewRows(db, ips);

    res.json({
      subnet,
      ips,
      ranges,
      totalIps,
      filteredTotal: totalIps,
      page,
      pageSize,
      totalPages,
    });
  }),
);

// GET /api/subnets/:id/ips/:ip: one canonical IP projection without creating a row
router.get(
  '/:id/ips/:ip',
  requirePerm('subnets:read'),
  asyncHandler((req, res) => {
    const db = getDb();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });
    if (!isValidAddress(req.params.ip)) {
      return res.status(400).json({ error: 'Invalid IP address' });
    }

    const ipAddress = subnetAddress(subnet, req.params.ip);
    if (!ipAddress) {
      return res.status(400).json({ error: 'IP address is outside this subnet' });
    }

    res.json({ ip: getCanonicalSubnetIpRow(db, subnet, ipAddress) });
  }),
);

// GET /api/subnets/:id/summary: whole-subnet canonical allocation and liveness counts
router.get(
  '/:id/summary',
  requirePerm('subnets:read'),
  asyncHandler((req, res) => {
    const db = getDb();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

    res.json(summarizeCanonicalSubnetIps(db, subnet));
  }),
);

// Protected topology addresses cannot become operator reservations or be
// released through the administrative reservation endpoint.
function ipAllocationRejectionReason(subnet, ip) {
  const parsed = parseNetwork(subnet.cidr);
  const value = addressToBig(ip).value;
  if (value === parsed.networkBig || (parsed.family === 4 && value === parsed.lastBig)) {
    return parsed.family === 4
      ? 'Network and broadcast allocations are managed by subnet topology'
      : 'The network address is managed by subnet topology';
  }
  if (subnet.gateway_address && addressToBig(subnet.gateway_address).value === value) {
    return 'Gateway allocation is managed by subnet topology';
  }
  return null;
}

// The canonical spelling of an address inside the subnet, or null.
function subnetAddress(subnet, ip) {
  const canonical = typeof ip === 'string' ? canonicalizeIp(ip) : null;
  return canonical && networkContains(subnet.cidr, canonical) ? canonical : null;
}

// PUT /api/subnets/:id/ips/bulk-allocation: reserve or release a range of IPs
router.put(
  '/:id/ips/bulk-allocation',
  requirePerm('subnets:write'),
  asyncHandler((req, res) => {
    const db = getDb();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

    const { start_ip, end_ip, allocation_state, note } = req.body;
    if (!start_ip || !end_ip)
      return res.status(400).json({ error: 'start_ip and end_ip are required' });
    const parsed = parseNetwork(subnet.cidr);
    const startAddress = typeof start_ip === 'string' ? familyAddress(parsed, start_ip) : null;
    const endAddress = typeof end_ip === 'string' ? familyAddress(parsed, end_ip) : null;
    if (startAddress === null)
      return res
        .status(400)
        .json({ error: `start_ip must be a valid IPv${parsed.family} address` });
    if (endAddress === null)
      return res.status(400).json({ error: `end_ip must be a valid IPv${parsed.family} address` });
    if (!['unassigned', 'reserved'].includes(allocation_state)) {
      return res.status(400).json({ error: 'allocation_state must be reserved or unassigned' });
    }
    if (!parsedNetworkContains(parsed, start_ip) || !parsedNetworkContains(parsed, end_ip)) {
      return res.status(400).json({ error: 'IP range must be within the subnet' });
    }
    if (note !== undefined) {
      const err = validateDisplayString(note, { maxLength: 1024 });
      if (err) return res.status(400).json({ error: `note ${err}` });
    }

    if (startAddress > endAddress)
      return res.status(400).json({ error: 'start_ip must be <= end_ip' });
    if (endAddress - startAddress > 1024n)
      return res.status(400).json({ error: 'Range too large (max 1024 IPs)' });

    const reservationNote = allocation_state === 'reserved' ? note || null : null;
    const updated = [];
    const skipped = [];

    const bulkUpdate = db.transaction(() => {
      for (let value = startAddress; value <= endAddress; value++) {
        const ip = bigToAddress(value, parsed.family);
        // Silently skip protected IPs (network/broadcast/gateway) so a bulk
        // "reserve this /24" doesn't fail wholesale on three topology IPs.
        if (ipAllocationRejectionReason(subnet, ip)) {
          skipped.push(ip);
          continue;
        }
        setManualReservation(db, subnet.id, ip, allocation_state === 'reserved', reservationNote);
        updated.push(ip);
      }
    });
    bulkUpdate();

    audit(req.user.id, 'ip_allocation_changed', 'ip_address', subnet.id, {
      start_ip,
      end_ip,
      count: updated.length,
      skipped: skipped.length,
      allocation_state,
      note: reservationNote,
    });
    if (updated.length > 0) req.afterCommit('regenerate_dhcp');
    res.json({
      count: updated.length,
      skipped: skipped.length,
      allocation_state,
      reservation_note: reservationNote,
    });
  }),
);

// PUT /api/subnets/:id/ips/:ip/allocation: reserve or release an IP
router.put(
  '/:id/ips/:ip/allocation',
  requirePerm('subnets:write'),
  asyncHandler((req, res) => {
    const db = getDb();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

    const { allocation_state, note } = req.body;
    if (!isValidAddress(req.params.ip))
      return res.status(400).json({ error: 'Invalid IP address' });
    const ipAddress = subnetAddress(subnet, req.params.ip);
    if (!ipAddress) return res.status(400).json({ error: 'IP address must be within the subnet' });
    if (!['unassigned', 'reserved'].includes(allocation_state)) {
      return res.status(400).json({ error: 'allocation_state must be reserved or unassigned' });
    }
    if (note !== undefined) {
      const err = validateDisplayString(note, { maxLength: 1024 });
      if (err) return res.status(400).json({ error: `note ${err}` });
    }

    const rejection = ipAllocationRejectionReason(subnet, ipAddress);
    if (rejection) return res.status(400).json({ error: rejection });

    const reservationNote = allocation_state === 'reserved' ? note || null : null;

    setManualReservation(
      db,
      subnet.id,
      ipAddress,
      allocation_state === 'reserved',
      reservationNote,
    );

    audit(req.user.id, 'ip_allocation_changed', 'ip_address', subnet.id, {
      ip_address: ipAddress,
      allocation_state,
      note: reservationNote,
    });
    req.afterCommit('regenerate_dhcp');
    res.json({ ip_address: ipAddress, allocation_state, reservation_note: reservationNote });
  }),
);

// PUT /:id/ips/:ip/scan-enabled: set per-IP liveness scan override
router.put(
  '/:id/ips/:ip/scan-enabled',
  requirePerm('subnets:write'),
  asyncHandler((req, res) => {
    const db = getDb();
    const subnet = db.prepare('SELECT * FROM subnets WHERE id = ?').get(req.params.id);
    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

    const { scan_enabled } = req.body;
    if (!isValidAddress(req.params.ip))
      return res.status(400).json({ error: 'Invalid IP address' });
    const ipAddress = subnetAddress(subnet, req.params.ip);
    if (!ipAddress) return res.status(400).json({ error: 'IP address must be within the subnet' });
    if (scan_enabled !== null && typeof scan_enabled !== 'boolean') {
      return res.status(400).json({ error: 'scan_enabled must be boolean or null' });
    }
    const scanEn = scan_enabled === null ? null : scan_enabled ? 1 : 0;

    IpAddress.setScanEnabled(db, subnet.id, ipAddress, scanEn);

    res.json({ ip_address: ipAddress, scan_enabled: scanEn });
  }),
);

// GET /:id/ips/:ip/events: IP lifecycle event history
router.get(
  '/:id/ips/:ip/events',
  requirePerm('subnets:read'),
  asyncHandler((req, res) => {
    const db = getDb();
    const subnet = db.prepare('SELECT id FROM subnets WHERE id = ?').get(req.params.id);
    if (!subnet) return res.status(404).json({ error: 'Subnet not found' });

    const existing = IpAddress.findBySubnetAndIp(db, subnet.id, req.params.ip);
    if (!existing) return res.json({ events: [] });

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
    const events = IpAddress.getEvents(db, existing.id, { limit });
    res.json({ events });
  }),
);

// Error handler for all subnet routes
router.use((err, req, res, _next) => {
  console.error(
    'Subnet route error [%s]:',
    sanitizeForLog(`${req.method} ${req.originalUrl}`),
    err,
  );
  res.status(500).json({ error: err.message || 'Internal server error' });
});

export default router;
