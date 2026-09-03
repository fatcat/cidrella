import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  atomicWrite,
  signalDnsmasq,
  restartDnsmasq,
  cleanStaleFiles,
  withValidatedDnsmasqUpdate
} from './dnsmasq.js';
import { parseCidr, isIpInSubnet, ipToLong, longToIp } from './ip.js';
import { DHCP_OPTIONS_BY_CODE } from './dhcp-options.js';
import { generateFallbackHostname } from './mac-vendor.js';
import { DATA_DIR, FALLBACK_SECONDARY_DNS, DHCP_LEASE_WATCH_MS } from '../config/defaults.js';
import { isValidIpv4 } from './ip.js';
import { validateDnsmasqConfigValue } from './dnsmasq-escape.js';
import { replaceLeases, syncDhcpDnsRecords } from '../models/dhcp-lease.js';
import { upsertServerDnsDefault } from '../models/dhcp-option.js';
import { dhcpLeaseRejectionReason } from '../services/ip-lifecycle-service.js';

/**
 * Resolve a hostname to an IPv4 address. Returns the IP string, or null on failure.
 * Caches results for the lifetime of a config generation pass.
 */
const dnsCache = new Map();
function resolveToIp(value) {
  if (isValidIpv4(value)) return value;
  if (dnsCache.has(value)) return dnsCache.get(value);
  try {
    const out = execFileSync('getent', ['ahostsv4', value], { timeout: 3000, encoding: 'utf-8' });
    const firstLine = out.split('\n')[0];
    const ip = firstLine?.split(/\s+/)[0];
    const result = ip && isValidIpv4(ip) ? ip : null;
    dnsCache.set(value, result);
    return result;
  } catch {
    dnsCache.set(value, null);
    return null;
  }
}
const CONF_DIR = path.join(DATA_DIR, 'dnsmasq', 'conf.d');
const DHCP_HOSTS_DIR = path.join(DATA_DIR, 'dnsmasq', 'dhcp-hosts.d');
const LEASE_FILE = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.leases');

/**
 * Generate dnsmasq config for a single DHCP scope.
 * Uses tagging so options only apply to the correct scope's range.
 * Merges: scope options > global defaults > legacy columns (fallback).
 */
function dynamicRangeSegments(scope, excludedIps) {
  const start = ipToLong(scope.start_ip);
  const end = ipToLong(scope.end_ip);
  const excluded = [...new Set(excludedIps
    .map(ipToLong)
    .filter(value => value >= start && value <= end))].sort((a, b) => a - b);
  const segments = [];
  let cursor = start;
  for (const value of excluded) {
    if (cursor < value) segments.push([cursor, value - 1]);
    cursor = value + 1;
  }
  if (cursor <= end) segments.push([cursor, end]);
  return segments;
}

