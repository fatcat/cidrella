import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { setupTestDb, cleanupTestDb } from '../../helpers/test-db.js';

// blocklist.js reaches dns-proxy and dnsmasq at import time. Stub the effect
// modules; the refresh path itself is what we are testing, for real, against
// real SQLite.
vi.mock('../../../src/utils/dnsmasq.js', () => ({
  atomicWrite: vi.fn(), restartDnsmasq: vi.fn(), applyInterfaceConfig: vi.fn(),
}));
vi.mock('../../../src/db/duckdb.js', () => ({ logDnsQuery: vi.fn() }));

// The one thing we fake is the network.
const openPinnedOutboundStream = vi.fn();
vi.mock('../../../src/utils/url-guard.js', async (importOriginal) => ({
  ...(await importOriginal()),
  openPinnedOutboundStream: (...a) => openPinnedOutboundStream(...a),
}));

const { getDb, setSetting } = await import('../../../src/db/init.js');
const { refreshCategory, parseDomainLine, getMaxFeedBytes, ensureCategoryRows } =
  await import('../../../src/utils/blocklist.js');
const { TOO_LARGE_CODE } = await import('../../../src/utils/url-guard.js');

let tmpDir;

/** A successful 200 whose body is `text`. */
function feed(text, headers = {}) {
  return {
    ok: true, status: 200, statusText: 'OK',
    headers: { etag: 'W/"v1"', 'last-modified': 'Mon, 20 Jul 2026 13:07:13 GMT', ...headers },
    stream: Readable.from([Buffer.from(text, 'utf-8')]),
  };
}

/** A 200 whose body dies partway through, the shape a tripped cap produces. */
function failingFeed(prefixLines, code) {
  const err = new Error('boom');
  err.code = code;
  err.limitBytes = 5 * 1024 * 1024;
  err.stage = 'decompressed';
  let sent = false;
  return {
    ok: true, status: 200, statusText: 'OK', headers: {},
    stream: new Readable({
      read() {
        if (!sent) { sent = true; this.push(Buffer.from(prefixLines.join('\n') + '\n')); return; }
        this.destroy(err);
      },
    }),
  };
}

const domainsFor = (slug) => getDb()
  .prepare('SELECT domain FROM blocklist_domains WHERE category_slug = ? ORDER BY domain')
  .pluck().all(slug);

beforeAll(async () => {
  const s = await setupTestDb();
  tmpDir = s.tmpDir;
  ensureCategoryRows(getDb());
});
afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  openPinnedOutboundStream.mockReset();
  const db = getDb();
  db.exec("DELETE FROM blocklist_domains; DELETE FROM blocklist_stage;");
  db.prepare("UPDATE blocklist_categories SET domain_count = 0, etag = NULL, last_modified = NULL, last_error = NULL").run();
  setSetting('blocklist_max_feed_mb', '128');
});

describe('parseDomainLine', () => {
  it('accepts a bare domain and lowercases it', () => {
    expect(parseDomainLine('Evil.Example.COM')).toBe('evil.example.com');
    expect(parseDomainLine('  spaced.example.com  ')).toBe('spaced.example.com');
  });

  it('skips blanks and comment lines', () => {
    for (const line of ['', '   ', '# Title: Malware Block List', '   # indented']) {
      expect(parseDomainLine(line)).toBeNull();
    }
  });

  it('strips inline comments', () => {
    expect(parseDomainLine('evil.example.com # known c2')).toBe('evil.example.com');
  });

  it('rejects bare IPs, localhost, single labels and over-long names', () => {
    expect(parseDomainLine('10.0.0.1')).toBeNull();
    expect(parseDomainLine('localhost')).toBeNull();
    expect(parseDomainLine('intranet')).toBeNull();
    expect(parseDomainLine('a'.repeat(250) + '.example.com')).toBeNull();
  });

  it('rejects hosts-file format rather than silently mangling it', () => {
    // The trap for anyone pointing a category at a hosts-style feed: these
    // lines must not parse, so the caller can report an empty feed loudly.
    expect(parseDomainLine('0.0.0.0 evil.example.com')).toBeNull();
    expect(parseDomainLine('127.0.0.1\tevil.example.com')).toBeNull();
  });
});

