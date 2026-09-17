/**
 * IPv6 neighbor discovery: the kernel's neighbor table, read through
 * `ip -6 neigh show`.
 *
 * The IPv6 counterpart of arp-cache.js. An IPv6 prefix is never swept (a /64
 * has 2^64 addresses), so discovery is observation-driven: the scanner pings
 * the all-nodes multicast group on the link and then reads what the kernel
 * learned here. Entries carry the interface, which is identity for link-local
 * addresses, and the MAC, which is what an operator needs to find a device.
 *
 * Linux-only, like the ARP reader. Elsewhere it returns nothing.
 */

import { execFileSync } from 'child_process';
import { MAC_RE, NULL_MAC } from './mac.js';
import { canonicalizeIp } from './address.js';

const CACHE_TTL_MS = 5000;
// States that mean the kernel has heard from the neighbor. FAILED and
// INCOMPLETE are probes that got no answer, so they are not evidence.
const SEEN_STATES = new Set(['REACHABLE', 'STALE', 'DELAY', 'PROBE', 'PERMANENT', 'NOARP']);

let cached = null;
let cachedAt = 0;

/**
 * Parse `ip -6 neigh show` output into a Map of canonical address to
 * { mac, interface, state }. Lines look like:
 *   fd00:a::1600 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE
 *   fe80::1 dev eth0 lladdr aa:bb:cc:dd:ee:01 router STALE
 *   fd00:a::9 dev eth0 FAILED
 */
export function parseNeighTable(text) {
  const table = new Map();
  if (!text) return table;
  for (const raw of String(text).split('\n')) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const ip = canonicalizeIp(parts[0]);
    if (!ip) continue;
    const state = parts[parts.length - 1].toUpperCase();
    if (!SEEN_STATES.has(state)) continue;
    const dev = parts.indexOf('dev');
    const lladdr = parts.indexOf('lladdr');
    const iface = dev >= 0 ? parts[dev + 1] || null : null;
    let mac = lladdr >= 0 ? String(parts[lladdr + 1] || '').toLowerCase() : null;
    if (mac && (!MAC_RE.test(mac) || mac === NULL_MAC)) mac = null;
    table.set(ip, { mac, interface: iface, state });
  }
  return table;
}

/**
 * Read the kernel's IPv6 neighbor table. Cached briefly; pass `force` right
 * after a probe, when the point is to see entries it just created.
 */
export function readNdCache({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && now - cachedAt < CACHE_TTL_MS) return cached;

  let table;
  try {
    table = parseNeighTable(
      execFileSync('ip', ['-6', 'neigh', 'show'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000,
      }),
    );
  } catch {
    // No iproute2, or not Linux.
    table = new Map();
  }
  cached = table;
  cachedAt = now;
  return table;
}

/** The neighbor entry the kernel has for `ip`, or null. */
export function lookupNdEntry(ip) {
  const canonical = canonicalizeIp(ip);
  if (!canonical) return null;
  return readNdCache().get(canonical) || null;
}
