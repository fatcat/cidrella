import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

// Stub dnsmasq (no real config writes / exec) and force DNSSEC support on.
vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    regenerateConfigs: vi.fn(),
    regenerateDnsmasqConf: vi.fn(),
    restartDnsmasq: vi.fn(),
    dnsmasqSupportsDnssec: vi.fn(() => true),
  };
});

// Stub timesync so the route doesn't shell out to timedatectl.
vi.mock('../../../src/utils/timesync.js', () => ({
  getNtpStatus: vi.fn(() => ({ available: true, ntpEnabled: true, synchronized: false })),
  ensureNtpEnabled: vi.fn(() => true),
  armDnssecTimecheckWhenSynced: vi.fn(),
}));

const { default: dnsRouter } = await import('../../../src/routes/dns.js');
const { dnsmasqSupportsDnssec } = await import('../../../src/utils/dnsmasq.js');
const { ensureNtpEnabled, armDnssecTimecheckWhenSynced } = await import('../../../src/utils/timesync.js');
const { default: request } = await import('supertest');

let tmpDir;
let app;

beforeAll(async () => {
  const setup = await setupTestDb();
  tmpDir = setup.tmpDir;
  app = createTestApp(dnsRouter, '/api/dns');
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  vi.mocked(dnsmasqSupportsDnssec).mockReturnValue(true);
  vi.mocked(ensureNtpEnabled).mockClear();
  vi.mocked(armDnssecTimecheckWhenSynced).mockClear();
});

describe('GET /api/dns/dnssec', () => {
  it('returns enabled state, support flag, and NTP status', async () => {
    const res = await request(app).get('/api/dns/dnssec');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('enabled');
    expect(res.body).toHaveProperty('supported', true);
    expect(res.body).toHaveProperty('ntp');
    expect(res.body.ntp).toHaveProperty('synchronized');
  });
});

describe('PUT /api/dns/dnssec', () => {
  it('rejects a non-boolean enabled value', async () => {
    const res = await request(app).put('/api/dns/dnssec').send({ enabled: 'yes' });
    expect(res.status).toBe(400);
  });

  it('enables DNSSEC, persists it, and ensures NTP', async () => {
    const res = await request(app).put('/api/dns/dnssec').send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(ensureNtpEnabled).toHaveBeenCalled();
    expect(armDnssecTimecheckWhenSynced).toHaveBeenCalled();

    const get = await request(app).get('/api/dns/dnssec');
    expect(get.body.enabled).toBe(true);
  });

  it('disables DNSSEC without touching NTP', async () => {
    await request(app).put('/api/dns/dnssec').send({ enabled: true });
    vi.mocked(ensureNtpEnabled).mockClear();

    const res = await request(app).put('/api/dns/dnssec').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(ensureNtpEnabled).not.toHaveBeenCalled();

    const get = await request(app).get('/api/dns/dnssec');
    expect(get.body.enabled).toBe(false);
  });

  it('refuses to enable when dnsmasq lacks DNSSEC support', async () => {
    vi.mocked(dnsmasqSupportsDnssec).mockReturnValue(false);
    const res = await request(app).put('/api/dns/dnssec').send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/DNSSEC support/i);
  });
});
