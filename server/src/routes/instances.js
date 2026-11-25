/**
 * /api/instances: the instances that share this data of record, as an admin
 * sees and manages them (docs/REDUNDANCY-PLAN.md, section 8).
 */
import { Router } from 'express';
import path from 'path';
import { getDb } from '../db/init.js';
import { requireRole } from '../auth/roles.js';
import { recordAudit } from '../services/audit.js';
import { currentActor } from '../utils/request-actor.js';
import { APP_VERSION } from '../utils/version.js';
import { queueRegen } from '../utils/after-commit.js';
import { syncFingerprint } from '../sync/identity.js';
import { syncHead } from '../sync/log.js';
import { restoreCarryoverFailed } from '../sync/restore.js';
import { controllerOf, instanceMode, isMember, writeRefusal } from '../sync/mode.js';
import { joinController, JoinError, memberSyncStatus } from '../sync/member.js';
import {
  backupsOff,
  cancelHandover,
  divergenceReportPath,
  ensurePreDemotionSnapshot,
  promoteRefusal,
  promoteSelf,
  PromotionError,
  promotionRestart,
  promotionView,
  startHandover,
} from '../services/controller-promotion.js';
import { clearHandover, dhcpState, dhcpStateChanged } from '../sync/dhcp-active.js';
import { takeoverNotice } from '../sync/promotion-state.js';
import {
  DhcpMoveError,
  dhcpRole,
  dhcpView,
  forceDhcpStart,
  moveDhcp,
  moveRefusal,
} from '../services/dhcp-move.js';
import {
  createJoinToken,
  dnsInstances,
  listInstances,
  ownInstanceId,
  ownInstanceName,
  removeMember,
  reportedServiceStates,
} from '../models/sync-instance.js';
import { heardInstanceStates, ownServiceStates } from '../services/instance-services.js';
import { MAX_SERVED_INSTANCES, servedInstances } from '../utils/instance-dns.js';

const router = Router();
router.use(requireRole('admin'));

const fingerprintOf = (db) => syncFingerprint(path.dirname(db.name));

// What only a controller that takes changes does. A member, a controller
// that was replaced and one frozen for a handover each say so, in the words
// of every other write they refuse (sync/write-gate.js).
function controllerOnly(req, res, next) {
  const refusal = writeRefusal();
  if (!refusal) return next();
  res.status(409).json(refusal);
}

// What a row's DNS and DHCP servers are doing ({ dns, dhcp }, see
// services/instance-services.js): this box's own, read now. On the
// controller, what a member told it in its last sync, while it is still in
// contact. On a member, what the controller last vouched for, while the member
// is in touch with it. Nothing for the rest.
function serviceStatesOf(row, { self, member, own, heard }) {
  if (row.instance_id === self) return own;
  if (member) return heard?.[row.instance_id] ?? null;
  return row.is_controller ? null : reportedServiceStates(row);
}

// The row of the controller this box took over from, while the word owed to
// it is still pending and nothing has been heard from it since the takeover.
function silentSinceTakeover(row, notice) {
  if (!notice || row.instance_id !== notice.to?.instance_id) return false;
  return !(Date.parse(row.last_contact_at || '') > Date.parse(notice.since));
}

function dnsHandedOut(db) {
  const instances = dnsInstances(db);
  const served = servedInstances(instances);
  return {
    limit: MAX_SERVED_INSTANCES,
    served: instances.filter((i) => served.has(i)).map((i) => i.name),
    left_out: instances.filter((i) => !served.has(i)).map((i) => i.name),
  };
}

