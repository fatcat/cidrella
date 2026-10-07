/**
 * Kea's two configuration files (kea-dhcp4.conf, kea-dhcp6.conf) from the
 * DHCP scope model (backends/shared/dhcp-scope-model.js). Pure: every input
 * is passed in, so the same model renders the same bytes.
 *
 * Mapping, where it is not one to one:
 * - A Kea subnet id is the CIDRella subnets.id. Several scopes on one network
 *   become one Kea subnet with several pools. The first scope's options and
 *   lease time are the subnet's (a reserved client is outside every pool and
 *   gets the subnet's); another scope's options ride on its own pools. Kea
 *   has no per-pool lease time, so the first scope's applies to all.
 * - Reservations are in the configuration, not host_cmds, so the file stays
 *   the whole desired state.
 * - DDNS is off: CIDRella writes the DNS names itself. With DDNS off Kea
 *   still stores the name the client sent in the lease.
 * - A SLAAC scope has no DHCPv6 service; dnsmasq keeps sending the Router
 *   Advertisements for every IPv6 scope.
 */
import { addressToBig, networkContains } from '../../utils/cidr.js';
import { leaseSeconds } from '../../utils/lease-time.js';
import { poolSegments } from '../shared/pool-segments.js';
import {
  KEA_API_USER,
  KEA_LOG_DIR,
  KEA_PASSWORD_FILE,
  KEA_SECRET_DIR,
  controlPort,
  leaseFilePath,
  legalLogBaseName,
  logFilePath,
} from './paths.js';

export const INFINITE_LIFETIME = 4294967295;

// The fingerprint watcher reads these (legal-log-parser.js). Kea writes a
// legal-log line only for a lease it commits, so each line is a REQUEST and
// its ACK. Kea joins the request and response parts with nothing between
// them, so the response part opens with a space.
const LEGAL_REQUEST_FORMAT =
  "ifelse(pkt4.msgtype == 3 or pkt4.msgtype == 1, 'type=' + uint32totext(pkt4.msgtype) + " +
  "' mac=' + hexstring(pkt4.mac, ':') + ' prl=' + hexstring(option[55].hex, ',') + " +
  "' vci=' + option[60].text + ' host=' + option[12].text, '')";
const LEGAL_RESPONSE_FORMAT = "ifelse(pkt4.msgtype == 5, ' ack ip=' + addrtotext(pkt4.yiaddr), '')";

function lifetime(leaseTime) {
  const seconds = leaseSeconds(leaseTime);
  if (seconds === Infinity) return INFINITE_LIFETIME;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, INFINITE_LIFETIME - 1) : null;
}

function addressBytes(ip, family) {
  return addressToBig(ip)
    .value.toString(16)
    .padStart(family === 6 ? 32 : 8, '0');
}

// dnsmasq's rule for a number with no declared width (option.c): the
// smallest of 1, 2 or 4 bytes that holds it. A custom number option goes on
// the wire the same from either server.
function numberBytes(value) {
  const n = Number(value) >>> 0;
  const width = n & 0xffff0000 ? 8 : n & 0xff00 ? 4 : 2;
  return n.toString(16).padStart(width, '0');
}

const utf8Bytes = (text) => Buffer.from(text, 'utf8').toString('hex');

// An option's bytes from its declared type, for an option Kea has no
// definition for.
function typedBytes(option, family) {
  if (option.addresses) return option.addresses.map((ip) => addressBytes(ip, family)).join('');
  if (option.type === 'number') return numberBytes(option.text);
  return utf8Bytes(option.text);
}

const HEX_PAIRS_RE = /^[0-9a-f]{1,2}(?::[0-9a-f]{1,2})+$/i;
const IPV4_LIST_RE = /^\d{1,3}(?:\.\d{1,3}){3}(?:,\d{1,3}(?:\.\d{1,3}){3})*$/;

