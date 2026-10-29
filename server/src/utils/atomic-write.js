/**
 * A file replaced in one rename, so a reader never sees it half written.
 * Backend configs (backends/shared/validated-files.js re-exports it) and the
 * DNS proxy's saved config use it.
 */
import fs from 'fs';
import path from 'path';

// The temp file sits beside its target, often in a directory a backend
// watches (dnsmasq's hostsdir and dhcp-hostsdir load every file but names
// that start with '.' or end in '~'), so a plain `<file>.tmp.<pid>` was read
// while half written (DNSMASQ-01). The leading dot keeps it unread.
function atomicWriteTempPath(filePath) {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp.${process.pid}`);
}

/** Replace `filePath` with `content` in one rename. */
export function atomicWrite(filePath, content, { mode } = {}) {
  const tmpPath = atomicWriteTempPath(filePath);
  fs.writeFileSync(tmpPath, content, mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode });
  fs.renameSync(tmpPath, filePath);
}
