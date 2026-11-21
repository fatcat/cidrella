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

// DELETE /api/instances/:id: stop sending a member changes.
router.delete('/:id', controllerOnly, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const row = Number.isInteger(id)
    ? db.prepare('SELECT name, instance_id, address FROM sync_instances WHERE id = ?').get(id)
    : null;
  if (!row || !removeMember(db, id)) {
    return res.status(404).json({ error: 'No such member.' });
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
