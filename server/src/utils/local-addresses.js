/**
 * The IPv4 addresses this appliance itself holds.
 *
 * CIDRella scans the networks it is attached to, which means it probes its own
 * interface addresses and they always answer. Without this, an address the
 * appliance owns looked exactly like an unknown host squatting on an unassigned
 * address, and got flagged rogue. That only stayed hidden for the addresses
 * that happen to carry a DNS record, since a manual A record already counts as
 * a claim.
 *
 * Loopback is excluded: it is never part of a managed subnet, so it would only
 * ever be noise.
 */

import os from 'os';

const CACHE_TTL_MS = 60000;

let cached = null;
let cachedAt = 0;

let cachedAll = null;

function enumerate(wantV6) {
  const addresses = new Set();
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const addr of addrs || []) {
        // Node 18+ reports family as the string 'IPv4', older as the number 4.
        const isV4 = addr.family === 'IPv4' || addr.family === 4;
        const isV6 = addr.family === 'IPv6' || addr.family === 6;
        if (!addr.internal && addr.address && (isV4 || (wantV6 && isV6))) {
          addresses.add(addr.address);
        }
      }
    }
  } catch {
    /* enumeration is best effort */
  }
  return addresses;
}

/** The set of local IPv4 addresses, cached briefly. */
export function localIpv4Set({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && now - cachedAt < CACHE_TTL_MS) return cached;
  cached = enumerate(false);
  cachedAll = enumerate(true);
  cachedAt = now;
  return cached;
}

/** Every local address of either family (IPv6 without zone ids), cached briefly. */
export function localAddressSet({ force = false } = {}) {
  localIpv4Set({ force });
  return cachedAll;
}

/** Is `ip` an address this appliance holds, in either family? */
export function isLocalAddress(ip) {
  if (!ip) return false;
  return localAddressSet().has(ip);
}

/** Test seam: drop the cached set so the next read re-enumerates. */
export function resetLocalAddressCache() {
  cached = null;
  cachedAt = 0;
}
