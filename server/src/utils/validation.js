/**
 * Shared input validators used across multiple routes.
 *
 * Previously each route hand-rolled its own checks, which bit us in
 * v0.4.15-pre.1: a port-coercion bypass on `PUT /api/interfaces/config`
 * was "fixed" by copy-pasting the validator from settings.js instead of
 * sharing it, and the two copies drifted immediately. This module is the
 * single source of truth, drift becomes impossible.
 */

/**
 * Strip control characters (CR/LF, ANSI escape introducers) from a
 * request-derived value before embedding it in a log line, so request
 * data can't forge log entries or smuggle terminal escapes into the
 * journal. Pass the result as a printf-style argument (`%s`), never
 * interpolated into the format string itself.
 */
export function sanitizeForLog(v) {
  // The explicit CR/LF pass is redundant with the control-char sweep below,
  // but it matches the newline-removal pattern CodeQL recognizes as a
  // log-injection barrier, the range form alone is not modeled.
  return String(v).replace(/[\r\n]/g, ' ').replace(/[\x00-\x1f\x7f]/g, ' ');
}

/**
 * Require `v` to be a real JS integer in [1, 65535]. Rejects numeric
 * strings, single-element arrays, booleans, and everything else that
 * would be silently coerced by `Number()` or `parseInt()`. Returns an
 * error string suitable for a 400 body, or null when valid.
 */
export function validPortOrError(v, field) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
    return `${field} must be an integer 1–65535`;
  }
  return null;
}

/**
 * Validate the `interfaces` shape used by both `/api/settings/interface_config`
 * and `/api/interfaces/config`. Accepts either an object or a JSON-encoded
 * string (legacy settings-bulk path). Returns an error string or null.
 *
 * Keys must match `^[a-zA-Z0-9._-]{1,32}$` AND not be a reserved JS
 * property name. The regex alone is NOT sufficient, an earlier version
 * of this function claimed in a comment that the regex blocked
 * prototype-key injection, but keys like `constructor`, `__proto__`,
 * `toString`, `hasOwnProperty` all match `[a-zA-Z0-9._-]`. The trio
 * pentest (2026-04-24) confirmed that `{"interfaces":{"constructor":...}}`
 * was accepted and then crashed the server on the next restart because
 * `sysIfaces['constructor']` resolves via the prototype chain to the
 * Object constructor, not undefined, and the downstream `for…of` threw.
 * Consumers also use `Object.hasOwn` as defense-in-depth, but the
 * validator is the correct place to reject the write.
 */
const RESERVED_OBJECT_KEYS = new Set([
  '__proto__', 'constructor', 'prototype',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  'toString', 'toLocaleString', 'valueOf',
]);
export function validateInterfaceConfig(v) {
  let obj = v;
  if (typeof v === 'string') {
    try { obj = JSON.parse(v); } catch { return 'must be a JSON object'; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'must be an object';
  for (const [ifName, cfg] of Object.entries(obj)) {
    if (typeof ifName !== 'string' || !/^[a-zA-Z0-9._-]{1,32}$/.test(ifName)) {
      return `invalid interface name: ${ifName}`;
    }
    if (RESERVED_OBJECT_KEYS.has(ifName)) {
      return `reserved interface name: ${ifName}`;
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      return `interface ${ifName}: config must be an object`;
    }
    if ('dns' in cfg && typeof cfg.dns !== 'boolean') {
      return `interface ${ifName}: dns must be boolean`;
    }
    if ('dhcp' in cfg && typeof cfg.dhcp !== 'boolean') {
      return `interface ${ifName}: dhcp must be boolean`;
    }
  }
  return null;
}

export const GEOIP_MODES = new Set(['blocklist', 'allowlist']);

export function isIntInRange(v, lo, hi) {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}

export function validateSoaFields(fields = {}) {
  const {
    soa_primary_ns,
    soa_admin_email,
    soa_refresh,
    soa_retry,
    soa_expire,
    soa_minimum_ttl
  } = fields;

  const domainLike = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
  for (const [field, value] of [['soa_primary_ns', soa_primary_ns], ['soa_admin_email', soa_admin_email]]) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') return `${field} must be a string`;
    const text = value.trim();
    if (text !== value || text.length > 253 || text.includes('..') || !domainLike.test(text)) {
      return `${field} must be a DNS-safe name`;
    }
  }

  for (const [field, value] of [
    ['soa_refresh', soa_refresh],
    ['soa_retry', soa_retry],
    ['soa_expire', soa_expire],
    ['soa_minimum_ttl', soa_minimum_ttl]
  ]) {
    if (value === undefined || value === null || value === '') continue;
    if (!isIntInRange(value, 0, 2147483647)) return `${field} must be an integer 0-2147483647`;
  }

  return null;
}
