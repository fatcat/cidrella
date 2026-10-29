/**
 * Host association (docs/ARCHITECTURE.md, Canonical IP Model; docs/IPV6-HANDLING.md
 * rule 5): the address rows of a network grouped into the devices that hold
 * them. An IPv6 device holds several addresses (link-local, EUI-64 or stable
 * SLAAC, temporaries, a DHCPv6 lease), and this is what lets a /64 read as a
 * list of devices.
 *
 * A projection only. It never changes allocation_state, ownership, hostnames
 * or PTRs, and each address row stays its own identity. Pure, with no
 * database, so the workspace model test groups its fake estate with it too.
 *
 * Rows are joined when they share any identifier: a MAC (observed, inside a
 * DUID-LL/LLT, or encoded in an EUI-64 interface ID) or a DUID. `links` adds
 * the DUID and MAC pairs a DHCP lease or reservation holds.
 */
import { addressFamily, expandIpv6, macFromEui64, parseIp } from './address.js';
import { networkContains, parseAddressQuery } from './cidr.js';
import { macFromDuid, normalizeDuid } from './duid.js';
import { leaseExpiryMs } from './lease-sql.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const STABLE_KINDS = new Set(['static', 'reservation', 'dhcp', 'eui64', 'link-local']);
const STATIC_STATES = new Set(['static_dns', 'reserved', 'gateway', 'system', 'quarantined']);

function lowerMac(mac) {
  return typeof mac === 'string' && mac ? mac.toLowerCase() : null;
}

function isLinkLocal(row) {
  return !!row.interface_id || /^fe[89ab]/i.test(row.ip_address || '');
}

