// Rogue DHCP server detection, active probe.
//
// On a schedule, broadcast a DHCP DISCOVER out each LAN segment and collect the
// OFFERs. Any server that answers but isn't CIDRella's own DHCP (auto-trusted
// by LAN IP) or on the user allowlist is flagged as rogue. We send DISCOVER
// only, never REQUEST, so no lease is consumed and the probe is non-disruptive.
//
// No raw sockets and no new capability beyond the privileged-port bind we
// already do for :53, a single UDP socket on :68 with the broadcast flag set.
// Pure-JS packet build/parse, no dependency.
//
// L2-scoped: only sees servers on the same broadcast domain as a CIDRella
// interface. Note a DHCP OFFER echoes OUR MAC in chaddr (the server's real MAC
// is in the Ethernet frame we can't see over a UDP socket), so rogue servers are
// identified by IP (server-id / source), not MAC.

import dgram from 'dgram';
import os from 'os';
import { getDb, getSetting } from '../db/init.js';
import { upsertRogueEvent, authorizedIpSet } from '../models/rogue-dhcp.js';

const DHCP_SERVER_PORT = 67;
const DHCP_CLIENT_PORT = 68;
const MAGIC_COOKIE = 0x63825363;
const PROBE_WINDOW_MS = 4000;
const SCHEDULER_TICK_MS = 60 * 1000;
const INITIAL_KICK_MS = 20 * 1000;
// Grace on top of the listen window before the watchdog calls a probe stalled.
const PROBE_WATCHDOG_GRACE_MS = 15 * 1000;
// How long an "in progress" probe may sit before a later run reclaims the flag.
const PROBE_STUCK_MS = 5 * 60 * 1000;

// Module state
let probeInProgress = false;
let probeStartedAt = null;       // so a stranded in-progress flag is detectable
let probeSupported = true;       // flips false if :68 can't bind
let lastProbeAt = null;
let lastProbeOutcome = null;     // ok | timeout | error | unsupported | no-interfaces
let lastProbeError = null;
let xidSeq = 1;
let schedulerTimer = null;
let initialKickTimer = null;

function probeLog(level, msg, extra) {
  const ts = new Date().toISOString();
  const prefix = `[dhcp-probe] ${ts}`;
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  if (level === 'error') console.error(`${prefix} ERROR: ${msg}${suffix}`);
  else if (level === 'warn') console.warn(`${prefix} WARN: ${msg}${suffix}`);
  else console.log(`${prefix} ${msg}${suffix}`);
}

// ─── Pure helpers (exported for tests) ───────────────────

function parseMacBytes(mac) {
  if (!mac) return [0, 0, 0, 0, 0, 0];
  return mac.split(':').map(h => parseInt(h, 16) & 0xff);
}

function ipToStr(buf, off) {
  return `${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`;
}

// Build a DHCP DISCOVER (BOOTREQUEST) with the broadcast flag set so servers
// broadcast their OFFER back to us. Returns a 300-byte buffer (BOOTP minimum;
// trailing zeros after the end option are valid pad bytes).
export function buildDiscover({ xid, mac }) {
  const buf = Buffer.alloc(300);
  buf.writeUInt8(1, 0);                 // op = BOOTREQUEST
  buf.writeUInt8(1, 1);                 // htype = Ethernet
  buf.writeUInt8(6, 2);                 // hlen = 6
  buf.writeUInt8(0, 3);                 // hops
  buf.writeUInt32BE(xid >>> 0, 4);      // xid
  buf.writeUInt16BE(0, 8);              // secs
  buf.writeUInt16BE(0x8000, 10);        // flags = broadcast
  // ciaddr/yiaddr/siaddr/giaddr (12..27) = 0
  const macBytes = parseMacBytes(mac);
  for (let i = 0; i < 6; i++) buf.writeUInt8(macBytes[i] || 0, 28 + i); // chaddr
  // sname (44..107), file (108..235) = 0
  buf.writeUInt32BE(MAGIC_COOKIE, 236);
  let off = 240;
  buf.writeUInt8(53, off++); buf.writeUInt8(1, off++); buf.writeUInt8(1, off++); // msg type = DISCOVER
  const params = [1, 3, 6, 15, 51, 54]; // mask, router, dns, domain, lease, server-id
  buf.writeUInt8(55, off++); buf.writeUInt8(params.length, off++);
  for (const p of params) buf.writeUInt8(p, off++);
  buf.writeUInt8(255, off);             // end
  return buf;
}

