/**
 * Moving DHCP from one instance to another (docs/REDUNDANCY-PLAN.md, section
 * 7). Only the controller moves it, by writing the settings every instance
 * follows (sync/dhcp-active.js, services/dhcp-follow.js):
 *
 *   from the controller   its server stops answering, its leases are read one
 *                         last time into the lease table, and one transaction
 *                         raises the term and names the new instance. That
 *                         instance loads the leases from its copy and starts.
 *   from a member         one transaction names the member in
 *                         `dhcp_handover_from`, raises the term and names the
 *                         new instance. The member stops, sends its final
 *                         leases, the controller clears the handover, and the
 *                         new instance starts. A member that is dead never
 *                         sends them: forceDhcpStart clears the handover.
 *
 * The settings are written last and in one transaction, so a controller that
 * dies before them has moved nothing and one that dies after them finishes
 * at boot. The after-commit hooks and the lease sync are held meanwhile, as
 * in services/stack-switch.js.
 */
import { DEFAULTS } from '../config/defaults.js';
import { readSetting, upsertSetting } from '../models/setting.js';
import { settingValue } from '../models/setting-value.js';
import { clearHandover, dhcpState, quiesceDhcp } from '../sync/dhcp-active.js';
import { followingRefusal } from '../models/sync-instance.js';
import { writeRefusal } from '../sync/mode.js';
import { holdHooks } from '../utils/after-commit.js';
import { recordAudit } from './audit.js';
import { applyDhcpServing, followDhcp } from './dhcp-follow.js';
import { holdLeaseSync, syncLeasesNow } from './dhcp-lease-sync.js';

const SETTLE_ATTEMPTS = 5;

/** A move that was refused: `status` and `code` are what the API answers. */
export class DhcpMoveError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DhcpMoveError';
    this.status = status;
    this.code = code;
  }
}

const nameOf = (db, instanceId) =>
  db.prepare('SELECT name FROM sync_instances WHERE instance_id = ?').get(instanceId)?.name ?? null;

/** `{ active_instance_id, term, handover }` as GET /api/instances reports it. */
export function dhcpView(db, state = dhcpState(db)) {
  return {
    active_instance_id: state.active,
    term: state.term,
    handover: state.handoverFrom
      ? {
          from_instance_id: state.handoverFrom,
          from_name: nameOf(db, state.handoverFrom),
          since: state.handoverSince,
        }
      : null,
  };
}

/** A row's part in DHCP: 'serving', 'starting', 'handing_over' or null. */
export function dhcpRole(state, row) {
  if (state.handoverFrom && row.instance_id === state.handoverFrom) return 'handing_over';
  if (row.instance_id !== state.active) return null;
  return state.handoverFrom ? 'starting' : 'serving';
}

let moving = false;

/** Whether DHCP is between two instances: a move running, or a handover owed. */
export const dhcpMoving = (db) => moving || Boolean(dhcpState(db).handoverFrom);

/**
 * Why DHCP cannot move to `row` (a sync_instances row) right now:
 * `{ code, error }`, or null when it can.
 */
export function moveRefusal(db, row, state = dhcpState(db)) {
  if (moving) return { code: 'handover_pending', error: 'A DHCP move is already running.' };
  // One change of who does what at a time: the member taking over the
  // controller has to find DHCP where the controller it follows left it.
  const frozen = writeRefusal(db);
  if (frozen) return frozen;
  if (state.handoverFrom) {
    const from = nameOf(db, state.handoverFrom) || 'the instance that had it';
    return {
      code: 'handover_pending',
      error:
        `DHCP is still being handed over by ${from}. Wait for it to finish, ` +
        'or start DHCP without it if that instance is off.',
    };
  }
  if (row.instance_id === state.active) {
    return { code: 'already_active', error: `${row.name} already serves DHCP.` };
  }
  if (row.is_controller) {
    const enabled = settingValue('dhcp_enabled', readSetting(db, 'dhcp_enabled'), DEFAULTS);
    if (enabled === 'false') {
      return {
        code: 'dhcp_switched_off',
        error: `DHCP is switched off on ${row.name}. Switch it on in Settings > Interfaces first.`,
      };
    }
    return null;
  }
  return followingRefusal(
    db,
    row,
    'DHCP can only move to an instance that is following the controller.',
  );
}

const instanceRow = (db, id) =>
  Number.isInteger(id)
    ? db
        .prepare(
          `SELECT id, instance_id, name, is_controller, version, schema_version, last_contact_at,
             cursor
           FROM sync_instances WHERE id = ?`,
        )
        .get(id)
    : null;

