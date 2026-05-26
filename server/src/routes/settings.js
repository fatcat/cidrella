import { Router } from 'express';
import { getDb, setSetting, audit } from '../db/init.js';
import { requirePerm } from '../auth/require-perm.js';
import { requireRole } from '../auth/roles.js';
import { pruneEvents } from '../models/ip-address.js';
import { isValidIpv4 } from '../utils/ip.js';
import { validateInterfaceConfig, validPortOrError } from '../utils/validation.js';

const router = Router();

// Keys that should never be exposed via API
const SECRET_KEYS = new Set(['jwt_secret']);

// v0.4.15: per-key schema. In v0.4.14 the setter did `String(value)` on any
// JSON shape, so `{"value":{"a":1}}` persisted as `"[object Object]"` — and
// an attacker could brick the server by writing `dns_listen_port =
// "[object Object]"` (next restart would fail to bind). This schema rejects
// anything that doesn't match the declared type / shape for the key.
//
// Each entry is { validate: (v) => string|null }.
//   - validate returns null if the value is accepted,
//     or a short error string explaining the rejection.
// Keys not present here are not editable (was `EDITABLE_KEYS` in v0.4.14).

const BOOL_STR = new Set(['true', 'false']);
const GEOIP_MODES = new Set(['off', 'block-country', 'log-only']);
const BACKUP_SCHEDULES = new Set(['off', 'daily', 'weekly']);
const SCAN_INTERVALS = new Set(['', 'off', '5m', '15m', '30m', '1h', '4h']);

function isBoolStr(v) {
  return typeof v === 'string' ? BOOL_STR.has(v) : typeof v === 'boolean';
}
function toBoolStr(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v === 'true' ? 'true' : 'false';
}
function isBoolish01(v) {
  return typeof v === 'boolean' || v === 1 || v === 0 || v === '1' || v === '0' || v === 'true' || v === 'false';
}
function toBool01(v) {
  return (v === true || v === 1 || v === '1' || v === 'true') ? '1' : '0';
}
function isIntInRange(v, lo, hi) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d+$/.test(v) ? parseInt(v, 10) : NaN);
  return Number.isInteger(n) && n >= lo && n <= hi;
}
function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  return typeof v === 'number' ? v : parseInt(v, 10);
}

// One-shot validator for arrays of IPv4 — used for dns_upstream_servers.
function validateDnsUpstreamServers(v) {
  // Accept either a JSON-encoded array (legacy) or a real array (preferred).
  let arr = v;
  if (typeof v === 'string') {
    try { arr = JSON.parse(v); } catch { return 'must be a JSON array of IPv4 strings'; }
  }
  if (!Array.isArray(arr) || arr.length === 0) return 'must be a non-empty array of IPv4 strings';
  if (arr.length > 16) return 'too many upstream servers (max 16)';
  for (const s of arr) {
    if (typeof s !== 'string' || !isValidIpv4(s)) return `${s} is not a valid IPv4 address`;
  }
  return null;
}

