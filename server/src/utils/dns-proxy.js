/**
 * The DNS proxy as the web app sees it. The proxy itself is
 * dns-proxy/server.js: this module tells it where to listen and forward,
 * hands it the web app's settings and database, takes what it reports (the
 * analytics rows, the clients it saw, the Resolution Map events), and runs
 * the watchdog over it (services/dns-proxy-watchdog.js).
 */
import os from 'os';
import fs from 'fs';
import path from 'path';
import { getDb, getSetting } from '../db/init.js';
import { listenableAddresses, selectInterfaceNames } from './interface-config.js';
import { logDnsQuery } from '../db/duckdb.js';
import { recordDnsQueryLiveness } from './ip-liveness.js';
import { recordResolution } from './resolution-feed.js';
import { queryLogPath } from './query-log.js';
import { roleSwitchedOff } from './role-switches.js';
import { getDnsBackend, onBackendChanged } from '../backends/index.js';
import { DATA_DIR, resolveDnsmasqInternalPort, resolveDnsListenPort } from '../config/defaults.js';
import { proxyLog } from '../dns-proxy/log.js';
import {
  configureProxyServer,
  setProxyConfig,
  startServing,
  stopServing,
  cancelBindRetries,
  serverStatus,
  loadBlocklist,
  loadAllowlist,
  loadFilteringOverrides,
  loadGeoipRules,
  loadGeoipAllowlist,
  loadMmdbFrom,
} from '../dns-proxy/server.js';
import { startWatchdog, stopWatchdog, isProxyBypassed } from '../services/dns-proxy-watchdog.js';

export {
  loadBlocklist,
  loadAllowlist,
  loadFilteringOverrides,
  loadGeoipRules,
  loadGeoipAllowlist,
  unloadMmdb,
  isGeoipLoaded,
  resetStats,
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
  // What the proxy counted since the last call, for the metrics aggregator.
  drainMetrics as drainProxyMetrics,
} from '../dns-proxy/server.js';
export { clearBypassAtBoot, isProxyBypassed } from '../services/dns-proxy-watchdog.js';

configureProxyServer({
  setting: (key) => getSetting(key),
  db: () => getDb(),
  queryRow: (entry) => logDnsQuery(entry),
  liveness: (clientIp) => {
    try {
      recordDnsQueryLiveness(getDb(), clientIp, { createRogue: true, source: 'passive' });
    } catch (err) {
      proxyLog('warn', 'Failed to record DNS-query liveness', { clientIp, error: err.message });
    }
  },
  resolution: (event) => recordResolution(event),
});

const DEFAULT_MMDB = path.join(DATA_DIR, 'geoip', 'dbip-country-lite.mmdb');

/** The GeoIP database file: the `geoip_db_path` setting, or the one CIDRella downloads. */
export function geoipDbPath() {
  const p = getSetting('geoip_db_path');
  return !p || p === 'auto' ? DEFAULT_MMDB : p;
}

/** Load the GeoIP database from where the settings say it is now. */
export function loadMmdb() {
  return loadMmdbFrom(geoipDbPath());
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
export function refreshProxyConfig() {
  setProxyConfig(proxyConfigNow());
}

let followingBackend = false;
function followBackend() {
  if (followingBackend) return;
  followingBackend = true;
  onBackendChanged((role) => {
    if (role === 'dns') refreshProxyConfig();
  });
}

const handle = {
  sockets: () => serverStatus().sockets,
  anyBound: () => serverStatus().bound > 0,
  start: () => {
    refreshProxyConfig();
    startServing();
  },
  cancelBindRetries,
  listenAddresses: () => proxyConfigNow().listenAddresses,
};

export function startProxy() {
  followBackend();
  handle.start();
  startWatchdog(handle);
}

export function stopProxy() {
  stopServing();
  stopWatchdog();
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
  stopServing();
  handle.start();
}

// Filtering exemptions follow scans as well as edits: a MAC a scan learned
// changes which addresses it covers, so the set is read again every minute.
const FILTERING_OVERRIDES_REFRESH_MS = 60 * 1000;
let filteringOverridesTimer = null;

// Start proxy (always-on, called on server startup)
export async function startProxyIfEnabled() {
  const geoipOn = getSetting('geoip_enabled') === 'true';
  const blocklistOn = getSetting('blocklist_enabled') === 'true';

  refreshProxyConfig();
  if (geoipOn) {
    loadGeoipRules();
    loadGeoipAllowlist();
    const loaded = await loadMmdb();
    if (!loaded) {
      proxyLog('warn', 'GeoIP enabled but MMDB not available, starting without GeoIP filtering');
    }
  }

  if (blocklistOn) {
    loadBlocklist();
  }

  // Single global allowlist, used by the GeoIP path (the blocklist path also
  // excludes these at load time). Loaded regardless of which features are on.
  loadAllowlist();

  loadFilteringOverrides();
  clearInterval(filteringOverridesTimer);
  filteringOverridesTimer = setInterval(loadFilteringOverrides, FILTERING_OVERRIDES_REFRESH_MS);
  filteringOverridesTimer.unref?.();

  startProxy();
}

// Get proxy status
export function getProxyStatus() {
  const status = serverStatus();
  const dbPath = geoipDbPath();
  return {
    running: status.running,
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
