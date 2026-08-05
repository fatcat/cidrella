import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildSanList, certHasSan, ensureCerts } from '../../../src/utils/cert.js';

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
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
      '-days', '365', '-nodes', '-subj', '/CN=cidrella/O=CIDRella/C=US',
    ], { stdio: 'pipe' });
    expect(certHasSan(certPath)).toBe(false);

    ensureCerts(legacyDir);
    expect(certHasSan(certPath)).toBe(true);
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });
});