function seenMs(value) {
  const ms = value ? leaseExpiryMs(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** What kind of address a row is, for grouping and the Hosts view. */
export function addressKind(row) {
  if (row.address_family === 6 || addressFamily(row.ip_address) === 6) {
    if (isLinkLocal(row)) return 'link-local';
  }
  if (row.allocation_state === 'static_dhcp' || row.has_dhcp_reservation) return 'reservation';
  if (STATIC_STATES.has(row.allocation_state)) return 'static';
  if (
    row.allocation_state === 'dynamic_dhcp' ||
    row.detection_source === 'dhcpv6_lease' ||
    row.detection_source === 'dhcp_lease'
  ) {
    return 'dhcp';
  }
  if (macFromEui64(row.ip_address)) return 'eui64';
  if (row.detection_source === 'slaac_privacy') return 'temporary';
  if (row.allocation_state === 'slaac') return 'slaac';
  return 'other';
}

// The /64 an IPv6 address sits in, as a BigInt, for the temporary rule.
function prefix64(ip) {
  const parsed = parseIp(ip);
  return parsed && parsed.bits === 128 ? parsed.value >> 64n : null;
}

// A young SLAAC address beside an established one in the same /64 is likely
// a temporary (RFC 8981): nothing marks one, so this is a heuristic.
function markTemporaries(addresses, now) {
  const established = new Set();
  for (const address of addresses) {
    const first = seenMs(address.first_seen_at);
    const old = address.kind === 'eui64' || (first !== null && now - first >= DAY_MS);
    if ((address.kind === 'slaac' || address.kind === 'eui64') && old) {
      established.add(`${prefix64(address.ip_address)}`);
    }
  }
  for (const address of addresses) {
    if (address.kind !== 'slaac') continue;
    const first = seenMs(address.first_seen_at);
    if (first === null || now - first >= DAY_MS) continue;
    if (established.has(`${prefix64(address.ip_address)}`)) address.kind = 'temporary';
  }
}

// The identifier most rows name, ties to the lowest spelling.
function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return (
    [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0] ||
    null
  );
}

function compareRows(a, b) {
  const left = a.address_sort_key || '';
  const right = b.address_sort_key || '';
  if (left !== right) return left < right ? -1 : 1;
  return (a.interface_id || '') < (b.interface_id || '') ? -1 : 1;
}

function displayName(addresses) {
  const names = (list) => list.map((a) => a.hostname).filter(Boolean);
  const stable = names(addresses.filter((a) => STABLE_KINDS.has(a.kind)));
  if (stable.length) return stable[0];
  const bySeen = [...addresses].sort(
    (a, b) => (seenMs(b.last_seen_at) ?? -1) - (seenMs(a.last_seen_at) ?? -1),
  );
  return names(bySeen)[0] || null;
}

/**
 * Group address rows into hosts. Each row needs `ip_address` and
 * `address_sort_key`, and uses `interface_id`, `mac_address`, `last_seen_mac`,
 * `dhcp_duid`, `allocation_state`, `detection_source`, `has_dhcp_reservation`,
 * `hostname`, `is_online`, `first_seen_at` and `last_seen_at` when present.
 * `links` is a list of `{ mac, duid }`. Hosts come out in address order of
 * their lowest stable address, else their lowest address.
 */
export function groupHosts(rows, links = [], { now = Date.now() } = {}) {
  const parent = new Map();
  const find = (node) => {
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root);
    let walk = node;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk);
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const add = (node) => {
    if (!parent.has(node)) parent.set(node, node);
    return node;
  };
  const join = (a, b) => {
    const ra = find(add(a));
    const rb = find(add(b));
    if (ra !== rb) parent.set(rb, ra);
  };

  const facts = rows.map((row, index) => {
    const node = add(`row:${index}`);
    const observed = lowerMac(row.mac_address) || lowerMac(row.last_seen_mac);
    const duid = normalizeDuid(row.dhcp_duid);
    const derived = [macFromDuid(duid), macFromEui64(row.ip_address)].filter(Boolean);
    for (const mac of [observed, ...derived].filter(Boolean)) join(node, `mac:${mac}`);
    if (duid) join(node, `duid:${duid}`);
    return { row, node, observed, derived, duid };
  });
  for (const link of links) {
    const mac = lowerMac(link.mac);
    const duid = normalizeDuid(link.duid);
    if (mac && duid && parent.has(`duid:${duid}`)) join(`duid:${duid}`, `mac:${mac}`);
  }

  const groups = new Map();
  for (const fact of facts) {
    const root = find(fact.node);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(fact);
  }

  const hosts = [];
  for (const members of groups.values()) {
    members.sort((a, b) => compareRows(a.row, b.row));
    const observed = mostCommon(members.map((m) => m.observed).filter(Boolean));
    const derived = mostCommon(members.flatMap((m) => m.derived));
    const duid = mostCommon(members.map((m) => m.duid).filter(Boolean));
    const mac = observed || derived;
    const first = members[0].row;
    let key;
    let keyKind;
    if (mac) [key, keyKind] = [`mac:${mac}`, 'mac'];
    else if (duid) [key, keyKind] = [`duid:${duid}`, 'duid'];
    else {
      const zone = first.interface_id ? `%${first.interface_id}` : '';
      [key, keyKind] = [`address:${first.ip_address}${zone}`, 'address'];
    }

    const addresses = members.map(({ row }) => ({
      ip_address: row.ip_address,
      interface_id: row.interface_id || null,
      address_sort_key: row.address_sort_key || null,
      kind: addressKind(row),
      allocation_state: row.allocation_state || null,
      address_type: row.address_type || null,
      hostname: row.hostname || null,
      online: !!row.is_online,
      first_seen_at: row.first_seen_at || null,
      last_seen_at: row.last_seen_at || null,
    }));
    markTemporaries(addresses, now);

    const lastSeen = addresses
      .map((a) => a.last_seen_at)
      .filter(Boolean)
      .sort((a, b) => (seenMs(b) ?? 0) - (seenMs(a) ?? 0))[0];
    const stableCount = addresses.filter((a) => STABLE_KINDS.has(a.kind)).length;
    const temporaryCount = addresses.filter((a) => a.kind === 'temporary').length;
    const sortRow = addresses.find((a) => STABLE_KINDS.has(a.kind)) || addresses[0];
    hosts.push({
      key,
      key_kind: keyKind,
      mac: mac || null,
      duid: duid || null,
      name: displayName(addresses),
      hostnames: [...new Set(addresses.map((a) => a.hostname).filter(Boolean))],
      online: addresses.some((a) => a.online),
      last_seen_at: lastSeen || null,
      stable_count: stableCount,
      temporary_count: temporaryCount,
      other_count: addresses.length - stableCount,
      addresses,
      sort_key: sortRow.address_sort_key || '',
    });
  }
  hosts.sort((a, b) =>
    a.sort_key !== b.sort_key ? (a.sort_key < b.sort_key ? -1 : 1) : a.key < b.key ? -1 : 1,
  );
  for (const host of hosts) delete host.sort_key;
  return hosts;
}

/**
 * Does a host match a search box: an address or a CIDR (either family, any
 * spelling) holding one of its addresses, or text inside an address, a
 * hostname, the MAC or the DUID.
 */
export function hostMatches(host, query) {
  const text = String(query || '').trim();
  if (!text) return true;
  const parsed = parseAddressQuery(text);
  if (parsed.kind === 'address') return host.addresses.some((a) => a.ip_address === parsed.ip);
  if (parsed.kind === 'cidr') {
    return host.addresses.some((a) => networkContains(parsed.cidr, a.ip_address));
  }
  const needle = text.toLowerCase();
  const haystack = [
    host.mac,
    host.duid,
    ...host.hostnames,
    ...host.addresses.flatMap((a) => [a.ip_address, expandIpv6(a.ip_address)]),
  ].filter(Boolean);
  return haystack.some((value) => value.toLowerCase().includes(needle));
}
