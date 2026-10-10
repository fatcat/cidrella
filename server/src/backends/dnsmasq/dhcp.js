import fs from 'fs';
import path from 'path';
import { cleanStaleFiles } from './dnsmasq.js';
import { atomicWrite } from '../shared/validated-files.js';
import { isValidAddress } from '../../utils/ip.js';
import { isValidIpv6 } from '../../utils/address.js';
import { dnsmasqOptionToken } from './option-names.js';
import { poolSegments } from '../shared/pool-segments.js';
import { loadDhcpReservations, loadDhcpScopes } from '../shared/dhcp-scope-model.js';
import { CONF_DIR, DHCP_HOSTS_DIR } from './paths.js';
import { isWholeLeaseFile } from './lease-file.js';

/**
 * One option value as dnsmasq writes it: addresses comma-joined, and for
 * IPv6 in the bracketed form option6 values require.
 */
function optionText(option, family) {
  if (!option.addresses) return option.text;
  return option.addresses.map((ip) => (family === 6 ? `[${ip}]` : ip)).join(',');
}

function optionLine(tag, option, family) {
  return `dhcp-option=tag:${tag},${dnsmasqOptionToken(option.code, family)},${optionText(option, family)}`;
}

/**
 * dnsmasq config for one DHCPv4 scope (a scope from loadDhcpScopes). Tagging
 * keeps its options to its own ranges. dnsmasq ignores option 51 as a
 * dhcp-option, so the lease time rides on each dhcp-range.
 */
function generateScopeConfig(model) {
  const { scope, pools, excludedIps, leaseTime } = model;
  const tag = `scope${scope.id}`;
  const lines = [
    `# DHCP scope for ${scope.subnet_cidr} (${pools.map((pool) => `${pool.start_ip} - ${pool.end_ip}`).join(', ')})`,
  ];
  for (const [start, end] of poolSegments(pools, excludedIps, 4)) {
    lines.push(`dhcp-range=set:${tag},${start},${end},${model.netmask},${leaseTime}`);
  }
  // dnsmasq otherwise supplies its own address as router when option 3 is
  // omitted. An explicit network gateway policy of none must suppress that.
  if (model.suppressRouter) lines.push(`dhcp-option=tag:${tag},3`);
  for (const option of model.options) lines.push(optionLine(tag, option, 4));
  return lines.join('\n') + '\n';
}

// The DHCPv6 options dnsmasq also carries in its Router Advertisements:
// DNS servers (23) as RDNSS and the search list (24) as DNSSL.
const RA_OPTION_CODES = new Set([23, 24]);

/**
 * dnsmasq config for one DHCPv6 scope. The mode decides what dnsmasq does on
 * the link: `slaac` sends Router Advertisements only, carrying the DNS
 * servers and search list, `stateless` adds a stateless DHCPv6 service for
 * every option, `stateful` hands out addresses from the pool. Routers are
 * never an option: clients learn them from the network router's own RA, and
 * CIDRella's RAs announce a router lifetime of 0.
 */
function generateScopeConfigV6(model) {
  const { scope, mode, leaseTime } = model;
  const tag = `scope${scope.id}`;
  const lines = [
    `# DHCPv6 scope for ${scope.subnet_cidr} (${mode})`,
    'enable-ra',
    // Router lifetime 0 on every interface: CIDRella's Router Advertisements
    // carry the prefix, DNS servers and search list, but never offer this
    // host as a default router. The network's router advertises itself; left
    // at dnsmasq's default (three times the interval) every client would also
    // route through CIDRella, which does not forward. IPV6-12.
    'ra-param=*,0,0',
  ];
  // The lease time is the valid lifetime the RA gives the prefix, the one the
  // lifecycle times a SLAAC address by (IPV6-15); without it dnsmasq would
  // advertise its own default instead.
  const raLifetime = leaseTime ? `,${leaseTime}` : '';

  if (mode === 'slaac') {
    lines.push(`dhcp-range=set:${tag},${model.network},ra-only,${model.prefix}${raLifetime}`);
  } else if (mode === 'stateless') {
    lines.push(
      `dhcp-range=set:${tag},${model.network},ra-stateless,ra-names,${model.prefix}${raLifetime}`,
    );
  } else {
    for (const [start, end] of poolSegments(model.pools, model.excludedIps, 6)) {
      lines.push(`dhcp-range=set:${tag},${start},${end},${model.prefix},${leaseTime}`);
    }
  }

  for (const option of model.options) {
    // SLAAC runs no DHCPv6 service, so no option reaches a client by DHCP.
    // dnsmasq does copy these two into its Router Advertisements (RDNSS and
    // DNSSL), and without them a SLAAC client is told of no DNS server.
    if (mode === 'slaac' && !RA_OPTION_CODES.has(option.code)) continue;
    lines.push(optionLine(tag, option, 6));
  }
  return lines.join('\n') + '\n';
}

