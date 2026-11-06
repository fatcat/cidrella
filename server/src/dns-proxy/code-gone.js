/**
 * Is the code this proxy process came from gone? True after a rollback to a
 * release without a separate proxy.
 *
 * The install is a symlink onto one of two slots, and Node resolves
 * process.argv[1] against the physical working directory, so the entry reads
 * /opt/cidrella-b/... however the proxy was started. A rollback leaves that
 * slot in place, so the question goes through the symlink, the same path the
 * unit's ConditionPathExists names. Anywhere else (Docker, development) the
 * entry itself is what to watch.
 */
import fs from 'fs';
import path from 'path';

const INSTALL_DIR = '/opt/cidrella';

export function proxyCodeGone(entry, installDir = INSTALL_DIR) {
  const home = [installDir, `${installDir}-a`, `${installDir}-b`].find((dir) =>
    entry.startsWith(`${dir}/`),
  );
  const watched = home ? path.join(installDir, path.relative(home, entry)) : entry;
  return !fs.existsSync(watched);
}
