/**
 * The last two-factor step each user signed in with, which is what stops a
 * code being used twice (auth/totp.js, `afterStep`).
 *
 * The owner of the data keeps it on the user row. A member never writes that
 * row, so it keeps its own copy in sync_state, about this box alone, and
 * believes whichever is later: the row the controller sent, or what it saw.
 */
import * as User from '../models/user.js';
import { MEMBER, storedMode } from '../sync/mode.js';
import { readSyncState, writeSyncState } from '../sync/log.js';

const stateKey = (userId) => `totp_step:${userId}`;

/** The step a new code must come after, or null when any step will do. */
export function lastTotpStep(db, user) {
  const stored = user.totp_last_step ?? null;
  if (storedMode(db) !== MEMBER) return stored;
  const seen = Number(readSyncState(db, stateKey(user.id)));
  if (!Number.isInteger(seen) || seen <= 0) return stored;
  return stored == null ? seen : Math.max(stored, seen);
}

export function rememberTotpStep(db, userId, step) {
  if (storedMode(db) === MEMBER) writeSyncState(db, stateKey(userId), step);
  else User.recordTotpStep(db, userId, step);
}
