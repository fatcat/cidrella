/**
 * This instance's sync identity: a long-lived self-signed certificate that
 * other instances pin (docs/REDUNDANCY-PLAN.md, Trust and pairing).
 *
 * The web certificate cannot be pinned, an operator replaces it and CIDRella
 * renews its own. This one is made once and never renewed or replaced: its
 * fingerprint is what a join token carries and what every paired instance
 * checks. It is served on the web port, only to a client that asks for
 * SYNC_SERVER_NAME by SNI (utils/http-server.js).
 *
 * Every path comes from the dataDir argument, so nothing here freezes
 * DATA_DIR when the module loads.
 */
import { X509Certificate } from 'crypto';
import fs from 'fs';
import path from 'path';
import tls from 'tls';
import { writeSelfSignedCert } from '../utils/cert.js';

/** The SNI name a sync client asks for, and the certificate's CN. */
export const SYNC_SERVER_NAME = 'cidrella-sync';

// About 20 years. Nothing renews it, so it has to outlast the appliance.
const VALID_DAYS = 7300;

/** Where the identity's key and certificate are kept under `dataDir`. */
export function identityPaths(dataDir) {
  const dir = path.join(dataDir, 'sync');
  return {
    dir,
    keyPath: path.join(dir, 'identity.key'),
    certPath: path.join(dir, 'identity.crt'),
  };
}

/**
 * The SHA-256 fingerprint of a certificate, PEM (string or Buffer) or DER
 * (Buffer): 64 lowercase hex characters, no colons. Throws on anything that
 * is not a certificate.
 */
export function fingerprintOfCert(pemOrDer) {
  return new X509Certificate(pemOrDer).fingerprint256.replaceAll(':', '').toLowerCase();
}

/**
 * Make the identity if this data dir has none, and return
 * `{ keyPath, certPath, fingerprint }`. An existing identity is never touched.
 *
 * Key and certificate are generated beside their final names and renamed in,
 * certificate last, so a crash midway leaves no certificate and the next boot
 * starts over. A key without a certificate was never anyone's pin.
 */
export function ensureSyncIdentity(dataDir) {
  const { dir, keyPath, certPath } = identityPaths(dataDir);
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpKey = `${keyPath}.tmp`;
    const tmpCert = `${certPath}.tmp`;
    try {
      writeSelfSignedCert({
        keyPath: tmpKey,
        certPath: tmpCert,
        subject: `/CN=${SYNC_SERVER_NAME}/O=CIDRella`,
        days: VALID_DAYS,
        keyType: 'rsa:3072',
      });
      fs.chmodSync(tmpKey, 0o600);
      fs.renameSync(tmpKey, keyPath);
      fs.renameSync(tmpCert, certPath);
    } finally {
      fs.rmSync(tmpKey, { force: true });
      fs.rmSync(tmpCert, { force: true });
    }
    contexts.delete(dataDir);
    console.log('Sync identity certificate generated');
  }
  return { keyPath, certPath, fingerprint: syncFingerprint(dataDir) };
}

/** The identity certificate's fingerprint (see fingerprintOfCert). Throws if there is none. */
export function syncFingerprint(dataDir) {
  return fingerprintOfCert(fs.readFileSync(identityPaths(dataDir).certPath));
}

// One context per data dir. The identity never changes once made, so neither
// does its context.
const contexts = new Map();

/**
 * The tls.SecureContext that serves the identity, or null when this data dir
 * has none yet.
 */
export function syncSecureContext(dataDir) {
  const cached = contexts.get(dataDir);
  if (cached) return cached;
  const { keyPath, certPath } = identityPaths(dataDir);
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) return null;
  const context = tls.createSecureContext({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  });
  contexts.set(dataDir, context);
  return context;
}
