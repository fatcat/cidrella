/**
 * The DNS proxy's database while it runs inside the web app: its own
 * read-only connection (dns-proxy/db.js) on the web app's database file,
 * opened on first use and opened again if that file changes.
 */
import { getDb } from '../db/init.js';
import { DEFAULTS } from '../config/defaults.js';
import { proxyLog } from '../dns-proxy/log.js';
import {
  openProxyDb,
  proxyDb,
  proxyDbFile,
  setSettingDefaults,
  setting,
  cachedSetting,
} from '../dns-proxy/db.js';

setSettingDefaults(DEFAULTS);

/** The proxy's connection, or null while the web app has no database. */
export function inlineProxyDb() {
  let file;
  try {
    file = getDb().name;
  } catch {
    return null;
  }
  if (proxyDb() && proxyDbFile() === file) return proxyDb();
  try {
    return openProxyDb(file);
  } catch (err) {
    proxyLog('warn', 'Could not open the database read-only', { file, error: err.message });
    return null;
  }
}

/** What the proxy and the forwarder read settings with. */
export const proxySettings = {
  setting: (key) => {
    inlineProxyDb();
    return setting(key);
  },
  cachedSetting: (key) => {
    inlineProxyDb();
    return cachedSetting(key);
  },
};
