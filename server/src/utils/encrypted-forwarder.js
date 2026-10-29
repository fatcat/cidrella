/**
 * The encrypted forwarder (dns-proxy/forwarder.js) as the web app sees it:
 * run in this process, reading settings through the proxy's read-only
 * connection, or in the DNS proxy process (utils/dns-proxy-mode.js), reached
 * through the proxy client.
 */
import { getSetting } from '../db/init.js';
import * as Forwarder from '../dns-proxy/forwarder.js';
import { proxySettings } from './dns-proxy-inline-db.js';
import { proxyIsSeparate } from './dns-proxy-mode.js';
import * as Client from './dns-proxy-client.js';

const separate = proxyIsSeparate();

Forwarder.configureForwarder({ setting: proxySettings.setting });

export {
  stopEncryptedForwarder,
  getAndResetForwarderMetrics,
  buildServfail,
  fitToUdp,
  forwardDoT,
  forwardDoH,
  queryUpstreams,
  heldProviders,
  releaseHolds,
  forwardPlain,
  firstUpstream,
} from '../dns-proxy/forwarder.js';

/**
 * Start, stop or reconfigure the forwarder from the settings now. In the
 * proxy process this resolves once it has, so a status read after it is
 * current.
 */
export function applyEncryptedForwarder() {
  if (!separate) return Forwarder.applyEncryptedForwarder();
  return Client.requestApplyForwarder();
}

/** The forwarder's status; from the proxy process's last report, `stale` without one. */
export function getEncryptedForwarderStatus() {
  if (!separate) return Forwarder.getEncryptedForwarderStatus();
  const reported = Client.freshProxyStatus()?.forwarder;
  if (reported) return reported;
  return {
    ...Forwarder.getEncryptedForwarderStatus(),
    mode: getSetting('forwarder_encryption') || 'off',
    stale: true,
  };
}