// dnsmasq's bytes for a value it has no type for, which is every DHCPv4
// option, since CIDRella writes them by number: colon-separated hex is
// bytes, a plain number takes the width rule, addresses are four bytes
// each, and anything else is the text itself.
function shapeBytes(text) {
  if (HEX_PAIRS_RE.test(text)) {
    return text
      .split(':')
      .map((b) => b.padStart(2, '0'))
      .join('')
      .toLowerCase();
  }
  if (/^\d+$/.test(text)) return numberBytes(text);
  if (IPV4_LIST_RE.test(text))
    return text
      .split(',')
      .map((ip) => addressBytes(ip, 4))
      .join('');
  return utf8Bytes(text);
}

// dnsmasq writes option 121 as "net/prefix,router,net/prefix,router"; Kea
// wants "net/prefix - router, ...". A value that is not pairs is left for
// Kea to refuse, the same as dnsmasq would.
function classlessRoutes(text) {
  const parts = text.split(',').map((p) => p.trim());
  if (parts.length % 2 !== 0) return text;
  const routes = [];
  for (let i = 0; i < parts.length; i += 2) routes.push(`${parts[i]} - ${parts[i + 1]}`);
  return routes.join(', ');
}

// DHCPv6 NTP servers (RFC 5908): each address is its own suboption, 1 for a
// server and 2 for a multicast group, as dnsmasq sends them (rfc3315.c).
function ntpSuboptions(option) {
  return option.addresses
    .map((ip) => `${ip.toLowerCase().startsWith('ff') ? '0002' : '0001'}0010${addressBytes(ip, 6)}`)
    .join('');
}

// Catalog options whose Kea form is not the text a user enters for
// dnsmasq. `raw` gives the bytes; `text` gives Kea's text form.
const KEA_FORMS = {
  4: {
    // Kea has no definition for these.
    150: { raw: (option) => typedBytes(option, 4) },
    252: { raw: (option) => typedBytes(option, 4) },
    // Opaque to Kea (binary or an encapsulated space): dnsmasq's bytes.
    43: { raw: (option) => shapeBytes(option.text) },
    63: { raw: (option) => shapeBytes(option.text) },
    77: { raw: (option) => shapeBytes(option.text) },
    82: { raw: (option) => shapeBytes(option.text) },
    121: { text: (option) => classlessRoutes(option.text) },
  },
  6: {
    56: { raw: ntpSuboptions },
  },
};

/**
 * One option-data entry. A catalog option is a standard Kea option, written
 * as text Kea parses by its own definition, unless KEA_FORMS says
 * otherwise. A custom one has no definition Kea knows, so it is written as
 * the bytes of its declared type (an option-def could clash with a code Kea
 * defines and fail the file).
 */
function optionData(option, family) {
  const space = family === 6 ? 'dhcp6' : 'dhcp4';
  const form = option.custom
    ? { raw: (o) => typedBytes(o, family) }
    : KEA_FORMS[family][option.code];
  if (form?.raw) return { code: option.code, space, 'csv-format': false, data: form.raw(option) };
  const data = form?.text
    ? form.text(option)
    : option.addresses
      ? option.addresses.join(', ')
      : option.text;
  return { code: option.code, space, data };
}

function controlSockets(family) {
  return [
    {
      'socket-type': 'http',
      'socket-address': '127.0.0.1',
      'socket-port': controlPort(family),
      authentication: {
        type: 'basic',
        realm: 'cidrella',
        directory: KEA_SECRET_DIR,
        clients: [{ user: KEA_API_USER, 'password-file': KEA_PASSWORD_FILE }],
      },
    },
  ];
}

function loggers(family) {
  return [
    {
      name: `kea-dhcp${family}`,
      'output-options': [
        // Kea rotates its own log: four files of 10 MiB.
        { output: logFilePath(family), maxsize: 10485760, maxver: 4 },
      ],
      severity: 'INFO',
    },
  ];
}

