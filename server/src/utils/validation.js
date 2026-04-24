/**
 * Shared input validators used across multiple routes.
 *
 * Previously each route hand-rolled its own checks, which bit us in
 * v0.4.15-pre.1: a port-coercion bypass on `PUT /api/interfaces/config`
 * was "fixed" by copy-pasting the validator from settings.js instead of
 * sharing it, and the two copies drifted immediately. This module is the
 * single source of truth — drift becomes impossible.
 */

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
 * property name. The regex alone is NOT sufficient — an earlier version
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
