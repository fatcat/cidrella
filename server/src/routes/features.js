import { Router } from 'express';
import { featureReport } from '../backends/index.js';
import { ipv6Enabled } from '../utils/ipv6-support.js';
import { getDb } from '../db/init.js';
import { countMembers } from '../models/sync-instance.js';
import { controllerOf, handoverTarget, instanceMode, isFenced, isMember } from '../sync/mode.js';
import { memberSyncStatus } from '../sync/member.js';
import { servesDhcpHere } from '../sync/dhcp-active.js';
import { fencedState } from '../sync/promotion-state.js';

// GET /api/features: the switches the UI needs before it renders anything.
// Any signed-in user may read it; a viewer hides the same IPv6 affordances an
// admin does. `backendFeatures` lists every backend-dependent feature with
// whether the active backend supports it and why not (backends/features.js).
const router = Router();

// `instance` says what kind of instance this is (sync/mode.js): a member
// shows a read-only UI and names its controller. `serves_dhcp` is the rule
// in sync/dhcp-active.js. `fenced` is a controller that was replaced: it
// reports as a member with no controller, and `fenced_by` names who
// replaced it when it knows. `handover_to` names the member a
// controller is handing over to, while it refuses changes.
router.get('/', (req, res) => {
  const db = getDb();
  const controller = controllerOf(db);
  res.json({
    ipv6: ipv6Enabled(),
    backendFeatures: featureReport(),
    instance: {
      mode: instanceMode(),
      controller_name: controller?.name ?? null,
      members: isMember(db) ? 0 : countMembers(db),
      sync: memberSyncStatus(db),
      // Does this box answer DHCP: exactly one instance does.
      serves_dhcp: servesDhcpHere(db),
      fenced: isFenced(db),
      // Who took over, when this box knows.
      fenced_by: fencedState(db)?.by_name ?? null,
      handover_to: handoverTarget(db),
    },
  });
});

export default router;
