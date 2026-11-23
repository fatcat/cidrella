/**
 * The DNS servers a DHCP client is given when more than one instance answers
 * DNS (docs/REDUNDANCY-PLAN.md, section 6).
 *
 * A scope's DNS option holds what a person or networkOptionFills put there:
 * usually one address, CIDRella's own. That entry stands for "CIDRella", so
 * what is served in its place is every DNS-serving instance, in the order
 * dnsInstances (models/sync-instance.js) lists them: the one that serves
 * DHCP first, then the controller. Entries that are not an instance's address are someone's choice and
 * stay where they are; a list naming no instance is served as it is. Nothing
 * stored changes: this is a projection made when the options are resolved.
 * A single box has one instance, and its list comes out as it went in.
 */
import { addressFamily, canonicalizeIp } from './address.js';
import { networkContains } from './cidr.js';

const canonical = (address) => canonicalizeIp(String(address).trim());

// Clients use the first few DNS servers they are given and ignore the rest
// (glibc reads three, MAXNS), and a DHCPv4 option holds 255 bytes. So at most
// this many instances are served per family, in dnsInstances order: the one
// serving DHCP, the controller, then the members by name.
export const MAX_SERVED_INSTANCES = 3;

/** The one address of `family` an instance is reached at from `cidr`: one inside it, else its first. */
export function instanceAddressFor(addresses, { family, cidr }) {
  const mine = (addresses || [])
    .map(canonical)
    .filter((address) => address && addressFamily(address) === Number(family));
  if (mine.length === 0) return null;
  const inside = (address) => {
    try {
      return Boolean(cidr) && networkContains(cidr, address);
    } catch {
      return false;
    }
  };
  return mine.find(inside) || mine[0];
}

/**
 * `value` (a comma-separated server list) with CIDRella's entry replaced by
 * every instance's address. `instances` is [{ addresses: [...] }] in the
 * order to serve them.
 */
export function instanceDnsServers(value, { family, cidr, instances }) {
  if (!value || !instances || instances.length < 2) return value;
  const every = new Set(instances.flatMap((instance) => instance.addresses.map(canonical)));
  const served = instances
    .map((instance) => instanceAddressFor(instance.addresses, { family, cidr }))
    .filter(Boolean)
    .slice(0, MAX_SERVED_INSTANCES);
  const entries = String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.some((entry) => every.has(canonical(entry)))) return value;

  const out = [];
  let placed = false;
  for (const entry of entries) {
    if (!every.has(canonical(entry))) {
      if (!served.includes(canonical(entry))) out.push(entry);
    } else if (!placed) {
      out.push(...served);
      placed = true;
    }
  }
  return [...new Set(out)].join(',');
}

/**
 * The instances clients are given, in either family: the first
 * MAX_SERVED_INSTANCES with an address of that family. A Set of the entries of
 * `instances` (as dnsInstances lists them), for the Instances page to say who
 * is left out.
 */
export function servedInstances(instances) {
  const served = new Set();
  for (const family of [4, 6]) {
    instances
      .filter((instance) => instanceAddressFor(instance.addresses, { family }))
      .slice(0, MAX_SERVED_INSTANCES)
      .forEach((instance) => served.add(instance));
  }
  return served;
}
