import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { atomicWrite, signalDnsmasq } from './dnsmasq.js';
import { parseCidr, ipToLong, longToIp, isIpInSubnet } from './ip.js';
import { DHCP_OPTIONS_BY_CODE } from './dhcp-options.js';
import { syncLeasesToIps } from './ip-sync.js';
import { generateFallbackHostname } from './mac-vendor.js';
import { regenerateConfigs } from './dnsmasq.js';
import { FALLBACK_SECONDARY_DNS, DHCP_LEASE_WATCH_MS } from '../config/defaults.js';

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Resolve a hostname to an IPv4 address. Returns the IP string, or null on failure.
 * Caches results for the lifetime of a config generation pass.
 */
const dnsCache = new Map();
function resolveToIp(value) {
  if (IPV4_RE.test(value)) return value;
  if (dnsCache.has(value)) return dnsCache.get(value);
  try {
    const out = execFileSync('getent', ['ahostsv4', value], { timeout: 3000, encoding: 'utf-8' });
    const firstLine = out.split('\n')[0];
    const ip = firstLine?.split(/\s+/)[0];
    const result = ip && IPV4_RE.test(ip) ? ip : null;
    dnsCache.set(value, result);
    return result;
  } catch {
    dnsCache.set(value, null);
    return null;
  }
}

const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data');
const CONF_DIR = path.join(DATA_DIR, 'dnsmasq', 'conf.d');
const DHCP_HOSTS_DIR = path.join(DATA_DIR, 'dnsmasq', 'dhcp-hosts.d');
const LEASE_FILE = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.leases');

/**
 * Generate dnsmasq config for a single DHCP scope.
 * Uses tagging so options only apply to the correct scope's range.
 * Merges: scope options > global defaults > legacy columns (fallback).
 */
