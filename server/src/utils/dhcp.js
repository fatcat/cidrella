import fs from 'fs';
import path from 'path';
import { atomicWrite, signalDnsmasq } from './dnsmasq.js';
import { parseCidr, ipToLong, longToIp, isIpInSubnet } from './ip.js';

const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data');
const CONF_DIR = path.join(DATA_DIR, 'dnsmasq', 'conf.d');
const DHCP_HOSTS_DIR = path.join(DATA_DIR, 'dnsmasq', 'dhcp-hosts.d');
const LEASE_FILE = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.leases');

/**
 * Generate dnsmasq config for a single DHCP scope.
 * Uses tagging so options only apply to the correct scope's range.
 */
function generateScopeConfig(scope) {
  const tag = `scope${scope.id}`;
  const lines = [];

  lines.push(`# DHCP scope for ${scope.subnet_cidr} (${scope.start_ip} - ${scope.end_ip})`);
  lines.push(`dhcp-range=set:${tag},${scope.start_ip},${scope.end_ip},${scope.netmask},${scope.lease_time}`);

  // Gateway option
  const gateway = scope.gateway || scope.subnet_gateway;
  if (gateway) {
    lines.push(`dhcp-option=tag:${tag},option:router,${gateway}`);
  }

  // DNS servers option
  if (scope.dns_servers) {
    try {
      const servers = JSON.parse(scope.dns_servers);
      if (Array.isArray(servers) && servers.length > 0) {
        lines.push(`dhcp-option=tag:${tag},option:dns-server,${servers.join(',')}`);
      }
    } catch { /* skip invalid JSON */ }
  }

  // Domain name option
  if (scope.domain_name) {
    lines.push(`dhcp-option=tag:${tag},option:domain-name,${scope.domain_name}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Regenerate all DHCP scope config files in conf.d/.
 * Returns true if any file changed (needs SIGHUP).
 */
export function regenerateScopeConfigs(db) {
  const scopes = db.prepare(`
    SELECT s.*, r.start_ip, r.end_ip,
      sub.cidr as subnet_cidr, sub.gateway_address as subnet_gateway,
      sub.network_address, sub.prefix_length
    FROM dhcp_scopes s
    JOIN ranges r ON s.range_id = r.id
    JOIN subnets sub ON s.subnet_id = sub.id
    WHERE s.enabled = 1
  `).all();

  const activeIds = new Set();
  let changed = false;

  for (const scope of scopes) {
    activeIds.add(scope.id);
    const parsed = parseCidr(scope.subnet_cidr);
    scope.netmask = parsed.mask;

    const filePath = path.join(CONF_DIR, `dhcp-scope-${scope.id}.conf`);
    const newContent = generateScopeConfig(scope);

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
    if (r.hostname) parts.push(r.hostname);
    parts.push('infinite');
    return parts.join(',');
  });

  const filePath = path.join(DHCP_HOSTS_DIR, 'reservations.hosts');
  const content = lines.length > 0 ? lines.join('\n') + '\n' : '';

  let oldContent = '';
  try { oldContent = fs.readFileSync(filePath, 'utf-8'); } catch { /* doesn't exist */ }
  if (content !== oldContent) {
    atomicWrite(filePath, content);
  }
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
  return { synced: leases.length };
}

/**
 * Orchestrator: regenerate all DHCP configs.
 */
export function regenerateDhcpConfigs(db) {
  const confChanged = regenerateScopeConfigs(db);
  regenerateReservations(db);
  if (confChanged) {
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
    fs.watchFile(LEASE_FILE, { interval: 10000 }, () => {
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
