/**
 * The DNS proxy's log lines, `[dns-proxy] <time> <message> <json>`, written by
 * the proxy and by the web app's watchdog alike.
 */
export function proxyLog(level, msg, extra) {
  const ts = new Date().toISOString();
  const prefix = `[dns-proxy] ${ts}`;
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  if (level === 'error') console.error(`${prefix} ERROR: ${msg}${suffix}`);
  else if (level === 'warn') console.warn(`${prefix} WARN: ${msg}${suffix}`);
  else console.log(`${prefix} ${msg}${suffix}`);
}
