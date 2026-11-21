/**
 * Which instance serves DHCP (docs/REDUNDANCY-PLAN.md, section 7). Exactly
 * one does, and its leases are the leases: the controller keeps what it
 * reports and nothing from anyone else. Three settings say who, all data of
 * record, so every instance reads the same answer from its own copy:
 *
 *   dhcp_active_instance  the instance_id that serves. Absent: the controller.
 *   dhcp_term             raised by one every time the active instance changes.
 *   dhcp_handover_from    an instance that lost DHCP and still owes its final
 *                         leases. While it is set nobody serves.
 *   dhcp_handover_since   when that handover began (ISO), for the UI.
 *
 * One more thing is about this box alone, in sync_state: `dhcp_ready_term`,
 * the term at which this box last loaded the leases into its DHCP server. An
 * instance that became active at a later term has not taken the leases yet
 * and does not answer until it has (services/dhcp-follow.js), so a crash
 * between "the settings say this box" and "its server has the leases" comes
 * back in the same place.
 *
 * A single box has none of these: it is the controller, at term 0, and
 * `dhcp_enabled` alone decides, as it always has.
 *
 * "Absent: the controller" holds only while the controller stays the same. A
 * member that takes over writes the instance that served into
 * `dhcp_active_instance` in the same transaction
 * (services/controller-promotion.js), so a change of controller never moves
 * DHCP. A controller that was replaced and fenced serves none.
 */
import { DEFAULTS } from '../config/defaults.js';
import { getDb } from '../db/init.js';
import { deleteSetting, readSetting } from '../models/setting.js';
import { settingValue } from '../models/setting-value.js';
import { MEMBER, readSyncState, storedMode, writeSyncState } from './log.js';
import { fencedState } from './promotion-state.js';

const READY_KEY = 'dhcp_ready_term';

function controllerId(db) {
  try {
    return JSON.parse(readSyncState(db, 'controller'))?.instance_id || null;
  } catch {
    return null;
  }
}

/**
 * Where DHCP stands, read from this box's copy:
 * { self, member, fenced, active, term, handoverFrom, handoverSince, here, readyTerm }.
 * `active` is an instance_id (the controller's when nothing is stored),
 * `here` whether it is this box, `readyTerm` null when this box has loaded no
 * leases.
 */
export function dhcpState(db = getDb()) {
  const member = storedMode(db) === MEMBER;
  const self = readSyncState(db, 'instance_id');
  const stored = readSetting(db, 'dhcp_active_instance');
  const term = Number.parseInt(readSetting(db, 'dhcp_term'), 10);
  const ready = Number.parseInt(readSyncState(db, READY_KEY), 10);
  const fenced = fencedState(db) !== null;
  return {
    self,
    member,
    active: stored || (member ? controllerId(db) : self),
    term: Number.isSafeInteger(term) && term > 0 ? term : 0,
    handoverFrom: readSetting(db, 'dhcp_handover_from'),
    handoverSince: readSetting(db, 'dhcp_handover_since'),
    // A box that was replaced as the controller serves nothing and owes
    // nothing, whatever its old copy of the settings says.
    fenced,
    here: !fenced && (stored ? stored === self : !member),
    readyTerm: Number.isSafeInteger(ready) ? ready : null,
  };
}

/**
 * Are this box's leases the leases? True for the active instance once
 * nothing is owed by the one before it and its own server holds them. The
 * lease sync asks before it reports or stores a lease set: a box that is not
 * the holder has only old leases, and storing those would release every real
 * one.
 */
export function holdsDhcp(db = getDb()) {
  const state = dhcpState(db);
  return state.here && !state.handoverFrom && (state.term === 0 || state.readyTerm === state.term);
}

// Boxes told to answer no DHCP while a move reads their final leases.
const quiet = new WeakSet();

/** Keep this box from answering DHCP until the returned release is called. */
export function quiesceDhcp(db = getDb()) {
  quiet.add(db);
  return () => quiet.delete(db);
}

/**
 * Does this instance answer DHCP? THE rule: the registry, the statuses and
 * the adapters all reach it through roleSwitchedOff('dhcp')
 * (utils/role-switches.js). It holds the role, no move holds it quiet, and on
 * the controller the host switch `dhcp_enabled` is not 'false'. A member's
 * `dhcp_enabled` is ignored: it is 'false' from the day it joined, and the
 * settings above alone decide.
 */
export function servesDhcpHere(db = getDb()) {
  if (!holdsDhcp(db) || quiet.has(db)) return false;
  if (storedMode(db) === MEMBER) return true;
  return settingValue('dhcp_enabled', readSetting(db, 'dhcp_enabled'), DEFAULTS) !== 'false';
}

/** This box's DHCP server holds the leases as of `term` (null: it holds none). */
export function markDhcpReady(db, term) {
  if (term === null) db.prepare('DELETE FROM sync_state WHERE key = ?').run(READY_KEY);
  else writeSyncState(db, READY_KEY, String(term));
}

const followers = new Set();

/**
 * Call `fn(db)` when the settings above may have changed under this box: a
 * sync brought new settings (sync/member.js), or the controller moved DHCP.
 * services/dhcp-follow.js listens. Returns the unsubscribe.
 */
export function onDhcpStateChanged(fn) {
  followers.add(fn);
  return () => followers.delete(fn);
}

export function dhcpStateChanged(db) {
  for (const fn of followers) {
    try {
      fn(db);
    } catch (err) {
      console.warn('[dhcp] could not follow a change of the DHCP instance:', err.message);
    }
  }
}

/** The instance handing over has delivered, or is given up on: the new one may start. */
export function clearHandover(db) {
  db.transaction(() => {
    deleteSetting(db, 'dhcp_handover_from');
    deleteSetting(db, 'dhcp_handover_since');
  })();
}
