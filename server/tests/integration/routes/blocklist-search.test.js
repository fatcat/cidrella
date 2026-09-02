import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';
import { createTestApp } from '../../helpers/test-app.js';

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
const { default: request } = await import('supertest');

/**
 * GET /api/blocklists/search.
 *
 * The endpoint used to run TWO unanchored `LIKE '%...%'` full scans of
 * blocklist_domains per request: one COUNT(DISTINCT) for a total, and one for
 * the page. `LIKE '%...%'` cannot use the primary key, so both scanned the whole
 * table, which migration 053 sized at 2.65 million rows for one category.
 *
 * The paged SELECT survives that because the table is WITHOUT ROWID keyed on
 * (domain, category_slug): it streams in domain order with no temp b-tree, so
 * LIMIT stops it as soon as the page is full. The COUNT could never stop early.
 *
 * Measured on a synthetic 2.65M-row table: narrow match 145ms -> 2ms, broad
 * match 395ms -> 0ms, no match 208ms -> 107ms. The last is a single scan and is
 * irreducible without changing the index or the collation.
 *
 * These tests pin the CONTRACT that replaced the total: one extra row is
 * fetched, and its presence becomes `hasMore`. The boundary cases are where
 * a limit+1 probe is easy to get wrong.
 */
let tmpDir, app, db;

beforeAll(async () => {
  const s = await setupTestDb();
  tmpDir = s.tmpDir;
  db = s.db;
  app = createTestApp(blocklistsRouter, '/api/blocklists');

  db.prepare("INSERT OR IGNORE INTO blocklist_categories (slug, enabled) VALUES ('malware', 1)").run();
  db.prepare("INSERT OR IGNORE INTO blocklist_categories (slug, enabled) VALUES ('ads', 1)").run();
  db.prepare("INSERT OR IGNORE INTO blocklist_categories (slug, enabled) VALUES ('off', 0)").run();

  const ins = db.prepare('INSERT OR REPLACE INTO blocklist_domains (domain, category_slug) VALUES (?, ?)');
  db.transaction(() => {
    // 25 matches for 'needle', so a limit of 10 gives pages of 10 / 10 / 5.
    for (let i = 0; i < 25; i++) ins.run(`n${String(i).padStart(2, '0')}.needle.example.com`, 'malware');
    // exactly 10, to probe the page boundary
    for (let i = 0; i < 10; i++) ins.run(`e${i}.exactten.example.com`, 'malware');
    // one domain in two enabled categories, to prove de-duplication
    ins.run('both.example.com', 'malware');
    ins.run('both.example.com', 'ads');
    // a domain only in a DISABLED category, which must not be found
    ins.run('hidden.example.com', 'off');
  })();
});
afterAll(() => cleanupTestDb(tmpDir));

const search = (q, page = 1, limit = 10) =>
  request(app).get('/api/blocklists/search').query({ q, page, limit });

describe('search: the hasMore contract', () => {
  it('reports hasMore when a further page exists', async () => {
    const res = await search('needle', 1, 10);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(10);
    expect(res.body.hasMore).toBe(true);
    // The probe row must NOT leak into the page.
    expect(res.body.items).toHaveLength(res.body.limit);
  });

  it('reports hasMore on a middle page', async () => {
    const res = await search('needle', 2, 10);
    expect(res.body.items).toHaveLength(10);
    expect(res.body.hasMore).toBe(true);
  });

  it('clears hasMore on the last, partial page', async () => {
    const res = await search('needle', 3, 10);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.hasMore).toBe(false);
  });

  it('clears hasMore when the last page is exactly full', async () => {
    // The off-by-one that a limit+1 probe exists to get right: 10 matches with
    // a limit of 10 must NOT offer a next page.
    const res = await search('exactten', 1, 10);
    expect(res.body.items).toHaveLength(10);
    expect(res.body.hasMore).toBe(false);
  });

  it('returns an empty page past the end', async () => {
    const res = await search('needle', 9, 10);
    expect(res.body.items).toEqual([]);
    expect(res.body.hasMore).toBe(false);
  });

  it('no longer returns a total, which cost a second full scan', async () => {
    const res = await search('needle');
    expect(res.body.total).toBeUndefined();
    expect(res.body).toHaveProperty('hasMore');
  });
});

describe('search: results are unchanged by the rewrite', () => {
  it('paginates without overlap or gaps', async () => {
    const p1 = (await search('needle', 1, 10)).body.items.map(i => i.domain);
    const p2 = (await search('needle', 2, 10)).body.items.map(i => i.domain);
    const p3 = (await search('needle', 3, 10)).body.items.map(i => i.domain);
    const all = [...p1, ...p2, ...p3];
    expect(all).toHaveLength(25);
    expect(new Set(all).size, 'pages must not overlap').toBe(25);
    expect(all, 'and must come back in domain order').toEqual([...all].sort());
  });

  it('collapses one domain across categories into a single row', async () => {
    const res = await search('both.example');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].categories.split(', ').sort()).toEqual(['ads', 'malware']);
  });

  it('ignores domains that only appear in a disabled category', async () => {
    const res = await search('hidden');
    expect(res.body.items).toEqual([]);
    expect(res.body.hasMore).toBe(false);
  });

  it('still matches a substring, not just a prefix', async () => {
    // The scan is what makes this work, and it is why the endpoint is still a
    // scan. Pinned so a future "just anchor the LIKE" change has to fail here.
    const res = await search('eedle.exam');
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('refuses a query shorter than two characters', async () => {
    const res = await search('a');
    expect(res.body.items).toEqual([]);
    expect(res.body.hasMore).toBe(false);
  });

  it('treats LIKE wildcards in the query as literal characters', async () => {
    // '%' would otherwise match everything.
    const res = await search('%');
    expect(res.body.items).toEqual([]);
  });

  it('marks whitelisted domains', async () => {
    db.prepare('INSERT OR IGNORE INTO blocklist_whitelist (domain) VALUES (?)').run('n00.needle.example.com');
    const res = await search('n00.needle');
    expect(res.body.items[0]).toMatchObject({ domain: 'n00.needle.example.com', whitelisted: true });
  });
});
