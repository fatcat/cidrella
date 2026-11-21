/**
 * What a change of controller leaves on a box (docs/REDUNDANCY-PLAN.md,
 * section 7). All of it is about this box alone, so it survives a restart
 * and never travels. In sync_state:
 *
 *   fenced           this box was the controller and another instance took
 *                    over at a higher epoch: { epoch, by_instance_id,
 *                    by_name, since }. A fenced box runs as a member with no
 *                    controller (sync/mode.js) until it joins the new one.
 *   handover         this controller is handing over to a member and takes
 *                    no changes meanwhile: { to_instance_id, to_name, since }.
 *   epoch_base       the head of the change log when this box became the
 *                    controller at its epoch. A copy from the epoch before
 *                    can carry on from a cursor up to it, and no further.
 *
 * And in a 0600 file beside the credential (DATA_DIR/sync/), because it
 * holds credentials and a backup carries the database but not that
 * directory:
 *
 *   takeover notice  this box took over and still has to tell the controller
 *                    it replaced: { kind, to, credential, grant, epoch, base,
 *                    since }. Kept until that controller has heard. It is
 *                    written before the transaction that makes this box the
 *                    controller, so it counts only at the epoch it names.
 *
 * A leaf: it imports sync/log.js and sync/credential.js, nothing else of ours.
 */
import fs from 'fs';
import path from 'path';
import { syncDirOf } from './credential.js';
import { readSyncState, writeSyncState } from './log.js';

const FENCED = 'fenced';
const HANDOVER = 'handover';
const NOTICE_FILE = 'takeover-notice.json';
const EPOCH_BASE = 'epoch_base';

function readJson(db, key) {
  try {
    const value = JSON.parse(readSyncState(db, key));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

const forget = (db, key) => db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
const store = (db, key, value) =>
  value === null ? forget(db, key) : writeSyncState(db, key, JSON.stringify(value));

/** Why this box is fenced, or null when it is not. */
export const fencedState = (db) => readJson(db, FENCED);
export const setFenced = (db, value) => store(db, FENCED, value);

/** The handover this controller is frozen for, or null. */
export const handoverFreeze = (db) => readJson(db, HANDOVER);
export const setHandoverFreeze = (db, value) => store(db, HANDOVER, value);

const noticeFile = (db) => path.join(syncDirOf(db), NOTICE_FILE);

/** What this box still owes the controller it replaced, or null. */
export function takeoverNotice(db) {
  let notice;
  try {
    notice = JSON.parse(fs.readFileSync(noticeFile(db), 'utf8'));
  } catch {
    return null;
  }
  // One left by a takeover that never committed, or from an epoch since passed.
  return notice && notice.epoch === Number(readSyncState(db, 'epoch')) ? notice : null;
}

export function setTakeoverNotice(db, value) {
  if (value === null) return fs.rmSync(noticeFile(db), { force: true });
  fs.mkdirSync(syncDirOf(db), { recursive: true, mode: 0o700 });
  fs.writeFileSync(noticeFile(db), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/** The head this box became controller at, or null when it never took over. */
export function epochBase(db) {
  const base = Number(readSyncState(db, EPOCH_BASE) ?? NaN);
  return Number.isSafeInteger(base) ? base : null;
}
export const setEpochBase = (db, base) => writeSyncState(db, EPOCH_BASE, base);
