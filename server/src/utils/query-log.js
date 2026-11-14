/**
 * Which file the DNS proxy's query lines go to: the DNS backend's log, for a
 * backend whose logSource() says `proxyQueries`. PowerDNS keeps no query log
 * while the proxy is in front of it, so the proxy's lines are what the log
 * viewer, the metrics aggregator and passive liveness read there. With
 * dnsmasq, which logs its own queries, nothing is written. The writing is
 * utils/query-log-writer.js; the proxy facade (utils/dns-proxy.js) hands
 * it this path and hands it again when the DNS role moves.
 */
import { getService } from '../backends/index.js';

/** Where the proxy's query lines go for the DNS backend serving now, or null. */
export function queryLogPath() {
  let source = null;
  try {
    source = getService('dns').logSource();
  } catch {
    /* no backend yet */
  }
  return source?.proxyQueries ? source.path : null;
}

