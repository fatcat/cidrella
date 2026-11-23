// The tasks runDbTask (index.js) can run, each given a read-only connection.
import Database from 'better-sqlite3';
import { countEnabledBlocklistDomains, dropFeedDomains } from '../../models/blocklist-store.js';
import { exportChangesToFile } from '../../sync/changes.js';

export const TASKS = {
  // The whole data of record for a copy that is starting over: every row, so
  // it is read off the event loop (sync/changes.js). It goes to `file` a
  // piece at a time, never into memory whole; the route sends the file.
  syncExport(db, { dataset, since, file }) {
    return exportChangesToFile(db, { dataset, since }, file);
  },

  /**
   * Write the database a backup carries to `copyPath`.
   *
   * VACUUM INTO makes a compact, consistent copy, WAL included: the live
   * file keeps every page it ever grew to on its freelist (a blocklist
   * refresh stages a whole feed before sweeping it), and copying the file
   * carried those pages into every backup. The blocklist feeds are left out
   * too (dropFeedDomains). They are a cache of downloads, and the largest
   * table by far; the restart after a restore refreshes every enabled feed.
   */
  backupCopy(db, { copyPath }) {
    db.prepare('VACUUM INTO ?').run(copyPath);
    const copy = new Database(copyPath);
    try {
      dropFeedDomains(copy);
      copy.exec('VACUUM');
    } finally {
      copy.close();
    }
    return copyPath;
  },

  // The distinct domains the enabled categories block, for the stats card.
  blocklistDomainCount(db) {
    return countEnabledBlocklistDomains(db);
  },
};
