/**
 * Pure rendering for the PowerDNS backend: the zones Authoritative should
 * hold, from the shared DNS model (backends/shared/dns-zone-model.js), and
 * the two daemons' configuration files. No I/O.
 *
 * Names and record contents are written the way Authoritative 5.0 hands them
 * back from its API (absolute, lowercase, AAAA in the canonical spelling,
 * TXT as quoted strings), so the diff in diff.js finds nothing on a second
 * apply.
 */
import { canonicalizeIp, addressFamily } from '../../utils/address.js';
import { normalizeDnsName } from '../../utils/dns-names.js';
import { validateTxtValue } from '../../utils/config-value-validation.js';
import { LOCAL_RECORD_TTL, servedHostsByAddress } from '../shared/dns-zone-model.js';
import { isGloballyRoutableCidr } from '../../utils/ip.js';
import { networkContains } from '../../utils/cidr.js';
import { generateReverseNames, reverseNameOf } from '../../utils/reverse-zones.js';

/** The TTL Authoritative serves `record` ({type, ttl}) with. */
export const servedTtl = (record) => (record.ttl > 0 ? record.ttl : LOCAL_RECORD_TTL);

const LABEL = /^(\*|[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)$/;

/** `name` absolute (trailing dot) and lowercase, or null when it is no DNS name. */
export function absoluteName(name) {
  const bare = normalizeDnsName(name);
  if (!bare || bare.length > 253) return null;
  const labels = bare.split('.');
  if (!labels.every((label, i) => LABEL.test(label) && (label !== '*' || i === 0))) return null;
  return `${bare}.`;
}

const inZone = (name, zone) => name === zone || name.endsWith(`.${zone}`);

// One TXT string on the wire holds at most 255 bytes, so a longer value
// becomes several. Inside the quotes `"` and `\` are escaped and every byte
// outside printable ASCII is written as \DDD, as zone files spell it.
export function txtContent(value) {
  const bytes = Buffer.from(value, 'utf8');
  const strings = [];
  for (let at = 0; at < bytes.length || strings.length === 0; at += 255) {
    let text = '';
    for (const byte of bytes.subarray(at, at + 255)) {
      if (byte === 0x22 || byte === 0x5c) text += `\\${String.fromCharCode(byte)}`;
      else if (byte >= 0x20 && byte < 0x7f) text += String.fromCharCode(byte);
      else text += `\\${String(byte).padStart(3, '0')}`;
    }
    strings.push(`"${text}"`);
  }
  return strings.join(' ');
}

// The content of one record, or null when it cannot be served.
function recordContent(record) {
  const target = () => absoluteName(record.value);
  switch (record.type) {
    case 'A':
      return addressFamily(record.value) === 4 ? canonicalizeIp(record.value) : null;
    case 'AAAA':
      return addressFamily(record.value) === 6 ? canonicalizeIp(record.value) : null;
    case 'CNAME':
    case 'PTR':
      return target();
    case 'MX':
      return target() && `${record.priority ?? 10} ${target()}`;
    case 'SRV':
      return (
        target() &&
        Number.isInteger(record.port) &&
        `${record.priority || 0} ${record.weight || 0} ${record.port} ${target()}`
      );
    case 'TXT':
      return validateTxtValue(record.value) == null ? txtContent(record.value) : null;
    default:
      return null;
  }
}

function mailbox(email) {
  return absoluteName(String(email || '').replace('@', '.'));
}

// A zone CIDRella makes itself (below) carries the SOA defaults a new zone
// gets in the UI.
const DERIVED_SOA = { ns: 'ns1.localhost.', admin: 'admin.localhost.' };

function emptyZone(name, { ns, admin, serial, refresh, retry, expire, minimum }) {
  const rrsets = new Map();
  const zone = { name, rrsets };
  zone.put = (owner, type, ttl, content) => {
    const key = `${owner}|${type}`;
    const rrset = rrsets.get(key) || { name: owner, type, ttl, records: [] };
    rrset.ttl = Math.min(rrset.ttl, ttl);
    if (!rrset.records.includes(content)) rrset.records.push(content);
    rrsets.set(key, rrset);
  };
  zone.put(
    name,
    'SOA',
    LOCAL_RECORD_TTL,
    [
      ns,
      admin,
      serial ?? 1,
      refresh ?? 3600,
      retry ?? 900,
      expire ?? 604800,
      minimum ?? 86400,
    ].join(' '),
  );
  zone.put(name, 'NS', LOCAL_RECORD_TTL, ns);
  return zone;
}

const derivedZone = (name) => emptyZone(name, DERIVED_SOA);

// Space no one outside can reach (RFC 1918, shared, ULA, link-local and the
// like): a reverse zone for the whole network hides nothing that resolves
// upstream.
function isPrivateNetwork(cidr) {
  try {
    return !isGloballyRoutableCidr(cidr);
  } catch {
    return false;
  }
}

// The longest zone in `zones` that `owner` is in, or null.
function coveringZone(zones, owner) {
  let best = null;
  for (const name of zones.keys()) {
    if (inZone(owner, name) && (!best || name.length > best.length)) best = name;
  }
  return best;
}

/**
 * The zones Authoritative should hold: Map of absolute zone name to
 * { name, rrsets: Map of `${name}|${type}` to { name, type, ttl, records } },
 * records sorted. SOA and NS come from the zone row.
 *
 * What is left out, and why:
 * - placeholder PTRs (bare addresses), which no backend serves;
 * - a record whose name falls outside its zone, which Authoritative refuses
 *   (dnsmasq answers it from the hosts file);
 * - other data beside a CNAME at the same name, which DNS forbids (and
 *   Authoritative refuses): the first CNAME wins;
 * - every PTR at a name after the first, which is the canonical name the
 *   reverse-DNS projection chose.
 * An rrset is served with the lowest TTL among its records.
 *
 * And what is added, so PowerDNS answers what dnsmasq answers:
 * - a PTR for each served A or AAAA address inside an allocated network that
 *   has no PTR record served, naming its first name (servedHostsByAddress,
 *   the rule dnsmasq's hosts file follows). It goes in the CIDRella reverse
 *   zone covering it, else in a zone made for it: the whole network's for
 *   private space, the one address's for public space, so the rest of a
 *   public network still resolves upstream;
 * - an empty zone (SOA and NS) for each name in `reserved`
 *   (backends/shared/reserved-zones.js) no zone already has.
 */
export function desiredZones({ zones, records, networks = [] }, { reserved = [] } = {}) {
  const out = new Map();
  for (const row of zones) {
    const name = absoluteName(row.name);
    const ns = absoluteName(row.soa_primary_ns);
    const admin = mailbox(row.soa_admin_email);
    if (!name || !ns || !admin) continue;
    const zone = emptyZone(name, {
      ns,
      admin,
      serial: row.soa_serial,
      refresh: row.soa_refresh,
      retry: row.soa_retry,
      expire: row.soa_expire,
      minimum: row.soa_minimum_ttl,
    });

    const ofZone = records.filter((r) => r.zoneId === row.id && !r.placeholder);
    const cnames = new Map();
    for (const record of ofZone) {
      const owner = absoluteName(record.fqdn);
      if (record.type === 'CNAME' && owner && owner !== name && !cnames.has(owner)) {
        cnames.set(owner, record.id);
      }
    }
    for (const record of ofZone) {
      const owner = absoluteName(record.fqdn);
      if (!owner || !inZone(owner, name)) continue;
      if (cnames.has(owner) && cnames.get(owner) !== record.id) continue;
      if (record.type === 'CNAME' && !cnames.has(owner)) continue;
      if (record.type === 'PTR' && zone.rrsets.has(`${owner}|PTR`)) continue;
      const content = recordContent(record);
      if (content) zone.put(owner, record.type, servedTtl(record), content);
    }
    out.set(name, zone);
  }

  // Addresses with a PTR record served, wherever it is.
  const withPtr = new Set();
  for (const zone of out.values()) {
    for (const rrset of zone.rrsets.values()) if (rrset.type === 'PTR') withPtr.add(rrset.name);
  }
  for (const [address, names] of servedHostsByAddress({ records })) {
    const reverse = reverseNameOf(address);
    const owner = reverse && `${reverse}.`;
    const target = absoluteName(names[0]?.fqdn);
    if (!owner || !target || withPtr.has(owner)) continue;
    const network = networks.find((cidr) => {
      try {
        return networkContains(cidr, address);
      } catch {
        return false;
      }
    });
    if (!network) continue;
    let zoneName = coveringZone(out, owner);
    if (!zoneName) {
      zoneName = isPrivateNetwork(network)
        ? absoluteName(generateReverseNames(network).find((z) => inZone(owner, `${z}.`)) || reverse)
        : owner;
      if (!out.has(zoneName)) out.set(zoneName, derivedZone(zoneName));
    }
    out.get(zoneName).put(owner, 'PTR', LOCAL_RECORD_TTL, target);
    withPtr.add(owner);
  }

  for (const domain of reserved) {
    const name = absoluteName(domain);
    if (name && !out.has(name)) out.set(name, derivedZone(name));
  }

  for (const zone of out.values()) {
    for (const rrset of zone.rrsets.values()) rrset.records.sort();
  }
  return new Map([...out].map(([name, { rrsets }]) => [name, { name, rrsets }]));
}

// A minimal YAML writer for the Recursor configuration: every string is a
// JSON string, which YAML reads as the same string, so no value can break out
// of its line.
function yaml(value, indent = '') {
  if (Array.isArray(value)) {
    if (value.length === 0) return ' []';
    return value
      .map((item) => {
        if (item && typeof item === 'object') {
          const body = yaml(item, `${indent}  `).replace(/^\n\s*/, '');
          return `\n${indent}- ${body}`;
        }
        return `\n${indent}- ${JSON.stringify(item)}`;
      })
      .join('');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, v]) => {
        const nested = v && typeof v === 'object';
        return `\n${indent}${key}:${nested ? yaml(v, `${indent}  `) : ` ${JSON.stringify(v)}`}`;
      })
      .join('');
  }
  return ` ${JSON.stringify(value)}`;
}

