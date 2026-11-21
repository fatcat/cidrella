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
import { controllerOf, instanceMode, isMember, memberRefusal } from '../sync/mode.js';
import { memberSyncStatus } from '../sync/member.js';
import { clearHandover, dhcpState, dhcpStateChanged } from '../sync/dhcp-active.js';
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
  listInstances,
  ownInstanceId,
  ownInstanceName,
  removeMember,
} from '../models/sync-instance.js';

const router = Router();
router.use(requireRole('admin'));

const fingerprintOf = (db) => syncFingerprint(path.dirname(db.name));

// What only the controller does. A member says so, in the words of every
// other write it refuses.
function controllerOnly(req, res, next) {
  if (!isMember()) return next();
  res.status(409).json({ error: memberRefusal(), code: 'member_read_only' });
}

// GET /api/instances
router.get('/', (req, res) => {
  const db = getDb();
  const member = isMember();
  const self = ownInstanceId(db);
  const head = syncHead(db);
  const controller = controllerOf(db);
  const dhcp = dhcpState(db);
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
    instances: listInstances(db).map((row) => ({
      id: row.id,
      instance_id: row.instance_id,
      name: row.name,
      // A member knows where its controller is; the controller's own row does not say.
      address: member && row.is_controller ? controller.address : row.address,
      port: member && row.is_controller ? controller.port : row.port,
      is_controller: row.is_controller === 1,
      is_self: row.instance_id === self,
      serves_dns: row.serves_dns === 1,
      dns_addresses: JSON.parse(row.dns_addresses || '[]'),
      version: row.instance_id === self ? APP_VERSION : row.version,
      // What a controller heard from each member is its own knowledge.
      last_contact_at: member || row.is_controller ? null : row.last_contact_at,
      behind:
        member || row.is_controller || row.cursor === null ? null : Math.max(0, head - row.cursor),
      dhcp: dhcpRole(dhcp, row),
      // Only the controller moves DHCP.
      can_take_dhcp: !member && moveRefusal(db, row, dhcp) === null,
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
