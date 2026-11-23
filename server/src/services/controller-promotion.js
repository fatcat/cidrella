/**
 * Changing which instance is the controller (docs/REDUNDANCY-PLAN.md, section
 * 7). An admin decides; nothing here elects anyone.
 *
 *   Coordinated handover: the controller is reachable. It stops taking
 *     changes and names a member in the setting `controller_handover_to`.
 *     That member sees the setting arrive with everything before it, takes
 *     over at epoch + 1, and tells the old controller, which becomes a member
 *     of it with a credential the new controller made for it.
 *   Forced promotion: the controller is dead or cut off. A member takes over
 *     at epoch + 1 by itself and tells the old controller if it can.
 *   Fencing: every request between instances names the epoch. A controller
 *     that hears a higher one from an instance on its list has been replaced:
 *     it saves its database and a report of what the new controller never
 *     received, and runs as a member that follows nobody until an admin
 *     joins it to the new controller, or, when no controller answers any
 *     more, takes the role back at an epoch above every one it has heard.
 *
 * Before a box takes the role without being named for it, it asks every
 * instance on its list who it is. One that answers as a controller stops it:
 * the admin was wrong about the controller being gone, or another member got
 * there first. The same answers say which instance serves DHCP at the
 * highest term, which the new controller writes down instead of what its own
 * copy, possibly behind, says.
 *
 * The epoch is what keeps this to one controller. It is raised in the same
 * transaction that makes a box the controller, every member follows the
 * highest one it can reach (sync/find-controller.js), and the box with the
 * lower one stops the moment it hears. Two things no epoch can settle, and
 * the UI says so where the choice is made: a replaced controller that the
 * other instances cannot reach but clients still can keeps answering as it
 * did, and a controller frozen for a handover whose member took over and then
 * could not call back stays frozen (or, if the handover is cancelled there,
 * takes changes again) until one instance of the new epoch reaches it.
 *
 * Every step leaves its state in the database before the next begins, and a
 * mode change ends with the process exiting (sync/restart.js), so a box that
 * dies anywhere comes back at a step this code redoes.
 */
import fs from 'fs';
import path from 'path';
import { IDENTITY_HEADER, identityProof } from '../sync/identity-proof.js';
import { DEFAULTS } from '../config/defaults.js';
import { deleteSetting, readSetting, upsertSetting } from '../models/setting.js';
import { settingValue } from '../models/setting-value.js';
import {
  followingRefusal,
  mintCredential,
  ownInstanceId,
  ownInstanceName,
  takeControllerRow,
} from '../models/sync-instance.js';
import {
  callInstance,
  epochTooFar,
  FENCED,
  jsonBody,
  knownEpoch,
  lineageEpoch,
  STALE_EPOCH,
} from '../sync/controller-call.js';
import { CREDENTIAL_FILE, readCredential, syncDirOf } from '../sync/credential.js';
import { askEveryone } from '../sync/find-controller.js';
import { dhcpState, dhcpStateChanged } from '../sync/dhcp-active.js';
import {
  CONTROLLER,
  COPY_COMPLETE,
  ensureSyncTriggers,
  estateTables,
  MEMBER,
  readSyncState,
  storedMode,
  syncHead,
  syncStatus,
  writeSyncState,
} from '../sync/log.js';
import { controllerOf, writeRefusal } from '../sync/mode.js';
import { takeOwnOutbox } from '../sync/outbox-intake.js';
import {
  fencedState,
  handoverFreeze,
  setEpochBase,
  setFenced,
  setHandoverFreeze,
  setTakeoverNotice,
  takeoverNotice,
} from '../sync/promotion-state.js';
import { restartSoon } from '../sync/restart.js';
import { isSecretField, recordAudit, SECRET_MASK } from './audit.js';
import { dhcpMoving } from './dhcp-move.js';

// Both are named with the time they were written, so a second fencing never
// replaces what the first one kept. The newest KEPT of each stay.
const REPORT_NAME = /^divergence-report-\d{8}T\d{9}Z\.json$/;
const SNAPSHOT_NAME = /^cidrella-\d{8}T\d{9}Z\.db$/;
const SNAPSHOT_DIR = path.join('snapshots', 'pre-demotion');
const KEPT = 3;
// The backup settings a controller hands on with the role.
const BACKUP_KEYS = ['backup_schedule', 'backup_retention_count'];
const NOTICE_TIMEOUT_MS = 5_000;
const NOTICE_RETRY_MS = 30_000;
const HANDOVER = 'handover';
const FENCE = 'fence';

/** A promotion step that was refused: `status` and `code` are what the API answers. */
export class PromotionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PromotionError';
    this.status = status;
    this.code = code;
  }
}

let restart = restartSoon;

/** Replace the exit a change of mode ends with (tests carry on in the new mode). Returns the undo. */
export function setPromotionRestart(fn) {
  const previous = restart;
  restart = fn;
  return () => {
    restart = previous;
  };
}

/** The exit a change of mode made by the promotion routes ends with. */
export const promotionRestart = (reason) => restart(reason);

const dataDirOf = (db) => path.dirname(db.name);
const nameOf = (db, instanceId) =>
  db.prepare('SELECT name FROM sync_instances WHERE instance_id = ?').get(instanceId)?.name ?? null;

// Is DHCP switched off on this controller? Its own switch, which no other
// instance can read.
const dhcpSwitchedOff = (db) =>
  storedMode(db) === CONTROLLER &&
  settingValue('dhcp_enabled', readSetting(db, 'dhcp_enabled'), DEFAULTS) === 'false';