/**
 * recursor.yml, split in two: `zones` is what `rec_control reload-zones`
 * and `reload-lua-config` take while Recursor runs (the forward zones and
 * their negative trust anchors); `fixed` needs a restart.
 *
 * - every local zone goes to Authoritative, with a negative trust anchor:
 *   the zones are unsigned under a signed parent, so validation would call
 *   them Bogus;
 * - everything else goes to CIDRella's forwarder with recursion asked for,
 *   unless recursion is off, and Recursor itself never queries anyone else
 *   (dont_query covers every address; forwarders are exempt from it);
 * - Recursor adds none of its built-in RFC 1918 and RFC 6303 zones (turning
 *   off serve_rfc1918 turns off both): the reserved zones CIDRella forwards
 *   to Authoritative cover them, and each built-in one it skipped logged a
 *   warning at every start and zone reload. d.f.ip6.arpa, which Recursor
 *   would always answer, is local only while every upstream is public
 *   (backends/shared/reserved-zones.js);
 * - Recursor waits `networkTimeoutMs` for a forwarder, never throttles the
 *   loopback ones, and validates DNSSEC per `validation`.
 */
export function renderRecursorConfig({
  zones,
  listen,
  port,
  authPort,
  forwarders,
  recursion,
  validation,
  networkTimeoutMs,
  runDir,
  logQueries = false,
}) {
  const local = zones.map((name) => name.replace(/\.$/, '')).sort();
  const fixed = {
    incoming: { listen, port, allow_from: ['0.0.0.0/0', '::/0'] },
    outgoing: {
      network_timeout: networkTimeoutMs,
      dont_throttle_netmasks: ['127.0.0.1/32', '::1/128'],
      dont_query: ['0.0.0.0/0', '::/0'],
    },
    recursor: {
      socket_dir: runDir,
      security_poll_suffix: '',
      serve_rfc1918: false,
      forward_zones_recurse: recursion
        ? [{ zone: '.', forwarders }]
        : [],
    },
    dnssec: { validation },
  };
  // In bypass mode Recursor answers clients itself, so it logs each query
  // (backends/pdns/log-format.js reads them); behind the proxy, the proxy does.
  if (logQueries) fixed.logging = { quiet: false };
  const zonePart = {
    forward_zones: local.map((zone) => ({ zone, forwarders: [`127.0.0.1:${authPort}`] })),
    negative_trustanchors: local.map((name) => ({ name, reason: 'CIDRella local zone' })),
  };
  const config = {
    ...(fixed.logging && { logging: fixed.logging }),
    incoming: fixed.incoming,
    outgoing: fixed.outgoing,
    recursor: { ...fixed.recursor, forward_zones: zonePart.forward_zones },
    dnssec: { ...fixed.dnssec, negative_trustanchors: zonePart.negative_trustanchors },
  };
  return {
    text: `# Written by CIDRella from its database. Edits here are overwritten.${yaml(config)}\n`,
    fixed: JSON.stringify(fixed),
    zones: JSON.stringify(zonePart),
  };
}

/** pdns.conf: gsqlite3, DNS and the API on loopback only. */
export function renderAuthConfig({ dbPath, port, apiPort, apiKey, runDir }) {
  return [
    '# Written by CIDRella. Edits here are overwritten.',
    'launch=gsqlite3',
    `gsqlite3-database=${dbPath}`,
    'local-address=127.0.0.1',
    `local-port=${port}`,
    `socket-dir=${runDir}`,
    'api=yes',
    `api-key=${apiKey}`,
    'webserver=yes',
    'webserver-address=127.0.0.1',
    `webserver-port=${apiPort}`,
    'webserver-allow-from=127.0.0.1/32,::1/128',
    'security-poll-suffix=',
    '',
  ].join('\n');
}
