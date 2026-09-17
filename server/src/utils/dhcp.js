import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  atomicWrite,
  signalDnsmasq,
  restartDnsmasq,
  cleanStaleFiles,
  withValidatedDnsmasqUpdate,
} from './dnsmasq.js';
import {
  parseNetwork,
  ipToLong,
  longToIp,
  addressToBig,
  bigToAddress,
  isValidAddress,
  getServerIpForSubnet,
} from './ip.js';
import { addressFamily, isValidIpv6 } from './address.js';
import { findSubnetForIp } from './ip-sync.js';
import { DHCP_OPTIONS_BY_CODE } from './dhcp-options.js';
import { generateFallbackHostname } from './mac-vendor.js';
import { DATA_DIR, FALLBACK_SECONDARY_DNS, DHCP_LEASE_WATCH_MS } from '../config/defaults.js';
import { validateDnsmasqConfigValue } from './dnsmasq-escape.js';
import { replaceLeases, syncDhcpDnsRecords } from '../models/dhcp-lease.js';
import { upsertServerDnsDefault } from '../models/dhcp-option.js';
import { dhcpLeaseRejectionReason } from '../services/ip-lifecycle-service.js';
import { resolveEffectiveScopeOptions } from '../models/dhcp-scope.js';

/**
 * Resolve a hostname to an address of the wanted family (4 by default).
 * Returns the IP string, or null on failure. Caches results for the lifetime
 * of a config generation pass.
 */
