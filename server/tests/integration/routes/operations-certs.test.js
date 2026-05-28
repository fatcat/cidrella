import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const { default: request } = await import('supertest');

let tmpDir;
let app;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-test-'));
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'hosts.d'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'dhcp-hosts.d'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'dnsmasq', 'conf.d'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'certs'), { recursive: true });
  process.env.DATA_DIR = tmpDir;

  vi.resetModules();
  const { initDb } = await import('../../../src/db/init.js');
  await initDb(tmpDir);
  const { createTestApp } = await import('../../helpers/test-app.js');
  const { default: operationsRouter } = await import('../../../src/routes/operations.js');
  app = createTestApp(operationsRouter, '/api/operations');
});

afterAll(() => {
  if (tmpDir && tmpDir.includes('cidrella-test-')) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('certificate CSR flow', () => {
  it('rejects shell and OpenSSL subject injection-shaped CSR input', async () => {
    const cases = [
      { common_name: 'cidrella.test;touch /tmp/pwned' },
      { common_name: 'cidrella.test', san: ['good.test', 'bad.test\nDNS.99 = injected.test'] },
      { common_name: 'cidrella.test', organization: 'CIDRella/OU=injected' },
      { common_name: 'cidrella.test', country: 'USA' },
      { common_name: 'cidrella.test', key_algorithm: 'ecdsa', curve: 'badcurve' },
    ];

    for (const body of cases) {
      const res = await request(app)
        .post('/api/operations/certs/csr')
        .send({ key_size: 2048, ...body });
      expect(res.status, JSON.stringify({ body, response: res.body })).toBe(400);
    }
  });

  it('generates a CSR and accepts the signed certificate using the pending key', async () => {
    const csrRes = await request(app)
      .post('/api/operations/certs/csr')
      .send({
        common_name: 'cidrella.test',
        san: ['cidrella.test', 'cidrella', '10.0.0.8'],
        organization: 'CIDRella Test',
        country: 'US',
        key_size: 3072
      });

    expect(csrRes.status, JSON.stringify(csrRes.body)).toBe(201);
    expect(csrRes.body.csr).toContain('BEGIN CERTIFICATE REQUEST');
    expect(csrRes.body.key_algorithm).toBe('rsa');
    expect(csrRes.body.key_size).toBe(3072);

    const certsDir = path.join(tmpDir, 'certs');
    const csrPath = path.join(certsDir, 'pending-csr.csr');
    const keyPath = path.join(certsDir, 'pending-csr.key');
    const signedPath = path.join(certsDir, 'signed.crt');
    expect(fs.existsSync(csrPath)).toBe(true);
    expect(fs.existsSync(keyPath)).toBe(true);

    execFileSync('openssl', [
      'x509', '-req', '-in', csrPath, '-signkey', keyPath,
      '-out', signedPath, '-days', '30', '-sha256'
    ], { stdio: 'pipe', timeout: 10000 });

    const uploadRes = await request(app)
      .post('/api/operations/certs/upload')
      .send({ cert: fs.readFileSync(signedPath, 'utf-8') });

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.ok).toBe(true);
    expect(fs.existsSync(path.join(certsDir, 'server.crt'))).toBe(true);
    expect(fs.existsSync(path.join(certsDir, 'server.key'))).toBe(true);
    expect(fs.existsSync(keyPath)).toBe(false);
    expect(fs.existsSync(csrPath)).toBe(false);
  });

  it('generates an ECDSA CSR', async () => {
    const csrRes = await request(app)
      .post('/api/operations/certs/csr')
      .send({
        common_name: 'ecdsa-cidrella.test',
        san: ['ecdsa-cidrella.test'],
        key_algorithm: 'ecdsa',
        curve: 'prime256v1'
      });

    expect(csrRes.status, JSON.stringify(csrRes.body)).toBe(201);
    expect(csrRes.body.csr).toContain('BEGIN CERTIFICATE REQUEST');
    expect(csrRes.body.key_algorithm).toBe('ecdsa');
    expect(csrRes.body.curve).toBe('prime256v1');

    const keyPath = path.join(tmpDir, 'certs', 'pending-csr.key');
    const keyText = execFileSync('openssl', ['pkey', '-in', keyPath, '-text', '-noout'], {
      encoding: 'utf-8',
      timeout: 5000
    });
    expect(keyText).toContain('ASN1 OID: prime256v1');
  });
});
