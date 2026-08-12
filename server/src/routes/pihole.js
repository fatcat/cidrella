import { Router } from 'express';
import { parse as parseToml } from 'smol-toml';
import { getDb, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { ipToLong, isClientMac, isValidMac, isValidIpv4, isValidDomain } from '../utils/ip.js';
import { syncDnsToIp } from '../utils/ip-sync.js';
import { reservationIpRejectionReason } from './dhcp.js';
import { text as textParser } from 'express';
import { validateOutboundUrl, requestPinnedOutboundUrl } from '../utils/url-guard.js';
import { validateDnsmasqConfigValue } from '../utils/dnsmasq-escape.js';
import { createReservation } from '../models/dhcp-reservation.js';
import { importRecords, cnameTargetError, fqdnForRecordName } from '../models/dns-record.js';

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Make an HTTP/HTTPS request and parse JSON response.
 * Returns { ok, status, data } on success or { ok: false, error } on failure.
 * @param {string} url
 * @param {{ method?: string, body?: object, timeout?: number }} [opts]
 */
async function httpRequest(url, { method = 'GET', body = null, timeout = 5000 } = {}) {
  const headers = body
    ? { 'Content-Type': 'application/json' }
    : {};
  const response = await requestPinnedOutboundUrl(url, { method, body, timeout, headers, maxBytes: 2 * 1024 * 1024 });
  if (!response.ok) return response;
  try {
    return { ok: true, status: response.status, data: JSON.parse(response.text) };
  } catch {
    return { ok: false, status: response.status, error: 'Invalid JSON response' };
  }
}

/** GET JSON from a URL: thin wrapper around httpRequest */
function fetchJson(url) { return httpRequest(url); }

/** POST JSON to a URL: thin wrapper around httpRequest */
function postJson(url, body) { return httpRequest(url, { method: 'POST', body }); }

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
  if (common.length === 0) return null;
  const zone = common.join('.');
  // If the detected zone equals a full hostname, drop the first label
  // (e.g. single host "hass.the-mcnultys.org" → "the-mcnultys.org", not the full FQDN)
  if (allNames.some(n => n === zone) && common.length > 1) {
    return common.slice(1).join('.');
  }
  return zone;
}

/** Strip zone suffix from hostname to get record name */
function recordName(hostname, zoneName) {
  if (hostname === zoneName) return '@';
  const suffix = `.${zoneName}`;
  return hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : hostname;
}

function isValidRecordName(name) {
  if (name === '@') return true;
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 253
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name.replace(/\.$/, ''));
}

function validateImportArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > 5000) throw new Error(`${field} may contain at most 5000 entries`);
  return value;
}

/**
 * `db` and `batchFqdns` are optional so the shape checks stay usable without a
 * zone row. When both are present the CNAME target goes through the same
 * `cnameTargetError` the UI create path uses, which is the point: this function
 * used to accept any syntactically valid domain, so an import could land a
 * CNAME in a local zone pointing at an arbitrary external host, or at nothing,
 * that the same appliance refuses if you type it into the DNS page.
 * See REVIEW.md, duplicate-logic audit #18.
 */
function validateImportRecord(record, zoneName, db = null, zone = null, batchFqdns = null) {
  if (!isValidRecordName(record.name)) return 'Invalid hostname';
  const nameErr = validateDnsmasqConfigValue(record.name, { allowComma: false });
  if (nameErr) return `hostname ${nameErr}`;
  if (record.type === 'A') {
    if (!isValidIpv4(record.value)) return 'Invalid IPv4 address';
    return null;
  }
  if (record.type === 'CNAME') {
    if (!isValidDomain(record.value)) return 'Invalid CNAME target';
    if (record.name === '@') return 'CNAME cannot be created at zone apex';
    if (`${record.name}.${zoneName}`.toLowerCase() === String(record.value).replace(/\.$/, '').toLowerCase()) {
      return 'CNAME target cannot reference itself';
    }
    const valueErr = validateDnsmasqConfigValue(record.value, { allowComma: false });
    if (valueErr) return `CNAME target ${valueErr}`;
    if (db && zone) {
      const targetErr = cnameTargetError(db, record.value, zone, batchFqdns);
      if (targetErr) return targetErr;
    }
    return null;
  }
  return 'Unsupported record type';
}

