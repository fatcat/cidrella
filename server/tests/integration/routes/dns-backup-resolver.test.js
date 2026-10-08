import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

vi.mock('../../../src/utils/dnsmasq.js', async (importOriginal) => ({
  ...(await importOriginal()),
  regenerateConfigs: vi.fn(),
  regenerateDnsmasqConf: vi.fn(),
  restartDnsmasq: vi.fn(),
}));
vi.mock('../../../src/utils/encrypted-forwarder.js', () => ({
  applyEncryptedForwarder: vi.fn(),
  getEncryptedForwarderStatus: vi.fn(() => ({ mode: 'off', running: false, recentErrors: 0 })),
}));
// The real runner would query the public presets for a minute.
vi.mock('../../../src/services/resolver-benchmark.js', async (importOriginal) => ({
  ...(await importOriginal()),
  startBenchmark: vi.fn(() => 'run-1'),
  getBenchmark: vi.fn((id) =>
    id === 'run-1' ? { id, state: 'running', progress_pct: 10, results: [] } : null,
  ),
  cancelBenchmark: vi.fn((id) => id === 'run-1'),
}));

const { default: dnsRouter } = await import('../../../src/routes/dns.js');
const { applyEncryptedForwarder } = await import('../../../src/utils/encrypted-forwarder.js');
const benchmark = await import('../../../src/services/resolver-benchmark.js');
const { default: request } = await import('supertest');

let tmpDir, db, app;
const QUAD9 = { label: 'Quad9', hostname: 'dns10.quad9.net', addresses: ['9.9.9.10'] };
const ADGUARD = {
  label: 'AdGuard',
  hostname: 'unfiltered.adguard-dns.com',
  addresses: ['94.140.14.140'],
};

beforeAll(async () => {
  const s = await setupTestDb();
  tmpDir = s.tmpDir;
  db = s.db;
  app = createTestApp(dnsRouter, '/api/dns');
});
afterAll(() => cleanupTestDb(tmpDir));
beforeEach(() => vi.clearAllMocks());

const putForwarders = (body) => request(app).put('/api/dns/forwarders').send(body);

