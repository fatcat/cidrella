import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { X509Certificate } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SYNC_SERVER_NAME,
  ensureSyncIdentity,
  fingerprintOfCert,
  syncFingerprint,
  syncSecureContext,
} from '../../../src/sync/identity.js';

let dataDir;
let identity;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-sync-identity-'));
  identity = ensureSyncIdentity(dataDir);
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('ensureSyncIdentity', () => {
  it('puts a key and a certificate under <dataDir>/sync', () => {
    expect(identity.keyPath).toBe(path.join(dataDir, 'sync', 'identity.key'));
    expect(identity.certPath).toBe(path.join(dataDir, 'sync', 'identity.crt'));
    expect(fs.existsSync(identity.keyPath)).toBe(true);
    expect(fs.existsSync(identity.certPath)).toBe(true);
    expect(fs.readdirSync(path.join(dataDir, 'sync')).sort()).toEqual([
      'identity.crt',
      'identity.key',
    ]);
  });

  it('keeps the key readable by its owner alone', () => {
    expect(fs.statSync(identity.keyPath).mode & 0o777).toBe(0o600);
  });

  it('makes a self-signed certificate named for sync, good for about 20 years', () => {
    const cert = new X509Certificate(fs.readFileSync(identity.certPath));
    expect(cert.subject).toContain(`CN=${SYNC_SERVER_NAME}`);
    expect(cert.subject).toBe(cert.issuer);
    const years = (cert.validToDate.getTime() - Date.now()) / (365.25 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThan(19.9);
    expect(years).toBeLessThan(20.1);
  });

  it('never replaces an identity that exists', () => {
    const key = fs.readFileSync(identity.keyPath);
    const cert = fs.readFileSync(identity.certPath);
    const again = ensureSyncIdentity(dataDir);
    expect(again).toEqual(identity);
    expect(fs.readFileSync(identity.keyPath).equals(key)).toBe(true);
    expect(fs.readFileSync(identity.certPath).equals(cert)).toBe(true);
  });

  it('gives each data dir its own identity', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-sync-identity-'));
    try {
      expect(ensureSyncIdentity(other).fingerprint).not.toBe(identity.fingerprint);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('fingerprints', () => {
  it('is 64 lowercase hex characters with no colons', () => {
    expect(identity.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(syncFingerprint(dataDir)).toBe(identity.fingerprint);
  });

  it('reads the same fingerprint from PEM and from DER', () => {
    const pem = fs.readFileSync(identity.certPath);
    const der = new X509Certificate(pem).raw;
    expect(fingerprintOfCert(pem)).toBe(identity.fingerprint);
    expect(fingerprintOfCert(pem.toString())).toBe(identity.fingerprint);
    expect(fingerprintOfCert(der)).toBe(identity.fingerprint);
  });

  it('throws on something that is not a certificate', () => {
    expect(() => fingerprintOfCert('not a certificate')).toThrow();
  });
});

describe('syncSecureContext', () => {
  it('builds one context and keeps it', () => {
    const context = syncSecureContext(dataDir);
    expect(context).toBeTruthy();
    expect(syncSecureContext(dataDir)).toBe(context);
  });

  it('is null for a data dir with no identity', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-sync-identity-'));
    try {
      expect(syncSecureContext(empty)).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
