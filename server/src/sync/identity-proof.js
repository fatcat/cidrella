/**
 * An instance proving which one it is without a credential
 * (docs/REDUNDANCY-PLAN.md, section 7). A controller that was replaced holds
 * none: it issued them. It still has its sync identity, whose fingerprint is
 * in every instance's list, so it signs the fingerprint of the instance it
 * asks with that identity's key and sends the certificate along. The
 * instance asked checks the signature and looks the certificate up in its
 * list.
 *
 * The proof names the instance it is for, and travels only over a connection
 * pinned to that instance (utils/sync-client.js), so nobody else sees it and
 * it opens no other door. It is good for `GET /api/sync/hello` alone
 * (sync/require-member.js): it tells its bearer who the controller is, and
 * moves nothing.
 */
import crypto, { X509Certificate } from 'crypto';
import fs from 'fs';
import { fingerprintOfCert, identityPaths } from './identity.js';

export const IDENTITY_HEADER = 'x-cidrella-identity';
// A 3072-bit certificate and its signature, base64 twice over, is about 3 KB.
const MAX_PROOF_CHARS = 8192;

const signedText = (to) => Buffer.from(`cidrella-sync-identity\n${to}`);

/** The header value that proves the identity under `dataDir` to the instance with fingerprint `to`. */
export function identityProof(dataDir, to) {
  const { keyPath, certPath } = identityPaths(dataDir);
  const cert = fs.readFileSync(certPath, 'utf8');
  const sig = crypto.sign('sha256', signedText(to), fs.readFileSync(keyPath)).toString('base64');
  return Buffer.from(JSON.stringify({ cert, sig })).toString('base64');
}

/**
 * The fingerprint of the certificate a proof was made with, when it was made
 * for the instance with fingerprint `own`. Null for anything else.
 */
export function provenFingerprint(header, own) {
  if (typeof header !== 'string' || header.length > MAX_PROOF_CHARS) return null;
  try {
    const { cert, sig } = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const key = new X509Certificate(cert).publicKey;
    const good = crypto.verify('sha256', signedText(own), key, Buffer.from(sig, 'base64'));
    return good ? fingerprintOfCert(cert) : null;
  } catch {
    return null;
  }
}

/*
 * A call proof: the same signature over another text, for a request that
 * reads something of the instance asked, as a controller reading a member's
 * log. It names the instance it is for, what it is for and when it was made,
 * so it opens one kind of request on one instance for CALL_PROOF_MS, and is
 * never good as an identity proof (the texts differ in their first line).
 * Inside that window it can be sent again, but only over a connection pinned
 * to the instance it names, by whoever holds it already.
 */
export const CALL_PROOF_HEADER = 'x-cidrella-call-proof';
export const CALL_PROOF_MS = 60_000;

const callText = (to, purpose, at) => Buffer.from(`cidrella-sync-call\n${to}\n${purpose}\n${at}`);

/** The header value that proves the identity under `dataDir` to `to`, for `purpose`, now. */
export function callProof(dataDir, to, purpose, now = Date.now()) {
  const { keyPath, certPath } = identityPaths(dataDir);
  const cert = fs.readFileSync(certPath, 'utf8');
  const at = Math.floor(now);
  const sig = crypto
    .sign('sha256', callText(to, purpose, at), fs.readFileSync(keyPath))
    .toString('base64');
  return Buffer.from(JSON.stringify({ cert, sig, at })).toString('base64');
}

/**
 * The fingerprint of the certificate a call proof was made with, when it was
 * made for the instance with fingerprint `own`, for `purpose`, within
 * CALL_PROOF_MS of `now` either way. Null for anything else.
 */
export function provenCall(header, own, purpose, now = Date.now()) {
  if (typeof header !== 'string' || header.length > MAX_PROOF_CHARS) return null;
  try {
    const { cert, sig, at } = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    if (!Number.isSafeInteger(at) || Math.abs(now - at) > CALL_PROOF_MS) return null;
    if (typeof sig !== 'string') return null;
    const key = new X509Certificate(cert).publicKey;
    const good = crypto.verify(
      'sha256',
      callText(own, purpose, at),
      key,
      Buffer.from(sig, 'base64'),
    );
    return good ? fingerprintOfCert(cert) : null;
  } catch {
    return null;
  }
}
