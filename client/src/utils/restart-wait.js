// Waiting out a restart of this box's service: a restore, or joining a
// controller, ends with the process exiting and systemd starting it again
// some seconds later (RestartSec). Sign-in sent before it is back is refused.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Any HTTP answer means the service is up, a 401 from a token the new
// database does not know included, so this uses fetch rather than the API
// client and its 401 interceptor.
async function answers() {
  try {
    await fetch('/api/health', { cache: 'no-store' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve once the service has gone away and answers again. If it is not
 * seen going within `goneWithinMs` it restarted between two looks, or is not
 * restarting: carry on. Gives up waiting for it to come back after
 * `backWithinMs`.
 */
export async function waitForRestart({
  goneWithinMs = 15_000,
  backWithinMs = 120_000,
  everyMs = 1000,
} = {}) {
  const goneBy = Date.now() + goneWithinMs;
  let gone = false;
  while (!gone && Date.now() < goneBy) {
    gone = !(await answers());
    if (!gone) await sleep(everyMs);
  }
  if (!gone) return;
  const backBy = Date.now() + backWithinMs;
  while (Date.now() < backBy) {
    await sleep(everyMs);
    if (await answers()) return;
  }
}
