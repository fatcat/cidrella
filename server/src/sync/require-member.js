/**
 * Express middleware for what instances say to each other: the request
 * carries the credential pairing gave the caller, and `req.member` is its row
 * in sync_instances. A member answering instead of a controller says so, and
 * so does a controller that has been replaced.
 */
import { getDb } from '../db/init.js';
import { memberByInstanceId, memberForCredential } from '../models/sync-instance.js';
import { CONTROLLER_HEADER, EPOCH_HEADER, FENCED, NOT_CONTROLLER } from './controller-call.js';
import { syncStatus } from './log.js';
import { isFenced, isMember } from './mode.js';

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
 * the caller: a member that follows it is enough to fence the old one.
 */
export function epochGate(fence) {
  return (req, res, next) => {
    const db = getDb();
    const own = syncStatus(db).epoch;
    res.set(EPOCH_HEADER, String(own));
    const theirs = epochOfRequest(req);
    if (theirs === null || theirs <= own) return next();
    // The caller follows the instance that took over, and names it.
    const by = memberByInstanceId(db, String(req.headers[CONTROLLER_HEADER] || ''));
    fence(db, { epoch: theirs, by });
    res.status(409).json({
      error:
        `${by?.name || 'Another instance'} is the controller at a newer epoch: ` +
        'this instance is no longer the controller.',
      code: FENCED,
    });
  };
}
