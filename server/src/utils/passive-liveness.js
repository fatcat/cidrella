/**
 * Passive host liveness detection from dnsmasq logs.
 *
 * Tails the dnsmasq log file for DNS query lines ("query[...] ... from <ip>")
 * and marks the source IP as online in ip_addresses. Also runs a periodic
 * staleness sweep to mark hosts offline when no signal has been seen.
 *
 * DHCP lease liveness is handled separately in ip-sync.js (syncLeasesToIps).
 */

import fs from 'fs';
import path from 'path';
import { readLogTail } from './log-reader.js';
import { pruneStaleDhcpHostRows } from './ip-sync.js';
import { recordDnsQueryLiveness } from './ip-liveness.js';
import * as IpAddress from '../models/ip-address.js';
import {
  DATA_DIR,
  PASSIVE_LIVENESS_POLL_MS,
  PASSIVE_LIVENESS_STALE_MS
} from '../config/defaults.js';
const LOG_FILE = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.log');
// Matches: "query[A] example.com from 192.168.1.100"
const QUERY_FROM_RE = /\bquery\[.+?\]\s+\S+\s+from\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;

/**
 * Start the passive liveness watcher.
 * Polls the dnsmasq log for DNS query source IPs and updates ip_addresses.
 */
export function startPassiveLivenessWatcher(db) {
  let offset = 0;
  let lastStaleCheck = Date.now();

  // Start from end of file (don't process historical lines)
  try {
    offset = fs.statSync(LOG_FILE).size;
  } catch { /* file may not exist yet */ }

  function poll() {
    const { lines, newOffset } = readLogTail(LOG_FILE, offset);
    offset = newOffset;

    // Extract unique source IPs from DNS query lines
    const now = Date.now();
    const ipsThisCycle = new Set();

    for (const line of lines) {
      const m = line.match(QUERY_FROM_RE);
      if (!m) continue;
      const ip = m[1];
      if (ip === '127.0.0.1') continue;
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
      IpAddress.bulkMarkStale(db, staleMinutes);
      pruneStaleDhcpHostRows(db);
      IpAddress.pruneEvents(db);
      IpAddress.clearStaleDynamicMetadata(db);
      lastStaleCheck = now;

    }
  }

  const interval = setInterval(poll, PASSIVE_LIVENESS_POLL_MS);
  console.log(`[passive-liveness] Watching ${LOG_FILE} (poll ${PASSIVE_LIVENESS_POLL_MS / 1000}s, stale ${PASSIVE_LIVENESS_STALE_MS / 60000}min)`);

  return interval; // for cleanup in tests
}
