/**
 * The password CIDRella and the Kea daemons share for the HTTP control API.
 * Generated on first use, readable only by the service account; Kea reads it
 * through `password-file`, CIDRella here.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { KEA_PASSWORD_FILE, KEA_SECRET_DIR } from './paths.js';

export function ensureKeaSecret({ dir = KEA_SECRET_DIR } = {}) {
  const file = path.join(dir, KEA_PASSWORD_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* not created yet */
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = crypto.randomBytes(24).toString('base64url');
  // flag 'wx': two processes creating it at once can't both win.
  try {
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: 'wx' });
    return secret;
  } catch (err) {
    if (err.code === 'EEXIST') return fs.readFileSync(file, 'utf8').trim();
    throw err;
  }
}

export function readKeaSecret({ dir = KEA_SECRET_DIR } = {}) {
  try {
    return fs.readFileSync(path.join(dir, KEA_PASSWORD_FILE), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
