/**
 * The DNS proxy as the web app sees it. The proxy itself is
 * dns-proxy/server.js, run either inside the web app or as its own process
 * (dns-proxy/main.js), as utils/dns-proxy-mode.js says. Either way this
 * module tells it where to listen and forward, has it read things again,
 * takes what it counted and reported (services/dns-proxy-sinks.js), and runs
 * the watchdog over it (services/dns-proxy-watchdog.js).
 */
import os from 'os';
import fs from 'fs';
import path from 'path';
import { getSetting } from '../db/init.js';
import { listenableAddresses, selectInterfaceNames } from './interface-config.js';
import { queryLogPath } from './query-log.js';
import { roleSwitchedOff } from './role-switches.js';
import { getDnsBackend, onBackendChanged } from '../backends/index.js';
import {
  DATA_DIR,
  DEFAULTS,
  resolveDnsmasqInternalPort,
  resolveDnsListenPort,
} from '../config/defaults.js';
import { proxyLog } from '../dns-proxy/log.js';
import { codeId } from '../dns-proxy/code-id.js';
import { inlineProxyDb, proxySettings } from './dns-proxy-inline-db.js';
import { closeProxyDb } from '../dns-proxy/db.js';
import { proxyIsSeparate } from './dns-proxy-mode.js';
import * as Server from '../dns-proxy/server.js';
import * as Client from './dns-proxy-client.js';
import { getAndResetForwarderMetrics } from './encrypted-forwarder.js';
import { sinkQueryRow, sinkClientSeen, sinkResolution } from '../services/dns-proxy-sinks.js';
import { startWatchdog, stopWatchdog, isProxyBypassed } from '../services/dns-proxy-watchdog.js';
import { restartProxyProcess } from '../services/dns-proxy-supervisor.js';

// The proxy's pure helpers and policy, for the tests that exercise them.
export {
  lookupCountry,
  cachedPoint,
  domainSuffixes,
  getQueryOpt,
  classifyDnssecSupport,
  noteAnswer,
  createNxdomainResponse,
  createBlockedResponse,
  filteringBypass,
  evaluateInboundPolicy,
  recordInboundBlock,
  evaluateResolvedPolicy,
  recordResolvedBlock,
  wantsUnknownRetry,
  formErrReply,
  asksRecursion,
  withRecursionDesired,
  withClientRd,
  relayQueryOverTcp,
  getAndResetBlocklistHits,
  getBlockedDelta,
  getAndResetCountryHits,
  getAndResetPerformanceMetrics,
} from '../dns-proxy/server.js';
export { clearBypassAtBoot, isProxyBypassed } from '../services/dns-proxy-watchdog.js';

const separate = proxyIsSeparate();

Server.configureProxyServer({
  ...proxySettings,
  db: inlineProxyDb,
  queryRow: sinkQueryRow,
  liveness: sinkClientSeen,
  resolution: sinkResolution,
});

// Have the proxy read something again: in this process, or by message.
function reload(what, inline, extra) {
  if (separate) Client.sendReload(what, extra);
  else return inline();
}

export const loadBlocklist = () => reload('blocklist', Server.loadBlocklist);
export const loadAllowlist = () => reload('allowlist', Server.loadAllowlist);
export const loadFilteringOverrides = () =>
  reload('filtering-overrides', Server.loadFilteringOverrides);
export const loadGeoipRules = () => reload('geoip-rules', Server.loadGeoipRules);
export const loadGeoipAllowlist = () => reload('geoip-allowlist', Server.loadGeoipAllowlist);
export const unloadMmdb = () => reload('unload-mmdb', Server.unloadMmdb);
export const resetStats = () => reload('reset-stats', Server.resetStats);

/** Whether answers get a country now (GeoIP on and its database loaded). */
export function isGeoipLoaded() {
  return separate ? Client.freshProxyStatus()?.geoipLoaded === true : Server.isGeoipLoaded();
}

/**
 * What the proxy and the forwarder counted since the last call, for the
 * metrics aggregator. Nothing counted when the proxy process does not answer;
 * it keeps counting, so the next drain has it.
 */
