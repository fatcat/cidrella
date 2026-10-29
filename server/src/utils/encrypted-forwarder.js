/**
 * The forwarder (dns-proxy/forwarder.js), reading settings through the
 * proxy's own read-only connection.
 */
import { configureForwarder } from '../dns-proxy/forwarder.js';
import { proxySettings } from './dns-proxy-inline-db.js';

configureForwarder({ setting: proxySettings.setting });

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
