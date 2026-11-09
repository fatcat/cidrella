/**
 * The DNS proxy's log lines, `[dns-proxy] <time> <message> <json>`, written by
 * the proxy and by the web app's watchdog alike.
 */
import { createLog } from '../ipc/log.js';

export const proxyLog = createLog('dns-proxy');
