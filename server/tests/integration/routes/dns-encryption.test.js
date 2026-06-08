import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, regenerateConfigs: vi.fn(), regenerateDnsmasqConf: vi.fn(), restartDnsmasq: vi.fn(), dnsmasqSupportsDnssec: vi.fn(() => true) };
});
vi.mock('../../../src/utils/timesync.js', () => ({
  getNtpStatus: vi.fn(() => ({ available: true, ntpEnabled: true, synchronized: true })),
  ensureNtpEnabled: vi.fn(), armDnssecTimecheckWhenSynced: vi.fn(),
}));
vi.mock('../../../src/utils/encrypted-forwarder.js', () => ({
  applyEncryptedForwarder: vi.fn(),
  getEncryptedForwarderStatus: vi.fn(() => ({ mode: 'off', running: false, upstreams: [], recentErrors: 0, lastError: null })),
}));

const { default: dnsRouter } = await import('../../../src/routes/dns.js');
const { applyEncryptedForwarder } = await import('../../../src/utils/encrypted-forwarder.js');
const { default: request } = await import('supertest');

let tmpDir, app;
const CF = { label: 'Cloudflare', addresses: ['1.1.1.1', '1.0.0.1'], hostname: 'cloudflare-dns.com', doh_url: 'https://cloudflare-dns.com/dns-query' };

beforeAll(async () => { const s = await setupTestDb(); tmpDir = s.tmpDir; app = createTestApp(dnsRouter, '/api/dns'); });
afterAll(() => cleanupTestDb(tmpDir));
beforeEach(() => vi.mocked(applyEncryptedForwarder).mockClear());

describe('GET /api/dns/encryption', () => {
  it('returns mode, upstreams, the preset catalog, and status', async () => {
    const res = await request(app).get('/api/dns/encryption');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mode');
    expect(Array.isArray(res.body.providers)).toBe(true);
    expect(res.body.providers.some(p => p.id === 'cloudflare')).toBe(true);
    // Quad9 preset must be the UNFILTERED tier, not 9.9.9.9
    const q9 = res.body.providers.find(p => p.id === 'quad9');
    expect(q9.addresses).toContain('9.9.9.10');
    expect(q9.addresses).not.toContain('9.9.9.9');
  });
});

describe('PUT /api/dns/encryption', () => {
  it('rejects a bad mode', async () => {
    expect((await request(app).put('/api/dns/encryption').send({ mode: 'quic' })).status).toBe(400);
  });

  it('rejects tls/https with no upstreams', async () => {
    expect((await request(app).put('/api/dns/encryption').send({ mode: 'tls', upstreams: [] })).status).toBe(400);
  });

  it('rejects an upstream with a non-https DoH URL', async () => {
    const bad = { ...CF, doh_url: 'http://insecure/dns-query' };
    expect((await request(app).put('/api/dns/encryption').send({ mode: 'https', upstreams: [bad] })).status).toBe(400);
  });

  it('enables TLS, persists, and (re)starts the stub', async () => {
    const res = await request(app).put('/api/dns/encryption').send({ mode: 'tls', upstreams: [CF] });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('tls');
    expect(applyEncryptedForwarder).toHaveBeenCalled();
    expect((await request(app).get('/api/dns/encryption')).body.mode).toBe('tls');
  });

  it('disables (off) without requiring upstreams', async () => {
    const res = await request(app).put('/api/dns/encryption').send({ mode: 'off' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/dns/encryption')).body.mode).toBe('off');
  });
});
