/**
 * File-based backend configuration written as one transaction: snapshot the
 * backend's config files, run the update, validate with the backend's own
 * checker when something changed, and put every file back if the update or
 * the check throws. dnsmasq (`dnsmasq --test`) and Kea (`kea-dhcp4 -t`)
 * both render their configuration to files this way.
 */
import fs from 'fs';
import path from 'path';

export { atomicWrite } from '../../utils/atomic-write.js';

function collectFiles(target, files) {
  if (!fs.existsSync(target)) return files;
  const stat = fs.lstatSync(target);
  if (stat.isFile()) {
    files.set(target, { content: fs.readFileSync(target), mode: stat.mode });
    return files;
  }
  if (!stat.isDirectory()) return files;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isFile() || entry.isDirectory()) collectFiles(path.join(target, entry.name), files);
  }
  return files;
}

/**
 * A transaction over the files and directories `targets()` names, checked
 * by `validate()` (which throws to refuse). The result is
 * `withValidatedUpdate(update)`: `update` returns a boolean or an object
 * with `changed`; validation runs only when it reports a change. A nested
 * call joins the outer one, which owns the snapshot, the single validation
 * and the rollback.
 */
export function createValidatedFiles({ targets, validate }) {
  let depth = 0;

  const snapshot = () => {
    const files = new Map();
    for (const target of targets()) collectFiles(target, files);
    return files;
  };

  const restore = (saved) => {
    for (const filePath of snapshot().keys()) {
      if (!saved.has(filePath)) fs.unlinkSync(filePath);
    }
    for (const [filePath, file] of saved) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.rollback.${process.pid}`;
      fs.writeFileSync(tmpPath, file.content);
      fs.chmodSync(tmpPath, file.mode);
      fs.renameSync(tmpPath, filePath);
    }
  };

  return function withValidatedUpdate(update) {
    if (depth > 0) return update();
    const saved = snapshot();
    depth++;
    try {
      const result = update();
      const changed = typeof result === 'boolean' ? result : Boolean(result?.changed);
      if (changed) validate();
      return result;
    } catch (err) {
      restore(saved);
      throw err;
    } finally {
      depth--;
    }
  };
}
