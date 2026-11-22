/**
 * Which kind of instance this box is (docs/REDUNDANCY-PLAN.md).
 *
 *   controller  owns the data of record: every write, the full UI. A single
 *               box is one.
 *   member      holds a copy the controller keeps current, serves DNS from
 *               it, and never writes it.
 *
 * The mode is in sync_state, about this box alone. Code that must behave
 * differently on a member asks here; nothing else reads the row.
 *
 * The controller can change (services/controller-promotion.js). A controller
 * that another instance replaced is fenced: it runs as a member that follows
 * nobody, so everything a member must not do it does not do either, until it
 * joins the new controller. `isFenced` tells the two apart.
 */
import { getDb } from '../db/init.js';
import { CONTROLLER, hasSyncState, MEMBER, readSyncState, storedMode } from './log.js';
import { fencedState, handoverFreeze } from './promotion-state.js';

export { CONTROLLER, MEMBER, storedMode };

export const instanceMode = () => storedMode(getDb());
export const isMember = (db = getDb()) => storedMode(db) === MEMBER;

/**
 * The controller a member follows: { instance_id, name, address, port,
 * fingerprint }, or null on a controller.
 */
export function controllerOf(db = getDb()) {
  if (storedMode(db) !== MEMBER) return null;
  try {
    return JSON.parse(readSyncState(db, 'controller'));
  } catch {
    return null;
  }
}

/** Whether this box was the controller and has been replaced. */
export const isFenced = (db = getDb()) => fencedState(db) !== null;

/** The name of the member this controller is handing over to, or null. */
export const handoverTarget = (db = getDb()) =>
  storedMode(db) === MEMBER ? null : (handoverFreeze(db)?.to_name ?? null);

export const MEMBER_READ_ONLY = 'member_read_only';
export const CONTROLLER_FENCED = 'controller_fenced';
export const CONTROLLER_HANDOVER = 'controller_handover';

/** What a member says when asked to change the data of record. */
export function memberRefusal(db = getDb()) {
  const fenced = fencedState(db);
  if (fenced) {
    const by = fenced.by_name || 'Another instance';
    return (
      `${by} took over as the controller, so this CIDRella no longer takes changes. ` +
      'Make them there, or join it from Settings > System > Instances.'
    );
  }
  const name = controllerOf(db)?.name || 'another CIDRella';
  return `This is a member of ${name}. Make changes there.`;
}

/**
 * Why this box takes no change to the data of record right now:
 * `{ error, code }`, or null on a controller that does. One answer for the
 * write gate and for the routes that check for themselves.
 */
export function writeRefusal(db = getDb()) {
  if (storedMode(db) === MEMBER) {
    return {
      error: memberRefusal(db),
      code: fencedState(db) ? CONTROLLER_FENCED : MEMBER_READ_ONLY,
    };
  }
  const handover = handoverFreeze(db);
  if (!handover) return null;
  return {
    error: `The controller is being handed over to ${handover.to_name || 'another instance'}.`,
    code: CONTROLLER_HANDOVER,
  };
}

/**
 * Why this box takes no backup, schedules none and restores none:
 * `{ error, code }`, or null on a controller that does. A backup is of the
 * data of record and a restore replaces it, and only the controller holds
 * the record: a member holds a copy, a replaced controller holds what was,
 * and one handing over has stopped changing it. `db` may be a database from
 * before instances, which is a controller's.
 */
export function backupRefusal(db = getDb()) {
  if (!hasSyncState(db)) return null;
  const fenced = fencedState(db);
  if (fenced) {
    const by = fenced.by_name || 'the new controller';
    return {
      error:
        `${fenced.by_name || 'Another instance'} took over as the controller, so this CIDRella ` +
        `no longer holds the record. Take backups and restore them on ${by}.`,
      code: CONTROLLER_FENCED,
    };
  }
  if (storedMode(db) === MEMBER) {
    const name = controllerOf(db)?.name || 'the controller';
    return {
      error:
        `This is a member of ${name}: it holds a copy of the data, not the record. ` +
        `Take backups and restore them on ${name}.`,
      code: MEMBER_READ_ONLY,
    };
  }
  const handover = handoverFreeze(db);
  if (!handover) return null;
  const to = handover.to_name || 'another instance';
  return {
    error:
      `The controller is being handed over to ${to}. Cancel the handover first, ` +
      `or take backups and restore them on ${to} once it has taken over.`,
    code: CONTROLLER_HANDOVER,
  };
}
