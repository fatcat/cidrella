// Rogue DHCPv6 server detection, active probe.
//
// The IPv6 counterpart of dhcp-probe.js, and a different protocol (RFC 8415):
// there is no broadcast, so on a schedule we multicast a DHCPv6 SOLICIT to
// All_DHCP_Relay_Agents_and_Servers (ff02::1:2, UDP 547) out of each LAN
// segment and collect the ADVERTISEs that come back to UDP 546. A server that
// answers but is not CIDRella's own dnsmasq or on the allowlist is rogue. We
// send SOLICIT without Rapid Commit and never REQUEST, so no address is bound
// and the probe is non-disruptive.
//
// Identity is the server DUID, which is stable across reboots and address
// changes, plus the link-local source the ADVERTISE came from. The MAC is
// looked up in the kernel's neighbor table afterwards: the unicast reply we
// just received put it there.
//
// L2-scoped like the v4 probe: only servers on a link CIDRella has an
// interface on will answer. A server configured for stateless DHCPv6 only
// (information-request) ignores SOLICIT and is not found here; the router
// that points clients at it is what ra-monitor.js reports.
//
// One udp6 socket bound to [::]:546 receives the replies for every interface.
// Binding 546 needs the same privilege as :68 and :53, which the service has.

import dgram from 'dgram';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DATA_DIR } from '../config/defaults.js';
import { selectProbeInterfaceNames } from './dhcp-probe.js';
import { localAddressSet } from './local-addresses.js';
import { readNdCache } from './nd-cache.js';
import { canonicalizeIp, formatIp, IPV6_BITS } from './address.js';
import { duidFromBytes, normalizeDuid } from './duid.js';
import { upsertRogueEvent, authorizedSets } from '../models/rogue-dhcp.js';

const DHCPV6_SERVER_PORT = 547;
const DHCPV6_CLIENT_PORT = 546;
const ALL_DHCP_SERVERS = 'ff02::1:2';
const PROBE_WINDOW_MS = 4000;
const PROBE_WATCHDOG_GRACE_MS = 15 * 1000;
const PROBE_STUCK_MS = 5 * 60 * 1000;
const LEASE_FILE = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.leases');

// Message types (RFC 8415 section 7.3).
const MSG_SOLICIT = 1;
const MSG_ADVERTISE = 2;
const MSG_REPLY = 7;

// Option codes (RFC 8415 section 21, RFC 3646 for 23 and 24).
const OPT_CLIENTID = 1;
const OPT_SERVERID = 2;
const OPT_IA_NA = 3;
const OPT_IAADDR = 5;
const OPT_ORO = 6;
const OPT_PREFERENCE = 7;
const OPT_ELAPSED_TIME = 8;
const OPT_STATUS_CODE = 13;
const OPT_RAPID_COMMIT = 14;
const OPT_DNS_SERVERS = 23;
const OPT_DOMAIN_LIST = 24;

// Module state, mirrored on the v4 probe so the status route can report both.
let probeInProgress = false;
let probeStartedAt = null;
let probeSupported = true;
let lastProbeAt = null;
let lastProbeOutcome = null; // ok | timeout | error | unsupported | no-interfaces
let lastProbeError = null;
let xidSeq = 1;

function probeLog(level, msg, extra) {
  const ts = new Date().toISOString();
  const prefix = `[dhcpv6-probe] ${ts}`;
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  if (level === 'error') console.error(`${prefix} ERROR: ${msg}${suffix}`);
  else if (level === 'warn') console.warn(`${prefix} WARN: ${msg}${suffix}`);
  else console.log(`${prefix} ${msg}${suffix}`);
}

// ─── Pure helpers (exported for tests) ───────────────────

function macBytes(mac) {
  const bytes = String(mac || '')
    .split(':')
    .map((h) => parseInt(h, 16) & 0xff);
  while (bytes.length < 6) bytes.push(0);
  return bytes.slice(0, 6);
}

function readAddress(buf, off) {
  const hi = buf.readBigUInt64BE(off);
  const lo = buf.readBigUInt64BE(off + 8);
  return formatIp((hi << 64n) | lo, IPV6_BITS);
}

// A DUID-LL (type 3, RFC 8415 section 11.4) for this interface's MAC. Nothing
// depends on it beyond the server echoing it back.
export function clientDuidFor(mac) {
  return Buffer.from([0x00, 0x03, 0x00, 0x01, ...macBytes(mac)]);
}

function option(code, data) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(code, 0);
  head.writeUInt16BE(data.length, 2);
  return Buffer.concat([head, data]);
}

