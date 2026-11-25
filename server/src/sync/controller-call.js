/**
 * Every request one instance makes of another after pairing goes through
 * here, so every one carries the epoch (docs/REDUNDANCY-PLAN.md, section 7,
 * Fencing) and every answer is read for what it says about who the
 * controller is.
 *
 * The epoch sent is the highest this box knows of: the one its copy of the
 * data is from, or the one of the controller it has started to follow. A
 * controller that sees a higher epoch than its own has been replaced and
 * fences itself (sync/require-member.js).
 *
 * An answer that says the instance asked is not the controller any more
 * (`fenced`, `not_controller`), or that it runs at a lower epoch than this
 * box has seen, puts the controller in doubt: the member looks for the one
 * to follow (sync/find-controller.js).
 */
import path from 'path';
import { syncRequest } from '../utils/sync-client.js';
import { readCredential } from './credential.js';
import { CALL_PROOF_HEADER, callProof } from './identity-proof.js';
import { readSyncState } from './log.js';
import { controllerOf } from './mode.js';

export const EPOCH_HEADER = 'x-cidrella-epoch';
// Whose epoch that is: the instance_id of the controller the caller follows,
// or the caller's own when it is the controller. A controller fenced by a
// member's request learns from it who replaced it.
export const CONTROLLER_HEADER = 'x-cidrella-controller';
// On every answer to `hello`, a refusal included: 'controller', 'member' or
// 'fenced'. With the epoch it is all an instance tells a caller it does not
// know, and what a member the controller never heard of needs to learn that
// there is a controller before it takes the role itself.
export const MODE_HEADER = 'x-cidrella-mode';
// On every answer to a member's sync: the DNS and DHCP states of each instance
// the controller can vouch for (services/instance-services.js), so a member's
// Instances page shows them too.
export const SERVICES_HEADER = 'x-cidrella-services';
export const FENCED = 'fenced';
export const NOT_CONTROLLER = 'not_controller';
export const STALE_EPOCH = 'stale_epoch';

// No estate gets this far above an epoch in one step: each promotion adds one.
// A request that names more is refused, never stored.
export const EPOCH_LEAP = 1000;

/** The epoch this box's copy of the data is from. */
export const lineageEpoch = (db) => Number(readSyncState(db, 'epoch') ?? 1);

/** The highest epoch this box knows of. */
export function knownEpoch(db) {
  const followed = Number(controllerOf(db)?.epoch);
  return Math.max(lineageEpoch(db), Number.isSafeInteger(followed) ? followed : 0);
}

/** Whether `epoch` is further above this box's own than any promotion could have taken it. */
export const epochTooFar = (db, epoch) => epoch > lineageEpoch(db) + EPOCH_LEAP;

/** The epoch an answer names, or null. */
export function answerEpoch(response) {
  const epoch = Number(response?.headers?.[EPOCH_HEADER]);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
}

/** An answer's JSON body, {} when it is not one. */
export function jsonBody(response) {
  try {
    return JSON.parse(response.body.toString('utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * One request to the instance at `peer` ({ address, port, fingerprint }),
 * with this box's epoch. The rest is syncRequest's (utils/sync-client.js).
 */
export function callInstance(db, peer, { headers = {}, ...request }) {
  return syncRequest({
    address: peer.address,
    port: peer.port,
    fingerprint: peer.fingerprint,
    ...request,
    headers: {
      ...headers,
      [EPOCH_HEADER]: String(knownEpoch(db)),
      [CONTROLLER_HEADER]: controllerOf(db)?.instance_id || readSyncState(db, 'instance_id') || '',
    },
  });
}

/**
 * One request from a controller to a member it holds no credential for, made
 * with a call proof for `purpose` (sync/identity-proof.js), which the member
 * checks with `fromOwnController` (sync/require-member.js).
 */
export function callMemberAsController(db, peer, purpose, { headers = {}, ...request }) {
  const proof = callProof(path.dirname(db.name), peer.fingerprint, purpose);
  return callInstance(db, peer, {
    ...request,
    headers: { ...headers, [CALL_PROOF_HEADER]: proof },
  });
}

const doubters = new Set();

/**
 * Call `fn(db, reason)` when an answer puts this member's controller in
 * doubt. Returns the unsubscribe.
 */
export function onControllerDoubt(fn) {
  doubters.add(fn);
  return () => doubters.delete(fn);
}

function doubt(db, reason) {
  for (const fn of doubters) {
    try {
      fn(db, reason);
    } catch (err) {
      console.warn(`[sync] could not look for the controller: ${err.message}`);
    }
  }
}

/** Why an answer means "this is not the controller to follow", or null. */
export function doubtIn(db, response) {
  const theirs = answerEpoch(response);
  if (theirs !== null && theirs < knownEpoch(db)) return STALE_EPOCH;
  if (response.status !== 409) return null;
  const { code } = jsonBody(response);
  return code === FENCED || code === NOT_CONTROLLER ? code : null;
}

/**
 * One request to this member's controller, with its credential. Rejects with
 * `code` 'no_controller' on a box that follows nobody. Resolves what
 * syncRequest does, whatever the status.
 */
export async function callController(db, request) {
  const controller = controllerOf(db);
  const credential = readCredential(db);
  if (!controller || !credential) {
    const err = new Error('This member has lost its controller’s details. Join it again.');
    err.code = 'no_controller';
    throw err;
  }
  const response = await callInstance(db, controller, { ...request, credential });
  const reason = doubtIn(db, response);
  if (reason) doubt(db, reason);
  return response;
}
