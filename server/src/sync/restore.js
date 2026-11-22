/**
 * What a restore keeps of the running estate (docs/REDUNDANCY-PLAN.md,
 * section 7). A backup brings data back. Which instances share that data,
 * the epoch they follow and which of them serves DHCP are facts about the
 * estate as it runs today, and the box doing the restore is their owner: a
 * backup taken before a promotion or a DHCP move knows an estate that is
 * gone. So the restoring controller keeps its own:
 *
 *   in sync_state   its instance id and name, its epoch, the term its DHCP
 *                   server is ready at. Nothing of the backup's standing
 *                   (mode, the controller it followed, cursor, copy_from, fenced, a
 *                   handover freeze, epoch_base) comes back.
 *   in settings     which instance serves DHCP, the term, and a move that is
 *                   under way. A handover of the controller that the backup
 *                   was taken in the middle of is dropped.
 *   sync_instances  the rows as they are now, credential hashes included, so
 *                   every member's credential still opens the door.
 *
 * The restored database is a new dataset (sync/log.js), so each member takes
 * a snapshot and ends with the controller's data of record.
 *
 * Three steps, called from utils/backup.js: presentInstances reads the
 * running database, detachRestoredDatabase cleans the one being staged, and
 * keepPresentInstances writes what was read into the restored database at
 * its first boot, once migrations have given it the tables (a backup from
 * before instances has none).
 */
import { deleteSetting, readSetting, upsertSetting } from '../models/setting.js';
import { exportInstances, ownInstanceId, replaceInstances } from '../models/sync-instance.js';
import {
  dropSyncTriggers,
  forgetDataset,
  hasSyncState,
  readSyncState,
  syncStatus,
  writeSyncState,
} from './log.js';

// About the box the backup was taken on, as it stood then.
const BACKUP_STANDING = [
  'mode',
  'controller',
  'cursor',
  'copy_from',
  'fenced',
  'handover',
  'epoch_base',
];
// About this box, whatever is restored onto it.
const OWN_STATE = ['instance_name', 'dhcp_ready_term'];
const KEPT_SETTINGS = [
  'dhcp_active_instance',
  'dhcp_term',
  'dhcp_handover_from',
  'dhcp_handover_since',
];
const DROPPED_SETTINGS = ['controller_handover_to', 'controller_handover_since'];

/** What the running database says of the estate today, to park in the one restored over it. */
export function presentInstances(db) {
  return {
    state: {
      instance_id: ownInstanceId(db),
      epoch: syncStatus(db).epoch,
      ...Object.fromEntries(OWN_STATE.map((key) => [key, readSyncState(db, key)])),
    },
    settings: Object.fromEntries(KEPT_SETTINGS.map((key) => [key, readSetting(db, key)])),
    rows: exportInstances(db),
  };
}

/**
 * The staged database of a restore, before it is swapped in: a new dataset
 * at its next boot, and a controller's whatever the backup's box was. The
 * triggers go too: boot puts the right ones back (ensureSyncLog), and a
 * member's guards would refuse what the restore writes meanwhile.
 */
export function detachRestoredDatabase(staged) {
  dropSyncTriggers(staged);
  forgetDataset(staged);
  if (!hasSyncState(staged)) return;
  staged
    .prepare(`DELETE FROM sync_state WHERE key IN (${BACKUP_STANDING.map(() => '?').join(', ')})`)
    .run(...BACKUP_STANDING);
}

/**
 * First boot after a restore: write what presentInstances read. Returns
 * `{ epoch, members }`. The caller holds the transaction.
 */
export function keepPresentInstances(db, kept) {
  const { state = {}, settings = {} } = kept;
  for (const key of ['instance_id', 'epoch', ...OWN_STATE]) {
    const value = state[key] ?? null;
    if (value === null) db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
    else writeSyncState(db, key, value);
  }
  for (const key of KEPT_SETTINGS) {
    const value = settings[key] ?? null;
    if (value === null) deleteSetting(db, key);
    else upsertSetting(db, key, value);
  }
  for (const key of DROPPED_SETTINGS) deleteSetting(db, key);
  const rows = Array.isArray(kept.rows) ? kept.rows : [];
  replaceInstances(db, rows);
  return {
    epoch: syncStatus(db).epoch,
    members: rows.filter((row) => !row.is_controller).length,
  };
}
