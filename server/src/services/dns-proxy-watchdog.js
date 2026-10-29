/**
 * The DNS proxy's watchdog, in the web app: notices a proxy that stopped
 * answering, restarts it, and when it cannot, puts the DNS backend on the LAN
 * port (bypass) and tries the proxy again now and then (docs/ARCHITECTURE.md,
 * Proxy bypass). It reaches the proxy through a handle, so it does not care
 * where the proxy runs (utils/dns-proxy.js builds one for each mode):
 *
 *   dead()             not serving: no sockets, or a proxy process that
 *                      stopped reporting
 *   misses             dead checks in a row before the watchdog acts
 *   restart()          start it again (may return a Promise)
 *   settleMs           how long a restart takes to show
 *   anyBound()         whether any socket answers
 *   bind()             bind the listen addresses (leaving bypass)
 *   release()          let go of the LAN port and stop retrying it (bypass)
 *   processDown()      the proxy process is gone, and the forwarder with it
 *   listenAddresses()  the addresses the proxy binds
 */
import dgram from 'dgram';
import net from 'net';
import { getDb, setSetting } from '../db/init.js';
import * as Setting from '../models/setting.js';
import { applyListenNow } from './backend-apply.js';
import { recordAudit } from './audit.js';
import { switchInProgress } from '../utils/switch-state.js';
import { roleSwitchedOff } from '../utils/role-switches.js';
import { getDnsBackend } from '../backends/index.js';
import {
  PROXY_HEALTH_CHECK_MS,
  PROXY_MAX_RESTART_ATTEMPTS,
  PROXY_RESTART_DELAY_MS,
  PROXY_RECOVERY_FIRST_MS,
  PROXY_RECOVERY_MAX_MS,
} from '../config/defaults.js';
import { proxyLog } from '../dns-proxy/log.js';


let proxy = null;
// Dead checks in a row so far.
let deadChecks = 0;

// Bypass mode, when proxy dies and can't restart, dnsmasq takes over port 53
let bypassMode = false;
let healthTimer = null;
// A restart or recovery runs longer than one health interval; this keeps the
// next tick from starting a second one alongside it.
let healthBusy = false;
// While bypassed: when the proxy is next tried, and how long the wait after
// a failed try will be.
let recoveryAt = 0;
let recoveryWaitMs = PROXY_RECOVERY_FIRST_MS;

// The next try after `ms`; each failed try after it waits twice as long.
function scheduleRecovery(ms) {
  recoveryAt = Date.now() + ms;
  recoveryWaitMs = Math.min(ms * 2, PROXY_RECOVERY_MAX_MS);
  return ms;
}

const dnsSwitchedOff = () => roleSwitchedOff('dns');

/**
 * Watch the proxy behind `handle`. Watched from the start, not from the
 * first bind: a proxy that binds nothing at boot is the case the watchdog
 * exists for. Calling it again only swaps the handle.
 */
export function startWatchdog(handle) {
  proxy = handle;
  if (healthTimer) return;
  healthTimer = setInterval(async () => {
    if (healthBusy) return;
    if (dnsSwitchedOff()) return; // down on purpose, not dead
    if (bypassMode) {
      if (Date.now() < recoveryAt) return;
      healthBusy = true;
      try {
        await tryRecovery();
      } finally {
        healthBusy = false;
      }
      return;
    }
    if (!proxy.dead()) {
      deadChecks = 0;
      return;
    }
    if (++deadChecks < (proxy.misses ?? 1)) return;
    deadChecks = 0;

    healthBusy = true;
    try {
      await restartOrBypass();
    } finally {
      healthBusy = false;
    }
  }, PROXY_HEALTH_CHECK_MS);
}

export function stopWatchdog() {
  deadChecks = 0;
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

async function restartOrBypass() {
  proxyLog('warn', 'Proxy appears dead, attempting restart');

  for (let attempt = 1; attempt <= PROXY_MAX_RESTART_ATTEMPTS; attempt++) {
    try {
      await proxy.restart();
      // Give it a moment to bind (and a process to start and report)
      await new Promise((r) => setTimeout(r, proxy.settleMs ?? 500));
      if (!proxy.dead()) {
        proxyLog('info', 'Proxy restarted successfully', { attempt });
        return;
      }
    } catch (err) {
      proxyLog('error', 'Restart attempt failed', { attempt, error: err.message });
    }
    if (attempt < PROXY_MAX_RESTART_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, PROXY_RESTART_DELAY_MS));
    }
  }

  // All restart attempts failed, activate bypass
  await activateBypass();
}

// Can the proxy bind any of its listen addresses at all: each tried on a
// port of its own choosing, since the backend holds the LAN port. Nothing to
// try means the condition that stopped the proxy has not cleared.
async function listenAddressUsable() {
  for (const addr of proxy.listenAddresses()) {
    const usable = await new Promise((resolve) => {
      const sock = dgram.createSocket(net.isIP(addr) === 6 ? 'udp6' : 'udp4');
      sock.once('error', () => {
        sock.close();
        resolve(false);
      });
      sock.bind(0, addr, () => {
        sock.close();
        resolve(true);
      });
    });
    if (usable) return true;
  }
  return false;
}

