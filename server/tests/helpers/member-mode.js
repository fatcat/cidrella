import { writeSyncState } from '../../src/sync/log.js';

/**
 * Make the database a member's: the mode and the controller it follows, as
 * pairing leaves them in sync_state. Returns the controller it was given.
 */
export function makeMember(db, { name = 'ctl-1' } = {}) {
  const controller = {
    instance_id: 'test-controller',
    name,
    address: '192.0.2.10',
    port: 443,
    fingerprint: 'ab'.repeat(32),
  };
  writeSyncState(db, 'controller', JSON.stringify(controller));
  writeSyncState(db, 'mode', 'member');
  return controller;
}

/** Back to a controller, which is what a database is without those rows. */
export function makeController(db) {
  db.prepare("DELETE FROM sync_state WHERE key IN ('mode', 'controller')").run();
}
