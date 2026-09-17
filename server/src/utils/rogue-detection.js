// The one entry point for rogue detection: runs the DHCPv4 probe, the DHCPv6
// probe and the Router Advertisement check together, on the scheduler and on
// demand from the route. One setting and one interval govern all three.

import { getDb, getSetting } from '../db/init.js';
import { runProbe } from './dhcp-probe.js';
import { runProbe6 } from './dhcpv6-probe.js';
import { checkRouterAdvertisements } from './ra-monitor.js';

const SCHEDULER_TICK_MS = 60 * 1000;
const INITIAL_KICK_MS = 20 * 1000;

let schedulerTimer = null;
let initialKickTimer = null;

function log(level, msg, extra) {
  const ts = new Date().toISOString();
  const prefix = `[rogue-detection] ${ts}`;
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  if (level === 'error') console.error(`${prefix} ERROR: ${msg}${suffix}`);
  else console.log(`${prefix} ${msg}${suffix}`);
}

/**
 * Run every detector once. The DHCPv4 probe's rejection (it could not even
 * reach a socket) propagates, as before. The two IPv6 checks each report
 * their own failure in their result instead, so a host without IPv6 still
 * gets its DHCPv4 answer.
 */
export async function runRogueDetection(db, opts = {}) {
  const dhcp = await runProbe(db, opts.dhcp || {});
  let dhcpv6;
  try {
    dhcpv6 = await runProbe6(db, opts.dhcpv6 || {});
  } catch (err) {
    dhcpv6 = { supported: false, error: err.message, interfaces: 0, advertisements: 0, rogues: [] };
  }
  let routerAdvertisements;
  try {
    routerAdvertisements = checkRouterAdvertisements(db, opts.ra || {});
  } catch (err) {
    routerAdvertisements = {
      supported: false,
      error: err.message,
      interfaces: 0,
      routers: 0,
      rogues: [],
    };
  }
  return { dhcp, dhcpv6, routerAdvertisements };
}

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
      await runRogueDetection(getDb());
    } catch (err) {
      log('error', 'Scheduler tick failed', { error: err.message });
    }
  };
  schedulerTimer = setInterval(tick, SCHEDULER_TICK_MS);
  if (schedulerTimer.unref) schedulerTimer.unref();
  initialKickTimer = setTimeout(tick, INITIAL_KICK_MS);
  if (initialKickTimer.unref) initialKickTimer.unref();
}

export function stopRogueDhcpScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  if (initialKickTimer) {
    clearTimeout(initialKickTimer);
    initialKickTimer = null;
  }
}
