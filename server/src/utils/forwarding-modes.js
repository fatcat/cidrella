/**
 * How a backup resolver is used, as a pure rule on the stored value of
 * `dns_upstream_backup_mode` (utils/forwarding-settings.js reads it from
 * settings). Kept apart so the DNS proxy process, which reads settings its own
 * way, shares the rule.
 */
export const BACKUP_MODES = Object.freeze(['failover', 'balance']);

/** The stored mode, or 'balance' for anything else. */
export function backupModeOf(value) {
  return BACKUP_MODES.includes(value) ? value : 'balance';
}