export async function drainProxyMetrics() {
  if (!separate) return { ...Server.drainMetrics(), forwarder: getAndResetForwarderMetrics() };
  const drained = await Client.requestDrain();
  if (!drained) return { ...Server.emptyMetrics(), forwarder: [] };
  return { ...drained.metrics, forwarder: drained.forwarder || [] };
}

const DEFAULT_MMDB = path.join(DATA_DIR, 'geoip', 'dbip-country-lite.mmdb');

/** The GeoIP database file: the `geoip_db_path` setting, or the one CIDRella downloads. */
export function geoipDbPath() {
  const p = getSetting('geoip_db_path');
  return !p || p === 'auto' ? DEFAULT_MMDB : p;
}

/** Load the GeoIP database from where the settings say it is now. */
export function loadMmdb() {
  const dbPath = geoipDbPath();
  return reload('mmdb', () => Server.loadMmdbFrom(dbPath), { path: dbPath });
}

// The LAN addresses of both families to bind proxy sockets on.
function listenAddresses() {
  let ifaceConfig = {};
  try {
    const raw = getSetting('interface_config');
    if (raw) ifaceConfig = JSON.parse(raw);
  } catch {
    /* use default */
  }

  const sysIfaces = os.networkInterfaces();
  const addresses = [];

  // Interface selection is shared with dnsmasq.js and dhcp-probe.js so the
  // three cannot drift about which interfaces are in play (audit #9). The
  // bindable-address rule (IPv4 plus non-link-local IPv6) is dnsmasq.js's
  // too, so the proxy and dnsmasq bypass mode listen on the same set.
  const { names } = selectInterfaceNames('dns', { config: ifaceConfig, sysIfaces });
  for (const ifName of names) {
    addresses.push(...listenableAddresses(sysIfaces[ifName]));
  }

  return addresses;
}

function forwardsUnknownItself() {
  try {
    return getDnsBackend().forwardsUnknownItself;
  } catch {
    return true; // no backend yet: nothing to ask again
  }
}

/** Where the proxy listens and forwards, from the settings and the DNS backend now. */
export function proxyConfigNow() {
  // Shared with the backend config writers. `Number(x) || 53` used to live
  // in the proxy, which accepted any non-zero number, so a stored 70000 became
  // a bind attempt on 70000 while dnsmasq stayed on 53.
  // See REVIEW.md, duplicate-logic audit #10.
  const port = getSetting('dns_listen_port');
  return {
    listenAddresses: listenAddresses(),
    listenPort: resolveDnsListenPort(port),
    internalPort: resolveDnsmasqInternalPort(port),
    forwardsUnknownItself: forwardsUnknownItself(),
    queryLogPath: queryLogPath(),
    dnsOff: roleSwitchedOff('dns'),
    geoipDbPath: geoipDbPath(),
  };
}

/**
 * Tell the proxy its listen and forward settings again. A setting that feeds
 * them (the DNS port, DNS on or off, the interfaces) calls this when it is
 * written; the DNS backend changing does too.
 */
export function refreshProxyConfig({ rebind = false, serve = !isProxyBypassed() } = {}) {
  const proxy = proxyConfigNow();
  if (!separate) {
    Server.setProxyConfig(proxy);
    return;
  }
  // DEFAULTS: what a setting reads as when nothing is stored, which the
  // proxy process cannot import (dns-proxy/db.js). `serve` is false in
  // bypass, where the backend holds the LAN port; the saved config keeps it
  // that way across the proxy's own restarts.
  Client.sendProxyConfig({ proxy, defaults: DEFAULTS, serve }, { rebind });
}

let followingBackend = false;
function followBackend() {
  if (followingBackend) return;
  followingBackend = true;
  onBackendChanged((role) => {
    if (role === 'dns') refreshProxyConfig();
  });
}

// The watchdog's view of the proxy (services/dns-proxy-watchdog.js), one for
// each place it runs.
const startInline = () => {
  refreshProxyConfig();
  Server.startServing();
};
const inlineHandle = {
  dead: () => Server.serverStatus().sockets === 0,
  misses: 1,
  restart: startInline,
  settleMs: 500,
  anyBound: () => Server.serverStatus().bound > 0,
  bind: startInline,
  release: Server.cancelBindRetries,
  processDown: () => false,
  listenAddresses: () => proxyConfigNow().listenAddresses,
};