// Build a SOLICIT with one IA_NA and a request for DNS options. The IAID is
// derived from the MAC so retries from the same interface look like the same
// client to a server that keeps state across solicits.
export function buildSolicit({ xid, mac }) {
  const head = Buffer.alloc(4);
  head.writeUInt8(MSG_SOLICIT, 0);
  head.writeUIntBE(xid & 0xffffff, 1, 3);

  const iaNa = Buffer.alloc(12);
  const m = macBytes(mac);
  iaNa.writeUInt32BE(((m[2] << 24) | (m[3] << 16) | (m[4] << 8) | m[5]) >>> 0, 0);
  // T1 and T2 zero: the server chooses.

  const oro = Buffer.alloc(4);
  oro.writeUInt16BE(OPT_DNS_SERVERS, 0);
  oro.writeUInt16BE(OPT_DOMAIN_LIST, 2);

  return Buffer.concat([
    head,
    option(OPT_CLIENTID, clientDuidFor(mac)),
    option(OPT_ELAPSED_TIME, Buffer.from([0, 0])),
    option(OPT_IA_NA, iaNa),
    option(OPT_ORO, oro),
  ]);
}

function* options(buf, start, end) {
  let off = start;
  while (off + 4 <= end) {
    const code = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 2);
    off += 4;
    if (off + len > end) return;
    yield { code, data: buf.subarray(off, off + len) };
    off += len;
  }
}

// DNS wire-format name list (RFC 1035 labels, no compression in DHCPv6).
function parseDomainList(data) {
  const names = [];
  let off = 0;
  let labels = [];
  while (off < data.length) {
    const len = data[off++];
    if (len === 0) {
      if (labels.length) names.push(labels.join('.'));
      labels = [];
      continue;
    }
    if (off + len > data.length) break;
    labels.push(data.subarray(off, off + len).toString('latin1'));
    off += len;
  }
  if (labels.length) names.push(labels.join('.'));
  return names;
}

function parseStatus(data) {
  if (data.length < 2) return null;
  return { code: data.readUInt16BE(0), message: data.subarray(2).toString('utf8') };
}

// Parse an ADVERTISE (or a REPLY, which a server only sends to a SOLICIT when
// it commits an address without being asked: worth seeing). Returns null for
// anything else or anything malformed.
export function parseAdvertise(buf) {
  if (!buf || buf.length < 4) return null;
  const msgType = buf.readUInt8(0);
  if (msgType !== MSG_ADVERTISE && msgType !== MSG_REPLY) return null;
  const xid = buf.readUIntBE(1, 3);

  const result = {
    msgType,
    xid,
    serverDuid: null,
    clientDuid: null,
    addresses: [],
    dns: [],
    domains: [],
    preference: null,
    status: null,
    rapidCommit: false,
  };

  for (const { code, data } of options(buf, 4, buf.length)) {
    switch (code) {
      case OPT_SERVERID:
        result.serverDuid = duidFromBytes(data);
        break;
      case OPT_CLIENTID:
        result.clientDuid = duidFromBytes(data);
        break;
      case OPT_IA_NA: {
        if (data.length < 12) break;
        for (const sub of options(data, 12, data.length)) {
          if (sub.code === OPT_IAADDR && sub.data.length >= 24) {
            result.addresses.push({
              address: readAddress(sub.data, 0),
              preferred: sub.data.readUInt32BE(16),
              valid: sub.data.readUInt32BE(20),
            });
          } else if (sub.code === OPT_STATUS_CODE && !result.status) {
            result.status = parseStatus(sub.data);
          }
        }
        break;
      }
      case OPT_DNS_SERVERS:
        for (let i = 0; i + 16 <= data.length; i += 16) result.dns.push(readAddress(data, i));
        break;
      case OPT_DOMAIN_LIST:
        result.domains = parseDomainList(data);
        break;
      case OPT_PREFERENCE:
        if (data.length >= 1) result.preference = data.readUInt8(0);
        break;
      case OPT_STATUS_CODE:
        result.status = parseStatus(data);
        break;
      case OPT_RAPID_COMMIT:
        result.rapidCommit = true;
        break;
    }
  }
  if (!result.serverDuid) return null; // every ADVERTISE carries a server id
  return result;
}

// Decide whether an advertisement comes from an unauthorized server. `selfIps`
// holds this host's own addresses, `selfDuid` is dnsmasq's DUID from the lease
// file (null when it has never written one), `authorized` is the allowlist as
// { ips, duids, macs }. `mac` is what the neighbor table knows about the source.
export function classifyAdvertise(adv, { selfIps, selfDuid, authorized, mac = null }) {
  const source = adv.sourceIp ? String(adv.sourceIp).toLowerCase() : null;
  const duid = adv.serverDuid ? String(adv.serverDuid).toLowerCase() : null;
  if (source && selfIps.has(source)) return { rogue: false, reason: 'self' };
  if (duid && selfDuid && duid === selfDuid) return { rogue: false, reason: 'self' };
  if (source && authorized.ips.has(source)) return { rogue: false, reason: 'authorized' };
  if (duid && authorized.duids.has(duid)) return { rogue: false, reason: 'authorized' };
  if (mac && authorized.macs.has(String(mac).toLowerCase())) {
    return { rogue: false, reason: 'authorized' };
  }
  return { rogue: true, reason: 'unauthorized' };
}