function hooks(family) {
  const legal = {
    library: 'libdhcp_legal_log.so',
    parameters: {
      path: KEA_LOG_DIR,
      'base-name': legalLogBaseName(family),
      ...(family === 4
        ? {
            'request-parser-format': LEGAL_REQUEST_FORMAT,
            'response-parser-format': LEGAL_RESPONSE_FORMAT,
          }
        : {}),
    },
  };
  // Ping before offering, as dnsmasq does: DHCPv4 only (ICMP echo; the hook
  // has no DHCPv6 counterpart). Kea's defaults: one echo, a 100 ms wait, and
  // no ping for an address whose lease was active in the last minute.
  const ping = family === 4 ? [{ library: 'libdhcp_ping_check.so' }] : [];
  return [
    { library: 'libdhcp_lease_cmds.so' },
    { library: 'libdhcp_stat_cmds.so' },
    legal,
    ...ping,
  ];
}

// Scopes grouped by network, in scope order, so the first scope of each
// network sets the subnet.
function bySubnet(scopes) {
  const groups = new Map();
  for (const model of scopes) {
    const id = model.scope.subnet_id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(model);
  }
  return groups;
}

function pools(models, family) {
  const [first] = models;
  return models.flatMap((model) =>
    poolSegments(model.pools, model.excludedIps, family).map(([start, end]) => ({
      pool: `${start} - ${end}`,
      ...(model === first || model.options.length === 0
        ? {}
        : { 'option-data': model.options.map((option) => optionData(option, family)) }),
    })),
  );
}

function subnet4(models, reservations) {
  const [first] = models;
  const options = first.options.map((option) => optionData(option, 4));
  // Kea sends a broadcast address only when told to; dnsmasq always does.
  if (first.scope.subnet_broadcast) {
    options.push({ code: 28, space: 'dhcp4', data: first.scope.subnet_broadcast });
  }
  const valid = lifetime(first.leaseTime);
  return {
    id: first.scope.subnet_id,
    subnet: `${first.network}/${first.prefix}`,
    ...(valid ? { 'valid-lifetime': valid } : {}),
    pools: pools(models, 4),
    'option-data': options,
    reservations: reservations.map((r) => ({
      'hw-address': r.mac,
      'ip-address': r.ip,
      ...(r.hostname ? { hostname: r.hostname } : {}),
    })),
  };
}

// A DHCPv6 client on the link writes from a link-local address, so Kea picks
// the subnet by the interface it arrived on; a relayed one by the relay's
// link address, which needs no interface.
function interfaceFor(cidr, sysIfaces) {
  const onLink = (a) => {
    try {
      return a.family === 'IPv6' && networkContains(cidr, a.address);
    } catch {
      return false;
    }
  };
  for (const [name, addrs] of Object.entries(sysIfaces || {})) {
    if ((addrs || []).some(onLink)) return name;
  }
  return null;
}

function subnet6(models, reservations, sysIfaces) {
  const [first] = models;
  const cidr = `${first.network}/${first.prefix}`;
  const iface = interfaceFor(cidr, sysIfaces);
  const stateful = first.mode === 'stateful';
  const valid = lifetime(first.leaseTime);
  return {
    id: first.scope.subnet_id,
    subnet: cidr,
    ...(iface ? { interface: iface } : {}),
    // Kea's default preferred lifetime (an hour) would outlive a shorter
    // lease, which Kea refuses.
    ...(valid ? { 'valid-lifetime': valid, 'preferred-lifetime': valid } : {}),
    // dnsmasq always honors Rapid Commit; so does CIDRella under Kea.
    ...(stateful ? { 'rapid-commit': true } : {}),
    pools: stateful ? pools(models, 6) : [],
    'option-data': first.options.map((option) => optionData(option, 6)),
    reservations: reservations.map((r) => ({
      duid: r.duid,
      'ip-addresses': [r.ip],
      ...(r.hostname ? { hostname: r.hostname } : {}),
    })),
  };
}

