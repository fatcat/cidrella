import { Router } from 'express';
import { getDb, audit } from '../db/init.js';
import { hasPermission } from '../auth/roles.js';
import { regenerateConfigs } from '../utils/dnsmasq.js';
import http from 'http';
import https from 'https';
import { ipToLong } from '../utils/ip.js';
import express from 'express';

const router = Router();

function requirePerm(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Fetch JSON from a URL (http or https), returns { ok, status, data } or { ok, error } */
function fetchJson(url, options = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const reqOpts = { timeout: 5000, ...options };

    try {
      const req = mod.get(url, reqOpts, (resp) => {
        let body = '';
        resp.on('data', (chunk) => { body += chunk; });
        resp.on('end', () => {
          try {
            resolve({ ok: resp.statusCode >= 200 && resp.statusCode < 300, status: resp.statusCode, data: JSON.parse(body) });
          } catch {
            resolve({ ok: false, error: 'Invalid JSON response' });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Connection timed out' }); });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

/** POST JSON to a URL, returns same shape as fetchJson */
function postJson(url, body, options = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      ...options,
    };

    try {
      const req = mod.request(reqOpts, (resp) => {
        let respBody = '';
        resp.on('data', (chunk) => { respBody += chunk; });
        resp.on('end', () => {
          try {
            resolve({ ok: resp.statusCode >= 200 && resp.statusCode < 300, status: resp.statusCode, data: JSON.parse(respBody) });
          } catch {
            resolve({ ok: false, error: 'Invalid JSON response' });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Connection timed out' }); });
      req.write(data);
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

/** Parse Pi-hole config object into normalized arrays */
function parsePiholeConfig(cfg) {
  const dns = cfg.dns || {};
  const dhcp = cfg.dhcp || {};

  const hosts = (dns.hosts || []).map(entry => {
    if (typeof entry !== 'string') return null;
    const parts = entry.split(/\s+/, 2);
    return parts.length === 2 ? { ip: parts[0], hostname: parts[1] } : null;
  }).filter(Boolean);

  const cnames = (dns.cnameRecords || []).map(entry => {
    if (typeof entry !== 'string') return null;
    const parts = entry.split(',');
    return parts.length >= 2 ? { alias: parts[0].trim(), target: parts[1].trim() } : null;
  }).filter(Boolean);

  const dhcpHosts = (dhcp.hosts || []).map(entry => {
    if (typeof entry !== 'string') return null;
    const parts = entry.split(',');
    if (parts.length < 3) return null;
    let mac = parts[0].trim();
    // Normalize: strip leading 01: client-id prefix
    const macParts = mac.split(':');
    if (macParts.length === 7 && macParts[0].toLowerCase() === '01') {
      mac = macParts.slice(1).join(':');
    }
    return { mac: mac.toLowerCase(), ip: parts[1].trim(), hostname: parts[2].trim() };
  }).filter(Boolean);

  return { hosts, cnames, dhcpHosts };
}

/** Detect common zone name from hostnames */
function detectZoneName(hosts, cnames) {
  const allNames = [...hosts.map(h => h.hostname), ...cnames.map(c => c.alias)];
  if (allNames.length === 0) return null;
  const partsList = allNames.map(n => n.split('.'));
  const minLen = Math.min(...partsList.map(p => p.length));
  const common = [];
  for (let i = 1; i <= minLen; i++) {
    const segment = partsList[0][partsList[0].length - i];
    if (partsList.every(p => p[p.length - i] === segment)) {
      common.unshift(segment);
    } else break;
  }
  return common.length > 0 ? common.join('.') : null;
}

/** Strip zone suffix from hostname to get record name */
function recordName(hostname, zoneName) {
  if (hostname === zoneName) return '@';
  const suffix = `.${zoneName}`;
  return hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : hostname;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/pihole/probe
 * Test reachability of a Pi-hole instance and check auth requirements.
 * Body: { url: "http://pihole.local", password?: "optional" }
 */
router.post('/probe', requirePerm('dns:write'), async (req, res) => {
  const { url, password } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL must start with http:// or https://' });

  const baseUrl = url.replace(/\/+$/, '');
  const authResult = await fetchJson(`${baseUrl}/api/auth`);

  if (!authResult.ok) {
    return res.json({ reachable: false, error: authResult.error || 'Could not connect' });
  }

  const session = authResult.data?.session;
  const needsPassword = session?.message !== 'no password set';
  let authenticated = !needsPassword;

  // If password is needed and provided, attempt auth
  if (needsPassword && password) {
    const loginResult = await postJson(`${baseUrl}/api/auth`, { password });
    if (loginResult.ok && loginResult.data?.session?.valid) {
      authenticated = true;
    }
  }

  return res.json({
    reachable: true,
    needsPassword,
    authenticated,
  });
});

/**
 * POST /api/pihole/fetch
 * Fetch and parse config from a live Pi-hole instance.
 * Body: { url: "http://pihole.local", password?: "optional" }
 */
router.post('/fetch', requirePerm('dns:write'), async (req, res) => {
  const { url, password } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL must start with http:// or https://' });

  const baseUrl = url.replace(/\/+$/, '');

  // Authenticate if password provided
  let sid = null;
  if (password) {
    const loginResult = await postJson(`${baseUrl}/api/auth`, { password });
    if (loginResult.ok && loginResult.data?.session?.sid) {
      sid = loginResult.data.session.sid;
    } else if (!loginResult.ok) {
      return res.status(401).json({ error: 'Pi-hole authentication failed' });
    }
  }

  const configUrl = sid ? `${baseUrl}/api/config?sid=${sid}` : `${baseUrl}/api/config`;
  const configResult = await fetchJson(configUrl);

  if (!configResult.ok) {
    return res.status(502).json({ error: 'Failed to fetch Pi-hole config' });
  }

  const cfg = configResult.data?.config;
  if (!cfg) {
    return res.status(502).json({ error: 'Unexpected Pi-hole config format' });
  }

  const parsed = parsePiholeConfig(cfg);
  const zoneName = detectZoneName(parsed.hosts, parsed.cnames);

  res.json({
    zoneName,
    hosts: parsed.hosts,
    cnames: parsed.cnames,
    dhcpHosts: parsed.dhcpHosts,
  });
});

/**
 * POST /api/pihole/parse
 * Parse an uploaded pihole.toml file.
 * Multipart form with file field "file".
 */
router.post('/parse', requirePerm('dns:write'), express.text({ type: '*/*', limit: '512kb' }), async (req, res) => {
  const content = typeof req.body === 'string' ? req.body : '';
  if (!content) return res.status(400).json({ error: 'No file content provided' });

  try {
    const cfg = parseToml(content);

    const parsed = parsePiholeConfig(cfg);
    const zoneName = detectZoneName(parsed.hosts, parsed.cnames);

    res.json({
      zoneName,
      hosts: parsed.hosts,
      cnames: parsed.cnames,
      dhcpHosts: parsed.dhcpHosts,
    });
  } catch (err) {
    res.status(400).json({ error: `Failed to parse TOML: ${err.message}` });
  }
});

/**
 * Minimal TOML parser sufficient for pihole.toml.
 * Handles: sections, nested sections, string values, arrays of strings, booleans, numbers.
 */
function parseToml(content) {
  const result = {};
  let currentSection = result;
  let currentPath = [];
  let inArray = false;
  let arrayKey = null;
  let arrayValues = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.split('#')[0].trimEnd(); // strip comments (but not inside strings)
    const trimmed = line.trim();

    if (!trimmed) continue;

    // Collecting array values
    if (inArray) {
      if (trimmed === ']' || trimmed === '] ### CHANGED, default = []') {
        currentSection[arrayKey] = arrayValues;
        inArray = false;
        arrayKey = null;
        arrayValues = [];
        continue;
      }
      // Match quoted string value, possibly with trailing comma
      const m = trimmed.match(/^"((?:[^"\\]|\\.)*)"[, ]*$/);
      if (m) {
        arrayValues.push(m[1]);
      }
      continue;
    }

    // Section header [foo.bar]
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const parts = sectionMatch[1].split('.');
      currentPath = parts;
      currentSection = result;
      for (const part of parts) {
        if (!currentSection[part]) currentSection[part] = {};
        currentSection = currentSection[part];
      }
      continue;
    }

    // Key = value
    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const [, key, rawVal] = kvMatch;
      const val = rawVal.replace(/\s*###.*$/, '').trim(); // strip ### CHANGED comments

      if (val === '[') {
        // Start of multi-line array
        inArray = true;
        arrayKey = key;
        arrayValues = [];
      } else if (val.startsWith('[') && val.endsWith(']')) {
        // Single-line array
        const inner = val.slice(1, -1).trim();
        if (!inner) {
          currentSection[key] = [];
        } else {
          currentSection[key] = inner.split(',').map(s => {
            const m = s.trim().match(/^"((?:[^"\\]|\\.)*)"$/);
            return m ? m[1] : s.trim();
          });
        }
      } else if (val.startsWith('"') && val.endsWith('"')) {
        currentSection[key] = val.slice(1, -1);
      } else if (val === 'true') {
        currentSection[key] = true;
      } else if (val === 'false') {
        currentSection[key] = false;
      } else if (/^-?\d+(\.\d+)?$/.test(val)) {
        currentSection[key] = parseFloat(val);
      } else {
        currentSection[key] = val;
      }
    }
  }

  return result;
}

/**
 * POST /api/pihole/import
 * Import parsed Pi-hole data into CIDRella.
 * Body: { zoneId, hosts, cnames, dhcpHosts, subnetId? }
 */
router.post('/import', requirePerm('dns:write'), async (req, res) => {
  const { zoneId, hosts, cnames, dhcpHosts } = req.body;
  if (!zoneId) return res.status(400).json({ error: 'zoneId is required' });

  const db = getDb();
  const zone = db.prepare('SELECT * FROM dns_zones WHERE id = ?').get(zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });

  const results = { a: { created: 0, skipped: 0, failed: 0 }, cname: { created: 0, skipped: 0, failed: 0 }, dhcp: { created: 0, skipped: 0, failed: 0, noSubnet: 0 } };

  const existingRecords = new Set(
    db.prepare('SELECT type, name, value FROM dns_records WHERE zone_id = ?').all(zoneId)
      .map(r => `${r.type}|${r.name}|${r.value}`)
  );

  const insertRecord = db.prepare(
    'INSERT INTO dns_records (zone_id, name, type, value) VALUES (?, ?, ?, ?)'
  );

  // Import A records
  if (hosts && hosts.length > 0) {
    for (const h of hosts) {
      const name = recordName(h.hostname, zone.name);
      const key = `A|${name}|${h.ip}`;
      if (existingRecords.has(key)) { results.a.skipped++; continue; }
      try {
        insertRecord.run(zoneId, name, 'A', h.ip);
        existingRecords.add(key);
        results.a.created++;
      } catch { results.a.failed++; }
    }
  }

  // Import CNAME records
  if (cnames && cnames.length > 0) {
    for (const c of cnames) {
      const name = recordName(c.alias, zone.name);
      const key = `CNAME|${name}|${c.target}`;
      if (existingRecords.has(key)) { results.cname.skipped++; continue; }
      try {
        insertRecord.run(zoneId, name, 'CNAME', c.target);
        existingRecords.add(key);
        results.cname.created++;
      } catch { results.cname.failed++; }
    }
  }

  // Import DHCP reservations
  if (dhcpHosts && dhcpHosts.length > 0) {
    // Find all leaf subnets to match IPs against
    const subnets = db.prepare(`
      SELECT s.* FROM subnets s
      WHERE (SELECT COUNT(*) FROM subnets c WHERE c.parent_id = s.id) = 0
    `).all();

    const existingRes = db.prepare('SELECT subnet_id, mac_address, ip_address FROM dhcp_reservations').all();
    const existingMacs = new Set(existingRes.map(r => `${r.subnet_id}|${r.mac_address}`));
    const existingIps = new Set(existingRes.map(r => `${r.subnet_id}|${r.ip_address}`));

    const insertRes = db.prepare(
      'INSERT INTO dhcp_reservations (subnet_id, mac_address, ip_address, hostname, description) VALUES (?, ?, ?, ?, ?)'
    );

    for (const d of dhcpHosts) {
      // Find best matching subnet
      const ipLong = ipToLong(d.ip);
      let best = null;
      for (const s of subnets) {
        const netLong = ipToLong(s.network_address);
        const size = Math.pow(2, 32 - s.prefix_length);
        if (ipLong >= netLong && ipLong < netLong + size) {
          if (!best || s.prefix_length > best.prefix_length) best = s;
        }
      }

      if (!best) { results.dhcp.noSubnet++; continue; }

      const macKey = `${best.id}|${d.mac}`;
      const ipKey = `${best.id}|${d.ip}`;
      if (existingMacs.has(macKey) || existingIps.has(ipKey)) { results.dhcp.skipped++; continue; }

      try {
        insertRes.run(best.id, d.mac, d.ip, d.hostname, 'Imported from Pi-hole');
        existingMacs.add(macKey);
        existingIps.add(ipKey);
        results.dhcp.created++;
      } catch { results.dhcp.failed++; }
    }
  }

  // Bump zone serial
  db.prepare('UPDATE dns_zones SET soa_serial = soa_serial + 1, updated_at = datetime(?) WHERE id = ?')
    .run(new Date().toISOString(), zoneId);

  // Regenerate dnsmasq configs
  regenerateConfigs(db);

  audit(req.user.id, 'pihole_import', 'dns_zone', zoneId, { zone: zone.name, results });

  res.json({ message: 'Import complete', results });
});

export default router;
