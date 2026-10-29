/**
 * Which file the DNS proxy's query lines go to: the DNS backend's log, for a
 * backend whose logSource() says `proxyQueries`. PowerDNS keeps no query log
 * while the proxy is in front of it, so the proxy's lines are what the log
 * viewer, the metrics aggregator and passive liveness read there. With
 * dnsmasq, which logs its own queries, nothing is written. The writing is
 * utils/query-log-writer.js.
 */
import { getService, onBackendChanged } from '../backends/index.js';
import { setQueryLogPath, resetQueryLogWriter } from './query-log-writer.js';

let bound = false;
let unlisten = null;

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

/** Follow the DNS role: the log to write, or none. */
export function bindQueryLog() {
  setQueryLogPath(queryLogPath());
  if (!bound) {
    bound = true;
    unlisten = onBackendChanged((role) => {
      if (role === 'dns') bindQueryLog();
    });
  }
}

/** Tests: forget the binding and close the file. */
export function resetQueryLog() {
  resetQueryLogWriter();
  unlisten?.();
  unlisten = null;
  bound = false;
}