function generateScopeConfig(scope, globalDefaults, scopeOptions) {
  const tag = `scope${scope.id}`;
  const lines = [];

  lines.push(`# DHCP scope for ${scope.subnet_cidr} (${scope.start_ip} - ${scope.end_ip})`);

  // Build merged options map: global defaults, then scope overrides
  const mergedOptions = new Map();

  // 1. Global defaults
  for (const [code, value] of Object.entries(globalDefaults)) {
    mergedOptions.set(parseInt(code, 10), value);
  }

  // 2. Scope-specific options override globals
  for (const opt of scopeOptions) {
    mergedOptions.set(opt.option_code, opt.value);
  }

  // Option 51 (lease-time) overrides the scope's lease_time in dhcp-range
  // dnsmasq ignores option 51 via dhcp-option — it only uses the dhcp-range lease time
  let leaseTime = scope.lease_time;
  if (mergedOptions.has(51)) {
    leaseTime = `${mergedOptions.get(51)}s`;
    mergedOptions.delete(51);
  }
  lines.push(`dhcp-range=set:${tag},${scope.start_ip},${scope.end_ip},${scope.netmask},${leaseTime}`);

  // 3. Legacy column fallback: only if no scope_options exist for that code
  if (scopeOptions.length === 0) {
    const gw = scope.gateway || scope.subnet_gateway;
    if (gw && !mergedOptions.has(3)) mergedOptions.set(3, gw);
    if (scope.dns_servers && !mergedOptions.has(6)) {
      try {
        const servers = JSON.parse(scope.dns_servers);
        if (Array.isArray(servers) && servers.length > 0) mergedOptions.set(6, servers.join(','));
      } catch { /* skip */ }
    }
    if (scope.domain_name && !mergedOptions.has(15)) mergedOptions.set(15, scope.domain_name);
    if (scope.ntp_servers && !mergedOptions.has(42)) {
      try {
        const servers = JSON.parse(scope.ntp_servers);
        if (Array.isArray(servers) && servers.length > 0) mergedOptions.set(42, servers.join(','));
      } catch { /* skip */ }
    }
    if (scope.domain_search && !mergedOptions.has(119)) mergedOptions.set(119, scope.domain_search);
  }

  // Special handling: if no gateway option set but subnet has one, include it
  if (!mergedOptions.has(3) && scope.subnet_gateway) {
    mergedOptions.set(3, scope.subnet_gateway);
  }

  // Fallback: if no domain name option set, use subnet's domain_name
  if (!mergedOptions.has(15) && scope.subnet_domain_name) {
    mergedOptions.set(15, scope.subnet_domain_name);
  }

  // Fallback: if no domain search list set, use subnet's domain_name
  if (!mergedOptions.has(119) && scope.subnet_domain_name) {
    mergedOptions.set(119, scope.subnet_domain_name);
  }

  // Options handled internally by dnsmasq — don't emit as dhcp-option lines
  // Option 1 (subnet mask): derived from dhcp-range netmask
  // Option 28 (broadcast): auto-computed from network/mask
  mergedOptions.delete(1);
  mergedOptions.delete(28);

  // Emit dhcp-option lines, resolving hostnames to IPs where needed
  for (const [code, value] of mergedOptions) {
    const optDef = DHCP_OPTIONS_BY_CODE[code];
    if (!optDef || !value) continue;
    let emitValue = String(value);
    if (optDef.type === 'ip' || optDef.type === 'ip-list') {
      const parts = emitValue.split(',').map(s => s.trim());
      const resolved = parts.map(p => resolveToIp(p)).filter(Boolean);
      if (resolved.length === 0) continue;  // all failed to resolve
      emitValue = resolved.join(',');
    }
    lines.push(`dhcp-option=tag:${tag},${code},${emitValue}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Regenerate all DHCP scope config files in conf.d/.
 * Clears the DNS resolution cache each pass.
 * Returns true if any file changed (needs SIGHUP).
 */
export function regenerateScopeConfigs(db) {
  dnsCache.clear();
  const scopes = db.prepare(`
    SELECT s.*, r.start_ip, r.end_ip,
      sub.cidr as subnet_cidr, sub.gateway_address as subnet_gateway,
      sub.network_address, sub.prefix_length, sub.domain_name as subnet_domain_name
    FROM dhcp_scopes s
    JOIN ranges r ON s.range_id = r.id
    JOIN subnets sub ON s.subnet_id = sub.id
    WHERE s.enabled = 1
  `).all();

  // Load global defaults
  const defaultRows = db.prepare('SELECT option_code, value FROM dhcp_option_defaults WHERE value IS NOT NULL').all();
  const globalDefaults = Object.fromEntries(defaultRows.map(r => [r.option_code, r.value]));

  // Load all scope options
  const allScopeOptions = db.prepare('SELECT scope_id, option_code, value FROM dhcp_scope_options').all();
  const scopeOptionsMap = new Map();
  for (const opt of allScopeOptions) {
    if (!scopeOptionsMap.has(opt.scope_id)) scopeOptionsMap.set(opt.scope_id, []);
    scopeOptionsMap.get(opt.scope_id).push(opt);
  }

  const activeIds = new Set();
  let changed = false;

  for (const scope of scopes) {
    activeIds.add(scope.id);
    const parsed = parseCidr(scope.subnet_cidr);
    scope.netmask = parsed.mask;

    const filePath = path.join(CONF_DIR, `dhcp-scope-${scope.id}.conf`);
    const scopeOpts = scopeOptionsMap.get(scope.id) || [];
    const newContent = generateScopeConfig(scope, globalDefaults, scopeOpts);

    let oldContent = '';
    try { oldContent = fs.readFileSync(filePath, 'utf-8'); } catch { /* file doesn't exist */ }
    if (newContent !== oldContent) {
      atomicWrite(filePath, newContent);
      changed = true;
    }
  }

  // Clean stale scope config files
  if (fs.existsSync(CONF_DIR)) {
    const pattern = /^dhcp-scope-(\d+)\.conf$/;
    for (const file of fs.readdirSync(CONF_DIR)) {
      const match = file.match(pattern);
      if (match && !activeIds.has(parseInt(match[1], 10))) {
        fs.unlinkSync(path.join(CONF_DIR, file));
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * Regenerate the reservations hosts file for dhcp-hostsdir (hot-reload).
 * Format: <mac>,<ip>[,<hostname>],infinite
 */
export function regenerateReservations(db) {
  const reservations = db.prepare(`
    SELECT * FROM dhcp_reservations WHERE enabled = 1 ORDER BY ip_address
  `).all();

  const lines = reservations.map(r => {
    const parts = [r.mac_address, r.ip_address];
    const hostname = r.hostname || generateFallbackHostname(r.mac_address);
    if (hostname) parts.push(hostname);
    parts.push('infinite');
    return parts.join(',');
  });

  const filePath = path.join(DHCP_HOSTS_DIR, 'reservations.hosts');
  const content = lines.length > 0 ? lines.join('\n') + '\n' : '';

  let oldContent = '';
  try { oldContent = fs.readFileSync(filePath, 'utf-8'); } catch { /* doesn't exist */ }
  const changed = content !== oldContent;
  if (changed) {
    atomicWrite(filePath, content);
  }
  return changed;
}

/**
 * Sync leases from dnsmasq lease file into the database.
 * Lease format: <expiry_epoch> <mac> <ip> <hostname> <client-id>
 */
export function syncLeases(db) {
  let content;
  try {
    content = fs.readFileSync(LEASE_FILE, 'utf-8');
  } catch {
    return { synced: 0 };
  }

  const lines = content.trim().split('\n').filter(l => l.trim());
  const leases = [];

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;

    const [expiryStr, mac, ip, hostname, clientId] = parts;
    const expiry = parseInt(expiryStr, 10);
    const expiresAt = expiry === 0 ? 'infinite' : new Date(expiry * 1000).toISOString();

    // Find matching subnet
    const subnet = db.prepare(`
      SELECT id, cidr FROM subnets WHERE status = 'allocated'
    `).all().find(s => isIpInSubnet(ip, s.cidr));

    leases.push({
      ip,
      mac: mac.toLowerCase(),
      hostname: hostname === '*' ? null : hostname,
      clientId: clientId === '*' ? null : (clientId || null),
      expiresAt,
      subnetId: subnet?.id || null
    });
  }

  // Replace all leases (simple approach — lease file is the source of truth)
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM dhcp_leases').run();
    const insert = db.prepare(`
      INSERT INTO dhcp_leases (ip_address, mac_address, hostname, client_id, expires_at, subnet_id, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    for (const l of leases) {
      insert.run(l.ip, l.mac, l.hostname, l.clientId, l.expiresAt, l.subnetId);
    }
  });

  txn();

  // Generate fallback hostnames for leases without one
  for (const l of leases) {
    if (!l.hostname && l.mac) {
      l.hostname = generateFallbackHostname(l.mac) || null;
    }
  }

  syncLeasesToIps(db, leases);

  // Remove legacy dhcp-leases.hosts (hostnames now managed via dns_records)
  const legacyHostsPath = path.join(DATA_DIR, 'dnsmasq', 'hosts.d', 'dhcp-leases.hosts');
  try { if (fs.existsSync(legacyHostsPath)) fs.unlinkSync(legacyHostsPath); } catch { /* ignore */ }

  // Sync DHCP hostnames (leases + reservations) into dns_records
  syncDhcpDnsRecords(db, leases);

  return { synced: leases.length };
}

/**
 * Sync DHCP lease and reservation hostnames into dns_records table as A records with source='dhcp'.
 * Matches entries to forward DNS zones via the DHCP scope's domain_name or subnet's domain_name.
 * Also cleans up stale DHCP records for IPs no longer in leases/reservations.
 */
function syncDhcpDnsRecords(db, leases) {
  // Build a map of subnet_id -> domain_name from DHCP scopes and subnets
  const scopes = db.prepare(`
    SELECT s.subnet_id, s.domain_name as scope_domain, sub.domain_name as subnet_domain
    FROM dhcp_scopes s
    JOIN subnets sub ON s.subnet_id = sub.id
    WHERE s.enabled = 1
  `).all();

  const subnetDomainMap = new Map();
  for (const s of scopes) {
    const domain = s.scope_domain || s.subnet_domain;
    if (domain) subnetDomainMap.set(s.subnet_id, domain);
  }

  // Merge leases with reservations (reservations take priority for same IP)
  const entries = [...leases];
  const leaseIps = new Set(leases.map(l => l.ip));

  let reservations = [];
  try {
    reservations = db.prepare(`
      SELECT r.ip_address, r.hostname, r.mac_address, r.subnet_id
      FROM dhcp_reservations r
      WHERE r.enabled = 1 AND r.hostname IS NOT NULL AND r.hostname != ''
    `).all();
  } catch (err) {
    console.error('Failed to query DHCP reservations for DNS sync:', err.message);
    return;
  }

  for (const r of reservations) {
    // Only add reservations not already covered by a lease entry
    if (!leaseIps.has(r.ip_address)) {
      entries.push({
        ip: r.ip_address,
        hostname: r.hostname,
        subnetId: r.subnet_id
      });
    }
  }

  // Build a map of zone_name -> zone for forward zones
  const forwardZones = db.prepare("SELECT * FROM dns_zones WHERE type = 'forward' AND enabled = 1").all();
  const zoneByName = new Map();
  for (const z of forwardZones) zoneByName.set(z.name, z);

  // Track which DHCP dns_record IDs are still active
  const activeRecordIds = new Set();
  let configChanged = false;

  const findRecord = db.prepare(`
    SELECT id, source FROM dns_records WHERE zone_id = ? AND name = ? AND type = 'A' AND value = ?
  `);

  const insertDhcp = db.prepare(`
    INSERT INTO dns_records (zone_id, name, type, value, source, enabled)
    VALUES (?, ?, 'A', ?, 'dhcp', 1)
  `);

  const touchDhcp = db.prepare(`
    UPDATE dns_records SET updated_at = datetime('now') WHERE id = ?
  `);

  for (const l of entries) {
    if (!l.hostname || !l.subnetId) continue;

    const domain = subnetDomainMap.get(l.subnetId);
    if (!domain) continue;

    const zone = zoneByName.get(domain);
    if (!zone) continue;

    // Use the hostname as the record name (strip the domain suffix if present)
    let recordName = l.hostname;
    if (recordName.endsWith('.' + domain)) {
      recordName = recordName.slice(0, -(domain.length + 1));
    }

    const existing = findRecord.get(zone.id, recordName, l.ip);
    if (existing) {
      // Don't overwrite manual records; just track DHCP ones as active
      if (existing.source === 'dhcp') {
        touchDhcp.run(existing.id);
        activeRecordIds.add(existing.id);
      }
    } else {
      const result = insertDhcp.run(zone.id, recordName, l.ip);
      activeRecordIds.add(result.lastInsertRowid);
      configChanged = true;
    }
  }

  // Clean up DHCP records that no longer have a matching lease/reservation.
  // Only prune if we actually processed entries — avoids wiping all records
  // when all zones are disabled (activeRecordIds would be empty).
  if (entries.length > 0 || forwardZones.length > 0) {
    const staleRecords = db.prepare("SELECT id FROM dns_records WHERE source = 'dhcp'").all();
    for (const r of staleRecords) {
      if (!activeRecordIds.has(r.id)) {
        db.prepare('DELETE FROM dns_records WHERE id = ?').run(r.id);
        configChanged = true;
      }
    }
  }

  // Regenerate dnsmasq config files if records changed
  if (configChanged) {
    regenerateConfigs(db);
  }
}

/**
 * Orchestrator: regenerate all DHCP configs and sync DNS records.
 */
export function regenerateDhcpConfigs(db) {
  const confChanged = regenerateScopeConfigs(db);
  const resChanged = regenerateReservations(db);
  // Sync DHCP hostnames (leases + reservations) into dns_records
  const leases = db.prepare('SELECT ip_address as ip, hostname, subnet_id as subnetId FROM dhcp_leases WHERE hostname IS NOT NULL').all();
  syncDhcpDnsRecords(db, leases);
  if (confChanged || resChanged) {
    signalDnsmasq();
  }
}

/**
 * Watch the dnsmasq lease file for changes and sync to DB.
 */
let leaseWatcherDb = null;

export function startLeaseWatcher(db) {
  leaseWatcherDb = db;

  // Initial sync
  try { syncLeases(db); } catch (err) {
    console.warn('Initial lease sync failed:', err.message);
  }

  // Watch for changes (poll every 10 seconds since fs.watch can be unreliable)
  try {
    fs.watchFile(LEASE_FILE, { interval: DHCP_LEASE_WATCH_MS }, () => {
      try {
        syncLeases(leaseWatcherDb);
      } catch (err) {
        console.warn('Lease sync error:', err.message);
      }
    });
    console.log('Lease file watcher started:', LEASE_FILE);
  } catch (err) {
    console.warn('Could not watch lease file:', err.message);
  }
}

/**
 * Detect the server's primary IPv4 address and update the DNS Servers
 * global default (option 6) to "<server_ip>, <secondary>".
 * Runs at startup so a host IP change is always reflected.
 */
export function syncServerDnsDefault(db) {
  // Find the first non-internal IPv4 address
  const ifaces = os.networkInterfaces();
  let serverIp = null;
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        serverIp = addr.address;
        break;
      }
    }
    if (serverIp) break;
  }

  if (!serverIp) {
    console.warn('Could not detect server IPv4 address for DNS default');
    return;
  }

  const newValue = `${serverIp},${FALLBACK_SECONDARY_DNS}`;

  const existing = db.prepare('SELECT value FROM dhcp_option_defaults WHERE option_code = 6').get();
  if (existing?.value === newValue) return; // no change

  db.prepare(`
    INSERT INTO dhcp_option_defaults (option_code, value, updated_at)
    VALUES (6, ?, datetime('now'))
    ON CONFLICT(option_code) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(newValue, newValue);

  console.log(`DNS Servers default updated: ${newValue}`);
}
