/**
 * A member's side of the lease report: while this member serves DHCP, the
 * whole lease set its DHCP server holds goes to the controller, which keeps
 * it (sync/lease-intake.js) and answers with the leases to release here.
 *
 * The controller away: the member keeps serving, the report is tried again
 * every RETRY_MS, and the log says so once per outage. The controller saying
 * this member's leases do not count (409 not_dhcp_active): DHCP has moved
 * and this copy has not heard yet, so the member stops reporting until its
 * settings change, and asks again after REFUSED_RETRY_MS in case they never do.
 */
import { syncRequest } from '../utils/sync-client.js';
import { readCredential } from './credential.js';
import { dhcpState, holdsDhcp } from './dhcp-active.js';
import { LEASE_REPORT_TYPE, NOT_DHCP_ACTIVE, packReport } from './lease-wire.js';
import { controllerOf } from './mode.js';

export const RETRY_MS = 30_000;
const REFUSED_RETRY_MS = 10 * 60_000;
// A report of every lease on a large network, ingested before the answer.
const REPORT_TIMEOUT_MS = 120_000;

const NOTHING = () => ({ synced: 0, rejected: 0, blocking: [] });

let retry = null;
let timer = null;
let failing = false;
let refused = null;

/**
 * `fn` runs the lease sync again; the lease sync registers it
 * (services/dhcp-lease-sync.js). Returns the unsubscribe.
 */
export function onLeaseReportRetry(fn) {
  retry = fn;
  return () => {
    if (retry === fn) retry = null;
  };
}

/** Forget the retry timer and what the last reports ran into (tests, shutdown). */
export function stopLeaseReports() {
  clearTimeout(timer);
  timer = null;
  failing = false;
  refused = null;
}

function retryLater(ms = RETRY_MS) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      // The lease sync handles its own errors.
      void retry?.();
    } catch (err) {
      console.warn(`[sync] could not retry the lease report: ${err.message}`);
    }
  }, ms);
  timer.unref?.();
}

function failed(message) {
  // Said once per outage, not once per attempt.
  if (!failing) {
    console.warn(`[sync] the leases did not reach the controller, DHCP keeps serving: ${message}`);
  }
  failing = true;
  retryLater();
}

async function post(db, body) {
  const controller = controllerOf(db);
  const credential = readCredential(db);
  if (!controller || !credential) {
    throw new Error('This member has lost its controller’s details. Join it again.');
  }
  const response = await syncRequest({
    ...controller,
    method: 'POST',
    path: '/api/sync/leases',
    credential,
    headers: { 'content-type': LEASE_REPORT_TYPE },
    body: packReport(body),
    timeoutMs: REPORT_TIMEOUT_MS,
  });
  let answer = {};
  try {
    answer = JSON.parse(response.body.toString('utf8')) || {};
  } catch {
    /* not an answer */
  }
  return { status: response.status, answer };
}

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const identity = (lease) => `${lease?.ip}|${lease?.duid || lease?.mac || ''}`;

const signature = (state) => `${state.active}|${state.term}|${state.handoverFrom || ''}`;

/**
 * Report this member's whole lease set. Resolves what a facts sink's
 * `leases` does, `{ synced, rejected, blocking }`, plus `release`: leases the
 * controller wants released here. Never rejects. A member that does not hold
 * DHCP sends nothing.
 */
export async function reportLeases(db, leases) {
  if (!holdsDhcp(db)) return NOTHING();
  const state = dhcpState(db);
  if (refused?.signature === signature(state) && Date.now() - refused.at < REFUSED_RETRY_MS) {
    return NOTHING();
  }
  let result;
  try {
    result = await post(db, { term: state.term, leases });
  } catch (err) {
    failed(err.message);
    return NOTHING();
  }
  const { status, answer } = result;
  if (status === 409 && answer.code === NOT_DHCP_ACTIVE) {
    console.warn(
      '[sync] the controller no longer takes this instance’s leases: DHCP has moved. ' +
        'Reporting stops until this copy has caught up.',
    );
    refused = { signature: signature(state), at: Date.now() };
    failing = false;
    retryLater(REFUSED_RETRY_MS);
    return NOTHING();
  }
  if (status !== 200) {
    failed(answer.error || `the controller answered ${status}`);
    return NOTHING();
  }
  if (failing) console.log('[sync] the controller has the leases again');
  failing = false;
  refused = null;
  // Only leases this box reported are released here, as it reported them.
  const mine = new Map(leases.map((lease) => [identity(lease), lease]));
  const own = (list) =>
    (Array.isArray(list) ? list : []).map((lease) => mine.get(identity(lease))).filter(Boolean);
  return {
    synced: count(answer.synced),
    rejected: count(answer.rejected),
    blocking: own(answer.blocking),
    release: own(answer.release),
  };
}

/**
 * The last report of a member that has lost DHCP, sent once its server has
 * stopped: `leases` is its final set, or null when it never served at
 * `term`. Resolves once the controller has it, or says this member owes
 * nothing (the handover was forced, or already taken). Rejects when the
 * controller could not be asked: the caller tries again.
 */
export async function sendFinalReport(db, { term, leases }) {
  const { status, answer } = await post(
    db,
    leases ? { term, final: true, leases } : { term, final: true, unserved: true },
  );
  if (status === 200 || (status === 409 && answer.code === NOT_DHCP_ACTIVE)) return;
  throw new Error(answer.error || `The controller answered ${status} to the final leases.`);
}