// One try at leaving bypass: the backend back on its internal port, then the
// proxy on the LAN port. If the proxy binds nothing, bypass goes back on and
// the next try waits twice as long.
async function tryRecovery() {
  const wait = () => scheduleRecovery(recoveryWaitMs);
  if (switchInProgress()) return;
  // A proxy process that is gone comes back first, still kept off the LAN
  // port; it then has to bind like any other.
  if (proxy.processDown()) {
    await proxy.restart();
    await new Promise((r) => setTimeout(r, proxy.settleMs ?? 500));
    if (proxy.processDown()) {
      proxyLog('warn', 'The DNS proxy process is still down, bypass stays on', {
        nextTryMinutes: Math.round(wait() / 60000),
      });
      return;
    }
  }
  if (!(await listenAddressUsable())) {
    wait();
    return;
  }
  proxyLog('info', 'Bypass is on, trying the proxy again');
  try {
    const db = getDb();
    Setting.deleteSetting(db, 'dns_proxy_bypass');
    Setting.deleteSetting(db, 'dns_forwarder_down');
    await applyListenNow(db);
  } catch (err) {
    proxyLog('error', 'Could not move the backend off the LAN port', { error: err.message });
    await setBypassListen();
    wait();
    return;
  }
  try {
    proxy.bind();
  } catch (err) {
    proxyLog('error', 'Proxy start failed', { error: err.message });
  }
  for (let i = 0; i < 6 && !proxy.anyBound(); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (proxy.anyBound()) {
    deactivateBypass({ reason: 'the proxy bound its addresses again' });
    return;
  }
  // Binds still waiting on an address would only fail on the LAN port again.
  proxy.release();
  await setBypassListen();
  proxyLog('warn', 'The proxy still cannot bind, bypass stays on', {
    nextTryMinutes: Math.round(wait() / 60000),
  });
}

// Bypass: dnsmasq takes over port 53 on LAN IPs directly (requires full restart for port change)
//
// These two writers deliberately await applyListenNow
// inline, OUTSIDE the after-commit single-flight that serializes the
// request-driven regen hooks. Bypass needs the conf written and dnsmasq
// restarted before the proxy moves (queueRegen defers into a microtask that
// would fire after the restart). The cost is a small last-writer-wins window: a
// concurrent request-triggered regen that read dns_proxy_bypass before the
// flip can clobber the bypass directives. Accepted (2026-07-23 review):
// bypass only runs when the proxy is already dead, atomicWrite prevents torn
// files, and the health monitor re-runs activateBypass on the next tick if
// DNS still isn't answering, the window self-heals. Don't route these
// through queueRegen without solving the synchrony requirement first.
async function activateBypass() {
  if (bypassMode) return;
  // A server stack switch is moving the DNS backend; the next health check
  // tries again once it is done.
  if (switchInProgress()) return;
  bypassMode = true;
  proxyLog(
    'error',
    'All restart attempts failed, activating bypass mode (the DNS backend takes the LAN port)',
  );
  // Filtering, GeoIP and the query log stop with the proxy out of the path.
  try {
    recordAudit({
      action: 'dns_proxy_bypass_activated',
      entityType: 'dns_proxy',
      source: 'proxy-health',
      details: {
        reason: `the proxy did not restart after ${PROXY_MAX_RESTART_ATTEMPTS} attempts`,
        forwarderDown: proxy.processDown(),
        backend: getDnsBackend().name,
      },
    });
  } catch (err) {
    proxyLog('error', 'Could not record the bypass in the audit log', { error: err.message });
  }
  scheduleRecovery(PROXY_RECOVERY_FIRST_MS);
  proxy.release();
  await setBypassListen();
}

// The backend on the LAN port, the conf written before the restart it waits
// for: queueRegen would defer the conf write into a microtask that fires
// AFTER the restart.
async function setBypassListen() {
  try {
    setSetting('dns_proxy_bypass', 'true');
    // The forwarder runs in the proxy process: gone with it, the backend
    // forwards around it (utils/forwarding-settings.js recursionTargets).
    if (proxy.processDown()) setSetting('dns_forwarder_down', 'true');
    else Setting.deleteSetting(getDb(), 'dns_forwarder_down');
    await applyListenNow(getDb());
    proxyLog('info', 'DNS backend reconfigured for bypass mode (LAN port)');
  } catch (err) {
    proxyLog('error', 'Failed to reconfigure the DNS backend for bypass', { error: err.message });
  }
}

// Called with the backend already off the LAN port and the proxy bound.
function deactivateBypass({ reason }) {
  bypassMode = false;
  proxyLog('info', 'Bypass deactivated, proxy recovered');
  try {
    recordAudit({
      action: 'dns_proxy_bypass_deactivated',
      entityType: 'dns_proxy',
      source: 'proxy-health',
      details: { reason },
    });
  } catch (err) {
    proxyLog('error', 'Could not record the recovery in the audit log', { error: err.message });
  }
}

/**
 * At boot, before the backends are applied: forget a bypass left from before
 * the restart, so the backend takes its internal port and the proxy the LAN
 * port. If the proxy still cannot serve, the watchdog turns bypass on again.
 * Without this a bypass outlived every restart and update.
 */
export function clearBypassAtBoot(db) {
  Setting.deleteSetting(db, 'dns_forwarder_down');
  bypassMode = false;
  if (Setting.readSetting(db, 'dns_proxy_bypass') !== 'true') return false;
  Setting.deleteSetting(db, 'dns_proxy_bypass');
  proxyLog('info', 'Bypass was on before the restart, trying the proxy first');
  try {
    recordAudit({
      action: 'dns_proxy_bypass_deactivated',
      entityType: 'dns_proxy',
      source: 'boot',
      details: { reason: 'a restart tries the proxy first' },
    });
  } catch (err) {
    proxyLog('error', 'Could not record the cleared bypass in the audit log', {
      error: err.message,
    });
  }
  return true;
}

// Check if proxy is in bypass mode
export function isProxyBypassed() {
  return bypassMode;
}
