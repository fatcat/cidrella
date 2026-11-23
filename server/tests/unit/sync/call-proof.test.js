/**
 * A call proof (sync/identity-proof.js): good for the instance, the purpose
 * and the minute it was made for, and for nothing else, the identity proof
 * of `hello` included.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureSyncIdentity } from '../../../src/sync/identity.js';
import {
  CALL_PROOF_MS,
  callProof,
  identityProof,
  provenCall,
  provenFingerprint,
} from '../../../src/sync/identity-proof.js';

const dirs = [];
let caller;
let asked;
let other;

beforeAll(() => {
  const identity = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-call-proof-'));
    dirs.push(dir);
    return { dir, ...ensureSyncIdentity(dir) };
  };
  caller = identity();
  asked = identity();
  other = identity();
});

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

describe('call proof', () => {
  it('proves the caller to the instance it names, for its purpose', () => {
    const proof = callProof(caller.dir, asked.fingerprint, 'logs', NOW);
    expect(provenCall(proof, asked.fingerprint, 'logs', NOW)).toBe(caller.fingerprint);
    expect(provenCall(proof, asked.fingerprint, 'logs', NOW + CALL_PROOF_MS)).toBe(
      caller.fingerprint,
    );
  });

  it('is good for nobody else', () => {
    const proof = callProof(caller.dir, asked.fingerprint, 'logs', NOW);
    expect(provenCall(proof, other.fingerprint, 'logs', NOW)).toBeNull();
  });

  it('is good for nothing else', () => {
    const proof = callProof(caller.dir, asked.fingerprint, 'logs', NOW);
    expect(provenCall(proof, asked.fingerprint, 'leases', NOW)).toBeNull();
    // Neither one stands in for the other.
    expect(provenFingerprint(proof, asked.fingerprint)).toBeNull();
    expect(
      provenCall(identityProof(caller.dir, asked.fingerprint), asked.fingerprint, 'logs', NOW),
    ).toBeNull();
  });

  it('goes stale a minute either side of when it was made', () => {
    const proof = callProof(caller.dir, asked.fingerprint, 'logs', NOW);
    expect(provenCall(proof, asked.fingerprint, 'logs', NOW + CALL_PROOF_MS + 1)).toBeNull();
    expect(provenCall(proof, asked.fingerprint, 'logs', NOW - CALL_PROOF_MS - 1)).toBeNull();
  });

  it('is refused when its time or certificate is not what was signed', () => {
    const proof = callProof(caller.dir, asked.fingerprint, 'logs', NOW);
    const parts = JSON.parse(Buffer.from(proof, 'base64').toString('utf8'));
    const forge = (changes) =>
      Buffer.from(JSON.stringify({ ...parts, ...changes })).toString('base64');
    expect(provenCall(forge({ at: NOW + 1 }), asked.fingerprint, 'logs', NOW)).toBeNull();
    // Another instance's certificate with this signature.
    const otherCert = fs.readFileSync(other.certPath, 'utf8');
    expect(provenCall(forge({ cert: otherCert }), asked.fingerprint, 'logs', NOW)).toBeNull();
    expect(provenCall('not a proof', asked.fingerprint, 'logs', NOW)).toBeNull();
    expect(provenCall(undefined, asked.fingerprint, 'logs', NOW)).toBeNull();
  });
});