/**
 * Kea's server-id from a DUID string ("00:01:00:01:..."): LLT (1), EN (2)
 * and LL (3) are the types Kea can be told; anything else, or none, lets Kea
 * make and keep its own.
 */
export function serverIdFromDuid(duid) {
  const hex = String(duid || '')
    .replace(/:/g, '')
    .toLowerCase();
  if (!/^[0-9a-f]{8,}$/.test(hex)) return null;
  const type = parseInt(hex.slice(0, 4), 16);
  if (type === 1 && hex.length > 16) {
    return {
      type: 'LLT',
      htype: parseInt(hex.slice(4, 8), 16),
      time: parseInt(hex.slice(8, 16), 16),
      identifier: hex.slice(16),
      persist: false,
    };
  }
  if (type === 2 && hex.length > 12) {
    return {
      type: 'EN',
      enterprise: parseInt(hex.slice(4, 12), 16),
      identifier: hex.slice(12),
      persist: false,
    };
  }
  if (type === 3 && hex.length > 8) {
    return {
      type: 'LL',
      htype: parseInt(hex.slice(4, 8), 16),
      identifier: hex.slice(8),
      persist: false,
    };
  }
  return null;
}

/**
 * The configuration object for one family.
 *   scopes        loadDhcpScopes(db), both families
 *   reservations  loadDhcpReservations(db), both families
 *   interfaces    the interface names DHCP serves on
 *   sysIfaces     os.networkInterfaces(), to place DHCPv6 subnets on a link
 *   serverDuid    the DHCPv6 DUID to answer with, or null
 */
export function renderKeaConfig(
  family,
  { scopes, reservations, interfaces, sysIfaces = {}, serverDuid = null },
) {
  const resBySubnet = new Map();
  for (const r of reservations) {
    if (r.family !== family) continue;
    if (!resBySubnet.has(r.subnetId)) resBySubnet.set(r.subnetId, []);
    resBySubnet.get(r.subnetId).push(r);
  }
  const live = scopes.filter(
    (model) => model.family === family && (family === 4 || model.mode !== 'slaac'),
  );
  const subnets = [...bySubnet(live).values()].map((models) => {
    const held = (resBySubnet.get(models[0].scope.subnet_id) || []).filter((r) =>
      networkContains(`${models[0].network}/${models[0].prefix}`, r.ip),
    );
    return family === 6 ? subnet6(models, held, sysIfaces) : subnet4(models, held);
  });

  const body = {
    // A daemon that could not open a socket on every listed interface stops
    // instead of running deaf. An interface still coming up at boot (an
    // IPv6 link-local address arrives a moment after the link) gets five
    // tries, five seconds apart, first.
    'interfaces-config': {
      interfaces: [...interfaces],
      'service-sockets-require-all': true,
      'service-sockets-max-retries': 5,
      'service-sockets-retry-wait-time': 5000,
    },
    'lease-database': {
      type: 'memfile',
      persist: true,
      name: leaseFilePath(family),
      'lfc-interval': 3600,
    },
    'control-sockets': controlSockets(family),
    'hooks-libraries': hooks(family),
    // T1 and T2 at half and seven eighths of the lease, as dnsmasq sends.
    'calculate-tee-times': true,
    ...(family === 4 ? { 't1-percent': 0.5, 't2-percent': 0.875 } : {}),
    'ddns-send-updates': false,
    'ddns-replace-client-name': 'never',
    loggers: loggers(family),
    [family === 6 ? 'subnet6' : 'subnet4']: subnets,
  };
  if (family === 6) {
    const serverId = serverIdFromDuid(serverDuid);
    if (serverId) body['server-id'] = serverId;
  }
  return { [family === 6 ? 'Dhcp6' : 'Dhcp4']: body };
}

export const serializeKeaConfig = (config) => `${JSON.stringify(config, null, 2)}\n`;
