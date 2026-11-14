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
import { ENCRYPTED_FORWARDER_PORT } from '../config/defaults.js';
import { BACKUP_MODES, backupModeOf } from './forwarding-modes.js';

export { BACKUP_MODES };

/** The plaintext servers in the order dnsmasq should know them. */
export function plainUpstreams() {
  return [
    ...(getSetting('dns_upstream_servers') || []),
    ...(getSetting('dns_upstream_backup_servers') || []),
  ];
}

export function backupMode() {
  return backupModeOf(getSetting('dns_upstream_backup_mode'));
}

/**
 * Where a DNS backend sends the queries it recurses for: the forwarder on
 * loopback, in every mode. While the DNS proxy process is down in bypass
 * (`dns_forwarder_down`, set by the watchdog) the forwarder is down with it,
 * so in plaintext mode the backend asks the plain servers itself, on port 53.
 * With DoT or DoH it keeps the forwarder: recursion fails rather than send
 * in the clear what the settings say goes encrypted.
 */
export function recursionTargets() {
  const forwarderDown = getSetting('dns_forwarder_down') === 'true';
  const plaintext = (getSetting('forwarder_encryption') || 'off') === 'off';
  if (forwarderDown && plaintext && plainUpstreams().length > 0) {
    return plainUpstreams().map((address) => ({ address, port: 53 }));
  }
  return [{ address: '127.0.0.1', port: ENCRYPTED_FORWARDER_PORT }];
}