function refused(db, row, { code, error }) {
  recordAudit({
    action: 'dhcp_instance_move_refused',
    entityType: 'instance',
    entityId: row.id,
    db,
    details: { name: row.name, instance_id: row.instance_id, code },
  });
  return new DhcpMoveError(409, code, error);
}

// This box's own last leases into the lease table, with its server quiet.
async function finalOwnLeases(db) {
  for (let i = 0; i < SETTLE_ATTEMPTS; i++) {
    const result = await syncLeasesNow(db);
    if (!result.unsettled) return;
  }
  throw new Error('the DHCP server’s leases did not settle');
}

// After the settings are written: this box's server agrees with them. The
// move stands whatever this runs into; following tries again by itself.
async function settle(db) {
  try {
    await applyDhcpServing(db);
  } catch (err) {
    console.warn(`[dhcp] could not apply the DHCP move here: ${err.message}`);
  }
  await followDhcp(db);
}

/**
 * Move DHCP to the instance in sync_instances row `id`. Resolves
 * `{ active_instance_id, term, handover }`. Rejects with a DhcpMoveError:
 * 404 for an unknown row, 409 with the reason it cannot move now, 500 when
 * the controller could not hand its own leases over (nothing has moved).
 */
export async function moveDhcp(db, id) {
  const row = instanceRow(db, id);
  if (!row) throw new DhcpMoveError(404, 'not_found', 'No such instance.');
  const refusal = moveRefusal(db, row);
  if (refusal) throw refused(db, row, refusal);

  moving = true;
  const before = dhcpState(db);
  let releaseHooks = null;
  let releaseLeaseSync = null;
  let unquiet = null;
  try {
    releaseHooks = await holdHooks();
    releaseLeaseSync = await holdLeaseSync();
    const term = before.term + 1;
    if (before.here) {
      // The controller serves: quiet first, so the leases read next are final.
      unquiet = quiesceDhcp(db);
      await applyDhcpServing(db);
      await finalOwnLeases(db);
      db.transaction(() => {
        upsertSetting(db, 'dhcp_term', term);
        upsertSetting(db, 'dhcp_active_instance', row.instance_id);
      })();
    } else {
      db.transaction(() => {
        upsertSetting(db, 'dhcp_handover_from', before.active);
        upsertSetting(db, 'dhcp_handover_since', new Date().toISOString());
        upsertSetting(db, 'dhcp_term', term);
        upsertSetting(db, 'dhcp_active_instance', row.instance_id);
      })();
    }
  } catch (err) {
    // Nothing was written: the controller serves again as it did.
    unquiet?.();
    unquiet = null;
    if (before.here) {
      await applyDhcpServing(db).catch((undo) =>
        console.error(`[dhcp] could not start DHCP again after a failed move: ${undo.message}`),
      );
    }
    recordAudit({
      action: 'dhcp_instance_move_failed',
      entityType: 'instance',
      entityId: row.id,
      db,
      details: { name: row.name, instance_id: row.instance_id, error: err.message },
    });
    throw new DhcpMoveError(500, 'move_failed', `DHCP did not move: ${err.message}`);
  } finally {
    unquiet?.();
    releaseLeaseSync?.();
    releaseHooks?.();
    moving = false;
  }

  const view = dhcpView(db);
  recordAudit({
    action: 'dhcp_instance_moved',
    entityType: 'instance',
    entityId: row.id,
    db,
    before: { instance_id: before.active, name: nameOf(db, before.active), term: before.term },
    after: { instance_id: row.instance_id, name: row.name, term: view.term },
    details: { handover_from: view.handover?.from_name ?? null },
  });
  await settle(db);
  return view;
}

/**
 * Start DHCP on the new instance without the final leases of the one that
 * had it: that instance is dead or cut off. The leases are the ones the
 * controller last heard. Rejects with a DhcpMoveError (409 `no_handover`)
 * when nothing is pending.
 */
export async function forceDhcpStart(db) {
  const state = dhcpState(db);
  if (!state.handoverFrom) {
    throw new DhcpMoveError(409, 'no_handover', 'No DHCP handover is pending.');
  }
  const pending = dhcpView(db, state);
  clearHandover(db);
  recordAudit({
    action: 'dhcp_handover_forced',
    entityType: 'instance',
    db,
    details: {
      from: pending.handover.from_name,
      from_instance_id: state.handoverFrom,
      to: nameOf(db, state.active),
      to_instance_id: state.active,
      term: state.term,
      pending_since: state.handoverSince,
    },
  });
  await settle(db);
  return dhcpView(db);
}
