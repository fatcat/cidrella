import net from 'net';
import { PASSIVE_LIVENESS_DEBOUNCE_MS } from '../config/defaults.js';
import { findSubnetForIp } from './ip-sync.js';
import * as IpAddress from '../models/ip-address.js';

const lastPassiveWrite = new Map();
let lastDebouncePrune = Date.now();

function shouldIgnoreIp(ip) {
  if (!ip || net.isIP(ip) !== 4) return true;
  return ip.startsWith('127.') || ip === '0.0.0.0' || ip === '255.255.255.255';
}

function pruneDebounce(now) {
  if (now - lastDebouncePrune < 60000) return;
  const cutoff = now - PASSIVE_LIVENESS_DEBOUNCE_MS * 2;
  for (const [ip, ts] of lastPassiveWrite) {
    if (ts < cutoff) lastPassiveWrite.delete(ip);
  }
  lastDebouncePrune = now;
}

/**
 * Record host liveness from a DNS query source IP.
 *
 * This is the shared passive DNS-query path for both dnsmasq-log fallback mode
 * and the CIDRella DNS proxy. All writes go through the IpAddress model.
 */
export function recordDnsQueryLiveness(db, ip, { createRogue = false, source = 'passive' } = {}) {
  if (!db || shouldIgnoreIp(ip)) return { changes: 0, ignored: true };

  const now = Date.now();
  pruneDebounce(now);

  const last = lastPassiveWrite.get(ip) || 0;
  if (now - last < PASSIVE_LIVENESS_DEBOUNCE_MS) {
    return { changes: 0, debounced: true };
  }

  const subnet = findSubnetForIp(db, ip);
  if (!subnet) return { changes: 0, ignored: true };

  const result = IpAddress.recordPassiveActivity(db, subnet.id, ip, {
    source,
    createRogue
  });
  lastPassiveWrite.set(ip, now);
  return result;
}
