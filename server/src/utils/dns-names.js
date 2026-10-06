/**
 * DNS record names under the zone-file rule (docs/ARCHITECTURE.md, Canonical
 * IP Model). A name ending in '.' is absolute; every other name is relative
 * to its zone, dotted or not. Pure and dependency-free, so it can sit under
 * the client's @shared alias (client/shared-modules.js) if the UI ever needs
 * to show a record's full name before saving it.
 */

/** Lowercase, trimmed, without a trailing dot. Zone names are stored this way. */
export function normalizeDnsName(name) {
  return String(name || '')
    .trim()
    .replace(/\.$/, '')
    .toLowerCase();
}

/**
 * The canonical stored form of a record name in `zoneName`: lowercase; `@` for
 * the apex; relative when it is under the zone (with or without the dot);
 * otherwise as given, keeping the trailing dot that marks it absolute.
 *
 * `r.name || '.' || z.name` in SQL is a correct FQDN only for a relative name,
 * so SQL that builds one treats `@` as the zone and a name ending in '.' as
 * the name without it (models/dns-record.js, cnameTargetError). Every write
 * path (the API routes, the Pi-hole import, DHCP lease and reservation sync)
 * stores through this, so SQLite's case-sensitive `=` matches what the
 * JavaScript reader builds (REVIEW.md duplicate-logic audit #8).
 */
export function normalizeRecordNameForZone(name, zoneName) {
  const raw = String(name || '')
    .trim()
    .toLowerCase();
  const absolute = raw.endsWith('.');
  const normalized = raw.replace(/\.$/, '');
  const zone = normalizeDnsName(zoneName);
  if (normalized === '@' || normalized === zone) return '@';
  if (normalized.endsWith(`.${zone}`)) return normalized.slice(0, -(zone.length + 1));
  return absolute ? `${normalized}.` : normalized;
}

/** The FQDN a record name in `zoneName` is served as, without a trailing dot. */
export function fqdnForRecordName(recordName, zoneName) {
  const raw = String(recordName || '')
    .trim()
    .toLowerCase();
  const normalized = raw.replace(/\.$/, '');
  const zone = normalizeDnsName(zoneName);
  if (normalized === '@' || normalized === zone) return zoneName;
  if (normalized.endsWith(`.${zone}`)) return normalized;
  if (raw.endsWith('.')) return normalized;
  return `${normalized}.${zoneName}`;
}
