/**
 * The DNS proxy's query log line: one line per answered query, written into
 * the DNS backend's log when that backend keeps no query log of its own
 * (PowerDNS; utils/query-log.js writes it). Shaped like dnsmasq's
 * `query[A] name from client` so the log viewer styles it as a query, with
 * the answer on the same line:
 *
 *   Oct 11 13:30:11 proxy: query[A] host.example from 10.0.0.5, NOERROR 93.184.216.34, 12 ms
 *   Oct 11 13:30:12 proxy: query[AAAA] ads.example from fd00::5, blocked (blocklist ads), 0 ms
 *
 * Commas separate the parts because an IPv6 address holds colons. The time is
 * local and syslog-style, as PowerDNS writes its own lines into the same file.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** `Oct 11 13:30:11` in local time, the stamp PowerDNS puts on its lines. */
export function syslogTime(date) {
  return (
    `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, ' ')} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function outcome({ action, blockReason, responseCode, resolvedIp, failure }) {
  if (action === 'blocked_blocklist')
    return `blocked (blocklist${blockReason ? ` ${blockReason}` : ''})`;
  if (action === 'blocked_geoip') return `blocked (geoip${blockReason ? ` ${blockReason}` : ''})`;
  const parts = [responseCode || 'UNKNOWN'];
  if (resolvedIp) parts.push(resolvedIp);
  if (failure) parts.push(`(${failure})`);
  return parts.join(' ');
}

/**
 * One query line from the fields the proxy hands to logDnsQuery
 * (db/duckdb.js), newline included.
 */
export function formatQueryLine(entry, now = new Date()) {
  const name = entry.domain || '.';
  const type = entry.queryType || 'A';
  const client = entry.clientIp || 'unknown';
  const ms = entry.latencyUs != null ? Math.round(entry.latencyUs / 1000) : null;
  const tail = ms != null ? `, ${ms} ms` : '';
  return `${syslogTime(now)} proxy: query[${type}] ${name} from ${client}, ${outcome(entry)}${tail}\n`;
}

const QUERY_LINE_RE = / proxy: query\[[^\]]+\] \S+ from ([^\s,]+),/;

/** The client address of a proxy query line, or null for any other line. */
export function parseQueryLine(line) {
  const client = line.match(QUERY_LINE_RE)?.[1];
  return client && client !== 'unknown' ? client : null;
}
