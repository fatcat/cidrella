/**
 * The password CIDRella and the Kea daemons share for the HTTP control API.
 * Kea reads it through `password-file`, CIDRella here.
 */
import { ensureSecret, readSecret } from '../shared/secret.js';
import { KEA_PASSWORD_FILE, KEA_SECRET_DIR } from './paths.js';

export const ensureKeaSecret = ({ dir = KEA_SECRET_DIR } = {}) =>
  ensureSecret(dir, KEA_PASSWORD_FILE);

export const readKeaSecret = ({ dir = KEA_SECRET_DIR } = {}) => readSecret(dir, KEA_PASSWORD_FILE);