// dnsmasq writes its own server DUID as the first line of the lease file
// (`duid 00:01:00:01:...`) once it has served DHCPv6. Null until then.
export function readServerDuid({ leaseFile = LEASE_FILE } = {}) {
  try {
    const head = fs.readFileSync(leaseFile, 'utf8').split('\n', 1)[0] || '';
    const match = head.match(/^duid\s+(\S+)/i);
    return match ? normalizeDuid(match[1]) : null;
  } catch {
    return null;
  }
}

// Interfaces to solicit on: the DHCP-serving selection shared with the v4
// probe, narrowed to those holding an IPv6 link-local address, which is what
// a SOLICIT is sent from and an ADVERTISE comes back to.
export function getProbeInterfaces({ sysIfaces } = {}) {
  const ifaces = sysIfaces || os.networkInterfaces();
  const result = [];
  for (const ifName of selectProbeInterfaceNames({ sysIfaces: ifaces })) {
    const addrs = Object.hasOwn(ifaces, ifName) ? ifaces[ifName] : null;
    if (!addrs) continue;
    const linkLocal = addrs.find(
      (a) =>
        (a.family === 'IPv6' || a.family === 6) &&
        !a.internal &&
        String(a.address).toLowerCase().startsWith('fe80:'),
    );
    if (!linkLocal) continue;
    result.push({
      ifName,
      address: canonicalizeIp(linkLocal.address) || linkLocal.address,
      mac: linkLocal.mac,
      scopeid: linkLocal.scopeid ?? null,
    });
  }
  return result;
}

function splitZone(address) {
  const s = String(address || '');
  const pct = s.indexOf('%');
  if (pct === -1) return { ip: canonicalizeIp(s) || s, zone: null };
  return { ip: canonicalizeIp(s.slice(0, pct)) || s.slice(0, pct), zone: s.slice(pct + 1) };
}

// ─── Probe orchestration ─────────────────────────────────

/**
 * Solicit on every probe interface and persist the rogue advertisements.
 *
 * `destination`, `serverPort` and `clientPort` exist for tests, which run a
 * fake server on loopback with unprivileged ports. Production uses the
 * defaults: multicast to ff02::1:2 with the interface as the zone.
 */
