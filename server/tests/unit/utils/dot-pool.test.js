/**
 * The DoT pool keeps one verified TLS connection per upstream address and
 * pipelines queries on it. Run against a local TLS server with a throwaway
 * certificate for `dot.test`; the pool trusts it through `tlsOptions.ca`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import tls from 'tls';
import dnsPacket from 'dns-packet';
import { createDotPool } from '../../../src/utils/dot-pool.js';
import { extractTcpMessages, frameTcpMessage } from '../../../src/utils/dns-wire.js';

let tmpDir;
let cert;
let server;
let port;
let connections;
let received;
// What the server does with a query, by its name.
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

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-dot-pool-'));
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
      '/CN=dot.test',
      '-addext',
      'subjectAltName=DNS:dot.test',
      '-days',
      '1',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: 'ignore' },
  );
  cert = fs.readFileSync(certPath);
  server = tls.createServer({ key: fs.readFileSync(keyPath), cert }, (socket) => {
    connections++;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { messages, rest } = extractTcpMessages(buf);
      buf = rest;
      for (const message of messages) {
        received.push(message);
        const action = behavior(nameOf(message), received.length);
        if (action === 'close') return socket.destroy();
        if (action === 'hang') continue;
        const reply = () => socket.writable && socket.write(frameTcpMessage(answer(message)));
        if (typeof action === 'number') setTimeout(reply, action);
        else reply();
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  connections = 0;
  received = [];
  behavior = () => 'answer';
});

const upstream = { hostname: 'dot.test', addresses: ['127.0.0.1'] };

function pool(opts = {}) {
  const errors = [];
  const p = createDotPool({
    timeoutMs: 1000,
    port,
    tlsOptions: { ca: cert },
    onError: (error, up, address) => errors.push({ message: error.message, address }),
    ...opts,
  });
  return { ...p, errors };
}

describe('DoT pool', () => {
  it('answers on one connection and gives each caller its own query id back', async () => {
    const p = pool();
    try {
      const a = dnsPacket.decode(await p.query(query(0x1111, 'a.example'), upstream));
      const b = dnsPacket.decode(await p.query(query(0x2222, 'b.example'), upstream));
      expect([a.id, a.answers[0].name]).toEqual([0x1111, 'a.example']);
      expect([b.id, b.answers[0].name]).toEqual([0x2222, 'b.example']);
      expect(connections).toBe(1);
    } finally {
      p.closeAll();
    }
  });

  it('matches out-of-order replies to the right caller', async () => {
    behavior = (name) => (name === 'slow.example' ? 100 : 'answer');
    const p = pool();
    try {
      const [slow, fast] = await Promise.all([
        p.query(query(7, 'slow.example'), upstream),
        p.query(query(7, 'fast.example'), upstream),
      ]);
      expect(dnsPacket.decode(slow).answers[0].name).toBe('slow.example');
      expect(dnsPacket.decode(fast).answers[0].name).toBe('fast.example');
      // Both rode one connection, under different wire ids.
      expect(connections).toBe(1);
      expect(new Set(received.map((m) => m.readUInt16BE(0))).size).toBe(2);
    } finally {
      p.closeAll();
    }
  });

  it('retries once on a new connection when an open one closes mid-query', async () => {
    behavior = (_name, count) => (count === 1 ? 'close' : 'answer');
    const p = pool();
    try {
      const out = await p.query(query(9, 'retry.example'), upstream);
      expect(dnsPacket.decode(out).answers[0].name).toBe('retry.example');
      expect(connections).toBe(2);
      expect(p.errors).toHaveLength(1);
    } finally {
      p.closeAll();
    }
  });

  it('fails closed when the upstream never answers', async () => {
    behavior = () => 'hang';
    const p = pool({ timeoutMs: 150 });
    try {
      expect(await p.query(query(1, 'hang.example'), upstream)).toBeNull();
      expect(p.errors[0].message).toBe('DoT timeout');
    } finally {
      p.closeAll();
    }
  });

  it('moves to the next address when one refuses the connection', async () => {
    const p = pool();
    try {
      // Nothing listens on 127.0.0.2 at this port; the server is bound to 127.0.0.1.
      const out = await p.query(query(3, 'failover.example'), {
        hostname: 'dot.test',
        addresses: ['127.0.0.2', '127.0.0.1'],
      });
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
      expect(await untrusted.query(query(4, 'x.example'), upstream)).toBeNull();
      expect(
        await wrongName.query(query(5, 'x.example'), { ...upstream, hostname: 'other.test' }),
      ).toBeNull();
      expect(received).toHaveLength(0);
    } finally {
      untrusted.closeAll();
      wrongName.closeAll();
    }
  });

  it('closes an idle connection and opens a new one for the next query', async () => {
    const p = pool({ idleMs: 50 });
    try {
      await p.query(query(1, 'one.example'), upstream);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const out = await p.query(query(2, 'two.example'), upstream);
      expect(dnsPacket.decode(out).answers[0].name).toBe('two.example');
      expect(connections).toBe(2);
      expect(p.errors).toHaveLength(0);
    } finally {
      p.closeAll();
    }
  });

  it('reports a missing address without connecting', async () => {
    const p = pool();
    expect(
      await p.query(query(1, 'x.example'), { hostname: 'dot.test', addresses: [] }),
    ).toBeNull();
    expect(p.errors[0].message).toBe('no upstream address');
    expect(connections).toBe(0);
  });
});
