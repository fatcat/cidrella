import { Router } from 'express';
import os from 'os';
import fs from 'fs';
import { getDb, getSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import {
  applyInterfaceConfig,
  restartDnsmasq,
  isCidrellaDnsmasqRunning,
  dnsmasqRestartPending,
  withValidatedDnsmasqUpdate
} from '../utils/dnsmasq.js';
import { rebindProxy } from '../utils/dns-proxy.js';
import {
  applyHttpRedirectConfig, applyHttpsPortChange, applyHttpPortChange,
  getWebPortInfo, checkPortAvailable, getHttpsPort, getHttpPort
} from '../utils/http-server.js';
import { validPortOrError, validateInterfaceConfig } from '../utils/validation.js';
import * as Setting from '../models/setting.js';

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

// GET /api/interfaces: enumerate real network interfaces.
//
// Source the interface LIST from /sys/class/net rather than
// os.networkInterfaces(), because Node only reports interfaces that already
// have an assigned address. A provisioned-but-IP-less interface (e.g. a freshly
// added NIC with no IP yet) would otherwise be invisible here and get
// mislabeled "missing" in the UI. IPv4 addresses are merged in from
// os.networkInterfaces() (may be empty for an interface without an IP).
router.get('/', requirePerm('system:read'), (req, res) => {
  const sysIfaces = os.networkInterfaces();

  let names;
  try {
    names = fs.readdirSync('/sys/class/net');
  } catch {
    // Non-Linux / no sysfs, fall back to whatever has addresses.
    names = Object.keys(sysIfaces);
  }

  const result = [];
  for (const name of names) {
    if (!isRealInterface(name)) continue;
    // Skip sysfs control entries (e.g. bonding_masters), real interfaces
    // expose an `address` attribute; control files do not.
    if (!fs.existsSync(`/sys/class/net/${name}/address`)) continue;

    const ipv4Addrs = (sysIfaces[name] || [])
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

// GET /api/interfaces/config: read saved interface config
router.get('/config', requirePerm('system:read'), (req, res) => {
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

// PUT /api/interfaces/config: save interface config and apply
router.put('/config', requirePerm('system:write'), async (req, res) => {
  const body = req.body || {};
  const {
    interfaces, dns_enabled, dhcp_enabled, dns_listen_port, http_redirect_enabled,
    https_port, http_port
  } = body;

  // Validators are the shared helpers in utils/validation.js, same
  // implementation used by /api/settings/bulk and /api/settings/:key so
  // the two endpoints can never drift. The original port validator in
  // this route was hand-rolled and coerced single-element arrays
  // ([443]→443), which executed a live port swap on a bogus-shape
  // payload. Shared validator is strict: non-number → reject.
  if (dns_listen_port !== undefined) {
    const e = validPortOrError(dns_listen_port, 'dns_listen_port');
    if (e) return res.status(400).json({ error: e });
  }
  if (http_redirect_enabled !== undefined && typeof http_redirect_enabled !== 'boolean') {
    return res.status(400).json({ error: 'http_redirect_enabled must be boolean' });
  }
  if (interfaces !== undefined) {
    const e = validateInterfaceConfig(interfaces);
    if (e) return res.status(400).json({ error: `interfaces: ${e}` });
  }

  // Web-port validation + preflight bind. We test-bind BEFORE writing to DB,
  // so a port collision (EADDRINUSE, EACCES) cleanly fails the PUT and the
  // running listener stays up. Skip the test when the user is requesting
  // the port the server is already on (no-op save).
  let httpsPortNum = null;
  let httpPortNum  = null;
  if (https_port !== undefined) {
    const e = validPortOrError(https_port, 'https_port');
    if (e) return res.status(400).json({ error: e });
    httpsPortNum = https_port;
    if (https_port !== getHttpsPort()) {
      const probeErr = await checkPortAvailable(https_port);
      if (probeErr) return res.status(409).json({ error: `https_port ${https_port} not bindable: ${probeErr}` });
    }
  }
  if (http_port !== undefined) {
    const e = validPortOrError(http_port, 'http_port');
    if (e) return res.status(400).json({ error: e });
    httpPortNum = http_port;
    if (http_port !== getHttpPort()) {
      const probeErr = await checkPortAvailable(http_port);
      if (probeErr) return res.status(409).json({ error: `http_port ${http_port} not bindable: ${probeErr}` });
    }
  }
  if (httpsPortNum !== null && httpPortNum !== null && httpsPortNum === httpPortNum) {
    return res.status(400).json({ error: 'https_port and http_port must differ' });
  }

  const db = getDb();
  const dnsmasqSettingsChanged = [
    interfaces,
    dns_enabled,
    dhcp_enabled,
    dns_listen_port
  ].some(value => value !== undefined);

  // Validate the dnsmasq output inside the same transaction as the settings
  // it reflects. A validation or filesystem failure restores both the old
  // config files and the old database values.
  let ifaceChanged;
  try {
    ifaceChanged = db.transaction(() => {
      if (interfaces !== undefined) {
        Setting.upsertSettingWithConflict(db, 'interface_config', JSON.stringify(interfaces));
      }
      if (dns_enabled !== undefined) {
        Setting.upsertSettingWithConflict(db, 'dns_enabled', String(dns_enabled));
      }
      if (dhcp_enabled !== undefined) {
        Setting.upsertSettingWithConflict(db, 'dhcp_enabled', String(dhcp_enabled));
      }
      if (dns_listen_port !== undefined) {
        Setting.upsertSettingWithConflict(db, 'dns_listen_port', String(Number(dns_listen_port)));
      }
      if (http_redirect_enabled !== undefined) {
        Setting.upsertSettingWithConflict(db, 'http_redirect_enabled', http_redirect_enabled ? 'true' : 'false');
      }
      return dnsmasqSettingsChanged
        ? withValidatedDnsmasqUpdate(() => applyInterfaceConfig(db))
        : false;
    })();
  } catch (err) {
    console.warn('Failed to validate dnsmasq interface config:', err.message);
    return res.status(500).json({ error: `dnsmasq configuration update failed: ${err.message}` });
  }

  // Live-apply the HTTP listener toggle + port changes. Order matters:
  // HTTPS port first (so the HTTP redirect's Location target closure picks
  // up the new HTTPS port), then HTTP port, then redirect enable/disable.
  // applyHttpsPortChange() / applyHttpPortChange() both compare to their
  // OWN module-level state, we don't pre-check here because getHttpsPort()
  // would read the DB (which we haven't written yet) and resolve to the
  // old env fallback, not the currently-bound port.
  const port_changes = {};
  if (httpsPortNum !== null) {
    try {
      const r = await applyHttpsPortChange(httpsPortNum);
      port_changes.https = r;
      // Swap succeeded, commit the DB value now. If the server restarts
      // later it comes up on the new port.
      Setting.upsertSettingWithConflict(db, 'https_port', String(httpsPortNum));
    } catch (err) {
      console.warn('Failed to apply HTTPS port change:', err.message);
      return res.status(500).json({ error: `https_port swap failed: ${err.message}` });
    }
  }
  if (httpPortNum !== null) {
    try {
      const r = await applyHttpPortChange(httpPortNum);
      port_changes.http = r;
      Setting.upsertSettingWithConflict(db, 'http_port', String(httpPortNum));
    } catch (err) {
      console.warn('Failed to apply HTTP port change:', err.message);
      // Don't 500, the HTTPS port may have already swapped. Report warning.
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
  // through queueRegen, the hook fires in a microtask AFTER the restart,
  // which would leave dnsmasq running the old conf until the next regen.
  // A no-op save (nothing effectively changed, our unit healthy) skips the
  // restart so clicking Save can't blip DNS/DHCP for the whole LAN.
  let dnsmasqStatus = 'restarted';
  if (ifaceChanged || dnsmasqRestartPending() || !isCidrellaDnsmasqRunning()) {
    try {
      restartDnsmasq();
    } catch {
      dnsmasqStatus = 'restart_failed';
    }
  } else {
    dnsmasqStatus = 'unchanged';
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
