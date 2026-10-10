import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

vi.mock('../../../src/services/backend-apply.js', async (importOriginal) =>
  (await import('../../helpers/fake-backends.js')).stubBackendApply(await importOriginal(), [
    'applyDns',
    'applyResolver',
  ]),
);
vi.mock('../../../src/backends/index.js', async () =>
  (await import('../../helpers/fake-backends.js')).fakeBackendsModule(),
);
vi.mock('../../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

// A reader that places the documentation addresses, so no real database is needed.
const COUNTRY = { '203.0.113.9': 'RU', '2001:db8::9': 'RU', '198.51.100.9': 'US' };
vi.mock('maxmind', () => ({
  default: {
    open: vi.fn(async () => ({
      get: (ip) => (COUNTRY[ip] ? { country: { iso_code: COUNTRY[ip] } } : null),
    })),
  },
}));

// A refresh downloads a real file; this one gzips a placeholder.
const { gzipSync } = await import('zlib');
const download = () =>
  new Response(gzipSync(Buffer.from('placeholder')), { status: 200, statusText: 'OK' });

const { default: geoipRouter } = await import('../../../src/routes/geoip.js');
const { getDb, setSetting, getSetting } = await import('../../../src/db/init.js');
const { evaluateResolvedPolicy, isGeoipLoaded, unloadMmdb } = await import(
  '../../../src/utils/dns-proxy.js'
);
const { default: request } = await import('supertest');

let tmpDir, app;

beforeAll(async () => {
  const s = await setupTestDb();
  tmpDir = s.tmpDir;
  app = createTestApp(geoipRouter, '/api/geoip');
  // The reader is mocked; the file only has to exist where the proxy looks.
  const mmdb = path.join(tmpDir, 'test-country.mmdb');
  fs.writeFileSync(mmdb, 'placeholder');
  setSetting('geoip_db_path', mmdb);
  getDb().prepare("INSERT INTO geoip_rules (country_code, country_name, enabled) VALUES ('RU', 'Russia', 1)").run();
});
afterAll(() => cleanupTestDb(tmpDir));
beforeEach(() => {
  unloadMmdb();
  setSetting('geoip_enabled', 'false');
  setSetting('geoip_mode', 'blocklist');
});

const put = (body) => request(app).put('/api/geoip/settings').send(body);
const verdict = (ip) => evaluateResolvedPolicy('example.test', [ip]).action;

describe('PUT /api/geoip/settings', () => {
  for (const ip of ['203.0.113.9', '2001:db8::9']) {
    it(`blocks ${ip} while on and stops the moment GeoIP goes off`, async () => {
      expect((await put({ geoip_enabled: true })).status).toBe(200);
      expect(isGeoipLoaded()).toBe(true);
      expect(verdict(ip)).toBe('block');

      expect((await put({ geoip_enabled: false })).status).toBe(200);
      expect(isGeoipLoaded()).toBe(false);
      expect(verdict(ip)).toBe('forward');

      expect((await put({ geoip_enabled: true })).status).toBe(200);
      expect(verdict(ip)).toBe('block');
    });
  }

  it('leaves an unlisted country alone', async () => {
    await put({ geoip_enabled: true });
    expect(verdict('198.51.100.9')).toBe('forward');
  });

  it('a mode change while off does not load the database', async () => {
    expect((await put({ geoip_mode: 'allowlist' })).status).toBe(200);
    expect(isGeoipLoaded()).toBe(false);
    expect(verdict('198.51.100.9')).toBe('forward');
  });
});

describe('POST /api/geoip/db/refresh', () => {
  it('a refresh while GeoIP is off saves the file but does not turn blocking on', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => download());
    try {
      expect((await request(app).post('/api/geoip/db/refresh')).status).toBe(200);
      expect(getSetting('geoip_last_updated')).toBeTruthy();
      expect(isGeoipLoaded()).toBe(false);
      expect(verdict('203.0.113.9')).toBe('forward');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('a refresh while GeoIP is on loads the fresh file', async () => {
    await put({ geoip_enabled: true });
    unloadMmdb();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => download());
    try {
      expect((await request(app).post('/api/geoip/db/refresh')).status).toBe(200);
      expect(isGeoipLoaded()).toBe(true);
      expect(verdict('2001:db8::9')).toBe('block');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
