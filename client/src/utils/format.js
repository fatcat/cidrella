/**
 * Format a number with locale-aware separators.
 */
export function formatNumber(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString();
}

/**
 * Extract a user-friendly error message from an API error.
 */
export function apiError(err) {
  return err.response?.data?.error || err.message;
}

/**
 * Strip the domain suffix from a hostname for display.
 * Returns the hostname as-is if it doesn't end with the domain,
 * or an empty string / dash placeholder if hostname is falsy.
 */
export function displayHostname(hostname, domainName) {
  if (!hostname || !hostname.trim()) return '';
  if (domainName && hostname.endsWith('.' + domainName)) {
    return hostname.slice(0, -(domainName.length + 1));
  }
  return hostname;
}

export const EMPTY_CELL = '—';

/**
 * A byte count as a human-readable size.
 *
 * There were two of these. BackupSettings.vue's formatSize walked the unit list;
 * HeaderBar.vue's formatBytes only knew GB and MB, so 1500 bytes rendered as
 * "0 MB". They also disagreed on the missing-value placeholder, one returning
 * "0 B" and the other "--", which is a third spelling of the empty cell.
 *
 * A genuine zero is "0 B". A missing value is EMPTY_CELL, like every other cell.
 * See REVIEW.md, duplicate-logic audit #44.
 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return EMPTY_CELL;
  const n = Number(bytes);
  if (!Number.isFinite(n)) return EMPTY_CELL;
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = Math.abs(n);
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i += 1; }
  const sign = n < 0 ? '-' : '';
  return `${sign}${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function displayCell(value) {
  if (value === null || value === undefined) return EMPTY_CELL;
  const text = String(value).trim();
  return text ? text : EMPTY_CELL;
}

export function displayHostnameCell(hostname, domainName) {
  return displayHostname(hostname, domainName) || EMPTY_CELL;
}

export function displayMacAddress(mac) {
  if (!mac || !String(mac).trim()) return EMPTY_CELL;
  return String(mac).trim().toUpperCase();
}

/**
 * The liveness flag as a three-state value: true, false, or null for "unknown".
 *
 * `is_online` arrives from the API as a SQLite integer, but it reaches the client
 * as a string on some paths, which is why the classifier in ipLifecycleDisplay.js
 * has always tested `'1'` explicitly (and why one of its tests is named "even
 * when flags arrive as strings"). Plain truthiness is therefore wrong: the string
 * '0' is truthy in JavaScript, so an offline host read as Online.
 *
 * Null is deliberately distinct from false. "We have never seen this address"
 * and "this address is down" are different facts, and the UI shows them
 * differently, so collapsing them loses information.
 *
 * Matches truthy() in server/src/models/ip-view.js for the true case, which is
 * what keeps the client classifier in step with the server one.
 * See REVIEW.md, duplicate-logic audit #48.
 */
export function isOnlineFlag(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

export function displayOnlineStatus(isOnline) {
  const state = isOnlineFlag(isOnline);
  if (state === null) {
    return { label: EMPTY_CELL, className: 'cell-muted', known: false };
  }
  return {
    label: state ? 'Online' : 'Offline',
    className: state ? 'status-text state-ok' : 'status-text state-muted',
    known: true
  };
}

export function displayExpiry(expiresAt, formatDate, { reserved = false } = {}) {
  if (reserved) return 'Never';
  if (!expiresAt) return EMPTY_CELL;
  if (expiresAt === 'infinite') return 'Never';
  return formatDate(expiresAt);
}

/**
 * Label for a subnet in a picker or tree node: "10.0.0.0/24 — Office LAN",
 * falling back to the CIDR alone when there is no name.
 *
 * This was written out four times with three different null behaviours
 * (duplicate-logic audit #60/#F17). Two of them interpolated a missing name
 * directly, so a subnet with no name rendered "10.0.0.0/24 — undefined" in the
 * network and VLAN settings pickers.
 *
 * The em-dash here is the documented `value — value` label separator and is an
 * intentional survivor of the repo prose rule, not prose.
 */
export function subnetLabel(subnet) {
  if (!subnet || !subnet.cidr) return '';
  const name = typeof subnet.name === 'string' ? subnet.name.trim() : '';
  return name ? `${subnet.cidr} — ${name}` : subnet.cidr;
}
