import net from 'net';
import { PASSIVE_LIVENESS_DEBOUNCE_MS } from '../config/defaults.js';
import { findSubnetForIp } from './ip-sync.js';
import { lookupArpMac } from './arp-cache.js';
import { lookupNdEntry } from './nd-cache.js';
import { observePassiveActivity } from '../services/ip-lifecycle-service.js';

const lastPassiveWrite = new Map();
let lastDebouncePrune = Date.now();

// Sources that are never a host on a managed network: loopback, unspecified,
// broadcast, multicast, and IPv6 link-local (a link-local query source has no
// interface context on this path, so it cannot be a lifecycle identity).
function shouldIgnoreIp(ip) {
  const family = ip ? net.isIP(ip) : 0;
  if (family === 4) {
    return ip.startsWith('127.') || ip === '0.0.0.0' || ip === '255.255.255.255';
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower === '::' || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
  }
  return true;
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

  // A host that just sent us a query is normally in the kernel neighbour table,
  // so the MAC is there for free. It matters most for the rogue case: an
  // address CIDRella never assigned is exactly the one an operator has to go
  // find on the network, and the MAC is what makes that possible. Off-link
  // clients simply miss here, which is correct, the only MAC ARP could offer
  // for those is the gateway's.
  const result = observePassiveActivity(db, subnet.id, ip, {
    mac: net.isIP(ip) === 6 ? lookupNdEntry(ip)?.mac || null : lookupArpMac(ip),
    source,
    createRogue,
  });
  lastPassiveWrite.set(ip, now);
  return result;
}
