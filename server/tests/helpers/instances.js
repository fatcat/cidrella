/**
 * Several instances in one process, each with its own database AND its own
 * routes. The routes read the database with getDb(), which is one per
 * process, so a test that serves more than one instance mocks db/init.js with
 * `perInstanceDb` and serves each instance through `inInstance(db)`:
 *
 *   vi.mock('../../src/db/init.js', async (importOriginal) =>
 *     (await import('../helpers/instances.js')).perInstanceDb(await importOriginal()),
 *   );
 *   app.use(inInstance(box.db));
 *
 * Inside a request getDb() is then that instance's database; outside one it
 * is the process's own, as ever. Code that is handed a database (the member
 * side of the sync) needs none of this.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULTS } from '../../src/config/defaults.js';
import { upsertSettingWithConflict } from '../../src/models/setting.js';
import { settingValue } from '../../src/models/setting-value.js';

const current = new AsyncLocalStorage();

/** db/init.js with getDb, getSetting and setSetting answering for the instance being served. */
export function perInstanceDb(original) {
  const getDb = () => current.getStore() ?? original.getDb();
  return {
    ...original,
    getDb,
    getSetting: (key) =>
      settingValue(
        key,
        getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value,
        DEFAULTS,
      ),
    setSetting: (key, value) => upsertSettingWithConflict(getDb(), key, value),
  };
}

/** Express middleware: the rest of the request runs as the instance that owns `db`. */
export const inInstance = (db) => (req, res, next) => current.run(db, next);

/** Run `fn` as the instance that owns `db`, for code outside a request. */
export const asInstance = (db, fn) => current.run(db, fn);
