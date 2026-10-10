/**
 * A scope's dynamic pools with its reserved addresses carved out, for any
 * backend that writes pools as address ranges. Both families, on BigInt
 * arithmetic, so an IPv6 pool of any size works.
 */
import { addressToBig, bigToAddress } from '../../utils/cidr.js';

const compareBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A malformed excluded address carves nothing out, as it always has.
function tryAddress(ip) {
  try {
    return addressToBig(ip);
  } catch {
    return null;
  }
}

/**
 * `pools` ([{ start_ip, end_ip }]) minus every address in `excludedIps` of
 * the same family, as [startAddress, endAddress] strings in pool order.
 * Addresses outside a pool, or of the other family, are ignored.
 */
export function poolSegments(pools, excludedIps, family) {
  const excluded = [...new Set(excludedIps)]
    .map(tryAddress)
    .filter((address) => address?.family === family)
    .map((address) => address.value)
    .sort(compareBig);
  const segments = [];
  for (const pool of pools) {
    const start = addressToBig(pool.start_ip).value;
    const end = addressToBig(pool.end_ip).value;
    let cursor = start;
    for (const value of excluded) {
      if (value < start || value > end) continue;
      if (cursor < value) segments.push([cursor, value - 1n]);
      cursor = value + 1n;
    }
    if (cursor <= end) segments.push([cursor, end]);
  }
  return segments.map(([start, end]) => [bigToAddress(start, family), bigToAddress(end, family)]);
}
