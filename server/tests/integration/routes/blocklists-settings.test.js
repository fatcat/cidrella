import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

// blocklist.js pulls in dnsmasq + dns-proxy side effects and writes conf files.
// Stub those effect modules, keep the real blocklist.js exports (the route
// imports SCHEDULE_HOURS from it), and override only the side-effectful fns.
vi.mock('../../../src/utils/dnsmasq.js', () => ({ atomicWrite: vi.fn(), restartDnsmasq: vi.fn(), applyInterfaceConfig: vi.fn() }));
vi.mock('../../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));
vi.mock('../../../src/utils/blocklist.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureCategoryRows: vi.fn(),
  refreshCategory: vi.fn(),
  refreshAllEnabled: vi.fn(),
  generateBlocklistConfig: vi.fn()
}));

const { default: blocklistsRouter } = await import('../../../src/routes/blocklists.js');
const { generateBlocklistConfig } = await import('../../../src/utils/blocklist.js');
const { default: request } = await import('supertest');

let tmpDir, app;

beforeAll(async () => { const s = await setupTestDb(); tmpDir = s.tmpDir; app = createTestApp(blocklistsRouter, '/api/blocklists'); });
afterAll(() => cleanupTestDb(tmpDir));

describe('PUT /api/blocklists/settings', () => {
  it('accepts the exact payload the client sends and round-trips it', async () => {
    // Regression: the old validator demanded a JS boolean and rejected every real save
    const res = await request(app).put('/api/blocklists/settings').send({
      blocklist_enabled: 'false',
      blocklist_redirect_ip: '',
      blocklist_update_schedule: 'daily'
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const settings = (await request(app).get('/api/blocklists/settings')).body;
    expect(settings.blocklist_enabled).toBe('false');
    expect(settings.blocklist_update_schedule).toBe('daily');
    expect(generateBlocklistConfig).toHaveBeenCalled();
  });

  it('accepts re-enabling', async () => {
    const res = await request(app).put('/api/blocklists/settings').send({ blocklist_enabled: 'true' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/blocklists/settings')).body.blocklist_enabled).toBe('true');
  });

  it('accepts every schedule option the UI offers', async () => {
    // Regression: the old validator ran parseInt, so 'off', 'daily', and 'weekly' all 400ed
    for (const schedule of ['off', '6h', '12h', 'daily', 'weekly']) {
      const res = await request(app).put('/api/blocklists/settings').send({ blocklist_update_schedule: schedule });
      expect(res.status, `schedule '${schedule}'`).toBe(200);
    }
  });

  it('rejects non-string and out-of-enum blocklist_enabled values', async () => {
    for (const bad of [true, false, 1, 'yes', ['true'], { v: 'true' }]) {
      const res = await request(app).put('/api/blocklists/settings').send({ blocklist_enabled: bad });
      expect(res.status, `value ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('rejects a non-IPv4 blocklist_redirect_ip', async () => {
    for (const bad of ['not-an-ip', { x: 1 }, ['1.2.3.4'], '999.1.1.1', '1.2.3']) {
      const res = await request(app).put('/api/blocklists/settings').send({ blocklist_redirect_ip: bad });
      expect(res.status, `value ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('accepts a valid IPv4 or empty redirect IP', async () => {
    expect((await request(app).put('/api/blocklists/settings').send({ blocklist_redirect_ip: '10.0.0.1' })).status).toBe(200);
    expect((await request(app).put('/api/blocklists/settings').send({ blocklist_redirect_ip: '' })).status).toBe(200);
  });

  it('rejects unknown or non-string schedules', async () => {
    for (const bad of ['hourly', 6, ['daily'], 'monthly']) {
      const res = await request(app).put('/api/blocklists/settings').send({ blocklist_update_schedule: bad });
      expect(res.status, `value ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('ignores keys outside the allowlist', async () => {
    const res = await request(app).put('/api/blocklists/settings').send({ blocklist_enabled: 'true', evil_key: 'x' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/blocklists/settings')).body).not.toHaveProperty('evil_key');
  });

  it('round-trips blocklist_max_feed_mb as the string the UI sends', async () => {
    const res = await request(app).put('/api/blocklists/settings').send({ blocklist_max_feed_mb: '256' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/blocklists/settings')).body.blocklist_max_feed_mb).toBe('256');
  });

  it('accepts blocklist_max_feed_mb at both ends of the range, as string or number', async () => {
    for (const good of ['1', '128', '2048', 64]) {
      const res = await request(app).put('/api/blocklists/settings').send({ blocklist_max_feed_mb: good });
      expect(res.status, `value ${JSON.stringify(good)}`).toBe(200);
    }
  });

  it('rejects out-of-range and non-numeric blocklist_max_feed_mb', async () => {
    for (const bad of [0, 2049, -1, 'abc', '', '12.5', { a: 1 }, ['128'], true]) {
      const res = await request(app).put('/api/blocklists/settings').send({ blocklist_max_feed_mb: bad });
      expect(res.status, `value ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('exposes blocklist_max_feed_mb on GET so the UI can populate the field', async () => {
    expect((await request(app).get('/api/blocklists/settings')).body)
      .toHaveProperty('blocklist_max_feed_mb');
  });
});

describe('schedule vocabulary single-sourcing (v0.4.16)', () => {
  it('the route accepts exactly the SCHEDULE_HOURS keys', async () => {
    const { SCHEDULE_HOURS } = await import('../../../src/utils/blocklist.js');
    expect(Object.keys(SCHEDULE_HOURS)).toEqual(['off', '6h', '12h', 'daily', 'weekly']);
    // every key maps to a non-negative hour count, 'off' to 0
    expect(SCHEDULE_HOURS.off).toBe(0);
    for (const hours of Object.values(SCHEDULE_HOURS)) {
      expect(Number.isInteger(hours) && hours >= 0).toBe(true);
    }
  });
});

// The whitelist route used to inline its own domain regex with NO length bound,
// so a 300-character name was accepted here and rejected by every other route.
// It now uses the shared isValidDomain (shape + 253 cap) and keeps its own
// extra TLD requirement, which is deliberate for a public-domain allowlist.
// See REVIEW.md, duplicate-logic audit #21.
describe('whitelist domain validation matches the shared validator', () => {
  // These two names are built from labels of 63 characters or fewer on purpose.
  // They used to be a single 249-character label, which hits the 253 total cap
  // but is not a legal domain: RFC 1035 caps a LABEL at 63 octets, and
  // isValidDomain now enforces that (duplicate-logic audit #7). With the old
  // fixture the over-cap case was rejected for the label length rather than the
  // total, so it would have passed even with the 253 cap deleted. Keeping the
  // labels legal is what makes these tests actually about the total cap.
  it('rejects a name longer than 253 characters', async () => {
    const tooLong = ['a'.repeat(63), 'a'.repeat(63), 'a'.repeat(63), 'a'.repeat(62)].join('.');
    expect(tooLong.length).toBe(254);
    expect(tooLong.split('.').every(l => l.length <= 63)).toBe(true);
    const res = await request(app).post('/api/blocklists/whitelist').send({ domain: tooLong });
    expect(res.status).toBe(400);
  });

  it('accepts a name at the limit, so the cap is not off by one', async () => {
    const ok = ['a'.repeat(63), 'a'.repeat(63), 'a'.repeat(63), 'a'.repeat(61)].join('.');
    expect(ok.length).toBe(253);
    expect(ok.split('.').every(l => l.length <= 63)).toBe(true);
    const res = await request(app).post('/api/blocklists/whitelist').send({ domain: ok });
    expect(res.status).toBe(201);
  });

  it('rejects a label longer than 63 characters even when the total fits', async () => {
    const badLabel = `${'a'.repeat(64)}.com`;
    expect(badLabel.length).toBeLessThan(253);
    const res = await request(app).post('/api/blocklists/whitelist').send({ domain: badLabel });
    expect(res.status).toBe(400);
  });

  it('still requires a TLD, which is this route being deliberately stricter', async () => {
    const res = await request(app).post('/api/blocklists/whitelist').send({ domain: 'intranet' });
    expect(res.status).toBe(400);
  });

  it('accepts an ordinary domain', async () => {
    const res = await request(app).post('/api/blocklists/whitelist').send({ domain: 'example.com' });
    expect(res.status).toBe(201);
  });
});

describe('input type guards (v0.4.16-pre.3 pentest)', () => {
  it('whitelist rejects non-string domain with 400 not 500', async () => {
    for (const bad of [123, true, ['x.com'], { d: 'x.com' }]) {
      const res = await request(app).post('/api/blocklists/whitelist').send({ domain: bad });
      expect(res.status, `domain ${JSON.stringify(bad)}`).toBe(400);
    }
  });
  it('category enable requires a real boolean', async () => {
    for (const bad of [{ x: 1 }, 'true', 1, ['true']]) {
      const res = await request(app).put('/api/blocklists/categories/ads').send({ enabled: bad });
      expect(res.status, `enabled ${JSON.stringify(bad)}`).toBe(400);
    }
  });
});
