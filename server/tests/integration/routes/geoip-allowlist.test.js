import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

// dns-proxy (imported by geoip routes) pulls in dnsmasq + duckdb side effects; stub them.
vi.mock('../../../src/utils/dnsmasq.js', () => ({ applyInterfaceConfig: vi.fn(), restartDnsmasq: vi.fn() }));
vi.mock('../../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

const { default: geoipRouter } = await import('../../../src/routes/geoip.js');
const { getDb } = await import('../../../src/db/init.js');
const { default: request } = await import('supertest');

let tmpDir, app;

beforeAll(async () => { const s = await setupTestDb(); tmpDir = s.tmpDir; app = createTestApp(geoipRouter, '/api/geoip'); });
afterAll(() => cleanupTestDb(tmpDir));
beforeEach(() => getDb().exec('DELETE FROM geoip_ip_allowlist;'));

describe('GET /api/geoip/allowlist', () => {
  it('starts empty', async () => {
    const res = await request(app).get('/api/geoip/allowlist');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/geoip/allowlist', () => {
  it('accepts an IPv4 CIDR and lists it', async () => {
    const res = await request(app).post('/api/geoip/allowlist').send({ value: '203.0.113.0/24', reason: 'partner range' });
    expect(res.status).toBe(201);
    const list = (await request(app).get('/api/geoip/allowlist')).body;
    expect(list.map(e => e.value)).toContain('203.0.113.0/24');
  });

  it('accepts an IPv6 CIDR', async () => {
    expect((await request(app).post('/api/geoip/allowlist').send({ value: '2001:db8::/32' })).status).toBe(201);
  });

  it('rejects an invalid IP/CIDR', async () => {
    expect((await request(app).post('/api/geoip/allowlist').send({ value: '10.0.0.0/33' })).status).toBe(400);
    expect((await request(app).post('/api/geoip/allowlist').send({ value: 'nope' })).status).toBe(400);
  });

  it('rejects a missing value', async () => {
    expect((await request(app).post('/api/geoip/allowlist').send({})).status).toBe(400);
  });

  it('409s on a duplicate', async () => {
    await request(app).post('/api/geoip/allowlist').send({ value: '8.8.8.8' });
    expect((await request(app).post('/api/geoip/allowlist').send({ value: '8.8.8.8' })).status).toBe(409);
  });
});

describe('DELETE /api/geoip/allowlist/:id', () => {
  it('removes an entry', async () => {
    const { body } = await request(app).post('/api/geoip/allowlist').send({ value: '198.51.100.7' });
    expect((await request(app).delete(`/api/geoip/allowlist/${body.id}`)).status).toBe(200);
    expect((await request(app).get('/api/geoip/allowlist')).body).toEqual([]);
  });
  it('404s for a missing id', async () => {
    expect((await request(app).delete('/api/geoip/allowlist/99999')).status).toBe(404);
  });
});
