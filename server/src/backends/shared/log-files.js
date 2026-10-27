import fs from 'fs';
import path from 'path';

const DATED = /^\d{8}(?:\.gz)?$/; // logrotate's dateext copies, compressed or not
const NUMBERED = /^\d+$/; // Kea's own rotation: kea-dhcp4.log.1, .2, ...

/**
 * Delete the daemon log `file` and every rotated copy of it. Returns how many
 * files went. For a backend that no longer serves (contract.js clearLogs):
 * logrotate rotates on size, so a log nothing writes any more sits at the
 * size it stopped at, its last rotated copy never compressed, until deleted.
 */
export function removeLogFiles(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const rotated =
      (name.startsWith(`${base}-`) && DATED.test(name.slice(base.length + 1))) ||
      (name.startsWith(`${base}.`) && NUMBERED.test(name.slice(base.length + 1)));
    if (name !== base && !rotated) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed++;
    } catch (err) {
      console.warn(`Could not remove ${name}:`, err.message);
    }
  }
  return removed;
}
