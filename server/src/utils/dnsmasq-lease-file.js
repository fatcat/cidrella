import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config/defaults.js';
import { normalizeDuid } from './duid.js';

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