// Parse a DHCP OFFER. Returns null for anything that isn't a well-formed
// BOOTREPLY OFFER (msg type 2). chaddr is the echoed client hw-addr (ours).
export function parseOffer(buf) {
  if (!buf || buf.length < 240) return null;
  if (buf.readUInt32BE(236) !== MAGIC_COOKIE) return null;
  if (buf.readUInt8(0) !== 2) return null; // op = BOOTREPLY

  const xid = buf.readUInt32BE(4);
  const yiaddr = ipToStr(buf, 16);
  const siaddr = ipToStr(buf, 20);
  // giaddr, the relay agent that forwarded this. Zero means the offer came
  // straight from a server on our segment. Non-zero means a relay was in the
  // path, which is the difference between "a second DHCP server is running"
  // and "our own offer came back via a relay that rewrote the server-id".
  // Worth capturing: it is the only field that tells those two apart.
  const giaddrRaw = ipToStr(buf, 24);
  const giaddr = giaddrRaw === '0.0.0.0' ? null : giaddrRaw;
  const chaddr = Array.from(buf.subarray(28, 34)).map(b => b.toString(16).padStart(2, '0')).join(':');

  let off = 240;
  let msgType = null, serverId = null, gateway = null, subnetMask = null;
  const dns = [];
  while (off < buf.length) {
    const code = buf.readUInt8(off++);
    if (code === 255) break;   // end
    if (code === 0) continue;  // pad
    if (off >= buf.length) break;
    const len = buf.readUInt8(off++);
    if (off + len > buf.length) break;
    switch (code) {
      case 53: msgType = buf.readUInt8(off); break;
      case 54: if (len >= 4) serverId = ipToStr(buf, off); break;
      case 3:  if (len >= 4) gateway = ipToStr(buf, off); break;
      case 1:  if (len >= 4) subnetMask = ipToStr(buf, off); break;
      case 6:  for (let i = 0; i + 4 <= len; i += 4) dns.push(ipToStr(buf, off + i)); break;
    }
    off += len;
  }
  if (msgType !== 2) return null; // OFFER only
  return { msgType, xid, yiaddr, siaddr, giaddr, chaddr, serverId, gateway, subnetMask, dns };
}

// Decide whether an offer comes from an unauthorized server. `selfIps` and
// `authorized` are lowercased Sets of IPv4 strings; `offer.sourceIp` is the UDP
// source set by the caller. Trust if the server-id, siaddr, or source IP is ours
// or allowlisted.
export function classifyOffer(offer, { selfIps, authorized }) {
  const candidates = [offer.serverId, offer.siaddr, offer.sourceIp]
    .filter(Boolean)
    .map(s => String(s).trim().toLowerCase());
  for (const c of candidates) if (selfIps.has(c)) return { rogue: false, reason: 'self' };
  for (const c of candidates) if (authorized.has(c)) return { rogue: false, reason: 'authorized' };
  return { rogue: true, reason: 'unauthorized' };
}

// CIDRella's own non-internal IPv4 addresses (lowercased Set), always trusted.
export function getSelfIps() {
  const set = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) set.add(a.address.toLowerCase());
    }
  }
  return set;
}

function directedBroadcast(address, netmask) {
  try {
    const a = address.split('.').map(Number);
    const m = netmask.split('.').map(Number);
    if (a.length !== 4 || m.length !== 4) return null;
    return a.map((o, i) => (o | (~m[i] & 0xff))).join('.');
  } catch {
    return null;
  }
}

