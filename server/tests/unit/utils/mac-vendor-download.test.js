import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

const openPinnedOutboundStream = vi.fn();
vi.mock('../../../src/utils/url-guard.js', () => ({
  openPinnedOutboundStream: (...a) => openPinnedOutboundStream(...a),
  TOO_LARGE_CODE: 'E_FEED_TOO_LARGE',
}));

const rows = [];
const fakeDb = {
  prepare: (sql) => ({
    run: (...a) => { rows.push([sql, a]); },
    get: () => ({ cnt: 0 }),
    all: () => [],
  }),
  transaction: (fn) => (...a) => fn(...a),
};
vi.mock('../../../src/db/init.js', () => ({ getDb: () => fakeDb }));

const mod = await import('../../../src/utils/mac-vendor.js');
const { parseManufLine } = mod;

/**
 * utils/mac-vendor.js download hardening.
 *
 * refreshVendorDb used bare `fetch(MANUF_URL)` followed by `response.text()`,
 * so it had no timeout and no size cap, and buffered the whole body into one
 * string. The blocklist downloader had already grown a cap and a timeout for
 * exactly these reasons and lives behind url-guard.js; this now uses the same
 * path and streams the file line by line.
 *
 * NOT an SSRF fix: MANUF_URL is a hardcoded wireshark.org constant, not
 * operator input, so there is nowhere to redirect it. The exposure was a broken
 * or hostile upstream returning an unbounded body.
 */
describe('parseManufLine', () => {
  it('parses a 24-bit prefix', () => {
    expect(parseManufLine('00:1A:2B\tAcme\tAcme Corporation'))
      .toEqual({ prefix: '00:1A:2B', prefixLength: 24, shortName: 'Acme', vendorName: 'Acme Corporation' });
  });

  it('parses 28-bit and 36-bit prefixes', () => {
    expect(parseManufLine('00:1A:2B:30:00/28\tS\tShort Co')).toMatchObject({ prefix: '00:1A:2B:30:00', prefixLength: 28 });
    expect(parseManufLine('00:1A:2B:30:40/36\tT\tTiny Co')).toMatchObject({ prefix: '00:1A:2B:30:40', prefixLength: 36 });
  });

  it('uppercases the prefix', () => {
    expect(parseManufLine('aa:bb:cc\tx\tX Co').prefix).toBe('AA:BB:CC');
  });

  it('falls back to the short name when there is no full name', () => {
    expect(parseManufLine('00:1A:2B\tOnlyShort')).toMatchObject({ shortName: 'OnlyShort', vendorName: 'OnlyShort' });
  });

  it('skips comments, blanks and malformed lines', () => {
    for (const line of [
      '', '   \tx\ty'.slice(0, 0), '# a comment', '#', 'no-tabs-at-all',
      '00:1A:2B', 'ZZ:ZZ:ZZ\tx\tX', '00-1A-2B\tx\tX', '\tx\tX', '001A2B\tx\tX',
    ]) {
      expect(parseManufLine(line), JSON.stringify(line)).toBeNull();
    }
    expect(parseManufLine(null)).toBeNull();
    expect(parseManufLine(undefined)).toBeNull();
  });

  it('requires at least three octets', () => {
    expect(parseManufLine('00:1A\tx\tX Co')).toBeNull();
    expect(parseManufLine('00:1A:2B\tx\tX Co')).not.toBeNull();
  });
});

describe('refreshVendorDb: the download is capped, timed and guarded', () => {
  let errors;
  beforeEach(() => {
    rows.length = 0;
    openPinnedOutboundStream.mockReset();
    errors = [];
    // The failure path's only output is a log line, and the project rule is
    // that an error must be diagnostic on its own. Asserting the message, not
    // just "nothing was written", is what makes these tests catch a failure
    // handled in the wrong place or with the wrong reason.
    vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const manuf = (n) => Readable.from(
    Array.from({ length: n }, (_, i) =>
      `${i.toString(16).padStart(6, '0').match(/../g).join(':').toUpperCase()}\tV${i}\tVendor ${i}\n`)
  );

  it('asks the guard for a bounded, timed stream rather than calling fetch', async () => {
    openPinnedOutboundStream.mockResolvedValue({ ok: true, stream: manuf(1500) });
    await mod.refreshVendorDb();

    expect(openPinnedOutboundStream).toHaveBeenCalledTimes(1);
    const [url, opts] = openPinnedOutboundStream.mock.calls[0];
    expect(url).toMatch(/^https:\/\/www\.wireshark\.org\//);
    // The two things bare fetch() does not provide, which is the whole point.
    expect(opts.timeout, 'a timeout must be set').toBeGreaterThan(0);
    expect(opts.maxBytes, 'a size cap must be set').toBeGreaterThan(0);
    // Generous enough for the real ~5MB file, bounded enough to matter.
    expect(opts.maxBytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(opts.maxBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it('writes the parsed entries when the download is good', async () => {
    openPinnedOutboundStream.mockResolvedValue({ ok: true, stream: manuf(1500) });
    await mod.refreshVendorDb();
    const inserts = rows.filter(([sql]) => sql.includes('INSERT OR REPLACE INTO mac_vendors'));
    expect(inserts.length).toBe(1500);
  });

  it('writes NOTHING when the guard refuses the download, and says why', async () => {
    openPinnedOutboundStream.mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable' });
    await mod.refreshVendorDb();
    expect(rows.filter(([sql]) => sql.includes('DELETE FROM mac_vendors'))).toHaveLength(0);
    expect(rows.filter(([sql]) => sql.includes('INSERT OR REPLACE'))).toHaveLength(0);
    // Named at the point of failure, not as a downstream "read failed" that
    // hides which stage actually broke.
    expect(errors.join('\n')).toMatch(/download failed/);
    expect(errors.join('\n')).toMatch(/503/);
  });

  it('writes NOTHING when the body exceeds the cap', async () => {
    openPinnedOutboundStream.mockResolvedValue({
      ok: false, cause: { code: 'E_FEED_TOO_LARGE' }, error: 'too large',
    });
    await mod.refreshVendorDb();
    expect(rows).toHaveLength(0);
    // The message must name the cap, so an operator knows what to change.
    expect(errors.join('\n')).toMatch(/exceeded 32MB/);
  });

  it('writes NOTHING when the cap trips mid-stream', async () => {
    const boom = new Readable({ read() { const e = new Error('too large'); e.code = 'E_FEED_TOO_LARGE'; this.destroy(e); } });
    openPinnedOutboundStream.mockResolvedValue({ ok: true, stream: boom });
    await mod.refreshVendorDb();
    expect(rows.filter(([sql]) => sql.includes('DELETE FROM mac_vendors'))).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/mid-stream/);
  });

  it('refuses a suspiciously short file rather than wiping the table', async () => {
    // The existing sanity guard. Worth pinning: without it a truncated download
    // would replace a good 54k-entry table with a handful of rows.
    openPinnedOutboundStream.mockResolvedValue({ ok: true, stream: manuf(10) });
    await mod.refreshVendorDb();
    expect(rows.filter(([sql]) => sql.includes('DELETE FROM mac_vendors'))).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/parsed only 10 entries/);
  });
});