describe('getMaxFeedBytes', () => {
  it('reads the setting and converts MB to bytes', () => {
    setSetting('blocklist_max_feed_mb', '64');
    expect(getMaxFeedBytes()).toBe(64 * 1024 * 1024);
  });

  it('falls back to 128MB on a junk or non-positive value', () => {
    for (const bad of ['', 'abc', '0', '-5']) {
      setSetting('blocklist_max_feed_mb', bad);
      expect(getMaxFeedBytes(), `value ${JSON.stringify(bad)}`).toBe(128 * 1024 * 1024);
    }
  });
});

describe('refreshCategory', () => {
  it('imports a feed and records validators', async () => {
    openPinnedOutboundStream.mockResolvedValue(feed(
      '# comment\nevil.example.com\nbad.example.com\n\nevil.example.com\n'
    ));

    const r = await refreshCategory(getDb(), 'malware');

    // The duplicate line must not inflate the count.
    expect(r).toMatchObject({ count: 2, changed: true, notModified: false });
    expect(domainsFor('malware')).toEqual(['bad.example.com', 'evil.example.com']);

    const row = getDb().prepare("SELECT * FROM blocklist_categories WHERE slug='malware'").get();
    expect(row.domain_count).toBe(2);
    expect(row.etag).toBe('W/"v1"');
    expect(row.last_modified).toBe('Mon, 20 Jul 2026 13:07:13 GMT');
    expect(row.last_error).toBeNull();
  });

  it('sends conditional headers once validators are stored', async () => {
    openPinnedOutboundStream.mockResolvedValue(feed('evil.example.com\n'));
    await refreshCategory(getDb(), 'malware');

    openPinnedOutboundStream.mockResolvedValue(feed('evil.example.com\n'));
    await refreshCategory(getDb(), 'malware');

    const { headers } = openPinnedOutboundStream.mock.calls[1][1];
    expect(headers['If-None-Match']).toBe('W/"v1"');
    expect(headers['If-Modified-Since']).toBe('Mon, 20 Jul 2026 13:07:13 GMT');
  });

  it('treats 304 as a no-op and keeps existing domains', async () => {
    openPinnedOutboundStream.mockResolvedValue(feed('evil.example.com\nbad.example.com\n'));
    await refreshCategory(getDb(), 'malware');

    openPinnedOutboundStream.mockResolvedValue({ ok: false, status: 304, headers: {} });
    const r = await refreshCategory(getDb(), 'malware');

    expect(r).toMatchObject({ count: 2, changed: false, notModified: true });
    expect(domainsFor('malware')).toEqual(['bad.example.com', 'evil.example.com']);
    // last_fetched_at still advances, so the scheduler does not spin on it.
    expect(getDb().prepare("SELECT last_fetched_at FROM blocklist_categories WHERE slug='malware'").pluck().get())
      .toBeTruthy();
  });

  it('sweeps domains that left the feed, and adds the new ones', async () => {
    openPinnedOutboundStream.mockResolvedValue(feed('stays.example.com\ngoes.example.com\n'));
    await refreshCategory(getDb(), 'malware');

    openPinnedOutboundStream.mockResolvedValue(feed('stays.example.com\narrives.example.com\n'));
    await refreshCategory(getDb(), 'malware');

    expect(domainsFor('malware')).toEqual(['arrives.example.com', 'stays.example.com']);
    expect(getDb().prepare('SELECT COUNT(*) c FROM blocklist_stage').get().c).toBe(0);
  });

  it('leaves the live blocklist untouched when the download dies mid-stream', async () => {
    openPinnedOutboundStream.mockResolvedValue(feed('keep-me.example.com\nalso-keep.example.com\n'));
    await refreshCategory(getDb(), 'malware');
    const before = domainsFor('malware');

    openPinnedOutboundStream.mockResolvedValue(failingFeed(['brand-new.example.com'], TOO_LARGE_CODE));
    await expect(refreshCategory(getDb(), 'malware')).rejects.toThrow(/Max Feed Size \(MB\)/);

    // Nothing added, nothing swept: staging absorbed the partial feed.
    expect(domainsFor('malware')).toEqual(before);
    expect(getDb().prepare('SELECT COUNT(*) c FROM blocklist_stage').get().c).toBe(0);
  });

  it('reports an over-cap Content-Length with the actual size and the setting to raise', async () => {
    const cause = new Error('too big');
    cause.code = TOO_LARGE_CODE;
    cause.limitBytes = 5 * 1024 * 1024;
    cause.actualBytes = 51 * 1024 * 1024;
    cause.stage = 'content-length';
    openPinnedOutboundStream.mockResolvedValue({ ok: false, status: 200, headers: {}, error: 'too big', cause });

    await expect(refreshCategory(getDb(), 'malware')).rejects.toThrow(/Feed is 51 MB, over the 128 MB limit/);
    expect(getDb().prepare("SELECT last_error FROM blocklist_categories WHERE slug='malware'").pluck().get())
      .toMatch(/Max Feed Size \(MB\)/);
  });

  it('says "compressed" when the measured size was the gzip transfer size', async () => {
    const cause = new Error('too big');
    cause.code = TOO_LARGE_CODE;
    cause.actualBytes = 16 * 1024 * 1024;
    cause.compressed = true;
    cause.stage = 'content-length';
    openPinnedOutboundStream.mockResolvedValue({ ok: false, status: 200, headers: {}, error: 'too big', cause });

    await expect(refreshCategory(getDb(), 'malware')).rejects.toThrow(/16 MB compressed/);
  });

  it('refuses a feed that parsed to nothing rather than sweeping the category empty', async () => {
    openPinnedOutboundStream.mockResolvedValue(feed('evil.example.com\nbad.example.com\n'));
    await refreshCategory(getDb(), 'malware');

    // Hosts-file format: every line fails validation.
    openPinnedOutboundStream.mockResolvedValue(feed('0.0.0.0 evil.example.com\n0.0.0.0 bad.example.com\n'));
    await expect(refreshCategory(getDb(), 'malware')).rejects.toThrow(/no valid domains/);

    expect(domainsFor('malware')).toEqual(['bad.example.com', 'evil.example.com']);
  });

  it('records last_error when the write phase fails after a good download', async () => {
    openPinnedOutboundStream.mockResolvedValue(feed('keep-me.example.com\n'));
    await refreshCategory(getDb(), 'malware');

    // Simulate the driver throwing during the staged-to-live apply (disk full,
    // SQLITE_BUSY). The download succeeded, so the download-phase catch cannot
    // cover this; without its own handler the category kept claiming success.
    const db = getDb();
    const realPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('INSERT OR IGNORE INTO blocklist_domains')) {
        throw new Error('database or disk is full');
      }
      return realPrepare(sql);
    });

    try {
      openPinnedOutboundStream.mockResolvedValue(feed('brand-new.example.com\n'));
      await expect(refreshCategory(db, 'malware')).rejects.toThrow(/Storing the feed failed/);
    } finally {
      spy.mockRestore();
    }

    const lastError = getDb().prepare("SELECT last_error FROM blocklist_categories WHERE slug='malware'").pluck().get();
    expect(lastError).toMatch(/disk is full/);
    expect(lastError).toMatch(/still in place/);
    // And the previous list survived.
    expect(domainsFor('malware')).toEqual(['keep-me.example.com']);
  });

  it('records a non-2xx as last_error and keeps existing domains', async () => {
    openPinnedOutboundStream.mockResolvedValue(feed('evil.example.com\n'));
    await refreshCategory(getDb(), 'malware');

    openPinnedOutboundStream.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', headers: {} });
    await expect(refreshCategory(getDb(), 'malware')).rejects.toThrow(/404/);

    expect(domainsFor('malware')).toEqual(['evil.example.com']);
    expect(getDb().prepare("SELECT last_error FROM blocklist_categories WHERE slug='malware'").pluck().get())
      .toMatch(/404/);
  });

  it('imports across batch boundaries', async () => {
    // Larger than one BLOCKLIST_INSERT_BATCH would be too slow here; instead
    // check the staged-to-live apply loop terminates on a non-round count.
    const many = Array.from({ length: 1001 }, (_, i) => `d${String(i).padStart(5, '0')}.example.com`);
    openPinnedOutboundStream.mockResolvedValue(feed(many.join('\n') + '\n'));

    const r = await refreshCategory(getDb(), 'malware');
    expect(r.count).toBe(1001);
    expect(domainsFor('malware')).toHaveLength(1001);
  });

  it('refuses a second refresh while one is already running', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    openPinnedOutboundStream.mockImplementation(async () => {
      await gate;
      return feed('evil.example.com\n');
    });

    const first = refreshCategory(getDb(), 'malware');
    await expect(refreshCategory(getDb(), 'ads')).rejects.toThrow(/already in progress/);
    release();
    await first;
  });
});
