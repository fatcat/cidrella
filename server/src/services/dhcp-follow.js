/**
 * Making this box's DHCP server agree with who serves DHCP
 * (sync/dhcp-active.js), on a member and on the controller alike. The
 * settings say who; this does what a change of them calls for here:
 *
 *   given DHCP    the leases the controller holds (this box's own copy of
 *                 dhcp_leases, the ones still active) go into the DHCP server,
 *                 the box is marked ready at that term, and the server starts
 *                 answering. Not before the instance that had it has handed
 *                 over: while `dhcp_handover_from` is set nobody serves.
 *   lost DHCP     the server stops answering. A member named in
 *                 `dhcp_handover_from` then reads its leases one last time and
 *                 sends them as its final report (sync/lease-report.js).
 *
 * There is no marker file: the settings and `dhcp_ready_term` are the state,
 * so a process that dies partway runs the same step again when it comes back
 * (boot calls startDhcpFollow). A step that fails is tried again every
 * RETRY_MS and logged once.
 */
import { getDhcpBackend, getDnsBackend, getService } from '../backends/index.js';
import { activeBackendLeases } from '../models/dhcp-lease.js';
import {
  dhcpState,
  markDhcpReady,
  onDhcpStateChanged,
  servesDhcpHere,
} from '../sync/dhcp-active.js';
import { sendFinalReport } from '../sync/lease-report.js';
import { switchInProgress } from '../utils/switch-state.js';
import { applyDhcp } from './backend-apply.js';
import { settledLeases } from './stack-switch.js';

const RETRY_MS = 30_000;

// Per database: whether the daemons were last told this box serves.
const told = new WeakMap();

/**
 * Render and activate what decides whether this box answers DHCP: the listen
 * config (dnsmasq takes its DHCP interfaces there) and the DHCP config (Kea
 * listens on no interface while it does not serve). The way the DHCP switch
 * in Settings reaches the daemons (routes/interfaces.js). `restart` restarts
 * a DHCP server that reads its leases only when it starts.
 */
export async function applyDhcpServing(db, { restart = false } = {}) {
  const serving = servesDhcpHere(db);
  const dns = getService('dns');
  const listen = getDnsBackend().applyListen(db, { activate: false });
  if (listen.changed || (restart && dns === getService('dhcp'))) {
    await dns.activate({ force: true });
  }
  await applyDhcp(db);
  told.set(db, serving);
}

// Per database: the follow under way, and the final report already delivered.
const running = new WeakMap();
const delivered = new WeakMap();
const failing = new WeakSet();
const timers = new WeakMap();

async function agree(db, { restart = false } = {}) {
  const serving = servesDhcpHere(db);
  if (!restart && told.get(db) === serving) return;
  await applyDhcpServing(db, { restart });
}

// This box was given DHCP at `state.term` and has not loaded the leases yet.
async function takeOver(db, state) {
  const dhcp = getDhcpBackend();
  const leases = activeBackendLeases(db);
  let imported = false;
  if (dhcp.importLeases) {
    // Under this server's own DUID: the leases are kept, and a DHCPv6 client
    // rebinds to the new server when it next renews.
    const { failed = [] } = await dhcp.importLeases(leases, {
      serverDuid: dhcp.serverIdentity().duid,
    });
    imported = true;
    if (failed.length > 0) {
      console.warn(
        `[dhcp] ${failed.length} of ${leases.length} lease(s) could not be loaded ` +
          `(first: ${failed[0].ip}: ${failed[0].error})`,
      );
    }
  } else {
    console.warn('[dhcp] this DHCP server cannot be given leases: it starts with none');
  }
  // The settings may have moved on while the leases went in.
  const now = dhcpState(db);
  if (!now.here || now.handoverFrom || now.term !== state.term) return;
  markDhcpReady(db, state.term);
  await agree(db, { restart: imported });
  console.log(
    `[dhcp] this instance serves DHCP from now (term ${state.term}), with ${leases.length} lease(s)`,
  );
}

// This member lost DHCP and owes its final leases.
async function handOver(db, state) {
  const owed = `${state.term}`;
  if (delivered.get(db) === owed) return;
  // The rule already says this box does not serve: its server stops answering
  // first, so the leases read next are its last.
  await agree(db);
  const served = state.readyTerm === state.term - 1;
  const leases = served ? await settledLeases(getService('dhcp')) : null;
  await sendFinalReport(db, { term: state.term - 1, leases });
  delivered.set(db, owed);
  markDhcpReady(db, null);
  console.log(
    `[dhcp] this instance no longer serves DHCP: its final ${leases?.length ?? 0} lease(s) are with the controller`,
  );
}

async function followOnce(db) {
  // A stack switch moves the leases between this box's own servers and
  // applies when it ends; following waits for it.
  if (switchInProgress()) throw new Error('a server switch is running');
  const state = dhcpState(db);
  // A controller that was replaced has nobody to hand its leases to.
  if (state.fenced) return agree(db);
  if (state.member && state.handoverFrom === state.self) return handOver(db, state);
  if (state.here && !state.handoverFrom) {
    if (state.term !== 0 && state.readyTerm !== state.term) return takeOver(db, state);
    return agree(db);
  }
  // Another instance's, or this box's once the one before has handed over.
  if (state.readyTerm !== null) markDhcpReady(db, null);
  return agree(db);
}

function retryLater(db) {
  if (timers.has(db)) return;
  const timer = setTimeout(() => {
    timers.delete(db);
    void followDhcp(db);
  }, RETRY_MS);
  timer.unref?.();
  timers.set(db, timer);
}

/**
 * Do what the DHCP settings call for on this box, now. One at a time per
 * database; a change seen while one runs is followed after it. Never
 * rejects: a failure is logged once and tried again.
 */
export function followDhcp(db) {
  const current = running.get(db);
  if (current) {
    current.again = true;
    return current.promise;
  }
  const run = { again: false, promise: null };
  run.promise = (async () => {
    try {
      do {
        run.again = false;
        await followOnce(db);
      } while (run.again);
      if (failing.delete(db)) console.log('[dhcp] following the DHCP instance again');
    } catch (err) {
      if (!failing.has(db)) {
        console.warn(`[dhcp] could not follow a change of the DHCP instance: ${err.message}`);
      }
      failing.add(db);
      retryLater(db);
    } finally {
      running.delete(db);
    }
  })();
  running.set(db, run);
  return run.promise;
}

/**
 * Follow from now on: once at boot (a move the process died in the middle of
 * is finished here), and whenever the settings change under this box.
 * Returns the stop.
 */
export function startDhcpFollow(db) {
  const stop = onDhcpStateChanged((changed) => void followDhcp(changed));
  // Boot has just rendered and started the servers by the rule
  // (applyAtBoot): nothing to tell them again unless a step is owed.
  told.set(db, servesDhcpHere(db));
  void followDhcp(db);
  return () => {
    stop();
    clearTimeout(timers.get(db));
    timers.delete(db);
  };
}
