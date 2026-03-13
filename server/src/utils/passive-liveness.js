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
import { findSubnetForIp } from './ip-sync.js';
import * as IpAddress from '../models/ip-address.js';
import {
  PASSIVE_LIVENESS_POLL_MS,
  PASSIVE_LIVENESS_DEBOUNCE_MS,
  PASSIVE_LIVENESS_STALE_MS
} from '../config/defaults.js';

const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.log');

// Matches: "query[A] example.com from 192.168.1.100"
const QUERY_FROM_RE = /\bquery\[.+?\]\s+\S+\s+from\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;

/**
 * Read new bytes appended to the log file since the given offset.
 * Handles file truncation (e.g. log clear / rotation).
 */
function readNewLines(offset) {
  let size;
  try {
    size = fs.statSync(LOG_FILE).size;
  } catch {
    return { lines: [], newOffset: 0 };
  }

  if (size < offset) offset = 0; // truncated
  if (size === offset) return { lines: [], newOffset: offset };

  const buf = Buffer.alloc(size - offset);
  const fd = fs.openSync(LOG_FILE, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, offset);
  } finally {
    fs.closeSync(fd);
  }

  const text = buf.toString('utf-8');
  const lines = text.split('\n').filter(l => l.trim());
  return { lines, newOffset: size };
}

/**
 * Start the passive liveness watcher.
 * Polls the dnsmasq log for DNS query source IPs and updates ip_addresses.
 */
export function startPassiveLivenessWatcher(db) {
  // In-memory debounce map: ip → Date.now() of last DB write
  const lastSeen = new Map();
  let offset = 0;
  let lastStaleCheck = Date.now();

  // Start from end of file (don't process historical lines)
  try {
    offset = fs.statSync(LOG_FILE).size;
  } catch { /* file may not exist yet */ }

  function poll() {
    const { lines, newOffset } = readNewLines(offset);
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

    // Update liveness for each IP (debounced)
    for (const ip of ipsThisCycle) {
      const last = lastSeen.get(ip) || 0;
      if (now - last < PASSIVE_LIVENESS_DEBOUNCE_MS) continue;

      const subnet = findSubnetForIp(db, ip);
      if (!subnet) continue;

      // UPDATE only — don't create rows for unknown IPs
      IpAddress.markOnline(db, subnet.id, ip, { source: 'passive' });
      lastSeen.set(ip, now);
    }

    // Staleness sweep (every ~60 seconds) — also clears rogue on stale IPs
    if (now - lastStaleCheck >= 60000) {
      const staleMinutes = Math.round(PASSIVE_LIVENESS_STALE_MS / 60000);
      IpAddress.bulkMarkStale(db, staleMinutes);
      IpAddress.pruneEvents(db);
      lastStaleCheck = now;

      // Prune debounce map entries older than 2x debounce window
      const pruneThreshold = now - PASSIVE_LIVENESS_DEBOUNCE_MS * 2;
      for (const [ip, ts] of lastSeen) {
        if (ts < pruneThreshold) lastSeen.delete(ip);
      }
    }
  }

  const interval = setInterval(poll, PASSIVE_LIVENESS_POLL_MS);
  console.log(`[passive-liveness] Watching ${LOG_FILE} (poll ${PASSIVE_LIVENESS_POLL_MS / 1000}s, debounce ${PASSIVE_LIVENESS_DEBOUNCE_MS / 1000}s, stale ${PASSIVE_LIVENESS_STALE_MS / 60000}min)`);

  return interval; // for cleanup in tests
}