// GET /api/instances
router.get('/', async (req, res) => {
  const own = await ownServiceStates().catch(() => null);
  const db = getDb();
  const member = isMember();
  const heard = member ? heardInstanceStates(db) : null;
  const self = ownInstanceId(db);
  const head = syncHead(db);
  const controller = controllerOf(db);
  const dhcp = dhcpState(db);
  const notice = takeoverNotice(db);
  res.json({
    mode: instanceMode(),
    self: {
      instance_id: self,
      name: ownInstanceName(db),
      fingerprint: fingerprintOf(db),
      version: APP_VERSION,
    },
    controller: controller && {
      instance_id: controller.instance_id,
      name: controller.name,
      address: controller.address,
      port: controller.port,
    },
    sync: memberSyncStatus(db),
    // Which instance serves DHCP, and a move that is not finished.
    dhcp: dhcpView(db, dhcp),
    // A handover of the controller that is not finished, and whether this
    // box was replaced as the controller.
    promotion: promotionView(db),
    // Nobody takes scheduled backups: the role changed hands and the
    // schedule did not come along.
    backups_off: backupsOff(db),
    // This boot followed a restore and could not write back the instance
    // list and the epoch: it talks to no other instance until a restart.
    restore_unfinished: restoreCarryoverFailed(),
    // Which DNS-serving instances DHCP clients are given (at most
    // MAX_SERVED_INSTANCES per family) and which answer DNS but are not.
    dns_handed_out: dnsHandedOut(db),
    instances: listInstances(db).map((row) => ({
      id: row.id,
      instance_id: row.instance_id,
      name: row.name,
      // A member knows where its controller is; the controller's own row does not say.
      // A box that was replaced follows nobody.
      address: member && row.is_controller && controller ? controller.address : row.address,
      port: member && row.is_controller && controller ? controller.port : row.port,
      is_controller: row.is_controller === 1,
      is_self: row.instance_id === self,
      serves_dns: row.serves_dns === 1,
      dns_addresses: JSON.parse(row.dns_addresses || '[]'),
      version: row.instance_id === self ? APP_VERSION : row.version,
      // What a controller heard from each member is its own knowledge.
      last_contact_at:
        member || row.is_controller || silentSinceTakeover(row, notice)
          ? null
          : row.last_contact_at,
      // The controller this box took over from, not heard from since: the
      // takeover stamped its row (takeControllerRow), which is no contact.
      silent_since_takeover: !member && silentSinceTakeover(row, notice),
      behind:
        member || row.is_controller || row.cursor === null ? null : Math.max(0, head - row.cursor),
      dhcp: dhcpRole(dhcp, row),
      dns_state: serviceStatesOf(row, { self, member, own, heard })?.dns ?? null,
      dhcp_state: serviceStatesOf(row, { self, member, own, heard })?.dhcp ?? null,
      // Only the controller moves DHCP.
      can_take_dhcp: !member && moveRefusal(db, row, dhcp) === null,
      // Only the controller hands itself over.
      can_promote: !member && promoteRefusal(db, row) === null,
    })),
  });
});

// POST /api/instances/join-token: a token a new box joins with.
router.post('/join-token', controllerOnly, (req, res) => {
  const db = getDb();
  const result = createJoinToken(db, { fingerprint: fingerprintOf(db), createdBy: currentActor() });
  recordAudit({
    action: 'instance_join_token_created',
    entityType: 'instance',
    details: { expires_at: result.expires_at },
  });
  res.status(201).json(result);
});

// A refused move answers its reason; anything else is the error handler's.
function sendMoveError(res, err) {
  if (!(err instanceof DhcpMoveError)) throw err;
  res.status(err.status).json({ error: err.message, code: err.code });
}

// POST /api/instances/dhcp/force { confirm: true }: start DHCP on the new
// instance without the final leases of the one that had it.
router.post('/dhcp/force', controllerOnly, async (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({
      error: 'Confirm that the instance that served DHCP is off.',
      code: 'confirm_required',
    });
  }
  try {
    res.json(await forceDhcpStart(getDb()));
  } catch (err) {
    sendMoveError(res, err);
  }
});

// POST /api/instances/:id/dhcp: move DHCP to this instance.
router.post('/:id/dhcp', controllerOnly, async (req, res) => {
  try {
    res.json(await moveDhcp(getDb(), Number(req.params.id)));
  } catch (err) {
    sendMoveError(res, err);
  }
});

// A refused promotion step answers its reason; anything else is the error handler's.
function sendPromotionError(res, err) {
  if (!(err instanceof PromotionError)) throw err;
  res.status(err.status).json({ error: err.message, code: err.code });
}

// POST /api/instances/promote/cancel: call off a handover of the controller.
router.post('/promote/cancel', (req, res) => {
  try {
    // Recorded by cancelHandover.
    cancelHandover(getDb());
    res.json({ handover: null });
  } catch (err) {
    sendPromotionError(res, err);
  }
});

// POST /api/instances/promote-self { confirm: true }: on a member, take over
// as the controller without the old one's help. It is dead or cut off. On a
// controller that was replaced, take the role back: the instance that took
// over is gone. Refused (`controller_reachable`) while any instance answers
// as a controller. Answers which instance DHCP is named on and whether it
// answered: `dhcp: { active_instance_id, name, reachable }`.
router.post('/promote-self', async (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({
      error: 'Confirm that the controller is off or cannot be reached.',
      code: 'confirm_required',
    });
  }
  try {
    // Recorded by promoteSelf, in the transaction that makes this box the controller.
    const { dhcp } = await promoteSelf(getDb());
    res.json({ restarting: true, dhcp });
  } catch (err) {
    sendPromotionError(res, err);
  }
});

