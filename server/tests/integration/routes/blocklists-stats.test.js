/**
 * GET /api/blocklists/stats reads a stored domain count. The count is a scan
 * of every blocklist domain, so it runs in the database worker whenever the
 * blocklist changes, never on the request (BLOCKLIST-STATS-STALL-01).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

vi.mock('../../../src/backends/index.js', async () =>
  (await import('../../helpers/fake-backends.js')).fakeBackendsModule(),
);
vi.mock('../../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));
// The proxy's in-memory sets are not what this test is about.
vi.mock('../../../src/utils/dns-proxy.js', () => ({
  loadBlocklist: vi.fn(),
  loadAllowlist: vi.fn(),
  loadFilteringOverrides: vi.fn(),
}));

const { default: blocklistsRouter } = await import('../../../src/routes/blocklists.js');
const { BLOCKLIST_CATEGORIES } = await import('../../../src/utils/blocklist-categories.js');
const { DOMAIN_COUNT_KEY } = await import('../../../src/utils/blocklist.js');
const { default: request } = await import('supertest');

let db, tmpDir, app;
const [first, second] = BLOCKLIST_CATEGORIES.map((c) => c.slug);
const stats = () => request(app).get('/api/blocklists/stats');

beforeAll(async () => {
  ({ db, tmpDir } = await setupTestDb());
  app = createTestApp(blocklistsRouter, '/api/blocklists');
  const enable = db.prepare(
    'INSERT OR REPLACE INTO blocklist_categories (slug, enabled, last_fetched_at) VALUES (?, 1, ?)',
  );
  enable.run(first, '2026-10-29 00:00:00');
  enable.run(second, '2026-10-29 00:00:00');
  const domain = db.prepare('INSERT INTO blocklist_domains (domain, category_slug) VALUES (?, ?)');
  db.transaction(() => {
    for (let i = 0; i < 20; i++) domain.run(`a-${i}.stats.test`, first);
    for (let i = 0; i < 5; i++) domain.run(`b-${i}.stats.test`, second);
    // In both: counted once.
    domain.run('a-0.stats.test', second);
  })();
  db.prepare('DELETE FROM settings WHERE key = ?').run(DOMAIN_COUNT_KEY);
});
afterAll(() => cleanupTestDb(tmpDir));

describe('GET /api/blocklists/stats', () => {
  it('says the domains are not counted yet, then reads the count it started', async () => {
    const before = await stats();
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ total_domains: null, domains_counted_at: null });
    await vi.waitFor(async () => expect((await stats()).body.total_domains).toBe(25));
    expect((await stats()).body.domains_counted_at).toEqual(expect.any(String));
  });

  it('counts again when a category is switched off', async () => {
    const res = await request(app).put(`/api/blocklists/categories/${second}`).send({ enabled: false });
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect((await stats()).body.total_domains).toBe(20));
  });
});