export function runProbe6(
  db,
  {
    windowMs = PROBE_WINDOW_MS,
    destination = ALL_DHCP_SERVERS,
    serverPort = DHCPV6_SERVER_PORT,
    clientPort = DHCPV6_CLIENT_PORT,
    interfaces = null,
    leaseFile = LEASE_FILE,
  } = {},
) {
  if (probeInProgress) {
    const heldMs = probeStartedAt ? Date.now() - probeStartedAt : 0;
    if (heldMs < PROBE_STUCK_MS) {
      probeLog('info', 'Probe already running, skipping this run', { heldMs });
      return Promise.resolve({
        supported: probeSupported,
        skipped: true,
        skipReason: 'in-progress',
        interfaces: 0,
        advertisements: 0,
        rogues: [],
      });
    }
    probeLog('error', 'Previous probe never completed, reclaiming the in-progress flag', {
      heldMs,
    });
    lastProbeError = `previous probe stalled for ${Math.round(heldMs / 1000)}s`;
    probeInProgress = false;
  }
  probeInProgress = true;
  probeStartedAt = Date.now();

  let ifaces, selfIps, selfDuid, authorized;
  try {
    ifaces = interfaces || getProbeInterfaces();
    selfIps = localAddressSet();
    selfDuid = readServerDuid({ leaseFile });
    authorized = authorizedSets(db);
  } catch (err) {
    probeInProgress = false;
    probeStartedAt = null;
    lastProbeOutcome = 'error';
    lastProbeError = err.message;
    probeLog('error', 'Probe setup failed', { error: err.message });
    return Promise.reject(err);
  }

  if (ifaces.length === 0) {
    probeInProgress = false;
    probeStartedAt = null;
    lastProbeAt = new Date().toISOString();
    lastProbeOutcome = 'no-interfaces';
    lastProbeError = null;
    probeLog('warn', 'No IPv6-capable LAN interfaces to probe');
    return Promise.resolve({ supported: true, interfaces: 0, advertisements: 0, rogues: [] });
  }

  const xidMap = new Map(); // xid → ifName
  const seen = new Map(); // `${duid}|${sourceIp}` → advertisement with source
  let advertisementCount = 0;

  return new Promise((resolve) => {
    let sock = null;
    let settled = false;
    let watchdog = null;

    const finish = (supported, { outcome = 'ok', error = null } = {}) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      try {
        sock?.close();
      } catch {
        /* ignore */
      }
      probeSupported = supported;
      probeInProgress = false;
      probeStartedAt = null;
      lastProbeAt = new Date().toISOString();
      lastProbeOutcome = supported ? outcome : 'unsupported';
      lastProbeError = error;

      // The replies were unicast to us, so the kernel now has each server's
      // MAC. Read the table once after the window rather than per reply.
      const neighbors = seen.size > 0 ? readNdCache({ force: true }) : new Map();
      const rogues = [];
      for (const adv of seen.values()) {
        const mac = neighbors.get(adv.sourceIp)?.mac || null;
        const verdict = classifyAdvertise(adv, { selfIps, selfDuid, authorized, mac });
        if (!verdict.rogue) continue;
        rogues.push({
          kind: 'dhcpv6',
          address_family: 6,
          server_ip: adv.sourceIp,
          server_mac: mac || '',
          server_duid: adv.serverDuid,
          server_identifier: adv.serverDuid,
          offered_ip: adv.addresses.map((a) => a.address).join(',') || null,
          offered_gateway: null,
          offered_dns: adv.dns.join(',') || null,
          offered_subnet_mask: null,
          advertised_prefixes: null,
          relay_ip: null,
          iface: adv.iface,
        });
      }
      try {
        for (const ev of rogues) upsertRogueEvent(db, ev);
      } catch (err) {
        probeLog('error', 'Failed to persist rogue events', { error: err.message });
      }
      if (rogues.length > 0) {
        probeLog('warn', 'Rogue DHCPv6 server(s) detected', {
          count: rogues.length,
          servers: rogues.map((r) => `${r.server_ip} (${r.server_duid})`),
        });
      }
      resolve({
        supported,
        interfaces: ifaces.length,
        advertisements: advertisementCount,
        rogues,
      });
    };

    watchdog = setTimeout(() => {
      probeLog('error', 'Probe did not complete in time, forcing completion');
      finish(probeSupported, { outcome: 'timeout', error: 'probe did not complete in time' });
    }, windowMs + PROBE_WATCHDOG_GRACE_MS);
    if (watchdog.unref) watchdog.unref();

    try {
      sock = dgram.createSocket({ type: 'udp6', reuseAddr: true });
    } catch (err) {
      probeLog('error', 'Could not create probe socket', { error: err.message });
      finish(probeSupported, { outcome: 'error', error: err.message });
      return;
    }

    sock.on('error', (err) => {
      if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
        probeLog(
          'warn',
          `Cannot bind UDP :${clientPort} (${err.code}). Rogue DHCPv6 detection is unavailable on this host`,
        );
        finish(false, { error: `cannot bind UDP :${clientPort} (${err.code})` });
      } else if (err.code === 'EAFNOSUPPORT') {
        probeLog('warn', 'IPv6 sockets are unavailable on this host');
        finish(false, { error: 'IPv6 is not available on this host' });
      } else {
        probeLog('error', 'Probe socket error', { error: err.message, code: err.code });
        finish(probeSupported, { outcome: 'error', error: err.message });
      }
    });

    sock.on('message', (msg, rinfo) => {
      try {
        const adv = parseAdvertise(msg);
        if (!adv || !xidMap.has(adv.xid)) return; // not a reply to our probe
        advertisementCount++;
        const { ip, zone } = splitZone(rinfo.address);
        adv.sourceIp = ip;
        adv.iface = zone || xidMap.get(adv.xid);
        const key = `${adv.serverDuid}|${ip}`;
        if (!seen.has(key)) seen.set(key, adv);
      } catch (err) {
        probeLog('warn', 'Failed to parse DHCPv6 advertisement', { error: err.message });
      }
    });

    sock.bind(clientPort, '::', () => {
      const base = (xidSeq++ & 0xff) << 16;
      const multicast = destination.toLowerCase().startsWith('ff');
      ifaces.forEach((iface, i) => {
        const xid = (base | (i & 0xffff)) & 0xffffff;
        xidMap.set(xid, iface.ifName);
        const pkt = buildSolicit({ xid, mac: iface.mac });
        const dest = multicast ? `${destination}%${iface.ifName}` : destination;
        if (multicast) {
          try {
            sock.setMulticastInterface(`::%${iface.ifName}`);
          } catch {
            /* the zone on the destination still selects the interface */
          }
        }
        sock.send(pkt, serverPort, dest, (err) => {
          if (err)
            probeLog('warn', 'SOLICIT send failed', {
              iface: iface.ifName,
              dest,
              error: err.message,
            });
        });
      });
      setTimeout(() => finish(true), windowMs);
    });
  });
}

export function getProbe6State() {
  return {
    lastProbeAt,
    probeSupported,
    probeInProgress,
    lastProbeOutcome,
    lastProbeError,
  };
}
