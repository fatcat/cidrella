/**
 * One free address in a network, for an editor's Suggest button
 * (docs/IPV6-HANDLING.md, rule 2; ARCHITECTURE.md, Canonical IP Model).
 *
 * Free means: no stored row that claims it or saw a host there (an IPv4
 * network's empty placeholder row is no claim), outside every
 * DHCP pool, not a topology address or the gateway, and on IPv6 not an EUI-64
 * interface ID. The winner is read through the read model and must show
 * `available`. Nothing is held; the write that uses it goes through the
 * lifecycle service, which refuses a claim that landed in between.
 *
 * Cost is bounded by the network's stored rows and pools, never its size: a
 * sequential search walks the stored sort keys from its start and jumps over
 * pools and EUI-64 blocks.
 */
import crypto from 'crypto';
import { isEui64InterfaceId, sortKey } from '../utils/address.js';
import {
  addressToBig,
  bigToAddress,
  isNetworkWithin,
  isTopologyAddress,
  isValidAddress,
  isValidNetwork,
  normalizeNetwork,
  parseNetwork,
  parsedNetworkContains,
} from '../utils/ip.js';
import { isDynamicPoolRange } from './ip-view.js';
import * as Range from './range.js';
import { getCanonicalSubnetIpRow, getSubnetIpReadContext } from './subnet-ip-read.js';

export const SUGGEST_STRATEGIES = ['sequential', 'random'];
const RANDOM_TRIES = 64;
const STORED_PAGE = 512;
// Where a sequential IPv6 search starts: past the low addresses people tend
// to hand-assign (::1 the gateway, a few infrastructure hosts).
const IPV6_SEQUENTIAL_OFFSET = 0x10n;
// An EUI-64 interface ID fixes ff:fe in bits 24-39; the low 24 bits vary.
const EUI64_LOW_BITS = 0xffffffn;

// A stored row that takes its address out of the running: a claim, or any
// sign a host was there. An IPv4 network keeps an empty row per address, and
// that alone is not one.
const TAKEN_ROW_SQL = `(allocation_state <> 'unassigned' OR is_online = 1 OR is_rogue = 1
  OR first_seen_at IS NOT NULL OR last_seen_at IS NOT NULL
  OR mac_address IS NOT NULL OR hostname IS NOT NULL)`;

