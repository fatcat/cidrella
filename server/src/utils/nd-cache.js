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

import { runCommand } from './run-command.js';
import { MAC_RE, NULL_MAC } from './mac.js';
import { canonicalizeIp } from './address.js';

const CACHE_TTL_MS = 5000;
// States that mean the kernel has heard from the neighbor. FAILED and
// INCOMPLETE are probes that got no answer, so they are not evidence.
const SEEN_STATES = new Set(['REACHABLE', 'STALE', 'DELAY', 'PROBE', 'PERMANENT', 'NOARP']);

let cached = null;
let cachedAt = 0;
// The read under way, which a second caller joins rather than starting one.
let reading = null;

const LINK_LOCAL_RE = /^fe[89ab]/i;

/**
 * The table key for a neighbor. A link-local address is only unique on its
 * link: fe80::1 on eth0 and fe80::1 on eth1 are two routers with two MACs, so
 * a link-local key carries the interface. A global address is one key.
 */
export function neighborKey(ip, iface) {
  return LINK_LOCAL_RE.test(ip) && iface ? `${ip}%${iface}` : ip;
}

/**
 * The entry for `ip`, on `iface` when it is link-local. A link-local lookup
 * without an interface answers only when exactly one link has the address;
 * guessing between links is how a rogue would inherit a trusted router's MAC.
 */
export function findNeighbor(table, ip, iface = null) {
  const canonical = canonicalizeIp(String(ip ?? '').split('%')[0]);
  if (!canonical || !table) return null;
  const zone = iface ?? (String(ip).includes('%') ? String(ip).split('%')[1] : null);
  if (!LINK_LOCAL_RE.test(canonical)) return table.get(canonical) || null;
  if (zone) {
    const exact = table.get(neighborKey(canonical, zone));
    if (exact) return exact;
    const bare = table.get(canonical);
    return bare && bare.interface === zone ? bare : null;
  }
  const matches = [...table.values()].filter((entry) => (entry.ip ?? null) === canonical);
  if (matches.length === 1) return matches[0];
  return matches.length === 0 ? table.get(canonical) || null : null;
}

/**
 * Parse `ip -6 neigh show` output into a Map of neighborKey to
 * { ip, mac, interface, state }. Lines look like:
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
    table.set(neighborKey(ip, iface), { ip, mac, interface: iface, state });
  }
  return table;
}

/**
 * Read the kernel's IPv6 neighbor table. Cached briefly; pass `force` right
 * after a probe, when the point is to see entries it just created.
 */
export async function readNdCache({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  if (!reading) {
    reading = (async () => {
      let table;
      try {
        const { stdout } = await runCommand('ip', ['-6', 'neigh', 'show'], { timeout: 3000 });
        table = parseNeighTable(stdout);
      } catch {
        // No iproute2, or not Linux.
        table = new Map();
      }
      cached = table;
      cachedAt = Date.now();
      return table;
    })().finally(() => {
      reading = null;
    });
  }
  return reading;
}

/**
 * The neighbor entry the kernel had for `ip` at the last read, or null.
 * Synchronous, for the passive liveness path that runs per DNS query: a
 * stale table starts a read in the background and this answers from the
 * one before it.
 */
export function lookupNdEntry(ip, iface = null) {
  if (!reading && (!cached || Date.now() - cachedAt >= CACHE_TTL_MS)) void readNdCache();
  return cached ? findNeighbor(cached, ip, iface) : null;
}
