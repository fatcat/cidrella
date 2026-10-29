/**
 * Where the DNS proxy's reports land in the web app: analytics rows into
 * DuckDB, the clients it saw into passive liveness (through the lifecycle
 * rules in ip-liveness.js), and Resolution Map events into the feed. The
 * proxy running inside the web app calls these per query; the proxy process
 * sends them in batches (utils/dns-proxy-client.js).
 */
import { getDb } from '../db/init.js';
import { logDnsQuery } from '../db/duckdb.js';
import { recordDnsQueryLiveness } from '../utils/ip-liveness.js';
import { recordResolution } from '../utils/resolution-feed.js';
import { proxyLog } from '../dns-proxy/log.js';

export function sinkQueryRow(entry) {
  logDnsQuery(entry);
}

export function sinkClientSeen(clientIp) {
  try {
    recordDnsQueryLiveness(getDb(), clientIp, { createRogue: true, source: 'passive' });
  } catch (err) {
    proxyLog('warn', 'Failed to record DNS-query liveness', { clientIp, error: err.message });
  }
}

// `at` is when the proxy saw it, for an event that waited in its outbox.
export function sinkResolution(event) {
  const { at, ...rest } = event;
  recordResolution(rest, Number.isFinite(at) ? at : undefined);
}
