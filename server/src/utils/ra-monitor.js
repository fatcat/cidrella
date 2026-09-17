// Rogue Router Advertisement detection, passive.
//
// A rogue RA is the most damaging IPv6 attack on a LAN (RFC 6104): any
// host that sends one becomes a default router and DNS server for every
// autoconfiguring client. CIDRella cannot send a Router Solicitation without
// a raw ICMPv6 socket, which Node does not offer, so this reads what the
// kernel already knows. With `accept_ra` on, the kernel processes every RA
// heard on the link and keeps the sender as a default route tagged
// `proto ra` for the router lifetime it advertised. Routers re-advertise well
// inside that lifetime, so a rogue that is still sending is still listed.
//
// Interfaces with `accept_ra` off (the kernel default when forwarding is on,
// unless set to 2) give no data. That is reported as unsupported per
// interface rather than as a clean result.
//
// Trust: CIDRella's own addresses, the allowlist by link-local IP or MAC, and
// the MAC of any router the operator has configured as a gateway. Without the
// last rule the first check on every deployment would flag the real router.

import fs from 'fs';
import { execFileSync } from 'child_process';
import { selectProbeInterfaceNames } from './dhcp-probe.js';
import { localAddressSet } from './local-addresses.js';
import { readNdCache } from './nd-cache.js';
import { canonicalizeIp } from './address.js';
import { upsertRogueEvent, authorizedSets, configuredGatewayMacSet } from '../models/rogue-dhcp.js';

let lastCheckAt = null;
let lastOutcome = null; // ok | unsupported | error | no-interfaces
let lastError = null;
let supportedInterfaces = [];
let unsupportedInterfaces = [];

function raLog(level, msg, extra) {
  const ts = new Date().toISOString();
  const prefix = `[ra-monitor] ${ts}`;
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  if (level === 'error') console.error(`${prefix} ERROR: ${msg}${suffix}`);
  else if (level === 'warn') console.warn(`${prefix} WARN: ${msg}${suffix}`);
  else console.log(`${prefix} ${msg}${suffix}`);
}

// ─── Pure helpers (exported for tests) ───────────────────

/**
 * Parse `ip -6 route show proto ra` into the routers and prefixes it learned.
 * Lines look like:
 *   default via fe80::1 dev eth0 proto ra metric 1024 expires 1755sec hoplimit 64 pref medium
 *   fd00:1234::/64 dev eth0 proto ra metric 1024 expires 86391sec pref medium
 * Returns { routers: [{ address, iface, expiresSec, preference }],
 *           prefixes: Map<iface, string[]> }.
 */
export function parseRaRoutes(text) {
  const routers = [];
  const prefixes = new Map();
  if (!text) return { routers, prefixes };
  for (const raw of String(text).split('\n')) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const field = (name) => {
      const i = parts.indexOf(name);
      return i >= 0 ? parts[i + 1] || null : null;
    };
    // `ip -6 route show proto ra` already filters, but a caller may pass the
    // unfiltered table.
    if (field('proto') !== 'ra') continue;
    const iface = field('dev');
    if (!iface) continue;
    const expires = field('expires');
    const expiresSec = expires ? Number.parseInt(expires, 10) : null;
    if (parts[0] === 'default') {
      const address = canonicalizeIp(field('via'));
      if (!address) continue;
      routers.push({
        address,
        iface,
        expiresSec: Number.isFinite(expiresSec) ? expiresSec : null,
        preference: field('pref'),
      });
      continue;
    }
    if (parts[0].includes('/') && !parts.includes('via')) {
      if (!prefixes.has(iface)) prefixes.set(iface, []);
      prefixes.get(iface).push(parts[0]);
    }
  }
  return { routers, prefixes };
}