// Written while another backend (Kea) answers DHCP. dnsmasq still sends the
// Router Advertisements, and an RA carrying the M or O flag makes it bind UDP
// 547 beside Kea, which no setting avoids. This makes it answer no DHCP
// request at all: no tag is called nosuchtag, so every packet matches.
// Verified against dnsmasq 2.91 with Kea 3.0 (docs/DNSMASQ-COUPLING.md).
const NOT_SERVING_FILE = 'dhcp-not-serving.conf';
const NOT_SERVING_CONTENT = [
  '# Another DHCP server answers DHCP; dnsmasq sends Router Advertisements only.',
  'dhcp-ignore=tag:!nosuchtag',
  '',
].join('\n');

function writeIfChanged(filePath, content) {
  let old = null;
  try {
    old = fs.readFileSync(filePath, 'utf-8');
  } catch {
    /* file doesn't exist */
  }
  if (content === old) return false;
  atomicWrite(filePath, content);
  return true;
}

/**
 * Regenerate all DHCP scope config files in conf.d/. A scope left out of the
 * model (disabled, or IPv6 with support off) loses its file with the other
 * inactive ones. Returns true if any file changed (needs dnsmasq restart).
 *
 * With `serving` false another backend answers DHCP: DHCPv4 scopes get no
 * file (no range, so dnsmasq opens no DHCPv4 socket), DHCPv6 scopes keep
 * theirs so the Router Advertisements carry the right M and O flags, and
 * dhcp-not-serving.conf makes dnsmasq ignore every request. A range is never
 * rewritten as ra-only: dnsmasq serves stateful DHCPv6 from a range with
 * ra-only all the same.
 */
export function regenerateScopeConfigs(db, { confDir = CONF_DIR, serving = true } = {}) {
  const activeIds = new Set();
  let changed = false;
  const notServingPath = path.join(confDir, NOT_SERVING_FILE);
  if (serving) {
    if (fs.existsSync(notServingPath)) {
      fs.rmSync(notServingPath, { force: true });
      changed = true;
    }
  } else if (writeIfChanged(notServingPath, NOT_SERVING_CONTENT)) {
    changed = true;
  }
  for (const model of loadDhcpScopes(db)) {
    if (!serving && model.family === 4) continue;
    activeIds.add(model.scope.id);
    const filePath = path.join(confDir, `dhcp-scope-${model.scope.id}.conf`);
    const newContent =
      model.family === 6 ? generateScopeConfigV6(model) : generateScopeConfig(model);
    if (writeIfChanged(filePath, newContent)) changed = true;
  }

  // Clean stale scope config files
  if (cleanStaleFiles(confDir, 'dhcp-scope-', '.conf', activeIds)) changed = true;

  return changed;
}

/**
 * Regenerate the reservations hosts file for dhcp-hostsdir (hot-reload).
 * DHCPv4: <mac>,<ip>[,<hostname>],infinite
 * DHCPv6: id:<duid>,[<ip>][,<hostname>],infinite
 * Empty while another backend answers DHCP (`serving` false).
 */
