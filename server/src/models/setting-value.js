/**
 * What a stored setting reads as: the raw text from the settings table, JSON
 * parsed for the keys stored as JSON, a number for the numeric ones, and the
 * default when nothing is stored. db/init.js's getSetting and the DNS proxy's
 * own connection (dns-proxy/db.js) both read settings through it.
 */

const JSON_KEYS = new Set([
  'dns_upstream_servers',
  'dns_upstream_backup_servers',
  'dns_soa_defaults',
  'forwarder_encrypted_upstreams',
]);
const INTEGER_KEYS = new Set(['audit_log_retention_days']);

/** The value of `key` stored as `raw` (undefined or null when absent). */
export function settingValue(key, raw, defaults) {
  if (JSON_KEYS.has(key)) {
    try {
      return raw ? JSON.parse(raw) : defaults[key];
    } catch {
      return defaults[key];
    }
  }
  if (INTEGER_KEYS.has(key)) return raw != null ? parseInt(raw, 10) : defaults[key];
  if (raw != null) return raw;
  return defaults[key] ?? null;
}
