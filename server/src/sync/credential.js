/**
 * The credential the controller issued this member, kept in a 0600 file in
 * DATA_DIR/sync/. A leaf, so everything that calls the controller can read it.
 */
import fs from 'fs';
import path from 'path';

export const CREDENTIAL_FILE = 'credential';

/** The data directory a database lives in: where its sync files are kept. */
export const syncDirOf = (db) => path.join(path.dirname(db.name), 'sync');

/** This member's credential, or null. */
export function readCredential(db) {
  try {
    return fs.readFileSync(path.join(syncDirOf(db), CREDENTIAL_FILE), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
