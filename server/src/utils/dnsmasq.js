import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { parseCidr } from './ip.js';
import { getSetting } from '../db/init.js';
import { isProxyBypassed } from './geoip.js';

const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data');
const HOSTS_DIR = path.join(DATA_DIR, 'dnsmasq', 'hosts.d');
const CONF_DIR = path.join(DATA_DIR, 'dnsmasq', 'conf.d');
const DNSMASQ_CONF = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.conf');

export function atomicWrite(filePath, content) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function cleanStaleFiles(dir, prefix, suffix, activeIds) {
  if (!fs.existsSync(dir)) return false;
  let removed = false;
  const pattern = new RegExp(`^${prefix}(\\d+)${suffix.replace('.', '\\.')}$`);
  for (const file of fs.readdirSync(dir)) {
    const match = file.match(pattern);
    if (match && !activeIds.has(parseInt(match[1], 10))) {
      fs.unlinkSync(path.join(dir, file));
      removed = true;
    }
  }
  return removed;
}

function toFqdn(recordName, zoneName) {
  return recordName === '@' ? zoneName : `${recordName}.${zoneName}`;
}

export function generateReverseName(cidr) {
  return generateReverseNames(cidr)[0];
}

/**
 * Generate all /24 reverse zone names for a CIDR.
 * Networks /24+ → 1 zone, /17-/23 → multiple /24 zones, /16 → /16 zone, etc.
 */
export function generateReverseNames(cidr) {
  const parsed = parseCidr(cidr);
  const octets = parsed.network.split('.').map(Number);

  if (parsed.prefix >= 24) {
    return [`${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`];
  } else if (parsed.prefix >= 17) {
    // Split into individual /24 zones
    const numBlocks = 1 << (24 - parsed.prefix);
    const zones = [];
    for (let i = 0; i < numBlocks; i++) {
      zones.push(`${octets[2] + i}.${octets[1]}.${octets[0]}.in-addr.arpa`);
    }
    return zones;
  } else if (parsed.prefix >= 16) {
    return [`${octets[1]}.${octets[0]}.in-addr.arpa`];
  } else if (parsed.prefix >= 8) {
    return [`${octets[0]}.in-addr.arpa`];
  }
  return [`${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`];
}

export function regenerateHostsDir(db) {
  const zones = db.prepare(`
    SELECT z.id, z.name FROM dns_zones z WHERE z.enabled = 1
  `).all();

  const activeIds = new Set();
  let changed = false;

  for (const zone of zones) {
    const records = db.prepare(`
      SELECT name, value FROM dns_records
      WHERE zone_id = ? AND type = 'A' AND enabled = 1
    `).all(zone.id);

    if (records.length === 0) continue;

    activeIds.add(zone.id);
    const filePath = path.join(HOSTS_DIR, `zone-${zone.id}.hosts`);
    const newContent = records.map(r => `${r.value} ${toFqdn(r.name, zone.name)}`).join('\n') + '\n';
    let oldContent = '';
    try { oldContent = fs.readFileSync(filePath, 'utf-8'); } catch { /* doesn't exist */ }
    if (newContent !== oldContent) {
      atomicWrite(filePath, newContent);
      changed = true;
    }
  }

  if (cleanStaleFiles(HOSTS_DIR, 'zone-', '.hosts', activeIds)) changed = true;
  return changed;
}

