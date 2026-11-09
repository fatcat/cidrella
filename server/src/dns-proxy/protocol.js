/**
 * What the web app and the DNS proxy process say over the proxy's Unix
 * socket. The framing (one JSON object per line, bounded) is ipc/framing.js.
 *
 * web app to proxy:
 *   hello {v, codeId}       first, on every connect
 *   config {config}         where to listen and forward (see utils/dns-proxy.js)
 *   reload {what, path?}    read something again (RELOADERS in main.js)
 *   drain {id}              the counters since the last drain, as drain-result
 *   apply-forwarder {id}    restart the encrypted forwarder, answered by status
 *   refresh-forwarder       apply the forwarder's settings if they changed
 *   db-release {id}         close the database until the next hello (a restore)
 *   shutdown                exit; the supervisor starts the proxy again
 *
 * proxy to web app:
 *   hello {v, codeId, pid}
 *   status {...}            every STATUS_INTERVAL_MS, and the heartbeat
 *   drain-result {id, metrics, forwarder}
 *   db-released {id}
 *   applied {id, ...status} the forwarder restarted, and the status after it
 *   rows {rows}             analytics rows, for DuckDB
 *   liveness {clients}      client addresses seen
 *   resolutions {events}    Resolution Map events
 */

export const PROTOCOL_VERSION = 1;
export const STATUS_INTERVAL_MS = 1000;

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
