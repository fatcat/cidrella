/**
 * The outbox that holds what the proxy reports while the web app is away. The
 * socket itself is ipc/server.js.
 */
import { boundedQueue } from '../ipc/server.js';

export const OUTBOX_LIMITS = { rows: 50_000, resolutions: 2_000, liveness: 10_000 };
export const OUTBOX_BATCH = 500;

/**
 * What the proxy reports, held until the web app takes it: analytics rows,
 * Resolution Map events, and client addresses seen (each address once).
 * Each kind is bounded; past its limit the oldest go and are counted.
 */
export function createOutbox(limits = OUTBOX_LIMITS) {
  const rows = boundedQueue(limits.rows);
  const resolutions = boundedQueue(limits.resolutions);
  let liveness = new Set();
  let livenessDropped = 0;

  return {
    row: (entry) => rows.push(entry),
    resolution: (event) => resolutions.push(event),
    client(ip) {
      if (liveness.has(ip)) return;
      liveness.add(ip);
      if (liveness.size > limits.liveness) {
        liveness.delete(liveness.values().next().value);
        livenessDropped++;
      }
    },
    rowCount: () => rows.size(),
    /** Send what is held, in batches, for as long as `send` takes them. */
    flush(send) {
      for (const [queue, type, key] of [
        [rows, 'rows', 'rows'],
        [resolutions, 'resolutions', 'events'],
      ]) {
        while (queue.size() > 0) {
          const batch = queue.take(OUTBOX_BATCH);
          if (!send({ type, [key]: batch })) {
            queue.unshift(batch);
            return;
          }
        }
      }
      if (liveness.size > 0) {
        const clients = [...liveness];
        if (send({ type: 'liveness', clients })) liveness = new Set();
      }
    },
    dropped: () => ({
      rows: rows.dropped(),
      resolutions: resolutions.dropped(),
      liveness: livenessDropped,
    }),
  };
}
