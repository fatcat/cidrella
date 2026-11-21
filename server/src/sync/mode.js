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
 */
import { getDb } from '../db/init.js';
import { CONTROLLER, MEMBER, readSyncState, storedMode } from './log.js';

export { CONTROLLER, MEMBER, storedMode };

export const instanceMode = () => storedMode(getDb());
export const isMember = () => instanceMode() === MEMBER;

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

/** What a member says when asked to change the data of record. */
export function memberRefusal(db = getDb()) {
  const name = controllerOf(db)?.name || 'another CIDRella';
  return `This is a member of ${name}. Make changes there.`;
}
