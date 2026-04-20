import { Router } from 'express';
import os from 'os';
import fs from 'fs';
import { getDb, getSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { applyInterfaceConfig, restartDnsmasq } from '../utils/dnsmasq.js';
import { rebindProxy } from '../utils/dns-proxy.js';
import {
  applyHttpRedirectConfig, applyHttpsPortChange, applyHttpPortChange,
  getWebPortInfo, checkPortAvailable, getHttpsPort, getHttpPort
} from '../utils/http-server.js';

const router = Router();

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

  const ifaceConfigRaw = getSetting('interface_config');
  if (ifaceConfigRaw) {
    try { interfaces = JSON.parse(ifaceConfigRaw); } catch { /* default */ }
  }
  if (getSetting('dns_enabled') === 'false') dnsEnabled = false;
  if (getSetting('dhcp_enabled') === 'false') dhcpEnabled = false;

  res.json({
    interfaces,
    dns_enabled: dnsEnabled,
    dhcp_enabled: dhcpEnabled,
    web_ports: getWebPortInfo()
  });
});

// PUT /api/interfaces/config — save interface config and apply
router.put('/config', requirePerm('subnets:write'), async (req, res) => {
  const body = req.body || {};
  const {
    interfaces, dns_enabled, dhcp_enabled, dns_listen_port, http_redirect_enabled,
    https_port, http_port
  } = body;

  // Validate port early so we can reject before persisting anything.
  if (dns_listen_port !== undefined) {
    const p = Number(dns_listen_port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return res.status(400).json({ error: 'dns_listen_port must be an integer 1–65535' });
    }
  }
  if (http_redirect_enabled !== undefined && typeof http_redirect_enabled !== 'boolean') {
    return res.status(400).json({ error: 'http_redirect_enabled must be boolean' });
  }

  // Web-port validation + preflight bind. We test-bind BEFORE writing to DB,
  // so a port collision (EADDRINUSE, EACCES) cleanly fails the PUT and the
  // running listener stays up. Skip the test when the user is requesting
  // the port the server is already on (no-op save).
  let httpsPortNum = null;
  let httpPortNum  = null;
  if (https_port !== undefined) {
    const p = Number(https_port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return res.status(400).json({ error: 'https_port must be an integer 1–65535' });
    }
    httpsPortNum = p;
    if (p !== getHttpsPort()) {
      const probeErr = await checkPortAvailable(p);
      if (probeErr) return res.status(409).json({ error: `https_port ${p} not bindable: ${probeErr}` });
    }
  }
  if (http_port !== undefined) {
    const p = Number(http_port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return res.status(400).json({ error: 'http_port must be an integer 1–65535' });
    }
    httpPortNum = p;
    if (p !== getHttpPort()) {
      const probeErr = await checkPortAvailable(p);
      if (probeErr) return res.status(409).json({ error: `http_port ${p} not bindable: ${probeErr}` });
    }
  }
  if (httpsPortNum !== null && httpPortNum !== null && httpsPortNum === httpPortNum) {
    return res.status(400).json({ error: 'https_port and http_port must differ' });
  }

  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  // Non-port settings write immediately. Port settings wait until the
  // live-swap succeeds, otherwise a swap failure would leave bad state on
  // disk that breaks the next server restart.
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
    if (dns_listen_port !== undefined) {
      upsert.run('dns_listen_port', String(Number(dns_listen_port)));
    }
    if (http_redirect_enabled !== undefined) {
      upsert.run('http_redirect_enabled', http_redirect_enabled ? 'true' : 'false');
    }
  })();

  // Live-apply the HTTP listener toggle + port changes. Order matters:
  // HTTPS port first (so the HTTP redirect's Location target closure picks
  // up the new HTTPS port), then HTTP port, then redirect enable/disable.
  // applyHttpsPortChange() / applyHttpPortChange() both compare to their
  // OWN module-level state — we don't pre-check here because getHttpsPort()
  // would read the DB (which we haven't written yet) and resolve to the
  // old env fallback, not the currently-bound port.
  const port_changes = {};
  if (httpsPortNum !== null) {
    try {
      const r = await applyHttpsPortChange(httpsPortNum);
      port_changes.https = r;
      // Swap succeeded — commit the DB value now. If the server restarts
      // later it comes up on the new port.
      upsert.run('https_port', String(httpsPortNum));
    } catch (err) {
      console.warn('Failed to apply HTTPS port change:', err.message);
      return res.status(500).json({ error: `https_port swap failed: ${err.message}` });
    }
  }
  if (httpPortNum !== null) {
    try {
      const r = await applyHttpPortChange(httpPortNum);
      port_changes.http = r;
      upsert.run('http_port', String(httpPortNum));
    } catch (err) {
      console.warn('Failed to apply HTTP port change:', err.message);
      // Don't 500 — the HTTPS port may have already swapped. Report warning.
      port_changes.http = { changed: false, error: err.message };
    }
  }
  if (http_redirect_enabled !== undefined) {
    try { await applyHttpRedirectConfig(); } catch (err) {
      console.warn('Failed to apply HTTP redirect config:', err.message);
    }
  }

  // Regenerate dnsmasq config and restart (interface changes require full
  // restart, not just SIGHUP). Must be synchronous: restartDnsmasq on the
  // next line needs to pick up the freshly-written conf. Don't route this
  // through queueRegen — the hook fires in a microtask AFTER the restart,
  // which would leave dnsmasq running the old conf until the next regen.
  applyInterfaceConfig(db);

  let dnsmasqStatus = 'restarted';
  try {
    restartDnsmasq();
  } catch {
    dnsmasqStatus = 'restart_failed';
  }

  // Rebind proxy sockets to updated interface addresses
  try {
    rebindProxy();
  } catch (err) {
    console.warn('Failed to rebind proxy:', err.message);
  }

  audit(req.user.id, 'interface_config_updated', 'setting', null, {
    interfaces, dns_enabled, dhcp_enabled, dns_listen_port,
    https_port: httpsPortNum, http_port: httpPortNum, http_redirect_enabled
  });

  res.json({
    ok: true,
    dnsmasq: dnsmasqStatus,
    web_ports: getWebPortInfo(),
    port_changes
  });
});

export default router;
