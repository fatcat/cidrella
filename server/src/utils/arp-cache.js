/**
 * MAC address discovery from arping output and the kernel ARP table.
 *
 * Shared by the active scanner and the passive DNS-query path, which both want
 * a MAC for an address they have just seen. A MAC is the one piece of identity
 * that survives an address change, so it is what an operator actually needs to
 * track down an unexpected device.
 *
 * Only /proc/net/arp is read, so this is Linux-only and returns nothing
 * elsewhere. That is the same assumption the rest of the appliance makes.
 */

import { readFileSync } from 'fs';

const ARP_TABLE_PATH = '/proc/net/arp';
const INCOMPLETE_MAC = '00:00:00:00:00:00';
const CACHE_TTL_MS = 5000;

// A canonical 6-octet MAC anywhere in the text. Deliberately not anchored to
// any one arping implementation's phrasing, see parseArpingMac.
const MAC_RE = /\b([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\b/;

let cached = null;
let cachedAt = 0;

/**
 * Pull the peer MAC out of arping stdout.
 *
 * There are two arping implementations in the wild and their output differs.
 * iputils-arping prints the MAC in square brackets:
 *   Unicast reply from 10.0.0.4 [B2:56:20:67:46:66]  0.746ms
 * The `arping` package (Habets) prints it bare, with the address in parens:
 *   60 bytes from b2:56:20:67:46:66 (10.0.0.4): index=0 time=26.789 msec
 *
 * Matching only the bracketed form silently dropped every MAC on hosts running
 * the second one, and nothing downstream could recover it: a successful arping
 * skips the ICMP fallback, and arping does not populate the kernel neighbour
 * table, so the ARP-table lookup below had nothing to find either.
 */
export function parseArpingMac(stdout) {
  if (!stdout) return null;
  const m = String(stdout).match(MAC_RE);
  if (!m) return null;
  const mac = m[1].toLowerCase();
  return mac === INCOMPLETE_MAC ? null : mac;
}

/**
 * Parse the contents of /proc/net/arp into a Map of IP to MAC.
 * Incomplete entries (all-zero MAC) are skipped: the kernel creates those for
 * addresses it probed and got no answer from, so they are not evidence.
 */
export function parseArpTable(text) {
  const arpMap = new Map();
  if (!text) return arpMap;
  // Format: IP address  HW type  Flags  HW address  Mask  Device
  for (const line of String(text).split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 4 && parts[3] !== INCOMPLETE_MAC) {
      arpMap.set(parts[0], parts[3].toLowerCase());
    }
  }
  return arpMap;
}

/**
 * Read the kernel ARP table.
 *
 * Results are cached briefly because the passive path can be called once per
 * DNS query. Pass `force` when a probe was just sent and the point is to pick
 * up an entry it created, which is what the scanner needs after each batch.
 */
export function readArpCache({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && (now - cachedAt) < CACHE_TTL_MS) return cached;

  let table;
  try {
    table = parseArpTable(readFileSync(ARP_TABLE_PATH, 'utf8'));
  } catch {
    // /proc/net/arp may not exist on non-Linux
    table = new Map();
  }
  cached = table;
  cachedAt = now;
  return table;
}

/** The MAC the kernel has for `ip`, or null when it has none. */
export function lookupArpMac(ip) {
  if (!ip) return null;
  return readArpCache().get(ip) || null;
}

/** Test seam: drop the cached table so the next read hits /proc. */
export function resetArpCache() {
  cached = null;
  cachedAt = 0;
}
