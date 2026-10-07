/**
 * DNS names as a zone file writes them, with the zone as its $ORIGIN: the zone
 * itself is @, a name under it is relative, and any other name is absolute,
 * with a trailing dot. The DNS table shows names this way when "Show domain
 * names" is off.
 */

// The types whose value is a name (a target), not an address or text.
const TARGET_TYPES = new Set(['CNAME', 'MX', 'SRV', 'PTR']);

export function zoneFileName(name, zoneName) {
  const full = String(name ?? '')
    .trim()
    .replace(/\.$/, '');
  const zone = String(zoneName ?? '')
    .trim()
    .replace(/\.$/, '');
  if (!full || !zone) return name;
  const lower = full.toLowerCase();
  const origin = zone.toLowerCase();
  if (lower === origin) return '@';
  if (lower.endsWith(`.${origin}`)) return full.slice(0, -(origin.length + 1));
  return `${full}.`;
}

export function zoneFileValue(type, value, zoneName) {
  return TARGET_TYPES.has(type) ? zoneFileName(value, zoneName) : value;
}