// POST /api/instances/rejoin { address, port, token }: on a member, join
// another controller. A controller that was replaced joins the new one this
// way, and so does a member the new controller never heard of (it joined the
// old one after the new one's last sync, so its credential opens nothing
// there). Everything here is replaced by that controller's data; a copy of
// the database is kept first (ensurePreDemotionSnapshot).
let rejoining = false;
router.post('/rejoin', async (req, res) => {
  const db = getDb();
  if (!isMember(db)) {
    return res.status(409).json({
      error:
        'This instance is the controller. Hand the role to a member first: ' +
        'only a member joins another controller.',
      code: 'not_fenced',
    });
  }
  const { address, token } = req.body || {};
  const port = req.body?.port === undefined ? 443 : Number(req.body.port);
  if (typeof address !== 'string' || !address.trim() || address.length > 255) {
    return res.status(400).json({ error: 'Enter the controller’s address.', code: 'unreachable' });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'The port must be 1 to 65535.', code: 'unreachable' });
  }
  if (rejoining) {
    return res.status(400).json({ error: 'A join is already running.', code: 'join_running' });
  }
  rejoining = true;
  try {
    try {
      ensurePreDemotionSnapshot(db);
    } catch (err) {
      return res.status(400).json({
        error:
          `This database could not be copied aside before it is replaced: ${err.message}. ` +
          'Nothing has changed. The snapshots directory under the data directory must be ' +
          'writable by the cidrella service user and have room for a copy of the database.',
        code: 'snapshot_failed',
      });
    }
    const joined = await joinController(
      db,
      { address, port, token },
      { restart: () => promotionRestart('Joined the new controller') },
    );
    // This box is a member now, so the row waits for its controller.
    recordAudit({
      action: 'instance_rejoined_controller',
      entityType: 'instance',
      details: { controller: joined.controller.name, address: address.trim(), port },
    });
    res.json({ ...joined, restarting: true });
  } catch (err) {
    if (!(err instanceof JoinError)) throw err;
    res.status(400).json({ error: err.message, code: err.code });
  } finally {
    rejoining = false;
  }
});

// GET /api/instances/divergence-report: what this box held that the
// controller which replaced it never received, as a file.
router.get('/divergence-report', (req, res) => {
  // The newest one: an earlier fencing's report stays in DATA_DIR/sync.
  const file = divergenceReportPath(getDb());
  if (!file) {
    return res.status(404).json({ error: 'There is no divergence report on this instance.' });
  }
  res.download(file, 'cidrella-divergence-report.json');
});

// POST /api/instances/:id/promote: hand the controller over to this member.
router.post('/:id/promote', (req, res) => {
  try {
    // Recorded by startHandover, a refusal included.
    res.json({ handover: startHandover(getDb(), Number(req.params.id)) });
  } catch (err) {
    sendPromotionError(res, err);
  }
});

// DELETE /api/instances/:id: stop sending a member changes.
router.delete('/:id', controllerOnly, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const row = Number.isInteger(id)
    ? db.prepare('SELECT name, instance_id, address FROM sync_instances WHERE id = ?').get(id)
    : null;
  // Its leases are the leases: taking it off the list would leave DHCP to nobody.
  if (row && row.instance_id === dhcpState(db).active) {
    recordAudit({
      action: 'instance_remove_refused',
      entityType: 'instance',
      entityId: id,
      details: { name: row.name, instance_id: row.instance_id, code: 'dhcp_active' },
    });
    return res.status(409).json({
      error: `${row.name} serves DHCP. Move DHCP to another instance first, then remove it.`,
      code: 'dhcp_active',
    });
  }
  if (!row || !removeMember(db, id)) {
    return res.status(404).json({ error: 'No such member.' });
  }
  // It owed its last leases: nobody will send them now, so the new one starts.
  if (row.instance_id === dhcpState(db).handoverFrom) {
    clearHandover(db);
    dhcpStateChanged(db);
  }
  // Its address leaves the DNS servers DHCP hands out.
  queueRegen('regenerate_dhcp');
  recordAudit({
    action: 'instance_removed',
    entityType: 'instance',
    entityId: id,
    details: { name: row.name, instance_id: row.instance_id, address: row.address },
  });
  res.status(204).end();
});

export default router;
