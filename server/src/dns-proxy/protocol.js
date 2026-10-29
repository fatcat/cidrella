/**
 * How the web app and the DNS proxy process talk over the proxy's Unix
 * socket: one JSON object per line. A line longer than MAX_LINE_BYTES ends
 * the connection, so a confused peer cannot make the other side buffer
 * without limit.
 *
 * web app to proxy:
 *   hello {v, codeId}       first, on every connect
 *   config {config}         where to listen and forward (see utils/dns-proxy.js)
 *   reload {what, path?}    read something again (RELOADS)
 *   drain {id}              the counters since the last drain, as drain-result
 *   apply-forwarder {id}    restart the encrypted forwarder, answered by status
 *   shutdown                exit; the supervisor starts the proxy again
 *
 * proxy to web app:
 *   hello {v, codeId, pid}
 *   status {...}            every STATUS_INTERVAL_MS, and the heartbeat
 *   drain-result {id, metrics, forwarder}
 *   applied {id}
 *   rows {rows}             analytics rows, for DuckDB
 *   liveness {clients}      client addresses seen
 *   resolutions {events}    Resolution Map events
 */

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 1024 * 1024;
export const STATUS_INTERVAL_MS = 1000;

/** What `reload` can name. */
export const RELOADS = new Set([
  'all',
  'blocklist',
  'allowlist',
  'filtering-overrides',
  'geoip-rules',
  'geoip-allowlist',
  'mmdb',
  'unload-mmdb',
  'reset-stats',
]);

export function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

/**
 * A line splitter for one connection. `onMessage` gets each parsed object;
 * `onError` gets an oversized line or one that is not a JSON object, and the
 * caller ends the connection.
 */
export function createDecoder(onMessage, onError) {
  let pending = '';
  let failed = false;
  return function feed(chunk) {
    if (failed) return;
    pending += chunk.toString('utf8');
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        message = null;
      }
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        failed = true;
        onError(new Error('not a protocol message'));
        return;
      }
      onMessage(message);
    }
    if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
      failed = true;
      onError(new Error(`a line passed ${MAX_LINE_BYTES} bytes`));
    }
  };
}

// The counters carry Maps, which JSON does not; they go as [key, value] pairs.
export function metricsToWire(metrics) {
  return {
    ...metrics,
    blocklistHits: {
      ...metrics.blocklistHits,
      categoryHits: [...metrics.blocklistHits.categoryHits],
    },
    countryHits: [...metrics.countryHits],
  };
}

export function metricsFromWire(wire) {
  return {
    ...wire,
    blocklistHits: {
      ...wire.blocklistHits,
      categoryHits: new Map(wire.blocklistHits.categoryHits),
    },
    countryHits: new Map(wire.countryHits),
  };
}
