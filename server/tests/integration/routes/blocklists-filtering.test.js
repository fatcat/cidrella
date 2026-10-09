import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, enableIpv6 } from '../../helpers/test-db.js';
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

const { default: blocklistsRouter } = await import('../../../src/routes/blocklists.js');
const { filteringBypass } = await import('../../../src/utils/dns-proxy.js');
const { default: request } = await import('supertest');

/**
 * Pausing filtering for everyone, and turning it off for one host. The proxy's
 * view (filteringBypass) is checked after each write, because a write that
 * stored the change but did not reach the proxy would look fine to the API.
 */
let tmpDir, db, app, viewer;

beforeAll(async () => {
  const s = await setupTestDb();
  tmpDir = s.tmpDir;
  db = s.db;
  app = createTestApp(blocklistsRouter, '/api/blocklists');
  viewer = createTestApp(blocklistsRouter, '/api/blocklists', {
    id: 2,
    role: 'readonly',
    username: 'viewer',
  });
});
afterAll(() => cleanupTestDb(tmpDir));
afterEach(async () => {
  db.exec("DELETE FROM filtering_exemptions; DELETE FROM dhcp_leases; DELETE FROM audit_log;");
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ipv6_enabled', 'false')").run();
  await request(app).put('/api/blocklists/pause').send({ minutes: 0 });
});

const auditActions = () =>
  db.prepare('SELECT action FROM audit_log ORDER BY id').pluck().all();

describe('PUT /api/blocklists/pause', () => {
  it('pauses for the chosen minutes, shows when it ends, and resumes on 0', async () => {
    const before = Date.now();
    const res = await request(app).put('/api/blocklists/pause').send({ minutes: 15 });
    expect(res.status).toBe(200);
    const until = Date.parse(res.body.filtering_paused_until);
    expect(until - before).toBeGreaterThanOrEqual(15 * 60e3 - 1000);
    expect(until - before).toBeLessThanOrEqual(15 * 60e3 + 1000);
    expect(filteringBypass('10.0.0.5')).toBe('paused');
    expect((await request(app).get('/api/blocklists/settings')).body.filtering_paused_until).toBe(
      res.body.filtering_paused_until,
    );

    const resumed = await request(app).put('/api/blocklists/pause').send({ minutes: 0 });
    expect(resumed.body.filtering_paused_until).toBeNull();
    expect(filteringBypass('10.0.0.5')).toBeNull();
    expect(auditActions()).toEqual(['filtering_paused', 'filtering_resumed']);
  });

  it('refuses any other period and readers without dns:write', async () => {
    for (const minutes of [1, 10, 120, -5, '15', null]) {
      const res = await request(app).put('/api/blocklists/pause').send({ minutes });
      expect([minutes, res.status]).toEqual([minutes, 400]);
    }
    const res = await request(viewer).put('/api/blocklists/pause').send({ minutes: 5 });
    expect(res.status).toBe(403);
    expect(filteringBypass('10.0.0.5')).toBeNull();
  });
});

describe('PUT /api/blocklists/host-filtering', () => {
  const put = (body, client = app) =>
    request(client).put('/api/blocklists/host-filtering').send(body);

  it('turns a host off by its device MAC and back on, IPv4', async () => {
    db.prepare(
      `INSERT INTO dhcp_leases (ip_address, mac_address, expires_at) VALUES (?, ?, ?)`,
    ).run('10.0.0.40', 'aa:bb:cc:dd:ee:40', new Date(Date.now() + 3600e3).toISOString());
    const off = await put({ ip_address: '10.0.0.40', subnet_id: null, enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ ip_address: '10.0.0.40', filtering_enabled: false });
    expect(db.prepare('SELECT mac_address, ip_address FROM filtering_exemptions').all()).toEqual([
      { mac_address: 'aa:bb:cc:dd:ee:40', ip_address: null },
    ]);
    expect(filteringBypass('10.0.0.40')).toBe('host');

    const on = await put({ ip_address: '10.0.0.40', enabled: true });
    expect(on.body.filtering_enabled).toBe(true);
    expect(filteringBypass('10.0.0.40')).toBeNull();
    expect(auditActions()).toEqual(['filtering_changed', 'filtering_changed']);
    const events = db
      .prepare("SELECT old_value, new_value FROM ip_events WHERE event_type = 'filtering_changed'")
      .all();
    expect(events.slice(-2)).toEqual([
      { old_value: 'on', new_value: 'off' },
      { old_value: 'off', new_value: 'on' },
    ]);
  });

  it('refuses IPv6 while the IPv6 switch is off, and keys an IPv6 host by address once on', async () => {
    expect((await put({ ip_address: 'fd00::40', enabled: false })).status).toBe(400);
    enableIpv6(db);
    const off = await put({ ip_address: 'FD00:0::40', enabled: false });
    expect(off.body).toEqual({ ip_address: 'fd00::40', filtering_enabled: false });
    expect(filteringBypass('fd00::40')).toBe('host');
  });

  it('refuses a bad body and readers without dns:write, changing nothing', async () => {
    for (const body of [
      { ip_address: '10.0.0.999', enabled: false },
      { ip_address: '10.0.0.41', enabled: 'false' },
      { ip_address: '10.0.0.41', subnet_id: '3', enabled: false },
      { ip_address: '10.0.0.41', interface_id: 7, enabled: false },
      { enabled: false },
    ]) {
      expect([body, (await put(body)).status]).toEqual([body, 400]);
    }
    expect((await put({ ip_address: '10.0.0.41', enabled: false }, viewer)).status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) FROM filtering_exemptions').pluck().get()).toBe(0);
    expect(auditActions()).toEqual([]);
  });

  it('a repeat of the current state changes nothing and audits nothing', async () => {
    const res = await put({ ip_address: '10.0.0.42', enabled: true });
    expect(res.body.filtering_enabled).toBe(true);
    expect(auditActions()).toEqual([]);
  });
});