// ─── What a replaced controller keeps ─────────────────────────────

// The time as a file name carries it, UTC to the millisecond: 20261122T153045123Z.
const fileStamp = () => new Date().toISOString().replace(/[-:.]/g, '');

// The files in `dir` named like `pattern`, newest first.
function stamped(dir, pattern) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => pattern.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

const newestIn = (dir, pattern) => {
  const [name] = stamped(dir, pattern);
  return name ? path.join(dir, name) : null;
};

function dropOldest(dir, pattern) {
  for (const name of stamped(dir, pattern).slice(KEPT)) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

const snapshotDirOf = (db) => path.join(dataDirOf(db), SNAPSHOT_DIR);

/** The newest divergence report of `db`, or null when there is none. */
export const divergenceReportPath = (db) => newestIn(syncDirOf(db), REPORT_NAME);

/** The newest copy of the database from before it was replaced, or null. */
export const preDemotionSnapshotPath = (db) => newestIn(snapshotDirOf(db), SNAPSHOT_NAME);

// A whole, consistent copy of the database as it is, taken while it is open.
// Update and restore snapshots copy more (the analytics store, certificates,
// the DNS and DHCP config) with the service stopped or about to exit; this
// one is taken on a running box that keeps all of those, and only its
// database is about to be replaced.
function savePreDemotionSnapshot(db) {
  const dir = snapshotDirOf(db);
  const file = path.join(dir, `cidrella-${fileStamp()}.db`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.rmSync(file, { force: true });
  db.prepare('VACUUM INTO ?').run(file);
  fs.chmodSync(file, 0o600);
  dropOldest(dir, SNAPSHOT_NAME);
  return file;
}

// What a box about to lose its data keeps of it: the copy of the database and
// the report, each null when it could not be written.
function keepWhatWas(db, report) {
  const kept = { snapshot: null, report: null };
  try {
    kept.snapshot = savePreDemotionSnapshot(db);
  } catch (err) {
    console.error(`[sync] could not save the database before it was replaced: ${err.message}`);
  }
  try {
    kept.report = writeDivergenceReport(db, report);
  } catch (err) {
    console.error(`[sync] could not write the divergence report: ${err.message}`);
  }
  return kept;
}

// A row as the report shows it: secrets masked the way the audit log masks
// them, binary values named and left out.
function reportRow(table, row) {
  const out = {};
  for (const [column, value] of Object.entries(row)) {
    if (Buffer.isBuffer(value)) out[column] = `(binary, ${value.length} bytes)`;
    else if (value !== null && isSecretField(column)) out[column] = SECRET_MASK;
    else out[column] = value;
  }
  // A setting's name is in its key, not in a column name.
  if (table === 'settings' && isSecretField(row.key) && row.value !== null) {
    out.value = SECRET_MASK;
  }
  return out;
}

/**
 * Write the divergence report: every change in this box's log above `since`,
 * the highest cursor the instance that took over is known to have reached.
 * Those are the changes it never received. Each entry names the table, the
 * key, whether the row was changed or deleted, and the row as it stands, so
 * an admin can enter by hand on the new controller what should be kept.
 * Nothing is merged. Returns the file.
 */
export function writeDivergenceReport(db, { since, replacedBy, epoch }) {
  const tables = new Map(estateTables(db).map((table) => [table.name, table]));
  const counts = {};
  const changes = [];
  const read = new Map();
  const logged = db
    .prepare('SELECT seq, tbl, pk, op FROM sync_log WHERE seq > ? ORDER BY tbl, seq')
    .all(since ?? 0);
  for (const { tbl, pk, op } of logged) {
    const table = tables.get(tbl);
    if (!table) continue;
    if (!read.has(tbl)) {
      read.set(
        tbl,
        db.prepare(`SELECT ${table.columns.join(', ')} FROM ${tbl} AS r WHERE r.${table.key} = ?`),
      );
    }
    const row = op === 'u' ? read.get(tbl).get(pk) : null;
    counts[tbl] = (counts[tbl] || 0) + 1;
    changes.push({
      table: tbl,
      key: pk,
      operation: row ? 'changed' : 'deleted',
      row: row ? reportRow(tbl, row) : null,
    });
  }
  const report = {
    generated_at: new Date().toISOString(),
    instance: { instance_id: ownInstanceId(db), name: ownInstanceName(db) },
    replaced_by: replacedBy,
    epoch,
    // Null: this box never heard how far the other instance had got, so
    // everything in its log is listed.
    since: since ?? null,
    head: syncHead(db),
    counts,
    changes,
  };
  const dir = syncDirOf(db);
  const file = path.join(dir, `divergence-report-${fileStamp()}.json`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  dropOldest(dir, REPORT_NAME);
  return file;
}

// ─── Fencing ──────────────────────────────────────────────────────

// The lower of the two cursors, or null when either is unknown: the report
// then lists everything.
function lowerCursor(...rows) {
  const cursors = rows.filter(Boolean).map((row) => row.cursor);
  return cursors.length > 0 && cursors.every(Number.isSafeInteger) ? Math.min(...cursors) : null;
}

/**
 * This controller has been replaced by the instance in sync_instances row
 * `by`, at `epoch`, on the word of the instance in row `toldBy` (the caller,
 * known by its credential; `by` is only named). Once: its database is copied
 * aside and the report of what the new controller never received is written,
 * from the lower of the two instances' cursors, so naming an instance that
 * was further along hides nothing. Then it becomes a member that follows
 * nobody, with a member's guards on the data of record, and restarts as
 * that. It refuses changes, runs none of a controller's jobs and serves no
 * DHCP; it keeps answering DNS from what it has. Returns false on a box that
 * is not a controller.
 */
export function fenceSelf(db, { epoch, by = null, toldBy = by }) {
  if (storedMode(db) === MEMBER) return false;
  const since = new Date().toISOString();
  const replacedBy = by ? { instance_id: by.instance_id, name: by.name } : null;
  const switchedOff = dhcpSwitchedOff(db);
  const kept = keepWhatWas(db, {
    since: by ? lowerCursor(by, toldBy) : null,
    replacedBy,
    epoch,
  });
  db.transaction(() => {
    // Written while this box still owns its log: it is the last row in it.
    recordAudit({
      db,
      action: 'controller_fenced',
      entityType: 'instance',
      source: 'sync',
      details: {
        by: by?.name ?? null,
        by_instance_id: by?.instance_id ?? null,
        told_by: toldBy?.name ?? null,
        told_by_instance_id: toldBy?.instance_id ?? null,
        epoch,
      },
    });
    setFenced(db, {
      epoch,
      by_instance_id: by?.instance_id ?? null,
      by_name: by?.name ?? null,
      told_by_instance_id: toldBy?.instance_id ?? null,
      told_by: toldBy?.name ?? null,
      since,
      dhcp_switched_off: switchedOff,
      snapshot: kept.snapshot && path.basename(kept.snapshot),
    });
    setHandoverFreeze(db, null);
    writeSyncState(db, 'mode', MEMBER);
    db.prepare("DELETE FROM sync_state WHERE key IN ('controller', 'cursor', 'copy_from')").run();
    ensureSyncTriggers(db, MEMBER);
  })();
  // The mode has changed: whatever the steps below run into, the process
  // must not carry on as the controller it was.
  try {
    // Whatever this box still owed a controller it had replaced is moot.
    setTakeoverNotice(db, null);
    console.warn(
      `[sync] ${by?.name || 'another instance'} is the controller now (epoch ${epoch}). ` +
        `This instance no longer takes changes. Database copy: ${kept.snapshot || 'not saved'}, ` +
        `report: ${kept.report || 'not written'}`,
    );
    dhcpStateChanged(db);
  } finally {
    restart('Fenced: another instance is the controller');
  }
  return true;
}

const TOO_FAR = {
  error: 'The epoch this notice names is too far above this controller’s to be true.',
  code: 'bad_request',
};

// What a controller answers the instance that tells it of a takeover.
const heardAnswer = (db) => {
  const fenced = fencedState(db);
  return fenced
    ? { fenced: true, dhcp_switched_off: fenced.dhcp_switched_off === true }
    : { fenced: false, member: storedMode(db) === MEMBER };
};

/**
 * POST /api/sync/fence, from the instance in row `member`, which took over
 * at `epoch`. Returns `{ status, body }`.
 */
export function receiveFence(db, member, epoch) {
  if (storedMode(db) === CONTROLLER) {
    if (!Number.isSafeInteger(epoch) || epoch <= syncStatus(db).epoch) {
      return {
        status: 409,
        body: {
          error: 'This controller runs at the same epoch or a newer one.',
          code: STALE_EPOCH,
        },
      };
    }
    if (epochTooFar(db, epoch)) return { status: 400, body: TOO_FAR };
    fenceSelf(db, { epoch, by: member });
  }
  return { status: 200, body: heardAnswer(db) };
}

// ─── Taking over ──────────────────────────────────────────────────

/**
 * Why this box cannot take over as the controller: `{ code, error }` with
 * `not_member` or `never_synced`, or null when it can. A controller that was
 * replaced can, to take the role back. What the other instances answer is
 * promoteSelf's to judge: it has to ask them.
 */
export function promoteSelfRefusal(db) {
  if (storedMode(db) !== MEMBER) {
    return { code: 'not_member', error: 'This instance is the controller already.' };
  }
  if (fencedState(db)) return null;
  // A copy is complete with a cursor, or when it had one before a migration
  // took it (this member was updated before its controller).
  const complete =
    readSyncState(db, 'cursor') !== null || readSyncState(db, COPY_COMPLETE) !== null;
  if (!complete || !controllerOf(db)) {
    return {
      code: 'never_synced',
      error:
        'This member holds no complete copy of the controller’s data, so it has nothing to ' +
        'take over with: it has not finished a first copy.',
    };
  }
  return null;
}

const HANDOVER_PENDING = 'handover_pending';
const CONTROLLER_REACHABLE = 'controller_reachable';

/**
 * Why this box does not take the role, going by what the other instances
 * answered (`heard`, sync/find-controller.js): `{ code, error }`, or null
 * when nothing stands in the way.
 *
 * `handover_pending`: the controller named another member for a handover
 * (`named`) and that member answered, so it can still do it. When it does
 * not answer it is taken for dead like the controller. Otherwise a
 * controller that died mid-handover with the member it named would leave
 * every other member unable to take over for good.
 *
 * `controller_reachable`: an instance answers as a controller at an epoch no
 * lower than this box knows. The one this box follows is not gone, or
 * another member took over first (and may not know this box at all: one that
 * joined the old controller after the new one's last sync). The controller that named this box for a
 * handover (`handover`) is expected to answer, and does not count.
 */
function reachableRefusal(db, heard, { former, named, handover, fenced }) {
  const known = knownEpoch(db);
  const chosen = named && !handover ? heard.find((answer) => answer.instance_id === named) : null;
  if (chosen) {
    if (chosen.mode === CONTROLLER && chosen.epoch > known) {
      return {
        code: HANDOVER_PENDING,
        error: `${chosen.name} has taken over as the controller already. This member will follow it shortly.`,
      };
    }
    return {
      code: HANDOVER_PENDING,
      error:
        `The controller was being handed over to ${chosen.name}, and ${chosen.name} is still reachable. ` +
        `Promote ${chosen.name}, or wait for it to take over.`,
    };
  }
  const [controller] = heard
    .filter((answer) => answer.mode === CONTROLLER && (fenced || answer.epoch >= known))
    .filter((answer) => !(handover && answer.instance_id === former.instance_id))
    .sort((x, y) => y.epoch - x.epoch || x.instance_id.localeCompare(y.instance_id));
  if (!controller) return null;
  const { name } = controller;
  if (controller.stranger) {
    return {
      code: CONTROLLER_REACHABLE,
      error:
        `${name} is the controller now and does not know this instance. ` +
        `Join ${name} with a join token from Settings > System > Instances.`,
    };
  }
  if (fenced) {
    return {
      code: CONTROLLER_REACHABLE,
      error: `${name} is answering as the controller. Join it instead of taking the role back.`,
    };
  }
  if (controller.instance_id === former.instance_id) {
    return {
      code: CONTROLLER_REACHABLE,
      error:
        `${name} is still answering as the controller. ` +
        `Use Make controller on ${name} to hand the role over.`,
    };
  }
  return {
    code: CONTROLLER_REACHABLE,
    error: `${name} has taken over as the controller already. This member will follow it shortly.`,
  };
}

/**
 * Which instance serves DHCP once this box is the controller: `{ active,
 * term, handoverFrom, handoverSince, adoptedFrom }`. DHCP does not move with
 * the role, so it is whoever served. This box's copy may be behind on that
 * (a move it never received), so the highest term any instance that
 * answered knows of wins, and `adoptedFrom` names the instance that said
 * so, null when this box's own copy stands. An instance that did not answer
 * cannot be asked.
 */
function dhcpAssignment(db, heard, { self, former }) {
  const own = dhcpState(db);
  let best = {
    // "No instance named" has meant the controller. It must not start to
    // mean this box, unless this box was that controller.
    active: readSetting(db, 'dhcp_active_instance') || former?.instance_id || self,
    term: own.term,
    handoverFrom: own.handoverFrom,
    handoverSince: own.handoverSince,
    adoptedFrom: null,
  };
  for (const answer of heard) {
    // A replaced controller's copy is of an estate that has moved on.
    if (!answer.dhcp || answer.mode === 'fenced' || answer.dhcp.term <= best.term) continue;
    best = { ...answer.dhcp, adoptedFrom: answer.name };
  }
  return best;
}

const setOrDelete = (db, key, value) =>
  value ? upsertSetting(db, key, value) : deleteSetting(db, key);

/**
 * Make this box the controller. First it asks every other instance who it is
 * (reachableRefusal, dhcpAssignment). Then one transaction: the epoch goes
 * up, this box's row becomes the controller's and the old controller's a
 * member's, the instance that serves DHCP is written down so DHCP stays
 * where it was, and the mode changes. The change log carries on from where
 * this copy of it stopped, in the same dataset, so the members whose copy is
 * of the same log go on with deltas. Then the old controller is told if it
 * can be reached, and the process restarts as a controller.
 *
 * On a member the epoch is the highest it knows plus one. When the
 * controller named this box for a handover, the old controller is given a
 * credential to come back with as a member. Otherwise it is fenced. When the
 * controller named another member, this box takes over only if that member
 * does not answer, and the handover is cleared.
 *
 * On a controller that was replaced this takes the role back: the epoch is
 * one above its own and the one it was fenced at. No controller answered, so
 * the instance that had replaced it is told when it comes back, with this
 * box's sync identity as the proof (it holds no credential of that one's).
 * The members it had find it by its epoch.
 *
 * Resolves `{ epoch, handover, dhcp }`, `dhcp` being `{ active_instance_id,
 * name, reachable }`: the instance DHCP is named on and whether it answered.
 * Rejects with a PromotionError.
 */
export async function promoteSelf(db) {
  const refusal = promoteSelfRefusal(db);
  if (refusal) throw new PromotionError(409, refusal.code, refusal.error);

  const heard = (await askEveryone(db)).filter(Boolean);
  // Nothing may have changed under the questions just asked.
  const again = promoteSelfRefusal(db);
  if (again) throw new PromotionError(409, again.code, again.error);

  const self = ownInstanceId(db);
  const fenced = fencedState(db);
  const former = controllerOf(db);
  const credential = readCredential(db);
  const named = fenced ? null : readSetting(db, 'controller_handover_to');
  const handover = named === self;
  const reachable = reachableRefusal(db, heard, { former, named, handover, fenced });
  if (reachable) throw new PromotionError(409, reachable.code, reachable.error);

  // The member the handover named, when this promotion goes over its head.
  const passedOver = named && !handover ? nameOf(db, named) || named : null;
  const grant = handover ? mintCredential() : null;
  const dhcp = dhcpAssignment(db, heard, { self, former });
  const since = new Date().toISOString();

  const head = syncHead(db);
  const lineage = lineageEpoch(db);
  const epoch = Math.max(knownEpoch(db), fenced?.epoch ?? 0) + 1;
  // Whose log this copy is of. A copy of the same log at the same epoch
  // carries on from a cursor up to here. When this box had started to follow
  // a newer controller without taking anything from it yet, no copy is known
  // to match, and all start over.
  const copied = fenced ? self : readSyncState(db, 'copy_from') || former.instance_id;
  const base =
    fenced || epoch === lineage + 1 ? { head, from: copied, epoch: lineage } : { head: -1 };
  if (former) {
    // What the old controller is owed, kept in a file of its own
    // (sync/promotion-state.js) and written first: it counts only once the
    // transaction below has made this the epoch.
    setTakeoverNotice(db, {
      kind: handover ? HANDOVER : FENCE,
      to: {
        instance_id: former.instance_id,
        name: former.name,
        address: former.address,
        port: former.port,
        fingerprint: former.fingerprint,
      },
      credential,
      grant: grant?.credential ?? null,
      epoch,
      base: head,
      since,
    });
  } else if (fenced?.by_instance_id) {
    // The instance that replaced this one is a controller too if it comes
    // back: it is owed the same word.
    const replaced = db
      .prepare(
        `SELECT instance_id, name, address, port, fingerprint FROM sync_instances
         WHERE instance_id = ? AND address IS NOT NULL AND fingerprint IS NOT NULL`,
      )
      .get(fenced.by_instance_id);
    if (replaced) {
      setTakeoverNotice(db, {
        kind: FENCE,
        to: replaced,
        credential: null,
        grant: null,
        epoch,
        base: head,
        since,
      });
    }
  }
  const takeOver = db.transaction(() => {
    db.prepare(
      "DELETE FROM sync_state WHERE key IN ('mode', 'controller', 'cursor', 'copy_from')",
    ).run();
    // The log triggers go on with the mode, so the writes below are the
    // first rows this box logs, right after the last one it copied.
    ensureSyncTriggers(db, CONTROLLER);
    takeControllerRow(db, { former, grantHash: grant?.hash ?? null, at: since });
    if (readSetting(db, 'dhcp_active_instance') !== dhcp.active) {
      upsertSetting(db, 'dhcp_active_instance', dhcp.active);
    }
    if (dhcp.adoptedFrom) {
      upsertSetting(db, 'dhcp_term', String(dhcp.term));
      setOrDelete(db, 'dhcp_handover_from', dhcp.handoverFrom);
      setOrDelete(db, 'dhcp_handover_since', dhcp.handoverSince);
    }
    // A controller serves DHCP only with its own switch on, and a member's
    // is off from the day it joined: this box keeps serving if it did. A
    // controller that takes the role back has its own switch as it left it.
    if (!fenced && dhcp.active === self) upsertSetting(db, 'dhcp_enabled', 'true');
    deleteSetting(db, 'controller_handover_to');
    deleteSetting(db, 'controller_handover_since');
    writeSyncState(db, 'epoch', epoch);
    setEpochBase(db, base);
    if (fenced) setFenced(db, null);
    const dhcpDetails = {
      dhcp_instance: nameOf(db, dhcp.active),
      ...(dhcp.adoptedFrom ? { dhcp_term: dhcp.term, dhcp_known_from: dhcp.adoptedFrom } : {}),
    };
    if (fenced) {
      recordAudit({
        db,
        action: 'controller_taken_back',
        entityType: 'instance',
        details: {
          epoch,
          fenced_by: fenced.by_name ?? null,
          fenced_at_epoch: fenced.epoch,
          ...dhcpDetails,
        },
      });
      return;
    }
    recordAudit({
      db,
      action: handover ? 'controller_handover_taken' : 'controller_promoted',
      entityType: 'instance',
      details: {
        from: former.name,
        from_instance_id: former.instance_id,
        epoch,
        forced: !handover,
        ...(passedOver ? { handover_to_unreachable: passedOver } : {}),
        ...dhcpDetails,
      },
    });
  });
  try {
    takeOver();
  } catch (err) {
    setTakeoverNotice(db, null);
    throw err;
  }
  // The mode has changed: whatever the steps below run into, the process
  // must not carry on as the member it was.
  try {
    fs.rmSync(path.join(syncDirOf(db), CREDENTIAL_FILE), { force: true });
    console.log(
      fenced
        ? `[sync] this instance is the controller again (epoch ${epoch})`
        : `[sync] this instance is the controller now (epoch ${epoch}), taking over from ${former.name}`,
    );
    try {
      takeOwnOutbox(db, { name: ownInstanceName(db), instanceId: self });
    } catch (err) {
      console.warn(`[sync] could not take in this instance’s own outbox: ${err.message}`);
    }
    // Best effort: a controller that is dead does not answer. Boot tries again.
    await deliverTakeoverNotice(db);
    dhcpStateChanged(db);
  } finally {
    restart(fenced ? 'Took the controller role back' : 'Took over as the controller');
  }
  return {
    epoch,
    handover,
    dhcp: {
      active_instance_id: dhcp.active,
      name: nameOf(db, dhcp.active),
      reachable: dhcp.active === self || heard.some((answer) => answer.instance_id === dhcp.active),
    },
  };
}

/**
 * A member's sync calls this after every round that left it current: when
 * the controller has named this box for a handover, it takes over. Resolves
 * whether it did.
 */
export async function takeOverIfNamed(db) {
  if (storedMode(db) !== MEMBER || fencedState(db)) return false;
  if (readSetting(db, 'controller_handover_to') !== ownInstanceId(db)) return false;
  await promoteSelf(db);
  return true;
}

// The old controller says DHCP was switched off on it. It was the instance
// named for DHCP, so as a member, whose switch counts for nothing, it would
// start serving. DHCP is named on this controller instead, whose own switch
// is off: nobody serves, as before, and the switch is where it always was.
function keepDhcpOff(db, former) {
  const state = dhcpState(db);
  if (state.active !== former.instance_id || state.handoverFrom) return;
  const ownSwitch = settingValue('dhcp_enabled', readSetting(db, 'dhcp_enabled'), DEFAULTS);
  if (ownSwitch !== 'false') {
    console.warn(
      `[dhcp] DHCP was switched off on ${former.name}, which is named to serve it. ` +
        'Move DHCP to the instance that should serve.',
    );
    return;
  }
  upsertSetting(db, 'dhcp_active_instance', ownInstanceId(db));
  recordAudit({
    db,
    action: 'dhcp_instance_kept_off',
    entityType: 'instance',
    source: 'sync',
    details: {
      from: former.name,
      from_instance_id: former.instance_id,
      reason: 'DHCP was switched off on the controller that was replaced',
    },
  });
  dhcpStateChanged(db);
}

// What each backup setting handed on with the role may be.
const BACKUP_VALUE = {
  backup_schedule: /^[a-z]{1,16}$/,
  backup_retention_count: /^[1-9]\d{0,2}$/,
};

// The old controller took the scheduled backups, and as a member it takes
// none. This box, a member until now, had them switched off at its join. So
// the schedule comes over with the role, unless this box already has one of
// its own. Returns what was taken on, or null.
function adoptBackupSchedule(db, handed) {
  const own = settingValue('backup_schedule', readSetting(db, 'backup_schedule'), DEFAULTS);
  const schedule = handed?.backup_schedule;
  if (own !== 'off' || typeof schedule !== 'string' || schedule === 'off') return null;
  const taken = {};
  for (const key of BACKUP_KEYS) {
    const value = handed[key];
    if (typeof value === 'string' && BACKUP_VALUE[key].test(value)) taken[key] = value;
  }
  if (!taken.backup_schedule) return null;
  for (const [key, value] of Object.entries(taken)) upsertSetting(db, key, value);
  return taken;
}

/**
 * Tell the controller this box replaced, if that is still owed. A handover
 * hands it the credential to come back with; a forced promotion tells it it
 * is fenced. Resolves 'none', 'delivered', 'dropped' (nothing left to tell)
 * or 'pending' (it did not answer: tried again later). Never rejects.
 */
export async function deliverTakeoverNotice(db) {
  const notice = takeoverNotice(db);
  if (!notice || storedMode(db) !== CONTROLLER) return 'none';
  const drop = (why) => {
    setTakeoverNotice(db, null);
    console.log(`[sync] nothing more to tell ${notice.to.name}: ${why}`);
    return 'dropped';
  };
  const row = db
    .prepare('SELECT last_contact_at FROM sync_instances WHERE instance_id = ?')
    .get(notice.to.instance_id);
  if (!row) return drop('it was removed from the instances');
  // The takeover itself stamped the row with `since` (takeControllerRow):
  // only something heard after that is the old controller following.
  if (Date.parse(row.last_contact_at || '') > Date.parse(notice.since)) {
    return drop('it follows this controller');
  }
  let response;
  try {
    response = await callInstance(db, notice.to, {
      method: 'POST',
      path: notice.kind === HANDOVER ? '/api/sync/handover-done' : '/api/sync/fence',
      credential: notice.credential,
      // No credential of that instance's: this box's sync identity says who asks.
      headers: notice.credential
        ? {}
        : { [IDENTITY_HEADER]: identityProof(path.dirname(db.name), notice.to.fingerprint) },
      body: { epoch: notice.epoch, base: notice.base, credential: notice.grant },
      timeoutMs: NOTICE_TIMEOUT_MS,
    });
  } catch {
    return 'pending';
  }
  const answer = jsonBody(response);
  if (response.status === 409 && answer.code === STALE_EPOCH) {
    return drop('it runs at a newer epoch than this controller');
  }
  // A handover it had cancelled, or one it no longer knows of: it fenced itself.
  const heard = response.status === 200 || (response.status === 409 && answer.code === FENCED);
  if (!heard) return 'pending';
  setTakeoverNotice(db, null);
  if (answer.dhcp_switched_off === true) keepDhcpOff(db, notice.to);
  const handedOver = notice.kind === HANDOVER && response.status === 200 && !answer.fenced;
  const backups = handedOver ? adoptBackupSchedule(db, answer.backup) : null;
  recordAudit({
    db,
    action: handedOver ? 'controller_handover_completed' : 'controller_fence_told',
    entityType: 'instance',
    source: 'sync',
    details: {
      to: notice.to.name,
      to_instance_id: notice.to.instance_id,
      epoch: notice.epoch,
      ...(backups ? { backup_schedule: backups.backup_schedule } : {}),
    },
  });
  return 'delivered';
}

/**
 * A controller's boot: keep trying to tell the controller it replaced until
 * there is nothing left to tell. Returns the stop.
 */
export function startTakeoverNotices(db) {
  if (!takeoverNotice(db)) return () => {};
  let timer = null;
  let stopped = false;
  const round = async () => {
    const outcome = await deliverTakeoverNotice(db);
    if (stopped || outcome !== 'pending') return;
    timer = setTimeout(round, NOTICE_RETRY_MS);
    timer.unref?.();
  };
  void round();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// ─── Handing over ─────────────────────────────────────────────────

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

/**
 * Why this controller cannot hand over to `row` (a sync_instances row) right
 * now: `{ code, error }`, or null when it can.
 */
export function promoteRefusal(db, row) {
  if (storedMode(db) === MEMBER) return writeRefusal(db);
  const freeze = handoverFreeze(db);
  if (freeze) {
    return {
      code: 'handover_pending',
      error:
        `The controller is already being handed over to ${freeze.to_name || 'another instance'}. ` +
        'Cancel that first.',
    };
  }
  const owed = takeoverNotice(db);
  if (owed) {
    return {
      code: 'handover_pending',
      error:
        `This controller has not yet told ${owed.to.name} that it took over. ` +
        `Wait until ${owed.to.name} follows it, or remove ${owed.to.name} from the instances.`,
    };
  }
  if (dhcpMoving(db)) {
    return {
      code: 'dhcp_moving',
      error: 'DHCP is being moved to another instance. Wait for that to finish.',
    };
  }
  if (row.is_controller) {
    return { code: 'already_controller', error: `${row.name} is the controller already.` };
  }
  return followingRefusal(
    db,
    row,
    'The controller can only be handed to an instance that is following it.',
  );
}

const handoverView = (freeze) =>
  freeze && {
    to_instance_id: freeze.to_instance_id,
    to_name: freeze.to_name,
    since: freeze.since,
  };

/**
 * Start handing the controller over to the member in sync_instances row
 * `id`. From here this controller refuses changes (sync/write-gate.js) until
 * that member has taken over or the handover is cancelled; a restart leaves
 * it frozen. Returns `{ to_instance_id, to_name, since }`. Throws a
 * PromotionError: 404 for an unknown row, 409 with the reason.
 */
export function startHandover(db, id) {
  const row = instanceRow(db, id);
  if (!row) throw new PromotionError(404, 'not_found', 'No such instance.');
  const refusal = promoteRefusal(db, row);
  if (refusal) {
    recordAudit({
      db,
      action: 'controller_handover_refused',
      entityType: 'instance',
      entityId: row.id,
      details: { name: row.name, instance_id: row.instance_id, code: refusal.code },
    });
    throw new PromotionError(409, refusal.code, refusal.error);
  }
  const freeze = {
    to_instance_id: row.instance_id,
    to_name: row.name,
    since: new Date().toISOString(),
  };
  // One transaction, the audit row first: the member takes over when it has
  // everything up to the setting, and this way that is everything there is.
  db.transaction(() => {
    recordAudit({
      db,
      action: 'controller_handover_started',
      entityType: 'instance',
      entityId: row.id,
      details: { to: row.name, to_instance_id: row.instance_id },
    });
    setHandoverFreeze(db, freeze);
    upsertSetting(db, 'controller_handover_since', freeze.since);
    upsertSetting(db, 'controller_handover_to', row.instance_id);
  })();
  return handoverView(freeze);
}

/**
 * Call the handover off: this controller takes changes again. Throws a
 * PromotionError (409 `no_handover`) when none is pending. A member that
 * took over at the same moment is not undone by this: this box fences itself
 * when it hears that member's epoch.
 */
export function cancelHandover(db) {
  const freeze = storedMode(db) === CONTROLLER ? handoverFreeze(db) : null;
  if (!freeze) throw new PromotionError(409, 'no_handover', 'No handover is pending.');
  db.transaction(() => {
    deleteSetting(db, 'controller_handover_to');
    deleteSetting(db, 'controller_handover_since');
    setHandoverFreeze(db, null);
    recordAudit({
      db,
      action: 'controller_handover_cancelled',
      entityType: 'instance',
      details: { to: freeze.to_name, to_instance_id: freeze.to_instance_id },
    });
  })();
}

const isCredential = (value) => typeof value === 'string' && /^cs1_[\w-]{20,}$/.test(value);

/**
 * POST /api/sync/handover-done, from the instance in row `member`: it has
 * taken over at `epoch`, with the change log at `base`, and hands this box
 * `credential` to follow it with. Returns `{ status, body }`.
 *
 * When that instance is the one this controller named, this box becomes its
 * member in one transaction: the mode, the controller's details from its row
 * in the list, the cursor at this box's own head (the new controller's log
 * carries on from there; if this box wrote anything after the member's last
 * copy, its database is copied aside, the changes are listed and it starts
 * over from everything the new controller has), and a member's guards. Then
 * it restarts as a member. The answer carries its backup schedule, which the
 * new controller takes on.
 *
 * When it is not (the handover was cancelled, or names someone else), the
 * caller has taken over all the same and this box is fenced.
 */
export function receiveHandoverDone(db, member, { epoch, base, credential }) {
  if (storedMode(db) === MEMBER) return { status: 200, body: heardAnswer(db) };
  const freeze = handoverFreeze(db);
  if (!freeze || freeze.to_instance_id !== member.instance_id) {
    return receiveFence(db, member, epoch);
  }
  if (!Number.isSafeInteger(epoch) || epoch <= syncStatus(db).epoch || !isCredential(credential)) {
    return {
      status: 400,
      body: { error: 'The handover notice is malformed.', code: 'bad_request' },
    };
  }
  if (epochTooFar(db, epoch)) return { status: 400, body: TOO_FAR };
  const peer = db
    .prepare('SELECT name, address, port, fingerprint FROM sync_instances WHERE id = ?')
    .get(member.id);
  const switchedOff = dhcpSwitchedOff(db);
  const head = syncHead(db);
  // Changes made here after the member's last copy never reached it. They
  // are few (this box refused every request meanwhile) and they are about to
  // be replaced, so the database is copied aside and they are listed, the
  // way a fenced controller keeps its own. With neither kept this box does
  // not give its data up: the new controller asks again.
  if (!(Number.isSafeInteger(base) && head === base)) {
    const kept = keepWhatWas(db, {
      since: Number.isSafeInteger(base) ? base : null,
      replacedBy: { instance_id: member.instance_id, name: member.name },
      epoch,
    });
    if (!kept.snapshot && !kept.report) {
      return {
        status: 503,
        body: {
          error:
            'This controller holds changes the new one never received and could not save ' +
            'them: neither a copy of its database nor the report could be written. The ' +
            'snapshots and sync directories under the data directory must be writable by ' +
            'the cidrella service user and have room for a copy of the database.',
          code: 'snapshot_failed',
        },
      };
    }
  }
  // The schedule as it was, for the new controller to take on: backups are
  // the controller's, and this box is about to stop taking them.
  const backup = Object.fromEntries(BACKUP_KEYS.map((key) => [key, readSetting(db, key)]));
  fs.mkdirSync(syncDirOf(db), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(syncDirOf(db), CREDENTIAL_FILE), `${credential}\n`, { mode: 0o600 });
  db.transaction(() => {
    // What a member starts with (sync/member.js): it takes no backups of
    // data it does not own, and its own DHCP switch decides nothing.
    upsertSetting(db, 'backup_schedule', 'off');
    upsertSetting(db, 'dhcp_enabled', 'false');
    setHandoverFreeze(db, null);
    writeSyncState(db, 'mode', MEMBER);
    // A member's audit row waits in its outbox for the new controller: written
    // here it would be one more change the new controller never saw.
    recordAudit({
      db,
      action: 'controller_handed_over',
      entityType: 'instance',
      entityId: member.id,
      source: 'sync',
      details: { to: member.name, to_instance_id: member.instance_id, epoch },
    });
    writeSyncState(
      db,
      'controller',
      JSON.stringify({
        instance_id: member.instance_id,
        name: peer.name,
        address: peer.address,
        port: peer.port,
        fingerprint: peer.fingerprint,
        epoch,
      }),
    );
    // The copy carries on from the new controller's log only when this box
    // holds exactly what it took over with: its own log, up to its own head.
    // Anything written here since is not in the new log, and its numbers
    // there mean other changes: start over.
    if (head === base) {
      writeSyncState(db, 'cursor', head);
      writeSyncState(db, 'copy_from', ownInstanceId(db));
    } else {
      db.prepare("DELETE FROM sync_state WHERE key IN ('cursor', 'copy_from')").run();
    }
    ensureSyncTriggers(db, MEMBER);
  })();
  // The mode has changed: whatever the steps below run into, the process
  // must not carry on as the controller it was.
  try {
    console.log(`[sync] handed the controller over to ${member.name} (epoch ${epoch})`);
    dhcpStateChanged(db);
  } finally {
    restart('Handed the controller over');
  }
  return {
    status: 200,
    body: { fenced: false, member: true, dhcp_switched_off: switchedOff, backup },
  };
}

// ─── What the API shows ───────────────────────────────────────────

/**
 * `{ handover, fenced }` as GET /api/instances reports it. `handover` is the
 * one this controller is frozen for, or on a member the one its copy of the
 * settings names. `fenced` says who replaced this box, which instance told
 * it so, and whether a divergence report was written.
 */
export function promotionView(db) {
  const fenced = fencedState(db);
  let handover = null;
  if (storedMode(db) === CONTROLLER) handover = handoverView(handoverFreeze(db));
  else if (!fenced) {
    const to = readSetting(db, 'controller_handover_to');
    if (to) {
      handover = {
        to_instance_id: to,
        to_name: nameOf(db, to),
        since: readSetting(db, 'controller_handover_since'),
      };
    }
  }
  return {
    handover,
    fenced: fenced && {
      by_name: fenced.by_name ?? null,
      // The instance whose request said so: `by_name` is only what it named.
      told_by: fenced.told_by ?? null,
      epoch: fenced.epoch,
      since: fenced.since,
      report: divergenceReportPath(db) !== null,
    },
  };
}

/**
 * Before a member's data is replaced by another controller's, a copy of its
 * database is kept. A controller that was replaced has the one from when it
 * was fenced, which is what it held as the controller; when that is missing,
 * and on any other member, one is taken now. Throws when none can be made.
 */
export function ensurePreDemotionSnapshot(db) {
  const kept = fencedState(db)?.snapshot;
  if (kept && fs.existsSync(path.join(snapshotDirOf(db), kept))) return;
  savePreDemotionSnapshot(db);
}

/**
 * Whether nobody takes scheduled backups: this is the controller of more
 * than one instance and its schedule is off. A member that took over had it
 * switched off at its join, and only a handover brings the old controller's
 * along.
 */
export function backupsOff(db) {
  if (storedMode(db) !== CONTROLLER) return false;
  const schedule = settingValue('backup_schedule', readSetting(db, 'backup_schedule'), DEFAULTS);
  const { n } = db.prepare('SELECT count(*) AS n FROM sync_instances').get();
  return schedule === 'off' && n > 1;
}
