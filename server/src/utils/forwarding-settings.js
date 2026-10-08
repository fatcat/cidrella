/**
 * Where forwarded queries go, read from settings. Each mode has a primary
 * resolver and an optional backup:
 *
 * - Plaintext: `dns_upstream_servers` (the primary's addresses) and
 *   `dns_upstream_backup_servers`. dnsmasq gets them as one list, primary
 *   first.
 * - Encrypted: `forwarder_encrypted_upstreams`, [primary, backup?].
 *
 * `dns_upstream_backup_mode` says how the backup is used. 'failover' asks it
 * only when the primary gives no answer: dnsmasq's strict-order for plaintext,
 * the encrypted forwarder always starting at the primary. 'balance' spreads
 * queries: the encrypted forwarder takes turns, and dnsmasq favors whichever
 * server answered fastest lately (not strict turns, dnsmasq has none).
 */
import { getSetting } from '../db/init.js';

export const BACKUP_MODES = Object.freeze(['failover', 'balance']);

/** The plaintext servers in the order dnsmasq should know them. */
export function plainUpstreams() {
  return [
    ...(getSetting('dns_upstream_servers') || []),
    ...(getSetting('dns_upstream_backup_servers') || []),
  ];
}

export function backupMode() {
  const mode = getSetting('dns_upstream_backup_mode');
  return BACKUP_MODES.includes(mode) ? mode : 'balance';
}