function generateScopeConfig(scope, globalDefaults, scopeOptions, excludedIps = []) {
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
  // dnsmasq ignores option 51 via dhcp-option, it only uses the dhcp-range lease time
  let leaseTime = scope.lease_time;
  if (mergedOptions.has(51)) {
    leaseTime = `${mergedOptions.get(51)}s`;
    mergedOptions.delete(51);
  }
  for (const [start, end] of dynamicRangeSegments(scope, excludedIps)) {
    lines.push(`dhcp-range=set:${tag},${longToIp(start)},${longToIp(end)},${scope.netmask},${leaseTime}`);
  }

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

  // Options handled internally by dnsmasq, don't emit as dhcp-option lines
  // Option 1 (subnet mask): derived from dhcp-range netmask
  // Option 28 (broadcast): auto-computed from network/mask
  mergedOptions.delete(1);
  mergedOptions.delete(28);

  // Emit dhcp-option lines, resolving hostnames to IPs where needed.
  // C3 fix: refuse to emit any option whose value would inject a directive
  // (newlines, =, or commas for non-list types). Skipping silently is
  // safer than crashing the whole regen; a bad row from a pre-v0.4.15
  // install won't be honored, but the scope still comes up.
  for (const [code, value] of mergedOptions) {
    const optDef = DHCP_OPTIONS_BY_CODE[code];
    if (!optDef || !value) continue;
    let emitValue = String(value);
    if (optDef.type === 'ip' || optDef.type === 'ip-list') {
      const parts = emitValue.split(',').map(s => s.trim());
      const resolved = parts.map(p => resolveToIp(p)).filter(Boolean);
      if (resolved.length === 0) continue;  // all failed to resolve
      emitValue = resolved.join(',');
      if (validateDnsmasqConfigValue(emitValue, { allowComma: true }) != null) continue;
    } else if (optDef.type === 'text-list') {
      if (validateDnsmasqConfigValue(emitValue, { allowComma: true }) != null) continue;
    } else {
      if (validateDnsmasqConfigValue(emitValue) != null) continue;
    }
    lines.push(`dhcp-option=tag:${tag},${code},${emitValue}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Regenerate all DHCP scope config files in conf.d/.
 * Clears the DNS resolution cache each pass.
 * Returns true if any file changed (needs dnsmasq restart).
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

  const reservedBySubnet = new Map();
  const reservedRows = db.prepare(`
    SELECT subnet_id, ip_address
    FROM ip_addresses
    WHERE allocation_state = 'reserved' OR status = 'locked'
  `).all();
  for (const row of reservedRows) {
    if (!reservedBySubnet.has(row.subnet_id)) reservedBySubnet.set(row.subnet_id, []);
    reservedBySubnet.get(row.subnet_id).push(row.ip_address);
  }

  const activeIds = new Set();
  let changed = false;

  for (const scope of scopes) {
    activeIds.add(scope.id);
    const parsed = parseCidr(scope.subnet_cidr);
    scope.netmask = parsed.mask;

    const filePath = path.join(CONF_DIR, `dhcp-scope-${scope.id}.conf`);
    const scopeOpts = scopeOptionsMap.get(scope.id) || [];
    const newContent = generateScopeConfig(
      scope, globalDefaults, scopeOpts, reservedBySubnet.get(scope.subnet_id) || []
    );

    let oldContent = '';
    try { oldContent = fs.readFileSync(filePath, 'utf-8'); } catch { /* file doesn't exist */ }
    if (newContent !== oldContent) {
      atomicWrite(filePath, newContent);
      changed = true;
    }
  }

  // Clean stale scope config files
  if (cleanStaleFiles(CONF_DIR, 'dhcp-scope-', '.conf', activeIds)) changed = true;

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

  // Load allocated subnets once before the loop to avoid N+1 queries
  const allocatedSubnets = db.prepare("SELECT id, cidr FROM subnets WHERE status = 'allocated'").all();

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;

    const [expiryStr, mac, ip, hostname, clientId] = parts;
    const expiry = parseInt(expiryStr, 10);
    const expiresAt = expiry === 0 ? 'infinite' : new Date(expiry * 1000).toISOString();

    // Find matching subnet (using pre-loaded list)
    const subnet = allocatedSubnets.find(s => isIpInSubnet(ip, s.cidr));

    leases.push({
      ip,
      mac: mac.toLowerCase(),
      hostname: hostname === '*' ? null : hostname,
      clientId: clientId === '*' ? null : (clientId || null),
      expiresAt,
      subnetId: subnet?.id || null
    });
  }

  // Persist the effective hostname used by DNS/IP sync. dnsmasq writes '*'
  // when a client does not provide one; keep CIDRella's generated fallback in
  // dhcp_leases too so later DHCP config regenerations do not treat the
  // DHCP-sourced DNS record as stale.
  for (const l of leases) {
    if (!l.hostname && l.mac) {
      l.hostname = generateFallbackHostname(l.mac) || null;
    }
  }

  const acceptedLeases = [];
  let rejected = 0;
  for (const lease of leases) {
    const rejection = dhcpLeaseRejectionReason(db, lease);
    if (rejection) {
      rejected++;
      console.warn(`Rejected lease ${lease.ip}: ${rejection}`);
    } else {
      acceptedLeases.push(lease);
    }
  }

  replaceLeases(db, acceptedLeases, { lifecycleValidated: true });

  // Remove legacy dhcp-leases.hosts (hostnames now managed via dns_records)
  const legacyHostsPath = path.join(DATA_DIR, 'dnsmasq', 'hosts.d', 'dhcp-leases.hosts');
  try { if (fs.existsSync(legacyHostsPath)) fs.unlinkSync(legacyHostsPath); } catch { /* ignore */ }

  // Sync DHCP hostnames (leases + reservations) into dns_records
  syncDhcpDnsRecords(db, acceptedLeases);

  return { synced: acceptedLeases.length, rejected };
}

/**
 * Orchestrator: regenerate all DHCP configs and sync DNS records.
 */
export function regenerateDhcpConfigs(db) {
  const { confChanged, resChanged } = withValidatedDnsmasqUpdate(() => {
    const confChanged = regenerateScopeConfigs(db);
    const resChanged = regenerateReservations(db);
    return { confChanged, resChanged, changed: confChanged || resChanged };
  });
  // Sync DHCP hostnames (leases + reservations) into dns_records
  const leases = db.prepare('SELECT ip_address as ip, hostname, mac_address as mac, subnet_id as subnetId FROM dhcp_leases').all()
    .map(l => ({
      ...l,
      hostname: l.hostname || (l.mac ? generateFallbackHostname(l.mac) : null)
    }));
  syncDhcpDnsRecords(db, leases);
  if (confChanged) {
    restartDnsmasq();
  } else if (resChanged) {
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

  if (upsertServerDnsDefault(db, newValue)) {
    console.log(`DNS Servers default updated: ${newValue}`);
  }
}

export { syncDhcpDnsRecords };