export function regenerateReservations(db, { hostsDir = DHCP_HOSTS_DIR, serving = true } = {}) {
  const reservations = serving ? loadDhcpReservations(db) : [];
  const lines = reservations.map((r) => {
    const parts = r.family === 6 ? [`id:${r.duid}`, `[${r.ip}]`] : [r.mac, r.ip];
    if (r.hostname) parts.push(r.hostname);
    parts.push('infinite');
    return parts.join(',');
  });

  const filePath = path.join(hostsDir, 'reservations.hosts');
  const content = lines.length > 0 ? lines.join('\n') + '\n' : '';
  // A missing file and an empty one are the same to dnsmasq.
  if (!content && !fs.existsSync(filePath)) return false;
  return writeIfChanged(filePath, content);
}

/**
 * One dnsmasq lease-file line as a lease object, or null for lines that are
 * not leases (the `duid <server-duid>` header, blank or truncated lines).
 *
 * DHCPv4: <expiry> <mac> <ip> <hostname|*> <client-id|*>
 * DHCPv6: <expiry> [T]<iaid> <ip6> <hostname|*> <client-duid|*>
 *   A leading T marks a temporary (IA_TA) address. The IAID is decimal.
 */
export function parseLeaseLine(line) {
  const parts = String(line || '')
    .trim()
    .split(/\s+/);
  if (parts.length < 4 || parts[0] === 'duid') return null;
  const [expiryStr, identity, ip, hostname, clientId] = parts;
  if (!/^\d+$/.test(expiryStr) || !isValidAddress(ip)) return null;
  const expiry = parseInt(expiryStr, 10);
  const base = {
    ip,
    hostname: hostname === '*' ? null : hostname,
    clientId: clientId === '*' ? null : clientId || null,
    expiresAt: expiry === 0 ? 'infinite' : new Date(expiry * 1000).toISOString(),
  };
  if (isValidIpv6(ip)) {
    const iaidMatch = /^(T?)(\d+)$/.exec(identity);
    if (!iaidMatch) return null;
    return {
      ...base,
      dhcpVersion: 6,
      mac: null,
      iaid: Number(iaidMatch[2]),
      temporary: iaidMatch[1] === 'T',
      duid: base.clientId ? base.clientId.toLowerCase() : null,
    };
  }
  return { ...base, dhcpVersion: 4, mac: identity.toLowerCase(), duid: null, iaid: null };
}

/**
 * A lease as the dnsmasq lease-file line parseLeaseLine reads back: the
 * inverse, for writing a lease set into a stopped dnsmasq (a backend
 * handover). Expiry is whole seconds; 'infinite' is 0.
 */
export function formatLeaseLine(lease) {
  const expiry =
    lease.expiresAt === 'infinite' ? 0 : Math.floor(Date.parse(lease.expiresAt) / 1000);
  const name = lease.hostname || '*';
  if (lease.dhcpVersion === 6) {
    const iaid = `${lease.temporary ? 'T' : ''}${lease.iaid}`;
    return `${expiry} ${iaid} ${lease.ip} ${name} ${lease.duid || lease.clientId || '*'}`;
  }
  return `${expiry} ${lease.mac} ${lease.ip} ${name} ${lease.clientId || '*'}`;
}

/**
 * A whole lease file in the order dnsmasq writes one: DHCPv4 leases, then
 * the server's DUID line and the DHCPv6 leases.
 */
export function formatLeaseFile(leases, { serverDuid = null } = {}) {
  const v4 = leases.filter((lease) => lease.dhcpVersion !== 6).map(formatLeaseLine);
  const v6 = leases.filter((lease) => lease.dhcpVersion === 6).map(formatLeaseLine);
  const lines = [...v4, ...(serverDuid ? [`duid ${serverDuid}`] : []), ...v6];
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * The leases in lease-file text, or null when the text was cut off partway
 * through a line (dnsmasq was still writing it). Lines that are not leases
 * are skipped.
 */
export function parseLeaseFile(content) {
  if (!isWholeLeaseFile(content)) return null;
  return content.split('\n').map(parseLeaseLine).filter(Boolean);
}
