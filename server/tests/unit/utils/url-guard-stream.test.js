import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { openPinnedOutboundStream, TOO_LARGE_CODE, validateOutboundUrl } from '../../../src/utils/url-guard.js';

// The SSRF guard blocks loopback by design, so these tests hand the function a
// pre-validated { ok, url, ip } object, which is the same shape routes/pihole.js
// passes to avoid re-resolving. That is the documented second input form.
let server, port;

const BIG = Buffer.alloc(4 * 1024 * 1024, 0x61);          // 4MB of 'a'
const BOMB = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0));  // ~8KB on the wire, 8MB expanded

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const wantsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
    switch (req.url) {
      case '/plain':
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('alpha\nbeta\ngamma\n');
      case '/gzip':
        res.writeHead(200, { 'Content-Encoding': 'gzip' });
        return res.end(gzipSync(Buffer.from('alpha\nbeta\ngamma\n')));
      case '/echo-accept-encoding':
        res.writeHead(200);
        return res.end(wantsGzip ? 'gzip-requested' : 'identity-requested');
      case '/big-chunked':
        // No Content-Length, so only the streaming cap can catch this.
        res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
        return res.end(BIG);
      case '/big-declared':
        res.writeHead(200, { 'Content-Length': String(BIG.length) });
        return res.end(BIG);
      case '/bomb':
        res.writeHead(200, { 'Content-Encoding': 'gzip' });
        return res.end(BOMB);
      case '/not-modified':
        return res.writeHead(304).end();
      case '/redirect':
        return res.writeHead(302, { Location: 'http://evil.example.com/next' }).end();
      case '/boom':
        return res.writeHead(500).end('server error');
      default:
        return res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

const target = (path) => ({ ok: true, url: `http://127.0.0.1:${port}${path}`, ip: '127.0.0.1' });

async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

describe('openPinnedOutboundStream', () => {
  it('streams a plain 200 body', async () => {
    const res = await openPinnedOutboundStream(target('/plain'), { maxBytes: 1024 * 1024 });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await collect(res.stream)).toBe('alpha\nbeta\ngamma\n');
  });

  it('requests gzip by default and decodes it', async () => {
    const probe = await openPinnedOutboundStream(target('/echo-accept-encoding'), { maxBytes: 1024 });
    expect(await collect(probe.stream)).toBe('gzip-requested');

    const res = await openPinnedOutboundStream(target('/gzip'), { maxBytes: 1024 * 1024 });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(await collect(res.stream)).toBe('alpha\nbeta\ngamma\n');
  });

  it('can be told not to request gzip', async () => {
    const res = await openPinnedOutboundStream(target('/echo-accept-encoding'), { maxBytes: 1024, acceptGzip: false });
    expect(await collect(res.stream)).toBe('identity-requested');
  });

  it('rejects an over-cap Content-Length before reading the body', async () => {
    const res = await openPinnedOutboundStream(target('/big-declared'), { maxBytes: 1024 });
    expect(res.ok).toBe(false);
    expect(res.cause.code).toBe(TOO_LARGE_CODE);
    expect(res.cause.stage).toBe('content-length');
    expect(res.cause.actualBytes).toBe(BIG.length);
    expect(res.stream).toBeUndefined();
  });

  it('trips the wire cap on a chunked body with no Content-Length', async () => {
    const res = await openPinnedOutboundStream(target('/big-chunked'), { maxBytes: 64 * 1024 });
    expect(res.ok).toBe(true); // headers looked fine, the body is what fails
    const err = await collect(res.stream).then(() => null, e => e);
    expect(err).toBeTruthy();
    expect(err.code).toBe(TOO_LARGE_CODE);
    expect(err.stage).toBe('wire');
  });

  it('trips the decompressed cap on a gzip bomb that passes the wire cap', async () => {
    // ~8KB on the wire, 8MB expanded. A wire-only cap would wave this through,
    // which is the whole reason the second cap exists: the feed URL is
    // operator-editable.
    expect(BOMB.length).toBeLessThan(1024 * 1024);
    const res = await openPinnedOutboundStream(target('/bomb'), { maxBytes: 1024 * 1024 });
    expect(res.ok).toBe(true);
    const err = await collect(res.stream).then(() => null, e => e);
    expect(err).toBeTruthy();
    expect(err.code).toBe(TOO_LARGE_CODE);
    expect(err.stage).toBe('decompressed');
  });

  it('returns 304 with no stream', async () => {
    const res = await openPinnedOutboundStream(target('/not-modified'), { maxBytes: 1024 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(304);
    expect(res.stream).toBeUndefined();
  });

  it('does not follow redirects, and surfaces Location instead', async () => {
    // Following redirects would reopen the DNS rebinding window that pinning
    // closes: the validated IP would no longer match the host being fetched.
    const res = await openPinnedOutboundStream(target('/redirect'), { maxBytes: 1024 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://evil.example.com/next');
    expect(res.stream).toBeUndefined();
  });

  it('reports a non-2xx without a stream', async () => {
    const res = await openPinnedOutboundStream(target('/boom'), { maxBytes: 1024 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.stream).toBeUndefined();
  });

  it('still applies the SSRF guard when given a raw URL', async () => {
    // Same policy as requestPinnedOutboundUrl: loopback is refused.
    const res = await openPinnedOutboundStream(`http://127.0.0.1:${port}/plain`, { maxBytes: 1024 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked range/);

    // And the shared validator agrees, so the two entry points cannot drift.
    expect((await validateOutboundUrl('http://127.0.0.1/x')).ok).toBe(false);
    expect((await validateOutboundUrl('http://169.254.169.254/latest/meta-data')).ok).toBe(false);
    expect((await validateOutboundUrl('file:///etc/passwd')).ok).toBe(false);
  });

  it('reports a connection failure rather than throwing', async () => {
    const dead = { ok: true, url: 'http://127.0.0.1:1/nope', ip: '127.0.0.1' };
    const res = await openPinnedOutboundStream(dead, { maxBytes: 1024, timeout: 2000 });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
