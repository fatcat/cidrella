import { Router } from 'express';
import os from 'os';
import fs from 'fs';
import { getDb, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import { applyInterfaceConfig, signalDnsmasq } from '../utils/dnsmasq.js';

const router = Router();

function requirePerm(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Interface name prefixes to exclude
const EXCLUDED_PREFIXES = ['br', 'veth', 'docker', 'virbr', 'tun', 'tap'];

function isRealInterface(name) {
  if (name === 'lo') return false;
  for (const prefix of EXCLUDED_PREFIXES) {
    if (name.startsWith(prefix)) return false;
  }
  return true;
}

function getInterfaceState(name) {
  try {
    return fs.readFileSync(`/sys/class/net/${name}/operstate`, 'utf-8').trim();
  } catch {
    return 'unknown';
  }
}

function getInterfaceMac(name) {
  try {
    return fs.readFileSync(`/sys/class/net/${name}/address`, 'utf-8').trim();
  } catch {
    return null;
  }
}

// GET /api/interfaces — enumerate real network interfaces
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const sysIfaces = os.networkInterfaces();
  const result = [];

  for (const [name, addrs] of Object.entries(sysIfaces)) {
    if (!isRealInterface(name)) continue;

    const ipv4Addrs = addrs
      .filter(a => a.family === 'IPv4')
      .map(a => ({ address: a.address, netmask: a.netmask }));

    result.push({
      name,
      mac: getInterfaceMac(name),
      addresses: ipv4Addrs,
      state: getInterfaceState(name),
    });
  }

  // Sort by name
  result.sort((a, b) => a.name.localeCompare(b.name));
  res.json(result);
});

// GET /api/interfaces/config — read saved interface config
router.get('/config', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  let interfaces = {};
  let dnsEnabled = true;
  let dhcpEnabled = true;

  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'interface_config'").get();
    if (row?.value) interfaces = JSON.parse(row.value);
  } catch { /* default */ }

  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'dns_enabled'").get();
    if (row?.value === 'false') dnsEnabled = false;
  } catch { /* default */ }

  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'dhcp_enabled'").get();
    if (row?.value === 'false') dhcpEnabled = false;
  } catch { /* default */ }

  res.json({ interfaces, dns_enabled: dnsEnabled, dhcp_enabled: dhcpEnabled });
});

// PUT /api/interfaces/config — save interface config and apply
router.put('/config', requirePerm('subnets:write'), (req, res) => {
  const { interfaces, dns_enabled, dhcp_enabled } = req.body;
  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  db.transaction(() => {
    if (interfaces !== undefined) {
      upsert.run('interface_config', JSON.stringify(interfaces));
    }
    if (dns_enabled !== undefined) {
      upsert.run('dns_enabled', String(dns_enabled));
    }
    if (dhcp_enabled !== undefined) {
      upsert.run('dhcp_enabled', String(dhcp_enabled));
    }
  })();

  // Regenerate dnsmasq config and signal
  applyInterfaceConfig(db);
  signalDnsmasq();

  audit(req.user.id, 'interface_config_updated', 'setting', null, {
    interfaces, dns_enabled, dhcp_enabled
  });

  res.json({ ok: true });
});

export default router;
