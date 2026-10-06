/**
 * Passive host liveness detection from the DNS backend's query log.
 *
 * Tails the log for DNS queries (logSource().querySourceIp) and marks the
 * source IP as online in ip_addresses. Also runs a periodic
 * staleness sweep to mark hosts offline when no signal has been seen.
 *
 * DHCP lease liveness is handled separately in ip-sync.js (syncLeasesToIps).
 */

import fs from 'fs';
import { readLogTail } from './log-reader.js';
import { recordDnsQueryLiveness } from './ip-liveness.js';
import {
  markStalePassiveAddresses,
  pruneLifecycleEvents,
  retireStaleDynamicAddresses,
} from '../services/ip-lifecycle-service.js';
import { queueRegen } from './after-commit.js';
import { PASSIVE_LIVENESS_POLL_MS, PASSIVE_LIVENESS_STALE_MS } from '../config/defaults.js';
import { getDhcpBackend, getService } from '../backends/index.js';

/**
 * Start the passive liveness watcher.
 * Polls the DNS backend's log for query source IPs and updates ip_addresses.
 * Without a log to read, only the staleness sweep runs.
 */
export function startPassiveLivenessWatcher(db) {
  const source = getService('dns').logSource();
  const logFile = source?.path;
  let offset = 0;
  let lastStaleCheck = Date.now();

  // Start from end of file (don't process historical lines)
  try {
    if (logFile) offset = fs.statSync(logFile).size;
  } catch {
    /* file may not exist yet */
  }

  function poll() {
    let lines = [];
    if (logFile) {
      const tail = readLogTail(logFile, offset);
      lines = tail.lines;
      offset = tail.newOffset;
    }

    // Extract unique source IPs from DNS query lines
    const now = Date.now();
    const ipsThisCycle = new Set();

    for (const line of lines) {
      const ip = source.querySourceIp(line);
      if (!ip) continue;
      if (ip === '127.0.0.1' || ip === '::1') continue;
      ipsThisCycle.add(ip);
    }

    // Update liveness for each IP. Unknown rows are not created here because
    // dnsmasq may be logging proxy-originated queries in fallback paths.
    for (const ip of ipsThisCycle) {
      recordDnsQueryLiveness(db, ip, { createRogue: false, source: 'passive' });
    }

    // Staleness sweep (every ~60 seconds), also clears rogue on stale IPs
    if (now - lastStaleCheck >= 60000) {
      const staleMinutes = Math.round(PASSIVE_LIVENESS_STALE_MS / 60000);
      markStalePassiveAddresses(db, staleMinutes);
      pruneLifecycleEvents(db);
      const retirement = retireStaleDynamicAddresses(db, {
        releaseLease: (lease) => getDhcpBackend().releaseLease(lease),
      });
      if (retirement.dnsRecordsRemoved > 0) queueRegen('regenerate_dns');
      if (retirement.retired > 0 || retirement.deferred > 0) {
        console.log(
          `[ip-retirement] retired=${retirement.retired} deferred=${retirement.deferred} ` +
            `dns=${retirement.dnsRecordsRemoved} leases=${retirement.leasesRemoved} ` +
            `sticky_skipped=${retirement.stickyRelease.skipped} sticky_failed=${retirement.stickyRelease.failed}`,
        );
      }
      lastStaleCheck = now;
    }
  }

  const interval = setInterval(poll, PASSIVE_LIVENESS_POLL_MS);
  console.log(
    `[passive-liveness] Watching ${logFile || 'no DNS log'} (poll ${PASSIVE_LIVENESS_POLL_MS / 1000}s, stale ${PASSIVE_LIVENESS_STALE_MS / 60000}min)`,
  );

  return interval; // for cleanup in tests
}
