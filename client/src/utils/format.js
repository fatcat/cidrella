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