describe('PUT /api/dns/forwarders: backup resolver', () => {
  it('starts out balancing with no backup', async () => {
    const res = await request(app).get('/api/dns/forwarders');
    expect(res.body).toMatchObject({ backup_servers: [], backup_mode: 'balance' });
  });

  it('saves a backup and On failure, and reapplies the forwarder', async () => {
    const res = await putForwarders({
      servers: ['9.9.9.10'],
      backup_servers: ['1.1.1.1', '1.0.0.1'],
      backup_mode: 'failover',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      servers: ['9.9.9.10'],
      backup_servers: ['1.1.1.1', '1.0.0.1'],
      backup_mode: 'failover',
    });
    expect(applyEncryptedForwarder).toHaveBeenCalled();
  });

  it('keeps the backup when a save leaves it out', async () => {
    const res = await putForwarders({ servers: ['9.9.9.10'] });
    expect(res.body.backup_servers).toEqual(['1.1.1.1', '1.0.0.1']);
    expect(res.body.backup_mode).toBe('failover');
  });

  it('clears the backup with an empty list', async () => {
    const res = await putForwarders({ servers: ['9.9.9.10'], backup_servers: [] });
    expect(res.body.backup_servers).toEqual([]);
  });

  it.each([
    [{ servers: ['9.9.9.10'], backup_mode: 'random' }, /backup_mode/],
    [{ servers: ['9.9.9.10'], backup_servers: 'x' }, /backup_servers/],
    [{ servers: ['9.9.9.10'], backup_servers: ['nope'] }, /Invalid IP address: nope/],
    [{ servers: ['9.9.9.10'], backup_servers: ['9.9.9.10'] }, /both the primary and the backup/],
  ])('refuses %j', async (body, error) => {
    const res = await putForwarders(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(error);
  });

  it('refuses an IPv6 backup while IPv6 is off, then takes it, canonical', async () => {
    const body = { servers: ['9.9.9.10'], backup_servers: ['2606:4700:4700:0::1111'] };
    expect((await putForwarders(body)).status).toBe(400);
    enableIpv6(db);
    const res = await putForwarders(body);
    expect(res.status).toBe(200);
    expect(res.body.backup_servers).toEqual(['2606:4700:4700::1111']);
  });

  it('sees an IPv6 address in both lists in any spelling', async () => {
    const res = await putForwarders({
      servers: ['2620:fe::10'],
      backup_servers: ['2620:FE:0::10'],
    });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/dns/encryption: primary and backup', () => {
  it('takes a primary and a backup', async () => {
    const res = await request(app)
      .put('/api/dns/encryption')
      .send({ mode: 'tls', upstreams: [QUAD9, ADGUARD] });
    expect(res.status).toBe(200);
    expect(res.body.upstreams.map((u) => u.hostname)).toEqual([
      'dns10.quad9.net',
      'unfiltered.adguard-dns.com',
    ]);
  });

  it('refuses a third resolver and the same one twice', async () => {
    const third = { ...ADGUARD, hostname: 'dns.google', addresses: ['8.8.8.8'] };
    for (const upstreams of [
      [QUAD9, ADGUARD, third],
      [QUAD9, QUAD9],
    ]) {
      const res = await request(app).put('/api/dns/encryption').send({ mode: 'tls', upstreams });
      expect(res.status).toBe(400);
    }
  });
});

describe('/api/dns/resolver-test', () => {
  it('starts a run over the protocol of the mode', async () => {
    const res = await request(app).post('/api/dns/resolver-test').send({ mode: 'https' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: 'run-1' });
    expect(benchmark.startBenchmark).toHaveBeenCalledWith({
      protocol: 'doh',
      mode: 'https',
      custom: [],
    });
  });

  it.each([
    ['plain', 'off', { addresses: ['192.168.1.53'] }],
    ['plain IPv6', 'off', { addresses: ['fd00::53'] }],
    ['DoT', 'tls', QUAD9],
  ])('takes a %s custom resolver', async (_kind, mode, custom) => {
    const res = await request(app)
      .post('/api/dns/resolver-test')
      .send({ mode, custom: [custom] });
    expect(res.status).toBe(202);
  });

  it.each([
    [{ mode: 'quic' }],
    [{ mode: 'off', custom: [{ addresses: [] }] }],
    [{ mode: 'off', custom: [{ addresses: ['x'] }] }],
    [{ mode: 'tls', custom: [{ ...QUAD9, addresses: ['10.0.0.5'] }] }],
    [{ mode: 'https', custom: [QUAD9] }],
    [{ mode: 'off', custom: [QUAD9, QUAD9, QUAD9] }],
  ])('refuses %j', async (body) => {
    expect((await request(app).post('/api/dns/resolver-test').send(body)).status).toBe(400);
  });

  it('answers 409 while a run is going', async () => {
    benchmark.startBenchmark.mockImplementationOnce(() => {
      throw new benchmark.BenchmarkBusyError({ id: 'run-0', mode: 'tls' });
    });
    const res = await request(app).post('/api/dns/resolver-test').send({ mode: 'off' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'A resolver test is already running',
      id: 'run-0',
      mode: 'tls',
    });
  });

  it('reports progress, cancels, and 404s an unknown run', async () => {
    expect((await request(app).get('/api/dns/resolver-test/run-1')).body.progress_pct).toBe(10);
    expect((await request(app).delete('/api/dns/resolver-test/run-1')).status).toBe(200);
    expect((await request(app).get('/api/dns/resolver-test/nope')).status).toBe(404);
    expect((await request(app).delete('/api/dns/resolver-test/nope')).status).toBe(404);
  });
});
