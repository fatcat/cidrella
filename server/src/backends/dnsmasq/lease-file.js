import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../../config/defaults.js';
import { normalizeDuid } from '../../utils/duid.js';

// The lease file dnsmasq owns. CIDRella reads it; dnsmasq alone writes it.
export const LEASE_FILE = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.leases');

/**
 * dnsmasq's own server DUID, from the `duid <hex>` line it writes to its lease
 * file once it has served DHCPv6, or null before then. The line follows every
 * DHCPv4 lease (lease.c writes the IPv4 leases first), so the whole file is
 * scanned: on a dual-stack appliance it is rarely the first line.
 */
export function readServerDuid({ leaseFile = LEASE_FILE } = {}) {
  let text;
  try {
    text = fs.readFileSync(leaseFile, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^duid\s+(\S+)/i);
    if (match) return normalizeDuid(match[1]);
  }
  return null;
}

/**
 * Whether lease file text could be a whole file. dnsmasq ends every line it
 * writes with a newline, so text that stops partway through a line was read
 * while dnsmasq was still writing it.
 */
export function isWholeLeaseFile(text) {
  return text === '' || text.endsWith('\n');
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readOrNull(leaseFile) {
  try {
    return await fs.promises.readFile(leaseFile, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The lease file once dnsmasq has finished writing it, or null when it never
 * settles (or is missing). dnsmasq rewrites the file in place: it truncates
 * it, then writes every lease. A read in between sees some leases or none,
 * and syncing that would release every lease it missed and restore them on
 * the next read, clearing and restoring their hostnames in address history.
 * So the text is taken only when two reads `settleMs` apart agree and it
 * ends on a whole line.
 */
export async function readSettledLeaseFile({
  leaseFile = LEASE_FILE,
  settleMs = 250,
  attempts = 4,
  wait = pause,
} = {}) {
  let previous = await readOrNull(leaseFile);
  for (let i = 0; i < attempts; i++) {
    await wait(settleMs);
    const current = await readOrNull(leaseFile);
    if (current !== null && current === previous && isWholeLeaseFile(current)) return current;
    previous = current;
  }
  return null;
}
