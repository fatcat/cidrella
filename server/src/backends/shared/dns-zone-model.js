/**
 * The DNS zones and records as every backend serves them: enabled zones only,
 * enabled records only, each record with its fully qualified name. An adapter
 * renders this in its own syntax (dnsmasq hosts and config lines, PowerDNS
 * rrsets) and decides nothing about which records are served.
 *
 * Records keep the database's id order across zones: dnsmasq takes an
 * address's PTR name from the first PTR row naming it.
 */
import { isValidAddress } from '../../utils/ip.js';
import { fqdnForRecordName, ipForPtrRecord } from '../../models/dns-record.js';

// The TTL a record without one of its own is served with, by every backend.
// Short, so an edit or a new lease name reaches clients within a minute.
export const LOCAL_RECORD_TTL = 60;

// A PTR whose value is a bare address (either family) is a placeholder the
// reverse-DNS projection keeps for an address with no name yet: no backend
// serves it. The dotted-quad test is the SQL GLOB the renderers used before
// this model, '[0-9]*.[0-9]*.[0-9]*.[0-9]*', kept exactly.
const DOTTED_QUAD_LIKE = /^[0-9].*\.[0-9].*\.[0-9].*\.[0-9]/s;

export function isPlaceholderPtr(value) {
  const v = String(value ?? '');
  return !v.includes('.') || DOTTED_QUAD_LIKE.test(v) || isValidAddress(v);
}

/**
 * { zones, records, networks }: `zones` are the enabled dns_zones rows by
 * id; `records` the enabled records of those zones by id, each with `zoneId`,
 * `zoneName`, `zoneType`, `fqdn` and, for a PTR, `placeholder`; `networks`
 * the CIDRs of the allocated networks.
 */
export function loadDnsZones(db) {
  const zones = db.prepare('SELECT * FROM dns_zones WHERE enabled = 1 ORDER BY id').all();
  const records = db
    .prepare(
      `SELECT r.id, r.zone_id, r.name, r.type, r.value, r.priority, r.weight, r.port, r.ttl,
              z.name AS zone_name, z.type AS zone_type
       FROM dns_records r
       JOIN dns_zones z ON z.id = r.zone_id
       WHERE z.enabled = 1 AND r.enabled = 1
       ORDER BY r.id`,
    )
    .all()
    .map(({ zone_id, zone_name, zone_type, ...record }) => ({
      ...record,
      zoneId: zone_id,
      zoneName: zone_name,
      zoneType: zone_type,
      fqdn: fqdnForRecordName(record.name, zone_name),
      ...(record.type === 'PTR' ? { placeholder: isPlaceholderPtr(record.value) } : {}),
    }));
  // The allocated networks: a backend that answers reverse lookups from the
  // forward records (PowerDNS) does so only for addresses inside them.
  const networks = db
    .prepare("SELECT cidr FROM subnets WHERE status = 'allocated' ORDER BY id")
    .all()
    .map((row) => row.cidr);
  return { zones, records, networks };
}

// Every served A and AAAA name, grouped by address, with each address's
// canonical PTR name first: the name a reverse lookup of the address answers
// when no PTR record is served for it. dnsmasq answers from the first hosts
// line naming the address; PowerDNS gets a PTR made from the first name.
export function servedHostsByAddress({ records }) {
  const ptrNames = new Map();
  for (const ptr of records) {
    if (ptr.type !== 'PTR') continue;
    const ip = ipForPtrRecord(ptr.name, ptr.zoneName);
    if (ip && !ptrNames.has(ip)) ptrNames.set(ip, lowerFqdn(ptr.value));
  }

  // `key` is the lowercase form PTR values compare by.
  const byAddress = new Map();
  for (const record of records) {
    if (record.zoneType !== 'forward' || (record.type !== 'A' && record.type !== 'AAAA')) continue;
    const names = byAddress.get(record.value) || [];
    if (!names.some((name) => name.key === lowerFqdn(record.fqdn))) {
      names.push({ fqdn: record.fqdn, key: lowerFqdn(record.fqdn) });
    }
    byAddress.set(record.value, names);
  }
  for (const [ip, names] of byAddress) {
    const canonical = ptrNames.get(ip);
    const at = canonical ? names.findIndex((name) => name.key === canonical) : -1;
    if (at > 0) names.unshift(...names.splice(at, 1));
  }
  return byAddress;
}

export function lowerFqdn(name) {
  return String(name || '')
    .trim()
    .replace(/\.$/, '')
    .toLowerCase();
}