// LAN IPv4 interfaces to probe on. Rogue DHCP detection is only meaningful where
// CIDRella actually serves DHCP, so this mirrors dnsmasq.js's DHCP-serving logic
// exactly: nothing when DHCP is globally off; with interface_config, only
// interfaces flagged `cfg.dhcp` (NOT dns-only ones); on a fresh deploy (no config)
// dnsmasq binds DHCP to all real interfaces, so we probe them all. We additionally
// need the MAC (for chaddr) and the directed broadcast (for per-segment egress).
export function getLanInterfaces() {
  // Global DHCP switch (same default + sense as dnsmasq.js: on unless 'false').
  if (getSetting('dhcp_enabled') === 'false') return [];

  let ifaceConfig = {};
  try {
    const raw = getSetting('interface_config');
    if (raw) ifaceConfig = JSON.parse(raw);
  } catch { /* default */ }

  const sysIfaces = os.networkInterfaces();
  const result = [];
  const pushFrom = (ifName) => {
    const addrs = Object.hasOwn(sysIfaces, ifName) ? sysIfaces[ifName] : null;
    if (!addrs) return;
    for (const a of addrs) {
      if (a.family !== 'IPv4' || a.internal) continue;
      result.push({
        ifName,
        address: a.address,
        mac: a.mac,
        broadcast: directedBroadcast(a.address, a.netmask),
      });
    }
  };

  if (Object.keys(ifaceConfig).length > 0) {
    for (const [ifName, cfg] of Object.entries(ifaceConfig)) {
      if (!cfg.dhcp) continue; // only interfaces CIDRella serves DHCP on (not dns-only)
      pushFrom(ifName);
    }
  } else {
    // Fresh deploy, dnsmasq binds DHCP to every real interface, so probe them all.
    for (const ifName of Object.keys(sysIfaces)) {
      if (ifName === 'lo') continue;
      pushFrom(ifName);
    }
  }
  return result;
}

// ─── Probe orchestration ─────────────────────────────────

export function runProbe(db, { windowMs = PROBE_WINDOW_MS } = {}) {
  if (probeInProgress) {
    const heldMs = probeStartedAt ? Date.now() - probeStartedAt : 0;
    if (heldMs < PROBE_STUCK_MS) {
      probeLog('info', 'Probe already running, skipping this run', { heldMs });
      return Promise.resolve({
        supported: probeSupported, skipped: true, skipReason: 'in-progress',
        interfaces: 0, offers: 0, rogues: []
      });
    }
    // A previous run never finished. This used to disable rogue detection
    // permanently and in total silence: every later call returned "skipped"
    // with no log, so the only symptom was a rogue event that stopped
    // updating. Take the flag back and say so.
    probeLog('error', 'Previous probe never completed, reclaiming the in-progress flag', { heldMs });
    lastProbeError = `previous probe stalled for ${Math.round(heldMs / 1000)}s`;
    probeInProgress = false;
  }
  probeInProgress = true;
  probeStartedAt = Date.now();

  let ifaces, selfIps, authorized;
  try {
    ifaces = getLanInterfaces();
    selfIps = getSelfIps();
    authorized = authorizedIpSet(db);
  } catch (err) {
    // Anything thrown here used to strand probeInProgress, because only
    // finish() cleared it and finish() lives past this point.
    probeInProgress = false;
    probeStartedAt = null;
    lastProbeOutcome = 'error';
    lastProbeError = err.message;
    probeLog('error', 'Probe setup failed', { error: err.message });
    // Rejected promise, not a synchronous throw. Every other path here returns
    // a promise, and callers use await or .catch.
    return Promise.reject(err);
  }

  if (ifaces.length === 0) {
    probeInProgress = false;
    probeStartedAt = null;
    lastProbeAt = new Date().toISOString();
    lastProbeOutcome = 'no-interfaces';
    lastProbeError = null;
    probeLog('warn', 'No LAN interfaces to probe');
    return Promise.resolve({ supported: true, interfaces: 0, offers: 0, rogues: [] });
  }

  const xidMap = new Map();        // xid → ifName
  const rogues = new Map();        // serverIp → event
  let offerCount = 0;

  return new Promise((resolve) => {
    let sock = null;
    let settled = false;
    let watchdog = null;

    const finish = (supported, { outcome = 'ok', error = null } = {}) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      try { sock?.close(); } catch { /* ignore */ }
      probeSupported = supported;
      probeInProgress = false;
      probeStartedAt = null;
      lastProbeAt = new Date().toISOString();
      lastProbeOutcome = supported ? outcome : 'unsupported';
      lastProbeError = error;
      try {
        for (const ev of rogues.values()) upsertRogueEvent(db, ev);
      } catch (err) {
        probeLog('error', 'Failed to persist rogue events', { error: err.message });
      }
      if (rogues.size > 0) {
        probeLog('warn', 'Rogue DHCP server(s) detected', { count: rogues.size, servers: [...rogues.keys()] });
      }
      resolve({ supported, interfaces: ifaces.length, offers: offerCount, rogues: [...rogues.values()] });
    };

    // Last line of defence. Every path below is supposed to reach finish(), but
    // if one ever does not (a bind callback that never fires, say) this clears
    // the in-progress flag anyway. Without it a single stall disables rogue
    // detection until the service restarts.
    watchdog = setTimeout(() => {
      probeLog('error', 'Probe did not complete in time, forcing completion');
      finish(probeSupported, { outcome: 'timeout', error: 'probe did not complete in time' });
    }, windowMs + PROBE_WATCHDOG_GRACE_MS);
    if (watchdog.unref) watchdog.unref();

    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      probeLog('error', 'Could not create probe socket', { error: err.message });
      finish(probeSupported, { outcome: 'error', error: err.message });
      return;
    }

    sock.on('error', (err) => {
      if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
        probeLog('warn', `Cannot bind UDP :68 (${err.code}). Rogue DHCP detection is unavailable on this host`);
        finish(false, { error: `cannot bind UDP :68 (${err.code})` });
      } else {
        probeLog('error', 'Probe socket error', { error: err.message, code: err.code });
        finish(probeSupported, { outcome: 'error', error: err.message });
      }
    });

    sock.on('message', (msg, rinfo) => {
      try {
        const offer = parseOffer(msg);
        if (!offer || !xidMap.has(offer.xid)) return; // not a reply to our probe
        offerCount++;
        offer.sourceIp = rinfo.address;
        const verdict = classifyOffer(offer, { selfIps, authorized });
        if (!verdict.rogue) return;
        const serverIp = offer.serverId || offer.sourceIp;
        if (!serverIp) return;
        if (!rogues.has(serverIp)) {
          rogues.set(serverIp, {
            server_ip: serverIp,
            server_mac: '',  // not observable over a UDP socket (Ethernet-frame only)
            server_identifier: offer.serverId || null,
            offered_ip: offer.yiaddr || null,
            offered_gateway: offer.gateway || null,
            offered_dns: (offer.dns || []).join(',') || null,
            offered_subnet_mask: offer.subnetMask || null,
            relay_ip: offer.giaddr || null,
            iface: xidMap.get(offer.xid),
          });
        }
      } catch (err) {
        probeLog('warn', 'Failed to parse DHCP offer', { error: err.message });
      }
    });

    sock.bind(DHCP_CLIENT_PORT, '0.0.0.0', () => {
      try { sock.setBroadcast(true); } catch { /* ignore */ }
      const base = (xidSeq++ & 0xffff) << 16;
      ifaces.forEach((iface, i) => {
        const xid = (base | (i & 0xffff)) >>> 0;
        xidMap.set(xid, iface.ifName);
        const pkt = buildDiscover({ xid, mac: iface.mac });
        const dest = iface.broadcast || '255.255.255.255';
        sock.send(pkt, DHCP_SERVER_PORT, dest, (err) => {
          if (err) probeLog('warn', 'DISCOVER send failed', { iface: iface.ifName, dest, error: err.message });
        });
      });
      setTimeout(() => finish(true), windowMs);
    });
  });
}

