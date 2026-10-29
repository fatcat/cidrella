/**
 * How full a network's DHCP pools are (docs/IPV6-HANDLING.md, rule 3): the
 * addresses its enabled address-pool scopes hand out, and how many of them an
 * active lease holds. It is how full an IPv6 network can usefully be said to
 * be, where the address count of a /64 means nothing; IPv4 gets the same
 * figures. The tree (GET /subnets) and the summary both read it.
 *
 * `pool_size` is a decimal string: a stateful DHCPv6 pool can outgrow a
 * JavaScript number. Overlapping pools are counted once.
 */
import { addressToBig } from '../utils/ip.js';
import { activeLeaseSql } from '../utils/lease-sql.js';
import { addressPoolScopeSql } from './dhcp-scope.js';

// Pools as merged [start, end] BigInt spans, in order.
function mergeSpans(spans) {
  const sorted = [...spans].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1n) {
      if (end > last[1]) last[1] = end;
    } else merged.push([start, end]);
  }
  return merged;
}

/**
 * Pool use per network: a Map of subnet id to `{ pool_size, pool_in_use }`,
 * holding only the networks with a pool. `subnetId` narrows it to one.
 */
export function dhcpPoolUse(db, subnetId = null) {
  const where = subnetId === null ? '' : 'AND s.subnet_id = ?';
  const args = subnetId === null ? [] : [subnetId];
  const pools = db
    .prepare(
      `SELECT s.subnet_id, p.start_ip, p.end_ip
         FROM dhcp_scopes s JOIN dhcp_scope_pools p ON p.scope_id = s.id
        WHERE s.enabled = 1 AND s.subnet_id IS NOT NULL AND ${addressPoolScopeSql('s')} ${where}`,
    )
    .all(...args);
  const spans = new Map();
  for (const pool of pools) {
    const start = addressToBig(pool.start_ip);
    const end = addressToBig(pool.end_ip);
    if (!start || !end || start.family !== end.family) continue;
    if (!spans.has(pool.subnet_id)) spans.set(pool.subnet_id, []);
    spans.get(pool.subnet_id).push([start.value, end.value]);
  }
  const use = new Map();
  for (const [id, list] of spans) {
    const merged = mergeSpans(list);
    const size = merged.reduce((sum, [start, end]) => sum + (end - start + 1n), 0n);
    use.set(id, { spans: merged, size, inUse: new Set() });
  }
  if (!use.size) return new Map();

  const leases = db
    .prepare(
      `SELECT DISTINCT subnet_id, ip_address FROM dhcp_leases
        WHERE subnet_id IS NOT NULL AND ${activeLeaseSql()} ${subnetId === null ? '' : 'AND subnet_id = ?'}`,
    )
    .all(...args);
  for (const lease of leases) {
    const entry = use.get(lease.subnet_id);
    const address = entry && addressToBig(lease.ip_address);
    if (!address) continue;
    if (entry.spans.some(([start, end]) => address.value >= start && address.value <= end))
      entry.inUse.add(address.value);
  }

  return new Map(
    [...use].map(([id, entry]) => [
      id,
      { pool_size: entry.size.toString(), pool_in_use: entry.inUse.size },
    ]),
  );
}
