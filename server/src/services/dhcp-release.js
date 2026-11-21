/**
 * Release a lease at the DHCP server that holds it. On the controller that
 * is its own backend while it serves DHCP; while another instance does, the
 * release is queued for that instance's next lease report
 * (sync/dhcp-release-queue.js). Every release the controller decides on by
 * itself goes through here.
 */
import { getDhcpBackend } from '../backends/index.js';
import { dhcpState } from '../sync/dhcp-active.js';
import { queueRelease } from '../sync/dhcp-release-queue.js';

/**
 * Resolves what the backend contract's releaseLease does:
 * `{ released, skipped?, error? }`. A queued release is `skipped: 'queued'`:
 * not released yet, and the caller comes back to it as it does for any other
 * lease it could not release.
 */
export async function releaseLeaseAnywhere(db, lease) {
  const state = dhcpState(db);
  if (state.here && !state.handoverFrom) return getDhcpBackend().releaseLease(lease);
  queueRelease(lease);
  return { released: false, skipped: 'queued' };
}
