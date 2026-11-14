/**
 * Is the code a long-running process (the DNS proxy, the privileged helper)
 * came from gone? True after a rollback to a release without that process.
 *
 * The install is a symlink onto one of two slots, and Node resolves
 * process.argv[1] against the physical working directory, so the entry reads
 * /opt/cidrella-b/... however the process was started. A rollback leaves that
 * slot in place, so the question goes through the symlink, the same path the
 * unit's ConditionPathExists names. Anywhere else (Docker, development) the
 * entry itself is what to watch.
 */
import fs from 'fs';
import path from 'path';

const INSTALL_DIR = '/opt/cidrella';

// The exit status for it. The units' RestartPreventExitStatus and
// SuccessExitStatus name it: systemd does not check ConditionPathExists on an
// automatic restart, and exit 0 means the web app wants the process back.
export const CODE_GONE_EXIT = 64;

export function codeGone(entry, installDir = INSTALL_DIR) {
  const home = [installDir, `${installDir}-a`, `${installDir}-b`].find((dir) =>
    entry.startsWith(`${dir}/`),
  );
  const watched = home ? path.join(installDir, path.relative(home, entry)) : entry;
  return !fs.existsSync(watched);
}
