/**
 * The upstream pool keeps one verified connection per upstream address and
 * reuses it. Every policy case runs against three local servers holding a
 * throwaway certificate for `upstream.test` (trusted through `tlsOptions.ca`):
 * DoT, DoH over HTTP/2, and DoH on a server that only speaks HTTP/1.1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import http2 from 'http2';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import dnsPacket from 'dns-packet';
import { createUpstreamPool } from '../../../src/utils/upstream-pool.js';
import { extractTcpMessages, frameTcpMessage } from '../../../src/utils/dns-wire.js';

const HOSTNAME = 'upstream.test';

let tmpDir;
let key;
let cert;
let connections;
let received;
// What a server does with a query: 'answer', 'close', 'hang', 'status'
// (an HTTP 500; DoT answers it), or a delay in ms before answering.
let behavior;

function query(id, name) {
  return dnsPacket.encode({
    id,
    type: 'query',
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type: 'A', name }],
  });
}

function answer(message) {
  const q = dnsPacket.decode(message);
  return dnsPacket.encode({
    id: q.id,
    type: 'response',
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.RECURSION_AVAILABLE,
    questions: q.questions,
    answers: [{ type: 'A', name: q.questions[0].name, ttl: 60, data: '192.0.2.1' }],
  });
}

const nameOf = (buf) => dnsPacket.decode(buf).questions[0].name;

function actionFor(message) {
  received.push(message);
  return behavior(nameOf(message), received.length);
}

// One DoH request on either server: `res` is the compat response for both.
function onDohRequest(req, res, drop) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const message = Buffer.concat(chunks);
    const action = actionFor(message);
    if (action === 'close') return drop();
    if (action === 'hang') return;
    const reply = () => {
      if (res.writableEnded || res.destroyed) return;
      if (action === 'status') {
        res.writeHead(500);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/dns-message' });
      res.end(answer(message));
    };
    if (typeof action === 'number') setTimeout(reply, action);
    else reply();
  });
}

function dotServer() {
  return tls.createServer({ key, cert }, (socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { messages, rest } = extractTcpMessages(buf);
      buf = rest;
      for (const message of messages) {
        const action = actionFor(message);
        if (action === 'close') return socket.destroy();
        if (action === 'hang') continue;
        const reply = () => socket.writable && socket.write(frameTcpMessage(answer(message)));
        if (typeof action === 'number') setTimeout(reply, action);
        else reply();
      }
    });
    socket.on('error', () => {});
  });
}

const h2Server = () =>
  http2.createSecureServer({ key, cert }, (req, res) =>
    onDohRequest(req, res, () => req.stream.session.destroy()),
  );

// No ALPN on a plain https server: a client offering h2 gets no protocol.
const h1Server = () =>
  https.createServer({ key, cert }, (req, res) =>
    onDohRequest(req, res, () => req.socket.destroy()),
  );

// The three servers on one loopback address.
async function startServers(host) {
  const servers = { dot: dotServer(), doh: h2Server(), 'doh-h1': h1Server() };
  const sockets = new Set();
  const ports = {};
  for (const [kind, server] of Object.entries(servers)) {
    server.on('connection', (socket) => {
      connections++;
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, resolve);
    });
    ports[kind] = server.address().port;
  }
  return {
    ports,
    close() {
      for (const socket of sockets) socket.destroy();
      for (const server of Object.values(servers)) server.close();
    },
  };
}

let v4;
let v6 = null;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-upstream-pool-'));
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-subj',
      `/CN=${HOSTNAME}`,
      '-addext',
      `subjectAltName=DNS:${HOSTNAME}`,
      '-days',
      '1',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: 'ignore' },
  );
  key = fs.readFileSync(keyPath);
  cert = fs.readFileSync(certPath);
  v4 = await startServers('127.0.0.1');
  v6 = await startServers('::1').catch(() => null); // no IPv6 loopback in some sandboxes
});

afterAll(() => {
  v4?.close();
  v6?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  connections = 0;
  received = [];
  behavior = () => 'answer';
});

// probe: the HTTP/2 attempt the HTTP/1.1-only server refuses before the pool
// remembers it, one extra connection on the first query.
const KINDS = [
  { kind: 'dot', protocol: 'dot', label: 'DoT', probe: 0 },
  { kind: 'doh', protocol: 'doh', label: 'DoH', probe: 0 },
  { kind: 'doh-h1', protocol: 'doh', label: 'DoH', probe: 1 },
];

describe.each(KINDS)('$kind', ({ kind, protocol, label, probe }) => {
  function upstreamFor(servers, { addresses, hostname = HOSTNAME } = {}) {
    const port = servers.ports[kind];
    return {
      hostname,
      addresses: addresses || [servers === v6 ? '::1' : '127.0.0.1'],
      doh_url: `https://${hostname}:${port}/dns-query`,
    };
  }

  function pool(opts = {}) {
    const errors = [];
    const p = createUpstreamPool({
      protocol,
      timeoutMs: 1000,
      port: v4.ports.dot,
      tlsOptions: { ca: cert },
      onError: (error, up, address) => errors.push({ message: error.message, address }),
      ...opts,
    });
    return { ...p, errors };
  }

  it('answers on one connection and gives each caller its own query id back', async () => {
    const p = pool();
    const upstream = upstreamFor(v4);
    try {
      const a = dnsPacket.decode(await p.query(query(0x1111, 'a.example'), upstream));
      const b = dnsPacket.decode(await p.query(query(0x2222, 'b.example'), upstream));
      expect([a.id, a.answers[0].name]).toEqual([0x1111, 'a.example']);
      expect([b.id, b.answers[0].name]).toEqual([0x2222, 'b.example']);
      expect(connections).toBe(1 + probe);
    } finally {
      p.closeAll();
    }
  });

  it('answers concurrent queries, each to its own caller, out of order', async () => {
    behavior = (name) => (name === 'slow.example' ? 100 : 'answer');
    const p = pool();
    const upstream = upstreamFor(v4);
    try {
      const [slow, fast] = await Promise.all([
        p.query(query(7, 'slow.example'), upstream),
        p.query(query(7, 'fast.example'), upstream),
      ]);
      expect(dnsPacket.decode(slow).answers[0].name).toBe('slow.example');
      expect(dnsPacket.decode(fast).answers[0].name).toBe('fast.example');
    } finally {
      p.closeAll();
    }
  });

  it('sends again on a new connection when a reused one drops mid-query', async () => {
    behavior = (_name, count) => (count === 2 ? 'close' : 'answer');
    const p = pool();
    const upstream = upstreamFor(v4);
    try {
      await p.query(query(8, 'first.example'), upstream);
      const out = await p.query(query(9, 'retry.example'), upstream);
      expect(dnsPacket.decode(out).answers[0].name).toBe('retry.example');
      expect(connections).toBe(2 + probe);
      // Answered in the end, so not a failure.
      expect(p.errors).toHaveLength(0);
    } finally {
      p.closeAll();
    }
  });

  // An HTTP/1.1 request dropped on a fresh socket reads as a connect failure,
  // so only the reused connection gets resent there; these two are DoT and h2.
  it.skipIf(kind === 'doh-h1')(
    'rides out connections dropped twice in a row, as Quad9 does',
    async () => {
      const p = pool();
      const upstream = upstreamFor(v4);
      try {
        await p.query(query(8, 'first.example'), upstream);
        let drops = 0;
        behavior = () => (drops++ < 2 ? 'close' : 'answer');
        const out = await p.query(query(9, 'again.example'), upstream);
        expect(dnsPacket.decode(out).answers[0].name).toBe('again.example');
        expect(p.errors).toHaveLength(0);
      } finally {
        p.closeAll();
      }
    },
  );

  it.skipIf(kind === 'doh-h1')(
    'moves to the next address when one keeps dropping the query',
    async () => {
      const p = pool();
      try {
        let drops = 0;
        behavior = () => (drops++ < 3 ? 'close' : 'answer');
        const out = await p.query(
          query(9, 'next.example'),
          upstreamFor(v4, { addresses: ['127.0.0.1', '127.0.0.1'] }),
        );
        expect(dnsPacket.decode(out).answers[0].name).toBe('next.example');
        expect(p.errors.map((e) => e.address)).toEqual(['127.0.0.1']);
      } finally {
        p.closeAll();
      }
    },
  );

  it('gives up on an address that never stops dropping the query', async () => {
    behavior = () => 'close';
    const p = pool();
    try {
      expect(await p.query(query(1, 'gone.example'), upstreamFor(v4))).toBeNull();
      expect(p.errors).toHaveLength(1);
    } finally {
      p.closeAll();
    }
  });

  it('fails closed when the upstream never answers', async () => {
    behavior = () => 'hang';
    const p = pool({ timeoutMs: 150 });
    try {
      expect(await p.query(query(1, 'hang.example'), upstreamFor(v4))).toBeNull();
      expect(p.errors[0].message).toBe(`${label} timeout`);
    } finally {
      p.closeAll();
    }
  });

  it('drops a connection that let a query time out, so the next one connects fresh', async () => {
    // A half-open connection would otherwise take every later query down with it.
    behavior = (_name, count) => (count === 1 ? 'hang' : 'answer');
    const p = pool({ timeoutMs: 150 });
    const upstream = upstreamFor(v4);
    try {
      expect(await p.query(query(1, 'lost.example'), upstream)).toBeNull();
      const out = await p.query(query(2, 'next.example'), upstream);
      expect(dnsPacket.decode(out).answers[0].name).toBe('next.example');
      expect(connections).toBe(2 + probe);
    } finally {
      p.closeAll();
    }
  });

  it('moves to the next address when one refuses the connection', async () => {
    const p = pool();
    try {
      // Nothing listens on 127.0.0.2; the servers are bound to 127.0.0.1.
      const out = await p.query(
        query(3, 'failover.example'),
        upstreamFor(v4, { addresses: ['127.0.0.2', '127.0.0.1'] }),
      );
      expect(dnsPacket.decode(out).answers[0].name).toBe('failover.example');
      expect(p.errors.map((e) => e.address)).toEqual(['127.0.0.2']);
    } finally {
      p.closeAll();
    }
  });

  it('refuses a certificate it cannot verify, or one for another name', async () => {
    const untrusted = pool({ tlsOptions: {} });
    const wrongName = pool();
    try {
      expect(await untrusted.query(query(4, 'x.example'), upstreamFor(v4))).toBeNull();
      expect(
        await wrongName.query(query(5, 'x.example'), upstreamFor(v4, { hostname: 'other.test' })),
      ).toBeNull();
      expect(received).toHaveLength(0);
    } finally {
      untrusted.closeAll();
      wrongName.closeAll();
    }
  });

  it('closes an idle connection and opens a new one for the next query', async () => {
    const p = pool({ idleMs: 50 });
    const upstream = upstreamFor(v4);
    try {
      await p.query(query(1, 'one.example'), upstream);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const out = await p.query(query(2, 'two.example'), upstream);
      expect(dnsPacket.decode(out).answers[0].name).toBe('two.example');
      expect(connections).toBe(2 + probe);
      expect(p.errors).toHaveLength(0);
    } finally {
      p.closeAll();
    }
  });

  it('reports a missing address without connecting', async () => {
    const p = pool();
    expect(await p.query(query(1, 'x.example'), upstreamFor(v4, { addresses: [] }))).toBeNull();
    expect(p.errors[0].message).toBe('no upstream address');
    expect(connections).toBe(0);
  });

  it('answers over IPv6', async () => {
    if (!v6) return; // no IPv6 loopback here; the IPv4 cases above still ran
    const p = pool({ port: v6.ports.dot });
    try {
      const out = await p.query(query(6, 'six.example'), upstreamFor(v6));
      expect(dnsPacket.decode(out).answers[0].name).toBe('six.example');
    } finally {
      p.closeAll();
    }
  });
});

describe('DoH error status', () => {
  it.each(['doh', 'doh-h1'])('is final on %s: no failover, no retry', async (kind) => {
    behavior = () => 'status';
    const errors = [];
    const p = createUpstreamPool({
      protocol: 'doh',
      timeoutMs: 1000,
      tlsOptions: { ca: cert },
      onError: (error, up, address) => errors.push({ message: error.message, address }),
    });
    try {
      const out = await p.query(query(1, 'x.example'), {
        hostname: HOSTNAME,
        addresses: ['127.0.0.1', '127.0.0.1'],
        doh_url: `https://${HOSTNAME}:${v4.ports[kind]}/dns-query`,
      });
      expect(out).toBeNull();
      expect(errors).toEqual([{ message: 'DoH HTTP 500', address: '127.0.0.1' }]);
      expect(received).toHaveLength(1);
    } finally {
      p.closeAll();
    }
  });
});

it('the IPv6 servers exist where the loopback does', () => {
  // Keeps the skip honest: if ::1 is bindable, the IPv6 cases ran.
  const probe = net.createServer();
  return new Promise((resolve) => {
    probe.once('error', () => resolve(expect(v6).toBeNull()));
    probe.listen(0, '::1', () => probe.close(() => resolve(expect(v6).not.toBeNull())));
  });
});
