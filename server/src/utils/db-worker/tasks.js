// The tasks runDbTask (index.js) can run, each given a read-only connection.
import Database from 'better-sqlite3';
import { countEnabledBlocklistDomains, dropFeedDomains } from '../../models/blocklist-store.js';

export const TASKS = {
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
