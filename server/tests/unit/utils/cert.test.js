import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  RENEW_BEFORE_DAYS,
  buildSanList,
  certDaysLeft,
  certHasSan,
  certNeedsRenewal,
  certSummary,
  isSelfGeneratedCert,
  ensureCerts,
  renewCertIfDue,
} from '../../../src/utils/cert.js';

const IFACES = {
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  eth0: [{ family: 'IPv4', address: '10.0.3.250', internal: false }],
  eth1: [
    { family: 'IPv4', address: '192.168.0.250', internal: false },
    { family: 'IPv6', address: 'fe80::1', internal: false },
  ],
};

describe('buildSanList', () => {
  it('covers localhost and the loopback address even with no interfaces', () => {
    const san = buildSanList({});
    expect(san).toContain('DNS:localhost');
    expect(san).toContain('IP:127.0.0.1');
  });

  it('includes every non-internal IPv4 address', () => {
    const san = buildSanList({ interfaces: IFACES });
    expect(san).toContain('IP:10.0.3.250');
    expect(san).toContain('IP:192.168.0.250');
  });

  it('skips IPv6 and internal addresses', () => {
    const san = buildSanList({ interfaces: IFACES });
    expect(san).not.toContain('fe80::1');
    // 127.0.0.1 is present as an explicit entry, not because lo was walked.
    expect(san.match(/IP:127\.0\.0\.1/g)).toHaveLength(1);
  });

  it('carries the short hostname and the FQDN, which is what gets typed', () => {
    const san = buildSanList({ hostname: 'testerella', fqdn: 'testerella.the-mcnultys.org' });
    expect(san).toContain('DNS:testerella');
    expect(san).toContain('DNS:testerella.the-mcnultys.org');
  });

  it('drops a name that would corrupt the SAN list', () => {
    const san = buildSanList({ hostname: 'evil,DNS:attacker.example' });
    expect(san).not.toContain('attacker.example');
  });

  it('does not repeat a name that is already covered', () => {
    const san = buildSanList({ hostname: 'cidrella' });
    expect(san.match(/DNS:cidrella/g)).toHaveLength(1);
  });
});

describe('ensureCerts', () => {
  let dir;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-cert-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('generates a certificate that carries a subjectAltName', () => {
    const { certPath } = ensureCerts(dir);
    expect(fs.existsSync(certPath)).toBe(true);
    expect(certHasSan(certPath)).toBe(true);
  });

  it('leaves a good certificate alone on the next boot', () => {
    const { certPath } = ensureCerts(dir);
    const before = fs.readFileSync(certPath, 'utf8');
    ensureCerts(dir);
    expect(fs.readFileSync(certPath, 'utf8')).toBe(before);
  });

  // The upgrade path that matters: pre-0.4.16 installs hold a CN-only cert
  // that browsers reject by name, so it has to be replaced, not reused.
  it('replaces a legacy certificate that has no subjectAltName', () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-legacy-'));
    const certsDir = path.join(legacyDir, 'certs');
    fs.mkdirSync(certsDir, { recursive: true });
    const keyPath = path.join(certsDir, 'server.key');
    const certPath = path.join(certsDir, 'server.crt');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '365',
        '-nodes',
        '-subj',
        '/CN=cidrella/O=CIDRella/C=US',
      ],
      { stdio: 'pipe' },
    );
    expect(certHasSan(certPath)).toBe(false);

    ensureCerts(legacyDir);
    expect(certHasSan(certPath)).toBe(true);
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });

  // The operator's own certificate is off limits. Overwriting it would destroy
  // the private key too, which an upgrade has no business doing.
  it('never replaces an operator certificate, even one with no subjectAltName', () => {
    const ownDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-own-'));
    const certsDir = path.join(ownDir, 'certs');
    fs.mkdirSync(certsDir, { recursive: true });
    const keyPath = path.join(certsDir, 'server.key');
    const certPath = path.join(certsDir, 'server.crt');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '365',
        '-nodes',
        '-subj',
        '/CN=nas.example.internal/O=Example Corp/C=GB',
      ],
      { stdio: 'pipe' },
    );
    expect(certHasSan(certPath)).toBe(false);
    const certBefore = fs.readFileSync(certPath, 'utf8');
    const keyBefore = fs.readFileSync(keyPath, 'utf8');

    ensureCerts(ownDir);

    expect(fs.readFileSync(certPath, 'utf8')).toBe(certBefore);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(keyBefore);
    fs.rmSync(ownDir, { recursive: true, force: true });
  });

  it("recognizes its own certificate and not the operator's", () => {
    const { certPath } = ensureCerts(dir);
    expect(isSelfGeneratedCert(certPath)).toBe(true);
  });
});

// CERT-EXPIRY-01: a generated certificate lasts a year and used to be left to run out.
describe('renewing a generated certificate', () => {
  let dir;
  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-cert-renew-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A certificate with the given subject and lifetime, at the paths ensureCerts uses.
  function writeCert(subject, days) {
    const certs = path.join(dir, 'certs');
    fs.mkdirSync(certs, { recursive: true });
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        path.join(certs, 'server.key'),
        '-out',
        path.join(certs, 'server.crt'),
        '-days',
        String(days),
        '-nodes',
        '-subj',
        subject,
        '-addext',
        'subjectAltName=DNS:cidrella',
      ],
      { stdio: 'pipe' },
    );
    return path.join(certs, 'server.crt');
  }

  it('leaves a fresh one alone, and counts its days', () => {
    const { certPath } = ensureCerts(dir);
    expect(certDaysLeft(certPath)).toBeGreaterThan(360);
    expect(certNeedsRenewal(certPath)).toBe(false);
    expect(renewCertIfDue()).toBeNull();
    // Due once the clock is inside the window.
    const later = Date.now() + (365 - RENEW_BEFORE_DAYS + 1) * DAY;
    expect(certNeedsRenewal(certPath, later)).toBe(true);
  });

  it('replaces one near its end at boot', () => {
    const certPath = writeCert('/CN=cidrella/O=CIDRella/C=US', RENEW_BEFORE_DAYS - 1);
    const before = certSummary(certPath).sha256;
    ensureCerts(dir);
    expect(certSummary(certPath).sha256).not.toBe(before);
    expect(certDaysLeft(certPath)).toBeGreaterThan(360);
    expect(certHasSan(certPath)).toBe(true);
  });

  it('replaces one that runs out while the appliance is up, and says what changed', () => {
    const { certPath } = ensureCerts(dir);
    const before = certSummary(certPath).sha256;
    const renewed = renewCertIfDue(Date.now() + 400 * DAY);
    expect(renewed.before.sha256).toBe(before);
    expect(renewed.after.sha256).toBe(certSummary(certPath).sha256);
    expect(renewed.after.sha256).not.toBe(before);
  });

  it("never renews an operator's certificate, however close its end", () => {
    const certPath = writeCert('/CN=ipam.example.com/O=Example Corp/C=US', 5);
    const before = certSummary(certPath).sha256;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ensureCerts(dir);
    expect(renewCertIfDue()).toBeNull();
    expect(renewCertIfDue(Date.now() + 30 * DAY)).toBeNull();
    expect(certSummary(certPath).sha256).toBe(before);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ends in'));
    warn.mockRestore();
  });
});
