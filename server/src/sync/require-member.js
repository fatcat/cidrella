/**
 * Express middleware for what instances say to each other: the request
 * carries the credential pairing gave the caller, and `req.member` is its row
 * in sync_instances. A member answering instead of a controller says so, and
 * so does a controller that has been replaced.
 */
import path from 'path';
import { getDb } from '../db/init.js';
import { memberByInstanceId, memberForCredential } from '../models/sync-instance.js';
import {
  CONTROLLER_HEADER,
  EPOCH_HEADER,
  EPOCH_LEAP,
  FENCED,
  NOT_CONTROLLER,
} from './controller-call.js';
import { syncFingerprint } from './identity.js';
import { IDENTITY_HEADER, provenFingerprint } from './identity-proof.js';
import { syncStatus } from './log.js';
import { isFenced, isMember } from './mode.js';
import { handoverFreeze } from './promotion-state.js';

// How long a controller frozen for a handover waits for the member it named
// to say it took over, before another instance's word for it is enough.
const HANDOVER_WAIT_MS = 5 * 60_000;

/** Everything but `hello` under /api/sync comes from the controller. */
export function controllerOnly(req, res, next) {
  if (!isMember()) return next();
  if (isFenced()) {
    return res.status(409).json({
      error: 'This instance was the controller and has been replaced. Look for the new one.',
      code: FENCED,
    });
  }
  res
    .status(409)
    .json({ error: 'This instance is a member, not the controller.', code: NOT_CONTROLLER });
}

/**
 * The caller is an instance on the list, by its credential. A controller
 * issued it. A member can check it too: the hashes are data of record, so its
 * copy of the list holds the hash of every credential the controller issued,
 * and a caller that presents one of them is an instance of this estate. The
 * controller's own row has no credential, so a member cannot tell its
 * controller from a stranger this way, and nothing asks it to.
 */
export function requireMember(req, res, next) {
  const header = req.headers.authorization || '';
  const member = header.startsWith('Bearer ')
    ? memberForCredential(getDb(), header.slice(7))
    : null;
  if (!member) {
    return res.status(401).json({
      error: 'This credential is not one this controller issued.',
      code: 'unknown_member',
    });
  }
  req.member = member;
  next();
}

/**
 * The caller is an instance on the list, by its credential or, when it sends
 * none, by its sync identity (sync/identity-proof.js). The second is how a
 * controller that was replaced asks who the controller is: `req.listed` is
 * its row, and there is no `req.member`, so nothing a member may do is open
 * to it. For `GET /api/sync/hello` and `POST /api/sync/fence`: telling a
 * controller of a higher epoch is what any listed instance may do.
 */
export function requireListed(req, res, next) {
  const proof = req.headers[IDENTITY_HEADER];
  if (req.headers.authorization || !proof) return requireMember(req, res, next);
  const db = getDb();
  let fingerprint = null;
  try {
    fingerprint = provenFingerprint(proof, syncFingerprint(path.dirname(db.name)));
  } catch {
    /* this box has no sync identity to be asked by */
  }
  const listed = fingerprint
    ? db
        .prepare('SELECT id, instance_id, name FROM sync_instances WHERE fingerprint = ?')
        .get(fingerprint)
    : null;
  if (!listed) {
    return res.status(401).json({
      error: 'This instance is not on the list of this estate.',
      code: 'unknown_member',
    });
  }
  req.listed = listed;
  next();
}

/** The epoch a request names, or null. */
export function epochOfRequest(req) {
  const epoch = Number(req.headers[EPOCH_HEADER]);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
}

/**
 * The fencing rule, after requireMember on a controller. Every answer names
 * this controller's epoch. A request from a listed instance that names a
 * higher one means another instance has taken over: this box stops being the
 * controller here and now (`fence`, services/controller-promotion.js) and
 * says so. The request names the instance that took over, which may not be
 * the caller: a member that follows it is enough to fence the old one. The
 * caller is known by its credential and the named instance only by the
 * caller's word, so both are handed to `fence`.
 *
 * Two requests are not acted on. One naming an epoch no promotion could have
 * reached is refused. And while this controller is frozen for a handover, a
 * request that names the member it is handing over to is told to ask around:
 * that member has taken over and its own notice, which carries the
 * credential this box comes back with, is on its way. After
 * HANDOVER_WAIT_MS the caller's word is enough.
 */
export function epochGate(fence) {
  return (req, res, next) => {
    const db = getDb();
    const own = syncStatus(db).epoch;
    res.set(EPOCH_HEADER, String(own));
    const theirs = epochOfRequest(req);
    if (theirs === null || theirs <= own) return next();
    if (theirs > own + EPOCH_LEAP) {
      return res.status(400).json({
        error: `Epoch ${theirs} is too far above this controller’s (${own}) to be true.`,
        code: 'bad_request',
      });
    }
    // The caller follows the instance that took over, and names it.
    const named = String(req.headers[CONTROLLER_HEADER] || '');
    const freeze = handoverFreeze(db);
    if (
      freeze?.to_instance_id === named &&
      Date.now() - Date.parse(freeze.since) < HANDOVER_WAIT_MS
    ) {
      return res.status(409).json({
        error:
          `This controller is handing over to ${freeze.to_name || 'another instance'} ` +
          'and waits to hear from it.',
        code: NOT_CONTROLLER,
      });
    }
    const by = memberByInstanceId(db, named);
    fence(db, { epoch: theirs, by, toldBy: req.member });
    res.status(409).json({
      error:
        `${by?.name || 'Another instance'} is the controller at a newer epoch: ` +
        'this instance is no longer the controller.',
      code: FENCED,
    });
  };
}