// Each key's validator. Returns string error or null. The persisted form is
// always a plain string (that's the settings column's actual type); numeric
// and boolean shapes are normalized to strings before save.
const SETTING_SCHEMA = {
  default_gateway_position: {
    validate: v => (typeof v === 'string' && (v === 'first' || v === 'last')) ? null : 'must be "first" or "last"',
    normalize: v => v
  },
  subnet_name_template: {
    validate: v => typeof v === 'string' && v.length <= 128 ? null : 'must be a string up to 128 chars',
    normalize: v => v
  },
  dns_upstream_servers: {
    validate: validateDnsUpstreamServers,
    normalize: v => typeof v === 'string' ? v : JSON.stringify(v)
  },
  backup_schedule: {
    validate: v => typeof v === 'string' && BACKUP_SCHEDULES.has(v) ? null : `must be one of: ${[...BACKUP_SCHEDULES].join(', ')}`,
    normalize: v => v
  },
  backup_retention_count: {
    validate: v => isIntInRange(v, 1, 365) ? null : 'must be an integer 1-365',
    normalize: v => String(intOrNull(v))
  },
  // ISO-8601 timestamp. Server writes this itself; refuse arbitrary values.
  backup_last_run: {
    validate: v => typeof v === 'string' && v.length <= 64 ? null : 'must be an ISO-8601-ish string',
    normalize: v => v
  },
  geoip_enabled: {
    validate: v => isBoolStr(v) ? null : 'must be true or false',
    normalize: v => toBoolStr(v)
  },
  geoip_mode: {
    validate: v => typeof v === 'string' && GEOIP_MODES.has(v) ? null : `must be one of: ${[...GEOIP_MODES].join(', ')}`,
    normalize: v => v
  },
  geoip_proxy_port: {
    validate: v => validPortOrError(v, 'geoip_proxy_port'),
    normalize: v => String(v)
  },
  default_scan_interval: {
    validate: v => typeof v === 'string' && SCAN_INTERVALS.has(v) ? null : `must be one of: ${[...SCAN_INTERVALS].map(v => v || 'off').join(', ')}`,
    normalize: v => v === 'off' ? '' : v
  },
  default_scan_enabled: {
    validate: v => isBoolish01(v) ? null : 'must be true or false',
    normalize: v => toBool01(v)
  },
  setup_wizard_completed: {
    validate: v => isBoolStr(v) ? null : 'must be true or false',
    normalize: v => toBoolStr(v)
  },
  interface_config: {
    validate: validateInterfaceConfig,
    normalize: v => typeof v === 'string' ? v : JSON.stringify(v)
  },
  dns_enabled: {
    validate: v => isBoolStr(v) ? null : 'must be true or false',
    normalize: v => toBoolStr(v)
  },
  dns_listen_port: {
    validate: v => validPortOrError(v, 'dns_listen_port'),
    normalize: v => String(v)
  },
  dhcp_enabled: {
    validate: v => isBoolStr(v) ? null : 'must be true or false',
    normalize: v => toBoolStr(v)
  },
  update_check_enabled: {
    validate: v => isBoolStr(v) ? null : 'must be true or false',
    normalize: v => toBoolStr(v)
  },
  http_redirect_enabled: {
    validate: v => isBoolStr(v) ? null : 'must be true or false',
    normalize: v => toBoolStr(v)
  },
  // https_port / http_port can be empty ("" clears the override). Non-empty
  // values go through the shared validPortOrError so the settings endpoint
  // matches /api/interfaces/config — a mismatch here was HIGH-severity
  // finding H1 from the pre.2 ship-gate trio: /api/settings/https_port
  // accepted {"value": 22} (numeric string / privileged integer) with no
  // bind preflight, which would brick the service on the next restart.
  // The /api/settings route is admin-only so the blast radius was "authed
  // admin can wedge the appliance", but the two endpoints must agree.
  https_port: {
    validate: v => (v === '' || v === null) ? null : validPortOrError(v, 'https_port'),
    normalize: v => (v === '' || v === null) ? '' : String(v)
  },
  http_port: {
    validate: v => (v === '' || v === null) ? null : validPortOrError(v, 'http_port'),
    normalize: v => (v === '' || v === null) ? '' : String(v)
  },
  ip_history_retention_days: {
    validate: v => isIntInRange(v, 1, 3650) ? null : 'must be an integer 1-3650',
    normalize: v => String(intOrNull(v))
  },
};

const EDITABLE_KEYS = new Set(Object.keys(SETTING_SCHEMA));

function validateSetting(key, value) {
  // Use Object.hasOwn, not indexing: otherwise inherited-prototype keys like
  // "__proto__", "toString", "hasOwnProperty" return Object.prototype and
  // crash the validator (found by the injection agent's v0.4.15 rerun).
  if (typeof key !== 'string' || !Object.hasOwn(SETTING_SCHEMA, key)) {
    return { error: `Setting '${key}' cannot be modified` };
  }
  const schema = SETTING_SCHEMA[key];
  if (value === undefined || value === null) return { error: 'Value is required' };
  const err = schema.validate(value);
  if (err) return { error: `${key}: ${err}` };
  return { normalized: schema.normalize(value) };
}

// GET /api/settings — return all non-secret settings
router.get('/', requirePerm('subnets:read'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    if (!SECRET_KEYS.has(row.key)) {
      settings[row.key] = row.value;
    }
  }
  res.json(settings);
});

// PUT /api/settings/bulk — update multiple settings in one transaction (admin only)
router.put('/bulk', requireRole('admin'), (req, res) => {
  const body = req.body || {};
  const { settings } = body;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return res.status(400).json({ error: 'settings object required' });
  }

  const entries = Object.entries(settings);
  const normalized = [];
  for (const [key, value] of entries) {
    const check = validateSetting(key, value);
    if (check.error) return res.status(400).json({ error: check.error });
    normalized.push([key, check.normalized]);
  }

  const db = getDb();
  const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  const saveAll = db.transaction((pairs) => {
    for (const [key, value] of pairs) {
      stmt.run(key, value);
    }
  });
  saveAll(normalized);

  if (settings.ip_history_retention_days !== undefined) {
    pruneEvents(db);
  }

  audit(req.user.id, 'settings_bulk_updated', 'setting', null, { keys: entries.map(([k]) => k) });
  res.json({ ok: true });
});

// PUT /api/settings/:key — update a single setting
router.put('/:key', requirePerm('subnets:write'), (req, res) => {
  const { key } = req.params;
  const body = req.body || {};
  const { value } = body;

  if (!EDITABLE_KEYS.has(key)) {
    return res.status(400).json({ error: `Setting '${key}' cannot be modified` });
  }

  const check = validateSetting(key, value);
  if (check.error) return res.status(400).json({ error: check.error });

  setSetting(key, check.normalized);

  if (key === 'ip_history_retention_days') {
    const db = getDb();
    pruneEvents(db);
  }

  audit(req.user.id, 'setting_updated', 'setting', null, { key, value: check.normalized });
  res.json({ key, value: check.normalized });
});

export default router;
