/**
 * Passive host liveness detection from the DNS backend's query log.
 *
 * Tails the log for DNS queries (logSource().querySourceIp) and marks the
 * source IP as online in ip_addresses. Also runs a periodic
 * staleness sweep to mark hosts offline when no signal has been seen.
 *
 * DHCP lease liveness is handled separately in ip-sync.js (syncLeasesToIps).
 */

import { createLogFollower } from './log-reader.js';
import { facts } from '../sync/facts.js';
import {
  markStalePassiveAddresses,
  pruneLifecycleEvents,
  retireStaleDynamicAddresses,
} from '../services/ip-lifecycle-service.js';
import { queueRegen } from './after-commit.js';
import { PASSIVE_LIVENESS_POLL_MS, PASSIVE_LIVENESS_STALE_MS } from '../config/defaults.js';
import { getService, onBackendChanged } from '../backends/index.js';
import { releaseLeaseAnywhere } from '../services/dhcp-release.js';

/**
 * Start the passive liveness watcher.
 * Polls the DNS backend's log for query source IPs and reports each client
 * as seen (sync/facts.js).
 */
export function startPassiveLivenessWatcher(db) {
  // Follows the DNS role to another backend after a stack switch. Behind the
  // proxy the clients read here were already recorded by the proxy itself;
  // reading them again costs one update per client per poll.
  let source;
  let log;
  const bind = () => {
    source = getService('dns').logSource();
    log = createLogFollower(source);
  };
  bind();
  onBackendChanged((role) => {
    if (role === 'dns') bind();
  });
  function poll() {
    const lines = log.read();

    // Extract unique source IPs from DNS query lines
    const ipsThisCycle = new Set();

    for (const line of lines) {
      const ip = source?.querySourceIp(line);
      if (!ip) continue;
      if (ip === '127.0.0.1' || ip === '::1') continue;
      ipsThisCycle.add(ip);
    }

    // Update liveness for each IP. Unknown rows are not created here because
    // dnsmasq may be logging proxy-originated queries in fallback paths.
    for (const ip of ipsThisCycle) {
      facts().clientSeen(db, ip, { createRogue: false, source: 'passive' });
    }
  }

  const interval = setInterval(poll, PASSIVE_LIVENESS_POLL_MS);
  console.log(
    `[passive-liveness] Watching ${log.path || 'no DNS log'} (poll ${PASSIVE_LIVENESS_POLL_MS / 1000}s)`,
  );

  return interval; // for cleanup in tests
}

const STALE_SWEEP_MS = 60_000;

/**
 * Every minute: mark addresses not heard from as stale (which clears rogue on
 * them), prune address history, and retire dynamic addresses offline past the
 * window. It changes the data of record, so the instance that owns it runs it.
 * The release half is async (a backend may release over its API), so one sweep
 * runs at a time. Returns the interval.
 */
export function startStaleAddressSweep(db) {
  let sweeping = false;
  async function staleSweep() {
    const staleMinutes = Math.round(PASSIVE_LIVENESS_STALE_MS / 60000);
    markStalePassiveAddresses(db, staleMinutes);
    pruneLifecycleEvents(db);
    const retirement = await retireStaleDynamicAddresses(db, {
      releaseLease: (lease) => releaseLeaseAnywhere(db, lease),
    });
    if (retirement.dnsRecordsRemoved > 0) queueRegen('regenerate_dns');
    if (retirement.retired > 0 || retirement.deferred > 0) {
      console.log(
        `[ip-retirement] retired=${retirement.retired} deferred=${retirement.deferred} ` +
          `dns=${retirement.dnsRecordsRemoved} leases=${retirement.leasesRemoved} ` +
          `sticky_skipped=${retirement.stickyRelease.skipped} sticky_failed=${retirement.stickyRelease.failed}`,
      );
    }
  }
  return setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    staleSweep()
      .catch((err) => console.warn('[ip-retirement] sweep failed:', err.message))
      .finally(() => {
        sweeping = false;
      });
  }, STALE_SWEEP_MS);
}
