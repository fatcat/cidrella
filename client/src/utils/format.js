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

export function displayOnlineStatus(isOnline) {
  if (isOnline === null || isOnline === undefined) {
    return { label: EMPTY_CELL, className: 'cell-muted', known: false };
  }
  return {
    label: isOnline ? 'Online' : 'Offline',
    className: isOnline ? 'status-text state-ok' : 'status-text state-muted',
    known: true
  };
}

export function displayExpiry(expiresAt, formatDate, { reserved = false } = {}) {
  if (reserved) return 'Never';
  if (!expiresAt) return EMPTY_CELL;
  if (expiresAt === 'infinite') return 'Never';
  return formatDate(expiresAt);
}