function sysctl(iface, key) {
  try {
    return fs.readFileSync(`/proc/sys/net/ipv6/conf/${iface}/${key}`, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Does the kernel process RAs on this interface? accept_ra=2 always,
 * accept_ra=1 only while forwarding is off. Null values mean the sysctl tree
 * is not there (not Linux, or IPv6 disabled), which counts as unsupported.
 */
export function raSupportedOn(iface, { read = sysctl } = {}) {
  const acceptRa = read(iface, 'accept_ra');
  if (acceptRa === '2') return true;
  if (acceptRa === '1') return read(iface, 'forwarding') === '0';
  return false;
}

/**
 * Decide whether a router is one we expect. `router` is { address, iface },
 * `mac` what the neighbor table knows, `trusted` = { selfIps, authorized,
 * gatewayMacs }.
 */
export function classifyRouter(router, { mac = null, selfIps, authorized, gatewayMacs }) {
  const ip = String(router.address).toLowerCase();
  const lladdr = mac ? String(mac).toLowerCase() : null;
  if (selfIps.has(ip)) return { rogue: false, reason: 'self' };
  if (authorized.ips.has(ip)) return { rogue: false, reason: 'authorized' };
  if (lladdr && authorized.macs.has(lladdr)) return { rogue: false, reason: 'authorized' };
  if (lladdr && gatewayMacs.has(lladdr)) return { rogue: false, reason: 'configured-gateway' };
  return { rogue: true, reason: 'unauthorized' };
}

function readRaRoutes() {
  return parseRaRoutes(
    execFileSync('ip', ['-6', 'route', 'show', 'proto', 'ra'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    }),
  );
}

// ─── Check orchestration ─────────────────────────────────

/**
 * Read the kernel's learned routers on every probe interface and persist the
 * ones nobody vouches for. Synchronous: it is two process reads.
 *
 * `routes`, `interfaces`, `neighbors` and `supported` are test seams.
 */
export function checkRouterAdvertisements(
  db,
  { routes = null, interfaces = null, neighbors = null, supported = raSupportedOn } = {},
) {
  lastCheckAt = new Date().toISOString();
  lastError = null;
  try {
    const names = interfaces || selectProbeInterfaceNames();
    if (names.length === 0) {
      lastOutcome = 'no-interfaces';
      supportedInterfaces = [];
      unsupportedInterfaces = [];
      return { supported: true, interfaces: 0, routers: 0, rogues: [] };
    }
    supportedInterfaces = names.filter((n) => supported(n));
    unsupportedInterfaces = names.filter((n) => !supported(n));
    if (supportedInterfaces.length === 0) {
      lastOutcome = 'unsupported';
      lastError = `accept_ra is off on ${unsupportedInterfaces.join(', ')}`;
      raLog('warn', 'No interface accepts Router Advertisements, RA detection is unavailable', {
        interfaces: unsupportedInterfaces,
      });
      return { supported: false, interfaces: names.length, routers: 0, rogues: [] };
    }

    const learned = routes || readRaRoutes();
    const watched = new Set(supportedInterfaces);
    const routers = learned.routers.filter((r) => watched.has(r.iface));
    const table = neighbors || (routers.length > 0 ? readNdCache({ force: true }) : new Map());
    const trusted = {
      selfIps: localAddressSet(),
      authorized: authorizedSets(db),
      gatewayMacs: configuredGatewayMacSet(db),
    };

    const rogues = [];
    for (const router of routers) {
      const mac = table.get(router.address)?.mac || null;
      const verdict = classifyRouter(router, { mac, ...trusted });
      if (!verdict.rogue) continue;
      rogues.push({
        kind: 'ra',
        address_family: 6,
        server_ip: router.address,
        server_mac: mac || '',
        server_duid: null,
        server_identifier: null,
        offered_ip: null,
        offered_gateway: router.address,
        offered_dns: null,
        offered_subnet_mask: null,
        advertised_prefixes: (learned.prefixes.get(router.iface) || []).join(',') || null,
        relay_ip: null,
        iface: router.iface,
      });
    }
    for (const ev of rogues) upsertRogueEvent(db, ev);
    if (rogues.length > 0) {
      raLog('warn', 'Rogue router(s) advertising on the link', {
        count: rogues.length,
        routers: rogues.map((r) => `${r.server_ip} on ${r.iface}`),
      });
    }
    lastOutcome = 'ok';
    return { supported: true, interfaces: names.length, routers: routers.length, rogues };
  } catch (err) {
    lastOutcome = 'error';
    lastError = err.message;
    raLog('error', 'Router Advertisement check failed', { error: err.message });
    throw err;
  }
}

export function getRaState() {
  return {
    lastCheckAt,
    lastOutcome,
    lastError,
    supported: lastOutcome !== 'unsupported',
    supportedInterfaces: [...supportedInterfaces],
    unsupportedInterfaces: [...unsupportedInterfaces],
  };
}
