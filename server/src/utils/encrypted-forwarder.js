/**
 * The encrypted forwarder (dns-proxy/forwarder.js) as the web app sees it:
 * it runs in the DNS proxy process, reached through the proxy client.
 */
import { getSetting } from '../db/init.js';
import * as Forwarder from '../dns-proxy/forwarder.js';
import * as Client from './dns-proxy-client.js';

/**
 * Start, stop or reconfigure the forwarder from the settings now. Resolves
 * once the proxy process has, so a status read after it is current.
 */
export const applyEncryptedForwarder = () => Client.requestApplyForwarder();

/** The forwarder's status; from the proxy process's last report, `stale` without one. */
export function getEncryptedForwarderStatus() {
  const reported = Client.freshProxyStatus()?.forwarder;
  if (reported) return reported;
  return {
    ...Forwarder.getEncryptedForwarderStatus(),
    mode: getSetting('forwarder_encryption') || 'off',
    stale: true,
  };
}