// The proxy process counts as dead when it stops reporting (gone, or its
// event loop hung) or binds nothing while it should. Three checks in a row,
// so one slow status is not a restart.
const processHandle = {
  dead() {
    const status = Client.freshProxyStatus();
    return !status || (status.serve && status.server.sockets === 0);
  },
  misses: 3,
  // Alive but bound to nothing: bind again, the forwarder keeps running.
  // Not reporting: kill it and have it started again.
  async restart() {
    if (Client.freshProxyStatus()) refreshProxyConfig({ rebind: true });
    else await restartProxyProcess(Client.lastProxyStatus()?.status.pid);
  },
  settleMs: 5000,
  anyBound: () => (Client.freshProxyStatus()?.server.bound ?? 0) > 0,
  bind: () => refreshProxyConfig({ serve: true, rebind: true }),
  release: () => refreshProxyConfig({ serve: false }),
  processDown: () => !Client.freshProxyStatus(),
  listenAddresses: () => proxyConfigNow().listenAddresses,
};

export function startProxy() {
  followBackend();
  if (separate) {
    // An update's preflight boots on a scratch data directory: no config
    // written, no connection, nothing spawned.
    if (process.env.CIDRELLA_PREFLIGHT === '1') return;
    refreshProxyConfig();
    Client.startProxyClient({
      codeId: codeId(),
      handlers: { queryRow: sinkQueryRow, clientSeen: sinkClientSeen, resolution: sinkResolution },
    });
    startWatchdog(processHandle);
    return;
  }
  startInline();
  startWatchdog(inlineHandle);
}

export function stopProxy() {
  stopWatchdog();
  if (separate) {
    Client.stopProxyClient();
    return;
  }
  Server.stopServing();
}

// Rebind proxy sockets (called when interface config changes)
export function rebindProxy() {
  // The backend holds the LAN port while bypassed, so the proxy could not
  // bind; the watchdog binds the new interfaces when it recovers.
  if (isProxyBypassed()) {
    proxyLog('info', 'Bypass is on, the proxy binds the new interfaces when it recovers');
    return;
  }
  proxyLog('info', 'Rebinding proxy to updated interface config');
  if (separate) {
    refreshProxyConfig({ rebind: true });
    return;
  }
  Server.stopServing();
  startInline();
}

// Start proxy (always-on, called on server startup). The proxy process reads
// everything itself when the client connects.
export async function startProxyIfEnabled() {
  if (!separate) {
    refreshProxyConfig();
    await Server.reloadAll();
    Server.startOverridesRefresh();
  }
  startProxy();
}

/**
 * Before a restore swaps the database files: the proxy closes its
 * connection (and keeps it closed until the restored web app starts), so it
 * never reads a half-swapped database or holds the old file.
 */
export async function releaseProxyDatabase() {
  if (separate) {
    if (!(await Client.requestDbRelease())) {
      proxyLog('warn', 'The DNS proxy did not confirm it closed the database; restoring anyway');
    }
    return;
  }
  closeProxyDb();
}

// Get proxy status. The proxy process's comes from its last status message;
// with none recent, it reads as stopped and `stale`.
export function getProxyStatus() {
  const reported = separate ? Client.freshProxyStatus()?.server : null;
  const status = reported ?? Server.serverStatus();
  const dbPath = geoipDbPath();
  return {
    running: status.running,
    ...(separate && !reported ? { stale: true } : {}),
    bypassed: isProxyBypassed(),
    // DNS switched off in CIDRella: the proxy does not listen, on purpose.
    switchedOff: roleSwitchedOff('dns'),
    port: 53,
    listenAddresses: status.listenAddresses,
    tcpListeners: status.tcpListeners,
    activeTcpConnections: status.activeTcpConnections,
    dbLoaded: status.dbLoaded,
    dbExists: fs.existsSync(dbPath),
    dbPath,
    dbLastUpdated: getSetting('geoip_last_updated') || null,
    statsTotal: status.statsTotal,
    statsBlocked: status.statsBlocked,
    statsAllowed: status.statsAllowed,
    blocklistLoaded: status.blocklistLoaded,
    blocklistDomainCount: status.blocklistDomainCount,
    filteringPausedUntil: status.filteringPausedUntil,
    filteringExemptClients: status.filteringExemptClients,
  };
}
