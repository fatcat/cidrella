import net from 'net';
import { PASSIVE_LIVENESS_DEBOUNCE_MS, PASSIVE_LIVENESS_STALE_MS } from '../config/defaults.js';
import { sqlTime } from './sql-time.js';
import { findSubnetForIp } from './ip-sync.js';
import { lookupArpMac } from './arp-cache.js';
import { lookupNdEntry } from './nd-cache.js';
import {
  observeEarlierSighting,
  observePassiveActivity,
  observeIpv6Presence,
  sightingSuperseded,
} from '../services/ip-lifecycle-service.js';
import { ipv6DiscoveryPolicy } from '../models/dhcp-scope.js';

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
 *
 * `observedAt` (epoch milliseconds) is when the client was heard, for a
 * sighting another instance made and sent here (sync/member-facts.js); `mac`
 * is the MAC that instance had for it. Such a sighting is recorded as of that
 * time, and it says the address is in use only while it still could:
 *
 * - a time in the future is taken as now;
 * - older than the stale window (PASSIVE_LIVENESS_STALE_MS, what the stale
 *   sweep allows a silent host), or older than what the row already holds
 *   (it was seen since, or decided offline since), it moves last_seen_at
 *   forward on a row that exists and does nothing else: no online state, no
 *   rogue, no new row;
 * - otherwise it is a sighting like any other, and last_seen_at never moves
 *   backwards.
 */
export function recordDnsQueryLiveness(
  db,
  ip,
  { createRogue = false, source = 'passive', observedAt = null, mac = null } = {},
) {
  if (!db || shouldIgnoreIp(ip)) return { changes: 0, ignored: true };

  const now = Date.now();
  const elsewhere = observedAt !== null;
  // The debounce is for this box's own stream of queries. A sighting made
  // elsewhere was already coalesced where it was made, and arrives oldest
  // first: debouncing would keep the oldest and drop the newest.
  if (!elsewhere) {
    pruneDebounce(now);
    const last = lastPassiveWrite.get(ip) || 0;
    if (now - last < PASSIVE_LIVENESS_DEBOUNCE_MS) {
      return { changes: 0, debounced: true };
    }
  }

  const subnet = findSubnetForIp(db, ip);
  if (!subnet) return { changes: 0, ignored: true };

  const family = net.isIP(ip);
  let seenMs = now;
  let seenAt;
  if (elsewhere) {
    if (!Number.isFinite(observedAt)) return { changes: 0, ignored: true };
    seenMs = Math.min(observedAt, now);
    seenAt = sqlTime(seenMs);
    if (!seenAt) return { changes: 0, ignored: true };
    if (now - seenMs > PASSIVE_LIVENESS_STALE_MS || sightingSuperseded(db, subnet.id, ip, seenAt)) {
      return { ...observeEarlierSighting(db, subnet.id, ip, seenAt), stale: true };
    }
  }

  // A host that just sent us a query is normally in the kernel neighbour table,
  // so the MAC is there for free. It matters most for the rogue case: an
  // address CIDRella never assigned is exactly the one an operator has to go
  // find on the network, and the MAC is what makes that possible. Off-link
  // clients simply miss here, which is correct, the only MAC ARP could offer
  // for those is the gateway's. A sighting made elsewhere brings the MAC that
  // instance had: this box's neighbour table is of another link.
  const localMac = () => (family === 6 ? lookupNdEntry(ip)?.mac || null : lookupArpMac(ip));
  const seenMac = elsewhere ? mac : localMac();
  // An IPv6 source that may create rows goes through the mode-aware presence
  // rule: a SLAAC claim on a SLAAC network, a rogue only on a stateful one.
  const result =
    family === 6 && createRogue
      ? observeIpv6Presence(db, subnet.id, ip, {
          mac: seenMac,
          policy: ipv6DiscoveryPolicy(db, subnet.id),
          source,
          now: seenMs,
          observedAt: seenAt,
        })
      : observePassiveActivity(db, subnet.id, ip, {
          mac: seenMac,
          source,
          createRogue,
          observedAt: seenAt,
        });
  if (!elsewhere) lastPassiveWrite.set(ip, now);
  return result;
}
