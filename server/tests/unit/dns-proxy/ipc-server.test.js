import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIpcServer, createOutbox } from '../../../src/dns-proxy/ipc-server.js';
import { encode, createDecoder } from '../../../src/dns-proxy/protocol.js';

describe('the outbox', () => {
  it('drops the oldest rows past its limit and counts them', () => {
    const outbox = createOutbox({ rows: 3, resolutions: 2, liveness: 2 });
    for (let i = 1; i <= 5; i++) outbox.row({ n: i });
    const sent = [];
    outbox.flush((m) => sent.push(m) > 0);
    expect(sent[0]).toEqual({ type: 'rows', rows: [{ n: 3 }, { n: 4 }, { n: 5 }] });
    expect(outbox.dropped().rows).toBe(2);
  });

  it('sends each client address once, either family, and drops the oldest past its limit', () => {
    const outbox = createOutbox({ rows: 10, resolutions: 2, liveness: 2 });
    for (const ip of ['10.0.0.1', '10.0.0.1', 'fd00::1', '10.0.0.2']) outbox.client(ip);
    const sent = [];
    outbox.flush((m) => sent.push(m) > 0);
    expect(sent).toEqual([{ type: 'liveness', clients: ['fd00::1', '10.0.0.2'] }]);
    expect(outbox.dropped().liveness).toBe(1);
  });

  it('keeps what it could not send, in order, for the next flush', () => {
    const outbox = createOutbox({ rows: 10, resolutions: 2, liveness: 2 });
    outbox.row({ n: 1 });
    outbox.row({ n: 2 });
    outbox.flush(() => false);
    outbox.row({ n: 3 });
    const sent = [];
    outbox.flush((m) => sent.push(m) > 0);
    expect(sent[0].rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});

describe('the IPC server', () => {
  let dir;
  let server;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-ipc-'));
  });
  afterEach(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const connect = (socketPath) =>
    new Promise((resolve) => {
      const sock = net.connect(socketPath, () => resolve(sock));
      sock.received = [];
      sock.on(
        'data',
        createDecoder(
          (m) => sock.received.push(m),
          () => {},
        ),
      );
    });

  it('takes one client at a time: a new one replaces the old', async () => {
    const socketPath = path.join(dir, 'p.sock');
    const got = [];
    server = createIpcServer({ socketPath, onMessage: (m) => got.push(m) });
    await server.listen();
    expect(fs.statSync(socketPath).mode & 0o077).toBe(0);
    const first = await connect(socketPath);
    const closed = new Promise((resolve) => first.on('close', resolve));
    const second = await connect(socketPath);
    await closed;
    second.write(encode({ type: 'hello' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(got).toEqual([{ type: 'hello' }]);
    server.send({ type: 'status' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(second.received).toEqual([{ type: 'status' }]);
    second.destroy();
  });

  it('replaces a stale socket file, and refuses to start beside a live proxy', async () => {
    const socketPath = path.join(dir, 'p.sock');
    fs.writeFileSync(socketPath, '');
    server = createIpcServer({ socketPath, onMessage: () => {} });
    await server.listen();
    const other = createIpcServer({ socketPath, onMessage: () => {} });
    await expect(other.listen()).rejects.toThrow(/another DNS proxy/);
  });
});

describe('the socket path', () => {
  it('refuses a path longer than a Unix socket holds instead of cutting it short', async () => {
    const socketPath = path.join(os.tmpdir(), 'x'.repeat(120), 'p.sock');
    const server = createIpcServer({ socketPath, onMessage: () => {} });
    await expect(server.listen()).rejects.toThrow(/more than a Unix socket path holds/);
  });
});