export function regenerateConfDir(db) {
  const zones = db.prepare(`
    SELECT z.* FROM dns_zones z WHERE z.enabled = 1
  `).all();

  const activeIds = new Set();
  let changed = false;

  for (const zone of zones) {
    const records = db.prepare(`
      SELECT name, type, value, priority, weight, port, ttl FROM dns_records
      WHERE zone_id = ? AND type NOT IN ('A', 'PTR') AND enabled = 1
    `).all(zone.id);

    // PTR records with hostname values (not bare IPs) generate ptr-record= lines
    const ptrRecords = db.prepare(`
      SELECT name, value FROM dns_records
      WHERE zone_id = ? AND type = 'PTR' AND enabled = 1 AND value LIKE '%.%' AND value NOT GLOB '[0-9]*.[0-9]*.[0-9]*.[0-9]*'
    `).all(zone.id);

    if (records.length === 0 && ptrRecords.length === 0) continue;

    activeIds.add(zone.id);
    const lines = [];

    // SOA comment for documentation
    if (zone.soa_primary_ns) {
      lines.push(`# SOA: ${zone.soa_primary_ns} ${zone.soa_admin_email} ${zone.soa_serial || 1} ${zone.soa_refresh} ${zone.soa_retry} ${zone.soa_expire} ${zone.soa_minimum_ttl}`);
    }

    for (const r of records) {
      const fqdn = toFqdn(r.name, zone.name);
      switch (r.type) {
        case 'CNAME':
          // dnsmasq cname supports TTL as third parameter
          lines.push(`cname=${fqdn},${r.value}${r.ttl ? ',' + r.ttl : ''}`);
          break;
        case 'MX':
          lines.push(`mx-host=${fqdn},${r.value},${r.priority || 10}`);
          break;
        case 'TXT':
          lines.push(`txt-record=${fqdn},"${r.value.replace(/"/g, '\\"')}"`);
          break;
        case 'SRV':
          lines.push(`srv-host=${fqdn},${r.value},${r.port},${r.priority || 0},${r.weight || 0}`);
          break;
      }
    }

    // PTR records: ptr-record=<octet>.<zone>,<hostname>
    for (const ptr of ptrRecords) {
      lines.push(`ptr-record=${ptr.name}.${zone.name},${ptr.value}`);
    }

    const filePath = path.join(CONF_DIR, `zone-${zone.id}.conf`);
    const newContent = lines.join('\n') + '\n';

    // Check if content actually changed
    let oldContent = '';
    try { oldContent = fs.readFileSync(filePath, 'utf-8'); } catch { /* file doesn't exist */ }
    if (newContent !== oldContent) {
      atomicWrite(filePath, newContent);
      changed = true;
    }
  }

  // Clean stale files
  if (fs.existsSync(CONF_DIR)) {
    const pattern = /^zone-(\d+)\.conf$/;
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

export function regenerateDnsmasqConf(db) {
  if (!fs.existsSync(DNSMASQ_CONF)) return;

  let servers = getSetting('dns_upstream_servers');

  // If GeoIP proxy is enabled, route through local proxy instead of direct upstream
  const geoipEnabled = getSetting('geoip_enabled');
  const geoipPort = getSetting('geoip_proxy_port');
  if (geoipEnabled === 'true' && geoipPort && !isProxyBypassed()) {
    servers = [`127.0.0.1#${geoipPort}`];
  }

  const content = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
  const lines = content.split('\n');
  const filtered = lines.filter(line => !line.match(/^server=/));

  // Insert server lines after no-resolv or at the start
  const noResolvIdx = filtered.findIndex(l => l.trim() === 'no-resolv');
  const insertIdx = noResolvIdx >= 0 ? noResolvIdx + 1 : 0;
  const serverLines = servers.map(s => `server=${s}`);
  filtered.splice(insertIdx, 0, ...serverLines);

  atomicWrite(DNSMASQ_CONF, filtered.join('\n'));
}

const DNSMASQ_PID = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.pid');

export function signalDnsmasq() {
  try {
    const pid = parseInt(fs.readFileSync(DNSMASQ_PID, 'utf-8').trim(), 10);
    if (pid) execFileSync('sudo', ['kill', '-HUP', String(pid)]);
  } catch {
    console.warn('Could not send SIGHUP to dnsmasq (may not be running)');
  }
}

export function restartDnsmasq() {
  try {
    // Native installs: use systemctl
    execFileSync('sudo', ['systemctl', 'restart', 'cidrella-dnsmasq'], { stdio: 'pipe' });
    console.log('dnsmasq restarted via systemctl');
    return;
  } catch {
    console.warn('systemctl restart failed, falling back to PID method');
  }

  try {
    // Docker / other: kill the process and let the supervisor restart it
    execFileSync('sudo', ['pkill', '-TERM', '-x', 'dnsmasq'], { stdio: 'pipe' });
    console.log('dnsmasq terminated (supervisor will restart)');
  } catch {
    console.warn('Could not restart dnsmasq');
  }
}

export function applyInterfaceConfig(db) {
  if (!fs.existsSync(DNSMASQ_CONF)) return;

  const content = fs.readFileSync(DNSMASQ_CONF, 'utf-8');
  const lines = content.split('\n');

  // Strip existing interface-related directives (not comments)
  const filtered = lines.filter(line => {
    if (line.startsWith('#')) return true;
    if (/^listen-address=/.test(line)) return false;
    if (/^interface=/.test(line)) return false;
    if (/^no-dhcp-interface=/.test(line)) return false;
    if (/^bind-dynamic$/.test(line)) return false;
    if (/^port=0$/.test(line)) return false;
    return true;
  });

  // Read settings
  let ifaceConfig = {};
  let dnsEnabled = true;
  let dhcpEnabled = true;

  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'interface_config'").get();
    if (row?.value) ifaceConfig = JSON.parse(row.value);
  } catch { /* use default */ }

  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'dns_enabled'").get();
    if (row?.value === 'false') dnsEnabled = false;
  } catch { /* use default */ }

  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'dhcp_enabled'").get();
    if (row?.value === 'false') dhcpEnabled = false;
  } catch { /* use default */ }

  // Enumerate current system interfaces for IP lookup
  const sysIfaces = os.networkInterfaces();

  // bind-dynamic allows mixing interface= and listen-address= directives
  // and handles interfaces that may appear/disappear
  const newDirectives = ['bind-dynamic', 'listen-address=127.0.0.1'];
  if (sysIfaces.lo?.some(a => a.family === 'IPv6')) {
    newDirectives.push('listen-address=::1');
  }
  const hasExplicitConfig = Object.keys(ifaceConfig).length > 0;

  if (hasExplicitConfig) {
    // User has configured specific interfaces — use those.
    // Every active interface gets interface= so dnsmasq listens on it
    // (bind-dynamic restricts to interface= list when any are present).
    // no-dhcp-interface= selectively disables DHCP per interface.
    for (const [ifName, cfg] of Object.entries(ifaceConfig)) {
      if (!cfg.dns && !cfg.dhcp) continue;

      const addrs = sysIfaces[ifName];
      if (addrs) {
        for (const addr of addrs) {
          if (addr.family === 'IPv4') {
            newDirectives.push(`listen-address=${addr.address}`);
          }
        }
      }

      newDirectives.push(`interface=${ifName}`);
      if (!cfg.dhcp || !dhcpEnabled) {
        newDirectives.push(`no-dhcp-interface=${ifName}`);
      }
    }
  } else {
    // No interface config yet (fresh deploy) — listen on all real interfaces
    for (const [ifName, addrs] of Object.entries(sysIfaces)) {
      if (ifName === 'lo') continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4') {
          newDirectives.push(`listen-address=${addr.address}`);
        }
      }
      if (dhcpEnabled) {
        newDirectives.push(`interface=${ifName}`);
      } else {
        newDirectives.push(`no-dhcp-interface=${ifName}`);
      }
    }
  }

  // Global DNS off → port=0
  if (!dnsEnabled) {
    newDirectives.push('port=0');
  }

  // Append directives at the end
  filtered.push(...newDirectives);

  atomicWrite(DNSMASQ_CONF, filtered.join('\n'));
}

export function regenerateConfigs(db) {
  const hostsChanged = regenerateHostsDir(db);
  const confChanged = regenerateConfDir(db);
  if (hostsChanged || confChanged) {
    signalDnsmasq();
  }
}
