/**
 * Backup file names from a template: the variables, the rule for a valid
 * template, and the rendering. Shared with the client (`@shared/backup-name.js`)
 * for Backup settings' validation and preview, so this module stays pure: no
 * fs, os or database. backup.js gathers the values and picks the counter.
 *
 * A name never identifies a backup. Archives are recognized by the manifest
 * they carry (backup.js, readLeadingManifest), so a template is free to drop
 * every fixed part.
 */

/** The variables a template may use, with an example value for the preview. */
export const BACKUP_NAME_VARIABLES = Object.freeze([
  { key: 'hostname', description: "The host's short name", example: 'cidrella' },
  { key: 'version', description: 'The CIDRella release', example: '0.6.4' },
  { key: 'schema', description: 'The database schema version', example: '94' },
  { key: 'stack', description: 'dnsmasq, or pdns-kea for PowerDNS + Kea', example: 'dnsmasq' },
  { key: 'trigger', description: 'manual or scheduled', example: 'manual' },
  { key: 'date', description: 'The date, UTC (YYYY-MM-DD)', example: '2026-11-11' },
  { key: 'time', description: 'The time, UTC (HH-MM-SS)', example: '13-42-09' },
]);

/** What every backup was called before templates; the stored default. */
export const DEFAULT_BACKUP_NAME_TEMPLATE = 'cidrella-backup-{{date}}_{{time}}';

/** Added by the app, never part of the template. */
export const BACKUP_EXTENSION = '.tar.gz';

export const MAX_TEMPLATE_LENGTH = 100;

/** The counter appended when a name is not unique: 00 to FF. */
export const COUNTER_LIMIT = 256;

const KNOWN = new Set(BACKUP_NAME_VARIABLES.map((v) => v.key));
const TOKEN = /\{\{([a-z]+)\}\}/g;
const SAFE_TEXT = /^[A-Za-z0-9._-]*$/;
const UNSAFE_CHARS = /[^A-Za-z0-9._-]/g;

/** One value made safe for a file name: anything else becomes `-`. */
export function sanitizeNameValue(value) {
  return String(value ?? '').replace(UNSAFE_CHARS, '-');
}

/** Why a template cannot be used, or null when it can. */
export function validateBackupNameTemplate(template) {
  if (typeof template !== 'string' || template.trim() === '') return 'Enter a file name';
  if (template.length > MAX_TEMPLATE_LENGTH) {
    return `Keep the file name to ${MAX_TEMPLATE_LENGTH} characters or fewer`;
  }
  for (const [, key] of template.matchAll(TOKEN)) {
    if (!KNOWN.has(key)) return `Unknown variable {{${key}}}`;
  }
  const literal = template.replace(TOKEN, '');
  if (/[{}]/.test(literal)) return 'A variable is written {{name}}, with two braces each side';
  if (!SAFE_TEXT.test(literal)) {
    return 'Use letters, digits, dots, dashes and underscores; no spaces or slashes';
  }
  if (template.startsWith('.')) return 'The file name cannot start with a dot';
  if (template.toLowerCase().endsWith(BACKUP_EXTENSION)) {
    return `Leave out ${BACKUP_EXTENSION}; it is added for you`;
  }
  return null;
}

/** True when the template alone tells backups apart: it has both date and time. */
export function templateIsUnique(template) {
  return template.includes('{{date}}') && template.includes('{{time}}');
}

/** The template with each variable replaced; values are sanitized. No extension. */
export function renderBackupName(template, values) {
  return template.replace(TOKEN, (_, key) => sanitizeNameValue(values[key]));
}

/** The date and time variables for one moment, UTC. */
export function timeValues(date) {
  const iso = date.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19).replaceAll(':', '-') };
}

/** The example values, for a preview; `overrides` replaces any of them. */
export function exampleValues(overrides = {}) {
  const values = Object.fromEntries(BACKUP_NAME_VARIABLES.map((v) => [v.key, v.example]));
  return { ...values, ...overrides };
}

/** `-00` to `-FF`. */
export function counterSuffix(n) {
  return `-${n.toString(16).toUpperCase().padStart(2, '0')}`;
}