export function getProbeState() {
  return {
    lastProbeAt,
    probeSupported,
    probeInProgress,
    lastProbeOutcome,
    lastProbeError
  };
}

// ─── Scheduler ───────────────────────────────────────────

export function startRogueDhcpScheduler() {
  stopRogueDhcpScheduler();
  let lastRun = 0;
  const tick = async () => {
    try {
      if (getSetting('rogue_dhcp_detection_enabled') !== 'true') return;
      const intervalMin = parseInt(getSetting('rogue_dhcp_probe_interval_min'), 10) || 15;
      const dueMs = intervalMin * 60 * 1000;
      const now = Date.now();
      if (now - lastRun < dueMs) return;
      lastRun = now;
      await runProbe(getDb(), {});
    } catch (err) {
      probeLog('error', 'Scheduler tick failed', { error: err.message });
    }
  };
  schedulerTimer = setInterval(tick, SCHEDULER_TICK_MS);
  if (schedulerTimer.unref) schedulerTimer.unref();
  initialKickTimer = setTimeout(tick, INITIAL_KICK_MS);
  if (initialKickTimer.unref) initialKickTimer.unref();
}

export function stopRogueDhcpScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
  if (initialKickTimer) { clearTimeout(initialKickTimer); initialKickTimer = null; }
}
