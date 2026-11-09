import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIpcServer } from '../../../src/ipc/server.js';
import { encode, createDecoder } from '../../../src/ipc/framing.js';

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
    server = createIpcServer({ socketPath, name: 'DNS proxy', onMessage: (m) => got.push(m) });
    await server.listen();
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
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
    server = createIpcServer({ socketPath, name: 'DNS proxy', onMessage: () => {} });
    await server.listen();
    const other = createIpcServer({ socketPath, name: 'DNS proxy', onMessage: () => {} });
    await expect(other.listen()).rejects.toThrow(/another DNS proxy/);
  });
});

describe('the socket mode', () => {
  it('gives the socket the mode asked for, never wider at any moment', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-ipc-'));
    const socketPath = path.join(dir, 'h.sock');
    const before = process.umask();
    const server = createIpcServer({ socketPath, name: 'helper', mode: 0o660, onMessage: () => {} });
    await server.listen();
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o660);
    expect(process.umask()).toBe(before);
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the socket path', () => {
  it('refuses a path longer than a Unix socket holds instead of cutting it short', async () => {
    const socketPath = path.join(os.tmpdir(), 'x'.repeat(120), 'p.sock');
    const server = createIpcServer({ socketPath, name: 'DNS proxy', onMessage: () => {} });
    await expect(server.listen()).rejects.toThrow(/more than a Unix socket path holds/);
  });
});