function refusal(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// The usable span of the network, narrowed by `within`: a CIDR inside the
// network, or the id of one of its ranges.
function suggestionBounds(db, subnet, parsed, within) {
  let low = addressToBig(parsed.firstUsable).value;
  let high = addressToBig(parsed.lastUsable).value;
  let label = subnet.cidr;
  if (within === null || within === undefined || within === '') return { low, high, label };
  const text = String(within).trim();
  if (/^\d+$/.test(text)) {
    const range = Range.findWithType(db, Number(text));
    if (!range || range.subnet_id !== subnet.id)
      throw refusal('within is not a range of this network');
    return {
      low: addressToBig(range.start_ip).value,
      high: addressToBig(range.end_ip).value,
      label: `${range.start_ip} - ${range.end_ip}`,
    };
  }
  if (!isValidNetwork(text)) throw refusal('within must be a CIDR or a range id');
  const cidr = normalizeNetwork(text);
  if (cidr !== subnet.cidr && !isNetworkWithin(cidr, subnet.cidr))
    throw refusal(`within must be inside ${subnet.cidr}`);
  const inner = parseNetwork(cidr);
  low = inner.networkBig > low ? inner.networkBig : low;
  high = inner.lastBig < high ? inner.lastBig : high;
  label = cidr;
  return { low, high, label };
}

// The taken addresses of the network at or above a value, in order, read a
// page at a time.
function storedAbove(db, subnet, family, start) {
  const query = db.prepare(`
    SELECT DISTINCT address_sort_key AS key FROM ip_addresses
     WHERE subnet_id = ? AND address_sort_key >= ? AND ${TAKEN_ROW_SQL}
     ORDER BY address_sort_key LIMIT ${STORED_PAGE}
  `);
  const prefix = family === 6 ? '6' : '4';
  let page = [];
  let index = 0;
  let nextKey = prefix + start.toString(16).padStart(32, '0');
  let exhausted = false;
  return {
    // The lowest stored value at or above `value`, or null.
    at(value) {
      for (;;) {
        while (index < page.length && page[index] < value) index += 1;
        if (index < page.length) return page[index];
        if (exhausted) return null;
        const rows = query.all(subnet.id, nextKey);
        page = rows
          .filter((row) => row.key?.startsWith(prefix))
          .map((row) => BigInt(`0x${row.key.slice(1)}`));
        index = 0;
        if (rows.length < STORED_PAGE) exhausted = true;
        if (rows.length) {
          const last = BigInt(`0x${rows.at(-1).key.slice(1)}`) + 1n;
          nextKey = prefix + last.toString(16).padStart(32, '0');
        }
        if (!page.length && exhausted) return null;
      }
    },
  };
}

export function suggestAddress(
  db,
  subnet,
  { strategy = 'sequential', within = null, from = null } = {},
) {
  if (!SUGGEST_STRATEGIES.includes(strategy))
    throw refusal(`strategy must be one of: ${SUGGEST_STRATEGIES.join(', ')}`);
  const parsed = parseNetwork(subnet.cidr);
  if (from && !(isValidAddress(from) && parsedNetworkContains(parsed, from)))
    throw refusal(`from must be an address inside ${subnet.cidr}`);
  const bounds = suggestionBounds(db, subnet, parsed, within);
  const context = getSubnetIpReadContext(db, subnet);
  const pools = context.rangeLookup
    .filter((range) => isDynamicPoolRange(range.range_type_name))
    .map((range) => [range.start, range.end]);
  const gateway = subnet.gateway_address ? addressToBig(subnet.gateway_address).value : null;

  // The first value at or above `value` that no fixed rule rules out: past a
  // pool, the gateway, a topology address or an EUI-64 block. The value itself
  // when none applies.
  function pastFixed(value) {
    const pool = pools.find(([start, end]) => value >= start && value <= end);
    if (pool) return pool[1] + 1n;
    if (value === gateway || isTopologyAddress(parsed, value)) return value + 1n;
    if (parsed.family === 6 && isEui64InterfaceId(bigToAddress(value, 6)))
      return (value | EUI64_LOW_BITS) + 1n;
    return value;
  }

  // The read model has the last word on the winner.
  const available = (value) =>
    getCanonicalSubnetIpRow(db, subnet, bigToAddress(value, parsed.family), context)
      .ip_display_status === 'available';

  function sequentialFrom(start) {
    const stored = storedAbove(db, subnet, parsed.family, start);
    let value = start;
    while (value <= bounds.high) {
      const next = pastFixed(value);
      if (next !== value) {
        value = next;
        continue;
      }
      if (stored.at(value) === value) {
        value += 1n;
        continue;
      }
      if (available(value)) return value;
      value += 1n;
    }
    return null;
  }

  const storedAt = db.prepare(
    `SELECT 1 FROM ip_addresses WHERE subnet_id = ? AND address_sort_key = ? AND ${TAKEN_ROW_SQL}`,
  );
  let found = null;
  if (strategy === 'random') {
    const span = bounds.high - bounds.low + 1n;
    let value = bounds.low;
    for (let attempt = 0; attempt < RANDOM_TRIES && found === null; attempt += 1) {
      value = bounds.low + (BigInt(`0x${crypto.randomBytes(16).toString('hex')}`) % span);
      const isStored = storedAt.get(subnet.id, sortKey(bigToAddress(value, parsed.family)));
      if (pastFixed(value) === value && !isStored && available(value)) found = value;
    }
    // Crowded bounds: take the first free address after the last try, then
    // wrap to the start.
    if (found === null) found = sequentialFrom(value) ?? sequentialFrom(bounds.low);
  } else {
    let start = bounds.low;
    if (from) start = addressToBig(from).value;
    else if (parsed.family === 6 && !within) start = parsed.networkBig + IPV6_SEQUENTIAL_OFFSET;
    // A prefix too small for the IPv6 offset starts at its first address; a
    // `from` past the bounds finds nothing.
    if (start < bounds.low || (!from && start > bounds.high)) start = bounds.low;
    found = sequentialFrom(start);
  }

  return found === null
    ? { ip_address: null, bounds: bounds.label }
    : { ip_address: bigToAddress(found, parsed.family), strategy, bounds: bounds.label };
}
