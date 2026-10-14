/**
 * A shared secret between CIDRella and a daemon it controls over HTTP (Kea's
 * control API password, PowerDNS's API key). Generated on first use as one
 * line in `dir/file`, readable only by the service account.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export function ensureSecret(dir, file) {
  const target = path.join(dir, file);
  try {
    const existing = fs.readFileSync(target, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* not created yet */
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = crypto.randomBytes(24).toString('base64url');
  // flag 'wx': two processes creating it at once can't both win.
  try {
    fs.writeFileSync(target, `${secret}\n`, { mode: 0o600, flag: 'wx' });
    return secret;
  } catch (err) {
    if (err.code === 'EEXIST') return fs.readFileSync(target, 'utf8').trim();
    throw err;
  }
}

export function readSecret(dir, file) {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
