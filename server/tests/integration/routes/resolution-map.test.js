import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

// The DuckDB analytics queries are not under test here.
vi.mock('../../../src/db/duckdb.js', () =>
  Object.fromEntries(
    [
      'queryTopClients',
      'queryTopDomains',
      'queryTopDomainsWithoutDnssec',
      'queryTopBlocked',
      'queryTopClientsByAction',
      'queryTopDomainsByAction',
      'queryTopBlockReasons',
      'queryTopClientDomainPairsByAction',
      'queryVolume',
      'queryActionBreakdown',
      'queryClientDomains',
      'queryDomainClients',
    ].map((name) => [name, vi.fn()]),
  ),
);
vi.mock('../../../src/utils/dns-proxy.js', () => ({ isGeoipLoaded: () => true }));

const { default: analyticsRouter } = await import('../../../src/routes/analytics.js');
const { default: settingsRouter } = await import('../../../src/routes/settings.js');
const { recordResolution, resetResolutionFeed } =
  await import('../../../src/utils/resolution-feed.js');
const { default: request } = await import('supertest');

let tmpDir, db, analytics, settings, viewer;

beforeAll(async () => {
  ({ tmpDir, db } = await setupTestDb());
  analytics = createTestApp(analyticsRouter, '/api/analytics');
  settings = createTestApp(settingsRouter, '/api/settings');
  viewer = createTestApp(settingsRouter, '/api/settings', {
    id: 2,
    role: 'readonly',
    username: 'viewer',
  });
});
afterAll(() => cleanupTestDb(tmpDir));
beforeEach(() => resetResolutionFeed());

const get = (since) =>
  request(analytics).get(`/api/analytics/resolution-map${since == null ? '' : `?since=${since}`}`);

describe('GET /api/analytics/resolution-map', () => {
  it('returns the feed after the cursor, with home and GeoIP state', async () => {
    recordResolution({
      kind: 'answer',
      name: 'v4.example',
      type: 'A',
      destination: { country: 'DE', point: [13.4, 52.5] },
    });
    recordResolution({
      kind: 'answer',
      name: 'v6.example',
      type: 'AAAA',
      destination: { country: 'FR', point: null },
    });
    const first = await get();
    expect(first.status).toBe(200);
    expect(first.body.events.map((e) => [e.name, e.country, e.point])).toEqual([
      ['v4.example', 'DE', [13.4, 52.5]],
      ['v6.example', 'FR', null],
    ]);
    expect(first.body.home).toBeNull();
    expect(first.body.geoip).toMatchObject({ enabled: false, loaded: true });

    recordResolution({ kind: 'blocklist', name: 'ads.example', type: 'A' });
    const next = await get(first.body.seq);
    expect(next.body.events.map((e) => e.kind)).toEqual(['blocklist']);
    expect(next.body.summary.kinds).toEqual({ answer: 2, geoip: 0, blocklist: 1 });
  });

  it('treats a junk cursor as the start', async () => {
    recordResolution({ kind: 'blocklist', name: 'ads.example' });
    for (const since of ['abc', '-5', '99999999999999999999']) {
      expect([since, (await get(since)).body.events.length]).toEqual([since, 1]);
    }
  });
});

describe('the map_home setting', () => {
  const put = (value, app = settings) => request(app).put('/api/settings/map_home').send({ value });

  it('refuses points off the globe and junk', async () => {
    for (const value of ['91,0', '0,-181', 'abc', '1,2,3', '45', 12]) {
      expect([value, (await put(value)).status]).toEqual([value, 400]);
    }
  });

  it('stores a point the map then reads, and clears it with an empty value', async () => {
    expect((await put(' -33.8688 , 151.2093 ')).status).toBe(200);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'map_home'").pluck().get()).toBe(
      '-33.8688,151.2093',
    );
    expect((await get()).body.home).toEqual({ lat: -33.8688, lon: 151.2093 });
    expect((await put('')).status).toBe(200);
    expect((await get()).body.home).toBeNull();
  });

  it('is an admin setting', async () => {
    expect((await put('10,10', viewer)).status).toBe(403);
  });
});
