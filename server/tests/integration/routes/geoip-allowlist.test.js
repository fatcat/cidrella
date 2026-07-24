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

describe('POST /api/geoip/allowlist — canonicalization (v0.4.16)', () => {
  it('stores the canonical CIDR form (host bits masked, explicit prefix)', async () => {
    const res = await request(app).post('/api/geoip/allowlist').send({ value: '10.5.5.5/8' });
    expect(res.status).toBe(201);
    expect(res.body.value).toBe('10.0.0.0/8');
    const bare = await request(app).post('/api/geoip/allowlist').send({ value: '9.9.9.9' });
    expect(bare.body.value).toBe('9.9.9.9/32');
  });

  it('409s on a different spelling of the same network', async () => {
    await request(app).post('/api/geoip/allowlist').send({ value: '10.0.0.0/8' });
    expect((await request(app).post('/api/geoip/allowlist').send({ value: '010.0.0.0/8' })).status).toBe(409);
    expect((await request(app).post('/api/geoip/allowlist').send({ value: '10.99.0.1/8' })).status).toBe(409);
  });

  it('canonicalizes IPv6 case and compression before dedup', async () => {
    const first = await request(app).post('/api/geoip/allowlist').send({ value: '2001:DB8:0:0:0:0:0:0/32' });
    expect(first.body.value).toBe('2001:db8::/32');
    expect((await request(app).post('/api/geoip/allowlist').send({ value: '2001:db8::/32' })).status).toBe(409);
  });
});

describe('canonicalizeExisting backfill', () => {
  it('rewrites legacy spellings and collapses same-network duplicates keeping the oldest', async () => {
    const { canonicalizeExisting } = await import('../../../src/models/geoip-ip-allowlist.js');
    const db = getDb();
    const ins = db.prepare('INSERT INTO geoip_ip_allowlist (value, reason) VALUES (?, ?)');
    ins.run('10.5.5.5/8', 'oldest — keep me');
    ins.run('010.0.0.0/8', 'dup — drop me');
    ins.run('8.8.8.8', null);
    ins.run('2001:DB8::1', null);
    canonicalizeExisting(db);
    const rows = db.prepare('SELECT value, reason FROM geoip_ip_allowlist ORDER BY id').all();
    expect(rows).toEqual([
      { value: '10.0.0.0/8', reason: 'oldest — keep me' },
      { value: '8.8.8.8/32', reason: null },
      { value: '2001:db8::1/128', reason: null },
    ]);
    // idempotent
    canonicalizeExisting(db);
    expect(db.prepare('SELECT COUNT(*) c FROM geoip_ip_allowlist').get().c).toBe(3);
  });
});

describe('canonicalizeExisting backfill — UNIQUE collision regression', () => {
  it('survives a non-canonical row ordered BEFORE a row already storing the canonical string', async () => {
    // Regression: the one-pass version UPDATEd row 1 ('10.5.5.5/8' -> '10.0.0.0/8')
    // while row 2 already held '10.0.0.0/8', violating UNIQUE(value) and
    // crash-looping the server at boot.
    const { canonicalizeExisting } = await import('../../../src/models/geoip-ip-allowlist.js');
    const db = getDb();
    const ins = db.prepare('INSERT INTO geoip_ip_allowlist (value, reason) VALUES (?, ?)');
    ins.run('10.5.5.5/8', null);
    ins.run('10.0.0.0/8', 'keep this reason');
    ins.run('2001:0DB8::/32', 'ipv6 spelling');
    ins.run('2001:db8::/32', null);
    expect(() => canonicalizeExisting(db)).not.toThrow();
    const rows = db.prepare('SELECT value, reason FROM geoip_ip_allowlist ORDER BY value').all();
    expect(rows).toEqual([
      // oldest row wins but inherits the dropped duplicate's reason when it has none
      { value: '10.0.0.0/8', reason: 'keep this reason' },
      { value: '2001:db8::/32', reason: 'ipv6 spelling' },
    ]);
  });
});

describe('POST /api/geoip/rules type guards (v0.4.16-pre.3 pentest)', () => {
  it('rejects non-object country entries with 400 not 500', async () => {
    for (const bad of [[null], ['US'], [123], [{}]]) {
      const res = await request(app).post('/api/geoip/rules').send({ countries: bad });
      expect(res.status, `countries ${JSON.stringify(bad)}`).toBe(400);
    }
  });
});
