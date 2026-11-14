/**
 * Log lines for a CIDRella process, `[<tag>] <time> <message> <json>`: the
 * DNS proxy's (dns-proxy/log.js) and the privileged helper's.
 */
export function createLog(tag) {
  return function log(level, msg, extra) {
    const prefix = `[${tag}] ${new Date().toISOString()}`;
    const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
    if (level === 'error') console.error(`${prefix} ERROR: ${msg}${suffix}`);
    else if (level === 'warn') console.warn(`${prefix} WARN: ${msg}${suffix}`);
    else console.log(`${prefix} ${msg}${suffix}`);
  };
}
