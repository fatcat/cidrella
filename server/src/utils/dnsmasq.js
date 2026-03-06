import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { parseCidr } from './ip.js';

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
  if (!fs.existsSync(dir)) return;
  const pattern = new RegExp(`^${prefix}(\\d+)${suffix.replace('.', '\\.')}$`);
  for (const file of fs.readdirSync(dir)) {
    const match = file.match(pattern);
    if (match && !activeIds.has(parseInt(match[1], 10))) {
      fs.unlinkSync(path.join(dir, file));
    }
  }
}

function toFqdn(recordName, zoneName) {
  return recordName === '@' ? zoneName : `${recordName}.${zoneName}`;
}

export function generateReverseName(cidr) {
  const parsed = parseCidr(cidr);
  const octets = parsed.network.split('.');

  if (parsed.prefix >= 24) {
    return `${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`;
  } else if (parsed.prefix >= 16) {
    return `${octets[1]}.${octets[0]}.in-addr.arpa`;
  } else if (parsed.prefix >= 8) {
    return `${octets[0]}.in-addr.arpa`;
  }
  return `${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`;
}

export function regenerateHostsDir(db) {
  const zones = db.prepare(`
    SELECT z.id, z.name FROM dns_zones z WHERE z.enabled = 1
  `).all();

  const activeIds = new Set();

  for (const zone of zones) {
    const records = db.prepare(`
      SELECT name, value FROM dns_records
      WHERE zone_id = ? AND type = 'A' AND enabled = 1
    `).all(zone.id);

    if (records.length === 0) continue;

    activeIds.add(zone.id);
    const lines = records.map(r => `${r.value} ${toFqdn(r.name, zone.name)}`);
    atomicWrite(path.join(HOSTS_DIR, `zone-${zone.id}.hosts`), lines.join('\n') + '\n');
  }

  cleanStaleFiles(HOSTS_DIR, 'zone-', '.hosts', activeIds);
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

  const row = db.prepare("SELECT value FROM settings WHERE key = 'dns_upstream_servers'").get();
  let servers = ['8.8.8.8', '1.1.1.1'];
  try {
    if (row?.value) servers = JSON.parse(row.value);
  } catch { /* use defaults */ }

  // If GeoIP proxy is enabled, route through local proxy instead of direct upstream
  const geoipEnabled = db.prepare("SELECT value FROM settings WHERE key = 'geoip_enabled'").get();
  const geoipPort = db.prepare("SELECT value FROM settings WHERE key = 'geoip_proxy_port'").get();
  if (geoipEnabled?.value === 'true' && geoipPort?.value) {
    servers = [`127.0.0.1#${geoipPort.value}`];
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

export function signalDnsmasq() {
  try {
    execSync('kill -HUP $(pidof dnsmasq) 2>/dev/null || true', { stdio: 'ignore' });
  } catch {
    console.warn('Could not send SIGHUP to dnsmasq (may not be running)');
  }
}

export function regenerateConfigs(db) {
  regenerateHostsDir(db);
  const confChanged = regenerateConfDir(db);
  if (confChanged) {
    signalDnsmasq();
  }
}
