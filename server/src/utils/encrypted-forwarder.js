/**
 * The forwarder (dns-proxy/forwarder.js), reading the web app's settings.
 */
import { getSetting } from '../db/init.js';
import { configureForwarder } from '../dns-proxy/forwarder.js';

configureForwarder({ setting: (key) => getSetting(key) });

export {
  applyEncryptedForwarder,
  stopEncryptedForwarder,
  getEncryptedForwarderStatus,
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
