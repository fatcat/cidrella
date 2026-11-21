/**
 * Lease releases the controller has decided on while another instance serves
 * DHCP. The controller cannot reach that instance's DHCP server, so a release
 * waits here and rides back in the answer to its next lease report
 * (sync/lease-intake.js); the instance releases it at its own server.
 *
 * Kept in memory on purpose. Whoever asks for a release asks again: the
 * stale-address sweep keeps an address it could not release for its next
 * pass a minute later, so a release lost to a restart is queued again. A
 * release is done when a report no longer holds the lease, and one nobody
 * has acted on is forgotten after HOLD_MS.
 */
const HOLD_MS = 10 * 60_000;
const MAX_QUEUED = 5000;

// key -> { lease, at }
const waiting = new Map();

const keyOf = (lease) => `${lease.ip}|${lease.duid || lease.mac || ''}`;

/** Queue a BackendLease for release. */
export function queueRelease(lease, now = Date.now()) {
  waiting.delete(keyOf(lease));
  // The oldest goes when the queue is full: it has waited longest unanswered.
  if (waiting.size >= MAX_QUEUED) waiting.delete(waiting.keys().next().value);
  waiting.set(keyOf(lease), { lease, at: now });
}

/**
 * The queued releases a lease report still holds, for the answer to it. Ones
 * the report no longer holds are done, and ones held too long are dropped.
 */
export function releasesFor(leases, now = Date.now()) {
  if (waiting.size === 0) return [];
  const held = new Set(leases.map(keyOf));
  const out = [];
  for (const [key, entry] of waiting) {
    if (now - entry.at > HOLD_MS || !held.has(key)) waiting.delete(key);
    else out.push(entry.lease);
  }
  return out;
}

export const queuedReleases = () => waiting.size;

/** Forget everything queued (tests, and a DHCP move: the leases change hands). */
export function clearReleases() {
  waiting.clear();
}