const dnsCache = new Map();
function resolveToIp(value, family = 4) {
  if (isValidAddress(value)) return addressFamily(value) === family ? value : null;
  const key = `${family}|${value}`;
  if (dnsCache.has(key)) return dnsCache.get(key);
  try {
    const database = family === 6 ? 'ahostsv6' : 'ahostsv4';
    const out = execFileSync('getent', [database, value], { timeout: 3000, encoding: 'utf-8' });
    const firstLine = out.split('\n')[0];
    const ip = firstLine?.split(/\s+/)[0];
    const result = ip && isValidAddress(ip) && addressFamily(ip) === family ? ip : null;
    dnsCache.set(key, result);
    return result;
  } catch {
    dnsCache.set(key, null);
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
  const segments = [];
  for (const pool of scope.pools || [{ start_ip: scope.start_ip, end_ip: scope.end_ip }]) {
    const start = ipToLong(pool.start_ip);
    const end = ipToLong(pool.end_ip);
    const excluded = [
      ...new Set(excludedIps.map(ipToLong).filter((value) => value >= start && value <= end)),
    ].sort((a, b) => a - b);
    let cursor = start;
    for (const value of excluded) {
      if (cursor < value) segments.push([cursor, value - 1]);
      cursor = value + 1;
    }
    if (cursor <= end) segments.push([cursor, end]);
  }
  return segments;
}

function generateScopeConfig(
  scope,
  globalDefaults,
  scopeOptions,
  excludedIps = [],
  suppressRouter = false,
) {
  const tag = `scope${scope.id}`;
  const lines = [];

  const pools = scope.pools || [{ start_ip: scope.start_ip, end_ip: scope.end_ip }];
  lines.push(
    `# DHCP scope for ${scope.subnet_cidr} (${pools.map((pool) => `${pool.start_ip} - ${pool.end_ip}`).join(', ')})`,
  );

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
    lines.push(
      `dhcp-range=set:${tag},${longToIp(start)},${longToIp(end)},${scope.netmask},${leaseTime}`,
    );
  }

  // 3. Legacy column fallback: only if no scope_options exist for that code
  if (scopeOptions.length === 0) {
    const gw = scope.gateway || scope.subnet_gateway;
    if (gw && !mergedOptions.has(3)) mergedOptions.set(3, gw);
    if (scope.dns_servers && !mergedOptions.has(6)) {
      try {
        const servers = JSON.parse(scope.dns_servers);
        if (Array.isArray(servers) && servers.length > 0) mergedOptions.set(6, servers.join(','));
      } catch {
        /* skip */
      }
    }
    if (scope.domain_name && !mergedOptions.has(15)) mergedOptions.set(15, scope.domain_name);
    if (scope.ntp_servers && !mergedOptions.has(42)) {
      try {
        const servers = JSON.parse(scope.ntp_servers);
        if (Array.isArray(servers) && servers.length > 0) mergedOptions.set(42, servers.join(','));
      } catch {
        /* skip */
      }
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

  // dnsmasq otherwise supplies its own address as router when option 3 is
  // omitted. An explicit network gateway policy of none must suppress that.
  if (suppressRouter) lines.push(`dhcp-option=tag:${tag},3`);

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
      const parts = emitValue.split(',').map((s) => s.trim());
      const resolved = parts.map((p) => resolveToIp(p)).filter(Boolean);
      if (resolved.length === 0) continue; // all failed to resolve
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

// IPv6 pool segments, reserved addresses carved out, as [start, end] BigInts.
function dynamicRangeSegmentsV6(scope, excludedIps) {
  const segments = [];
  const excluded = [...new Set(excludedIps)]
    .map((ip) => addressToBig(ip))
    .filter((address) => address.family === 6)
    .map((address) => address.value)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const pool of scope.pools) {
    const start = addressToBig(pool.start_ip).value;
    const end = addressToBig(pool.end_ip).value;
    let cursor = start;
    for (const value of excluded) {
      if (value < start || value > end) continue;
      if (cursor < value) segments.push([cursor, value - 1n]);
      cursor = value + 1n;
    }
    if (cursor <= end) segments.push([cursor, end]);
  }
  return segments;
}

// A JSON list of addresses from a scope column, filtered to one family and
// rendered in the bracketed form option6 values take. Hostnames resolve
// through the same cache as the IPv4 options.
function option6AddressList(json, family = 6) {
  if (!json) return null;
  let values;
  try {
    values = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(values)) return null;
  const resolved = values
    .map((value) => resolveToIp(String(value).trim(), family))
    .filter(Boolean)
    .filter((ip) => validateDnsmasqConfigValue(ip) == null);
  return resolved.length ? resolved.map((ip) => `[${ip}]`).join(',') : null;
}

/**
 * dnsmasq config for one DHCPv6 scope. The mode decides what dnsmasq does on
 * the link: `slaac` sends Router Advertisements only, `stateless` adds a
 * stateless DHCPv6 service for options, `stateful` hands out addresses from
 * the pool. Routers are never an option: clients learn them from the RA.
 */
export function generateScopeConfigV6(scope, excludedIps = []) {
  const tag = `scope${scope.id}`;
  const parsed = parseNetwork(scope.subnet_cidr);
  const mode = scope.v6_mode || 'stateful';
  const lines = [`# DHCPv6 scope for ${scope.subnet_cidr} (${mode})`, 'enable-ra'];
  const leaseTime = scope.lease_time;

  if (mode === 'slaac') {
    lines.push(`dhcp-range=set:${tag},${parsed.network},ra-only,${parsed.prefix}`);
  } else if (mode === 'stateless') {
    lines.push(`dhcp-range=set:${tag},${parsed.network},ra-stateless,ra-names,${parsed.prefix}`);
  } else {
    for (const [start, end] of dynamicRangeSegmentsV6(scope, excludedIps)) {
      lines.push(
        `dhcp-range=set:${tag},${bigToAddress(start, 6)},${bigToAddress(end, 6)},${parsed.prefix},${leaseTime}`,
      );
    }
  }

  // Router Advertisement only: dnsmasq answers no DHCPv6 request, so options
  // would never be sent.
  if (mode === 'slaac') return lines.join('\n') + '\n';

  const dnsServers =
    option6AddressList(scope.dns_servers) ||
    (getServerIpForSubnet(scope.subnet_cidr)
      ? `[${getServerIpForSubnet(scope.subnet_cidr)}]`
      : null);
  if (dnsServers) lines.push(`dhcp-option=tag:${tag},option6:dns-server,${dnsServers}`);
  const search = scope.domain_search || scope.domain_name || scope.subnet_domain_name;
  if (search && validateDnsmasqConfigValue(search, { allowComma: true }) == null) {
    lines.push(`dhcp-option=tag:${tag},option6:domain-search,${search}`);
  }
  const ntp = option6AddressList(scope.ntp_servers);
  if (ntp) lines.push(`dhcp-option=tag:${tag},option6:ntp-server,${ntp}`);

  return lines.join('\n') + '\n';
}

/**
 * Regenerate all DHCP scope config files in conf.d/.
 * Clears the DNS resolution cache each pass.
 * Returns true if any file changed (needs dnsmasq restart).
 */
export function regenerateScopeConfigs(db, { confDir = CONF_DIR } = {}) {
  dnsCache.clear();
  const scopes = db
    .prepare(
      `
    SELECT s.*, r.start_ip, r.end_ip,
      sub.cidr as subnet_cidr, sub.gateway_address as subnet_gateway,
      sub.network_address, sub.prefix_length, sub.domain_name as subnet_domain_name
    FROM dhcp_scopes s
    JOIN ranges r ON s.range_id = r.id
    JOIN subnets sub ON s.subnet_id = sub.id
    WHERE s.enabled = 1 AND sub.status = 'allocated'
  `,
    )
    .all();

  const reservedBySubnet = new Map();
  const reservedRows = db
    .prepare(
      `
    SELECT subnet_id, ip_address
    FROM ip_addresses
    WHERE allocation_state = 'reserved'
  `,
    )
    .all();
  for (const row of reservedRows) {
    if (!reservedBySubnet.has(row.subnet_id)) reservedBySubnet.set(row.subnet_id, []);
    reservedBySubnet.get(row.subnet_id).push(row.ip_address);
  }

  const activeIds = new Set();
  let changed = false;

  for (const scope of scopes) {
    activeIds.add(scope.id);
    const parsed = parseNetwork(scope.subnet_cidr);
    scope.netmask = parsed.mask;
    scope.pools = db
      .prepare(
        `
      SELECT start_ip, end_ip FROM dhcp_scope_pools
      WHERE scope_id = ? ORDER BY sort_order, id
    `,
      )
      .all(scope.id);

    const filePath = path.join(confDir, `dhcp-scope-${scope.id}.conf`);
    const effective = resolveEffectiveScopeOptions(db, scope);
    scope.lease_time = effective.lease_time;
    const newContent =
      parsed.family === 6
        ? generateScopeConfigV6(scope, reservedBySubnet.get(scope.subnet_id) || [])
        : generateScopeConfig(
            scope,
            {},
            effective.options,
            reservedBySubnet.get(scope.subnet_id) || [],
            effective.router_suppressed,
          );

    let oldContent = '';
    try {
      oldContent = fs.readFileSync(filePath, 'utf-8');
    } catch {
      /* file doesn't exist */
    }
    if (newContent !== oldContent) {
      atomicWrite(filePath, newContent);
      changed = true;
    }
  }

  // Clean stale scope config files
  if (cleanStaleFiles(confDir, 'dhcp-scope-', '.conf', activeIds)) changed = true;

  return changed;
}

/**
 * Regenerate the reservations hosts file for dhcp-hostsdir (hot-reload).
 * DHCPv4: <mac>,<ip>[,<hostname>],infinite
 * DHCPv6: id:<duid>,[<ip>][,<hostname>],infinite
 */
export function regenerateReservations(db, { hostsDir = DHCP_HOSTS_DIR } = {}) {
  const reservations = db
    .prepare(
      `
    SELECT r.* FROM dhcp_reservations r
    JOIN subnets sub ON sub.id = r.subnet_id
    WHERE r.enabled = 1 AND sub.status = 'allocated' ORDER BY r.ip_address
  `,
    )
    .all();

  const lines = reservations
    .map((r) => {
      const v6 = r.address_family === 6;
      if (v6 && (!r.duid || !isValidIpv6(r.ip_address))) return null;
      const parts = v6 ? [`id:${r.duid}`, `[${r.ip_address}]`] : [r.mac_address, r.ip_address];
      const hostname = r.hostname || (r.mac_address ? generateFallbackHostname(r.mac_address) : null);
      if (hostname) parts.push(hostname);
      parts.push('infinite');
      return parts.join(',');
    })
    .filter(Boolean);

  const filePath = path.join(hostsDir, 'reservations.hosts');
  const content = lines.length > 0 ? lines.join('\n') + '\n' : '';

  let oldContent = '';
  try {
    oldContent = fs.readFileSync(filePath, 'utf-8');
  } catch {
    /* doesn't exist */
  }
  const changed = content !== oldContent;
  if (changed) {
    atomicWrite(filePath, content);
  }
  return changed;
}

/**
 * One dnsmasq lease-file line as a lease object, or null for lines that are
 * not leases (the `duid <server-duid>` header, blank or truncated lines).
 *
 * DHCPv4: <expiry> <mac> <ip> <hostname|*> <client-id|*>
 * DHCPv6: <expiry> [T]<iaid> <ip6> <hostname|*> <client-duid|*>
 *   A leading T marks a temporary (IA_TA) address. The IAID is decimal.
 */
export function parseLeaseLine(line) {
  const parts = String(line || '')
    .trim()
    .split(/\s+/);
  if (parts.length < 4 || parts[0] === 'duid') return null;
  const [expiryStr, identity, ip, hostname, clientId] = parts;
  if (!/^\d+$/.test(expiryStr) || !isValidAddress(ip)) return null;
  const expiry = parseInt(expiryStr, 10);
  const base = {
    ip,
    hostname: hostname === '*' ? null : hostname,
    clientId: clientId === '*' ? null : clientId || null,
    expiresAt: expiry === 0 ? 'infinite' : new Date(expiry * 1000).toISOString(),
  };
  if (isValidIpv6(ip)) {
    const iaidMatch = /^(T?)(\d+)$/.exec(identity);
    if (!iaidMatch) return null;
    return {
      ...base,
      dhcpVersion: 6,
      mac: null,
      iaid: Number(iaidMatch[2]),
      temporary: iaidMatch[1] === 'T',
      duid: base.clientId ? base.clientId.toLowerCase() : null,
    };
  }
  return { ...base, dhcpVersion: 4, mac: identity.toLowerCase(), duid: null, iaid: null };
}

/**
 * Sync leases from dnsmasq lease file into the database.
 */
export function syncLeases(db, { leaseFile = LEASE_FILE } = {}) {
  let content;
  try {
    content = fs.readFileSync(leaseFile, 'utf-8');
  } catch {
    return { synced: 0 };
  }

  const leases = [];
  for (const line of content.split('\n')) {
    const lease = parseLeaseLine(line);
    if (!lease) continue;
    // A DHCPv6 lease without a client DUID has no identity CIDRella can act on.
    if (lease.dhcpVersion === 6 && !lease.duid) continue;
    let subnet;
    try {
      subnet = findSubnetForIp(db, lease.ip);
    } catch {
      subnet = null;
    }
    leases.push({ ...lease, subnetId: subnet?.status === 'allocated' ? subnet.id : null });
  }

  // Persist the effective hostname used by DNS/IP sync. dnsmasq writes '*'
  // when a client does not provide one; keep CIDRella's generated fallback in
  // dhcp_leases too so later DHCP config regenerations do not treat the
  // DHCP-sourced DNS record as stale. DHCPv6 clients have no MAC to look up.
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
  try {
    if (fs.existsSync(legacyHostsPath)) fs.unlinkSync(legacyHostsPath);
  } catch {
    /* ignore */
  }

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
  const leases = db
    .prepare(
      'SELECT ip_address as ip, hostname, mac_address as mac, subnet_id as subnetId FROM dhcp_leases',
    )
    .all()
    .map((l) => ({
      ...l,
      hostname: l.hostname || (l.mac ? generateFallbackHostname(l.mac) : null),
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
  try {
    syncLeases(db);
  } catch (err) {
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
