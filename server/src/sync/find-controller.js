/**
 * A member finding the controller to follow (docs/REDUNDANCY-PLAN.md,
 * section 7, Fencing). The controller can change: an admin promotes a member,
 * with the old controller's help or without it. Nobody tells the other
 * members, so each asks around.
 *
 * Every instance is in this member's copy of sync_instances with the address
 * the controller knew it by and the fingerprint of its sync certificate. The
 * member asks each `GET /api/sync/hello` over a connection pinned to that
 * fingerprint, with its own credential (the hashes are data of record, so
 * whichever instance took over knows this member), and follows the one that
 * says it is the controller at the highest epoch, when that epoch is no
 * lower than any this member has seen. Following is rewriting the pointer in
 * sync_state: the dataset, the cursor and the credential stay, and the next
 * request for changes goes to the new controller, which answers with what is
 * missing or, when this copy holds changes it never had, with everything.
 *
 * Two instances claiming the same epoch means two members were promoted at
 * once. Nothing here can settle that; the lowest instance_id is followed so
 * every member at least picks the same one.
 */
import { CONTROLLER, readSyncState, writeSyncState } from './log.js';
import { callInstance, jsonBody, knownEpoch } from './controller-call.js';
import { readCredential } from './credential.js';
import { controllerOf } from './mode.js';

const HELLO_TIMEOUT_MS = 5_000;

/**
 * Ask the instance at `peer` who it is. Resolves the peer with what it
 * answered (`mode`, `epoch`, `name`), or null when it did not answer as the
 * instance the list says it is. One attempt, a few seconds.
 */
export async function hello(db, peer, credential) {
  try {
    const response = await callInstance(db, peer, {
      path: '/api/sync/hello',
      credential,
      timeoutMs: HELLO_TIMEOUT_MS,
    });
    if (response.status !== 200) return null;
    const answer = jsonBody(response);
    const epoch = Number(answer.epoch);
    if (typeof answer.instance_id !== 'string' || !Number.isSafeInteger(epoch)) return null;
    // An instance is who the list says it is, or it is not asked again.
    if (peer.instance_id && answer.instance_id !== peer.instance_id) return null;
    return { ...peer, mode: answer.mode, epoch, name: String(answer.name || peer.name) };
  } catch {
    return null;
  }
}

/**
 * Ask every other instance who the controller is, and follow a new one when
 * there is one. Resolves the controller now followed when it changed, else
 * null. Never rejects.
 */
export async function findController(db) {
  const current = controllerOf(db);
  const credential = readCredential(db);
  const self = readSyncState(db, 'instance_id');
  if (!current || !credential) return null;
  const peers = db
    .prepare(
      `SELECT instance_id, name, address, port, fingerprint FROM sync_instances
       WHERE instance_id IS NOT ? AND instance_id IS NOT ?
         AND address IS NOT NULL AND fingerprint IS NOT NULL`,
    )
    .all(self, current.instance_id);
  const [standing, ...answers] = await Promise.all(
    [current, ...peers].map((peer) => hello(db, peer, credential)),
  );
  // The pointer may have moved while the answers came in.
  if (controllerOf(db)?.instance_id !== current.instance_id) return null;

  const known = knownEpoch(db);
  // The controller followed now holds unless another claims a higher epoch.
  // One that is gone, fenced or behind what this box has seen holds nothing.
  const holds = standing?.mode === CONTROLLER && standing.epoch >= known;
  const best = answers
    .filter((answer) => answer?.mode === CONTROLLER)
    .filter((answer) => (holds ? answer.epoch > standing.epoch : answer.epoch >= known))
    .sort((a, b) => b.epoch - a.epoch || a.instance_id.localeCompare(b.instance_id))[0];
  if (!best) return null;

  const followed = {
    instance_id: best.instance_id,
    name: best.name.slice(0, 255),
    address: best.address,
    port: best.port,
    fingerprint: best.fingerprint,
    epoch: best.epoch,
  };
  writeSyncState(db, 'controller', JSON.stringify(followed));
  console.log(
    `[sync] ${followed.name} is the controller now (epoch ${followed.epoch}), ` +
      `following it instead of ${current.name}`,
  );
  return followed;
}