/**
 * Validate and normalize a Pi-hole base URL.
 * v0.4.15: routes through the shared SSRF guard (loopback / RFC1918 /
 * link-local / metadata blocked). Returns { baseUrl } on success or
 * { error } on failure. The returned outbound target pins the validated IP
 * so auth/config requests do not re-resolve the host.
 */
async function normalizeUrl(url) {
  if (typeof url !== 'string' || !url) return { error: 'URL is required' };
  // Length cap before any regex work, the trailing-slash strip below is
  // quadratic on pathological all-slash inputs (CodeQL js/polynomial-redos).
  if (url.length > 2048) return { error: 'URL is too long' };
  const trimmed = url.replace(/\/+$/, '');
  const check = await validateOutboundUrl(trimmed);
  if (!check.ok) return { error: check.reason };
  return { baseUrl: check.url.replace(/\/+$/, ''), outbound: check };
}

function appendPath(norm, path) {
  return {
    ...norm.outbound,
    url: `${norm.baseUrl}${path}`,
  };
}


// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/pihole/probe
 * Test reachability of a Pi-hole instance and check auth requirements.
 * Body: { url: "http://pihole.local", password?: "optional" }
 */
router.post('/probe', requirePerm('dns:write'), async (req, res) => {
  const { url, password } = req.body || {};
  const norm = await normalizeUrl(url);
  if (norm.error) return res.status(400).json({ error: norm.error });
  const authResult = await fetchJson(appendPath(norm, '/api/auth'));

  if (!authResult.ok) {
    return res.json({ reachable: false, error: authResult.error || 'Could not connect' });
  }

  const session = authResult.data?.session;
  const needsPassword = session?.message !== 'no password set';
  let authenticated = !needsPassword;

  // If password is needed and provided, attempt auth
  if (needsPassword && password) {
    const loginResult = await postJson(appendPath(norm, '/api/auth'), { password });
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
  const { url, password } = req.body || {};
  const norm = await normalizeUrl(url);
  if (norm.error) return res.status(400).json({ error: norm.error });

  // Authenticate if password provided
  let sid = null;
  if (password) {
    const loginResult = await postJson(appendPath(norm, '/api/auth'), { password });
    if (loginResult.ok && loginResult.data?.session?.sid) {
      sid = loginResult.data.session.sid;
    } else if (!loginResult.ok) {
      return res.status(401).json({ error: 'Pi-hole authentication failed' });
    }
  }

  const configUrl = appendPath(norm, sid ? `/api/config?sid=${encodeURIComponent(sid)}` : '/api/config');
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
router.post('/parse', requirePerm('dns:write'), textParser({ type: '*/*', limit: '512kb' }), async (req, res) => {
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

  const results = {
    a: { created: 0, updated: 0, skipped: 0, failed: 0 },
    cname: { created: 0, updated: 0, skipped: 0, failed: 0 },
    dhcp: { created: 0, skipped: 0, failed: 0, noSubnet: 0 }
  };

  const recordsToImport = [];
  let hostRows, cnameRows, dhcpRows;
  try {
    hostRows = validateImportArray(hosts, 'hosts');
    cnameRows = validateImportArray(cnames, 'cnames');
    dhcpRows = validateImportArray(dhcpHosts, 'dhcpHosts');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Import A records, merge: skip exact dupes, update if same name but different value
  if (hostRows.length > 0) {
    for (const h of hostRows) {
      if (!h || typeof h !== 'object') return res.status(400).json({ error: 'hosts entries must be objects' });
      if (typeof h.hostname !== 'string') return res.status(400).json({ error: 'hosts hostname must be a string' });
      const record = { type: 'A', name: recordName(h.hostname.trim(), zone.name), value: h.ip };
      const err = validateImportRecord(record, zone.name);
      if (err) return res.status(400).json({ error: `A record ${record.name || '?'}: ${err}` });
      recordsToImport.push(record);
    }
  }

  // Import CNAME records, merge: skip exact dupes, update if same name but different target
  //
  // The A records above are already in recordsToImport, and their FQDNs count as
  // valid targets even though none of them is in the DB yet: nothing is inserted
  // until importRecords runs below. Without this set, a Pi-hole file that
  // defines a host and a CNAME pointing at it (the normal case) would be
  // rejected for referencing a record that "does not exist".
  const batchFqdns = new Set(
    recordsToImport
      .filter(r => r.type === 'A' || r.type === 'CNAME')
      .map(r => String(fqdnForRecordName(r.name, zone.name)).trim().replace(/\.$/, '').toLowerCase())
  );
  if (cnameRows.length > 0) {
    for (const c of cnameRows) {
      if (!c || typeof c !== 'object') return res.status(400).json({ error: 'cnames entries must be objects' });
      if (typeof c.alias !== 'string' || typeof c.target !== 'string') return res.status(400).json({ error: 'cnames alias and target must be strings' });
      const record = { type: 'CNAME', name: recordName(c.alias.trim(), zone.name), value: c.target.trim() };
      const err = validateImportRecord(record, zone.name, db, zone, batchFqdns);
      if (err) return res.status(400).json({ error: `CNAME record ${record.name || '?'}: ${err}` });
      batchFqdns.add(String(fqdnForRecordName(record.name, zone.name)).trim().replace(/\.$/, '').toLowerCase());
      recordsToImport.push(record);
    }
  }

  const importResult = importRecords(db, zone, recordsToImport);
  results.a = {
    created: importResult.results.A.created,
    updated: importResult.results.A.updated,
    skipped: importResult.results.A.skipped,
    failed: importResult.results.A.failed
  };
  results.cname = {
    created: importResult.results.CNAME.created,
    updated: importResult.results.CNAME.updated,
    skipped: importResult.results.CNAME.skipped,
    failed: importResult.results.CNAME.failed
  };
  for (const r of importResult.aRecordsToSync) {
    syncDnsToIp(db, r.name, r.value, zone.name);
  }

  // Import DHCP reservations
  if (dhcpRows.length > 0) {
    // Find all leaf subnets to match IPs against
    const subnets = db.prepare(`
      SELECT s.* FROM subnets s
      WHERE (SELECT COUNT(*) FROM subnets c WHERE c.parent_id = s.id) = 0
    `).all();

    const existingRes = db.prepare('SELECT subnet_id, mac_address, ip_address FROM dhcp_reservations').all();
    const existingMacs = new Set(existingRes.map(r => `${r.subnet_id}|${r.mac_address}`));
    const existingIps = new Set(existingRes.map(r => `${r.subnet_id}|${r.ip_address}`));

    for (const d of dhcpRows) {
      // Reuse the same validation gates as POST /api/dhcp/reservations so
      // imports can't inject data the normal API path would refuse.
      const mac = (d.mac || '').toLowerCase();
      if (!isValidMac(mac) || !isClientMac(mac)) { results.dhcp.failed++; continue; }
      if (!isValidIpv4(d.ip)) { results.dhcp.failed++; continue; }
      if (d.hostname && !isValidDomain(d.hostname)) { results.dhcp.failed++; continue; }

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

      if (reservationIpRejectionReason(db, best, d.ip)) { results.dhcp.failed++; continue; }

      const macKey = `${best.id}|${mac}`;
      const ipKey = `${best.id}|${d.ip}`;
      if (existingMacs.has(macKey) || existingIps.has(ipKey)) { results.dhcp.skipped++; continue; }

      try {
        createReservation(db, best, {
          mac_address: mac,
          ip_address: d.ip,
          hostname: d.hostname || null,
          description: 'Imported from Pi-hole'
        });
        existingMacs.add(macKey);
        existingIps.add(ipKey);
        results.dhcp.created++;
      } catch { results.dhcp.failed++; }
    }
  }

  // Queue dnsmasq regen (fires once after response; DNS always, DHCP if any created)
  req.afterCommit('regenerate_dns');
  if (results.dhcp.created > 0) {
    req.afterCommit('regenerate_dhcp');
  }

  audit(req.user.id, 'pihole_import', 'dns_zone', zoneId, { zone: zone.name, results });

  res.json({ message: 'Import complete', results });
});

export default router;
