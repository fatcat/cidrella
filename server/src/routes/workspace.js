import { Router } from 'express';
import { getDb } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { canonicalizeIp } from '../utils/address.js';
import {
  getWorkspaceNetworks,
  getWorkspaceDnsRecords,
  getWorkspaceDhcpAddresses,
} from '../models/workspace-view.js';

const router = Router();

function optionalInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return { value: undefined };
  if (!/^\d+$/.test(String(value))) return { error: `${name} must be an integer` };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return { error: `${name} must be between ${min} and ${max}` };
  }
  return { value: parsed };
}

function optionalBoolean(value, name) {
  if (value === undefined) return { value: undefined };
  if (value === 'true' || value === '1') return { value: true };
  if (value === 'false' || value === '0') return { value: false };
  return { error: `${name} must be true or false` };
}

function optionalText(value, name) {
  if (value === undefined) return { value: undefined };
  if (typeof value !== 'string' || value.length > 256)
    return { error: `${name} must be at most 256 characters` };
  return { value: value.trim() || undefined };
}

function parseCommon(req, { paged = false } = {}) {
  const result = {};
  for (const [queryName, key] of [
    ['subnet_id', 'subnetId'],
    ['folder_id', 'folderId'],
    ['zone_id', 'zoneId'],
    ['scope_id', 'scopeId'],
  ]) {
    const parsed = optionalInteger(req.query[queryName], queryName);
    if (parsed.error) return parsed;
    result[key] = parsed.value;
  }
  for (const [queryName, key] of [
    ['q', 'q'],
    ['table_q', 'tableQ'],
    ['record_type', 'recordType'],
    ['dns_source', 'dnsSource'],
    ['lease_status', 'leaseStatus'],
    ['dhcp_assignment_type', 'assignmentType'],
    ['sort_field', 'sortField'],
  ]) {
    const parsed = optionalText(req.query[queryName], queryName);
    if (parsed.error) return parsed;
    result[key] = parsed.value;
  }
  if (
    result.leaseStatus !== undefined &&
    !['active', 'offline', 'available', 'unavailable'].includes(result.leaseStatus)
  ) {
    return { error: 'lease_status must be active, offline, available, or unavailable' };
  }
  if (
    result.assignmentType !== undefined &&
    !['dynamic', 'reserved'].includes(result.assignmentType)
  ) {
    return { error: 'dhcp_assignment_type must be dynamic or reserved' };
  }
  const enabled = optionalBoolean(req.query.enabled, 'enabled');
  if (enabled.error) return enabled;
  result.enabled = enabled.value;
  // Exact address match, unlike table_q's substring search. The details panel
  // uses it to list what references one pinned address.
  if (req.query.ip_address !== undefined) {
    const ipAddress = canonicalizeIp(String(req.query.ip_address));
    if (!ipAddress) return { error: 'ip_address must be a valid IP address' };
    result.ipAddress = ipAddress;
  }
  if (req.query.sort_order !== undefined && !['asc', 'desc'].includes(req.query.sort_order)) {
    return { error: 'sort_order must be asc or desc' };
  }
  result.sortOrder = req.query.sort_order || 'asc';
  if (paged) {
    const page = optionalInteger(req.query.page ?? '1', 'page');
    const pageSize = optionalInteger(req.query.page_size ?? '50', 'page_size', { max: 512 });
    if (page.error) return page;
    if (pageSize.error) return pageSize;
    result.page = page.value;
    result.pageSize = pageSize.value;
  }
  return { value: result };
}

function contextExists(db, field, id) {
  const definitions = {
    subnetId: [
      'subnets',
      "status = 'allocated' AND NOT EXISTS (SELECT 1 FROM subnets child WHERE child.parent_id = subnets.id)",
    ],
    folderId: ['folders', '1 = 1'],
    zoneId: ['dns_zones', '1 = 1'],
    scopeId: ['dhcp_scopes', '1 = 1'],
  };
  const [table, condition] = definitions[field];
  return Boolean(db.prepare(`SELECT id FROM ${table} WHERE id = ? AND ${condition}`).get(id));
}

function validateContexts(db, query, fields) {
  for (const field of fields) {
    if (query[field] !== undefined && !contextExists(db, field, query[field])) {
      return (
        field.replace(/Id$/, '').replace(/^./, (letter) => letter.toUpperCase()) + ' not found'
      );
    }
  }
  return null;
}

router.get('/networks', requirePerm('subnets:read'), (req, res) => {
  const parsed = parseCommon(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const db = getDb();
  const contextError = validateContexts(db, parsed.value, ['folderId']);
  if (contextError) return res.status(404).json({ error: contextError });
  res.json(getWorkspaceNetworks(db, parsed.value));
});

router.get('/dns-records', requirePerm('dns:read'), (req, res) => {
  const parsed = parseCommon(req, { paged: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const db = getDb();
  const contextError = validateContexts(db, parsed.value, ['subnetId', 'folderId', 'zoneId']);
  if (contextError) return res.status(404).json({ error: contextError });
  res.json(getWorkspaceDnsRecords(db, parsed.value));
});

router.get('/dhcp-addresses', requirePerm('dhcp:read'), (req, res) => {
  const parsed = parseCommon(req, { paged: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const db = getDb();
  const contextError = validateContexts(db, parsed.value, ['subnetId', 'folderId', 'scopeId']);
  if (contextError) return res.status(404).json({ error: contextError });
  res.json(getWorkspaceDhcpAddresses(db, parsed.value));
});

export default router;
