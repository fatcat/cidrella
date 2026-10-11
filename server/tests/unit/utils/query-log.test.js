import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({ source: null, listeners: new Set() }));
vi.mock('../../../src/backends/index.js', () => ({
  getService: () => ({ logSource: () => registry.source }),
  onBackendChanged: (fn) => {
    registry.listeners.add(fn);
    return () => registry.listeners.delete(fn);
  },
}));

const { writeQueryLine, resetQueryLog } = await import('../../../src/utils/query-log.js');

const entry = (clientIp) => ({
  clientIp,
  domain: 'host.example',
  queryType: 'A',
  responseCode: 'NOERROR',
  action: 'allowed',
  latencyUs: 2000,
});
// The stream writes asynchronously; wait for what was written to land.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-log-'));
  file = path.join(dir, 'pdns.log');
  registry.listeners.clear();
  resetQueryLog();
});

afterEach(() => {
  resetQueryLog();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeQueryLine', () => {
  it("appends to a backend's log that asks for the proxy's lines, either family", async () => {
    registry.source = { path: file, proxyQueries: true };
    fs.writeFileSync(file, 'Oct 11 13:00:00 a daemon line\n');
    writeQueryLine(entry('10.0.0.5'));
    writeQueryLine(entry('fd00::5'));
    await settle();
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines[0]).toBe('Oct 11 13:00:00 a daemon line');
    expect(lines[1]).toMatch(/ proxy: query\[A\] host\.example from 10\.0\.0\.5, NOERROR, 2 ms$/);
    expect(lines[2]).toMatch(/ from fd00::5, NOERROR, 2 ms$/);
  });

  it('writes nothing for a backend that logs its own queries', async () => {
    registry.source = { path: file, querySourceIp: () => null };
    writeQueryLine(entry('10.0.0.5'));
    await settle();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('follows the DNS role to another backend', async () => {
    registry.source = { path: file, proxyQueries: true };
    writeQueryLine(entry('10.0.0.5'));
    registry.source = { path: path.join(dir, 'dnsmasq.log') };
    for (const fn of registry.listeners) fn('dns');
    writeQueryLine(entry('10.0.0.6'));
    await settle();
    expect(fs.readFileSync(file, 'utf8')).not.toContain('10.0.0.6');
    expect(fs.existsSync(path.join(dir, 'dnsmasq.log'))).toBe(false);
  });

  it('keeps writing after the log is cleared, and reopens one that was removed', async () => {
    registry.source = { path: file, proxyQueries: true };
    const t0 = Date.now();
    writeQueryLine(entry('10.0.0.5'), t0);
    await settle();
    fs.truncateSync(file, 0);
    writeQueryLine(entry('10.0.0.6'), t0 + 1);
    await settle();
    expect(fs.readFileSync(file, 'utf8').trimEnd().split('\n')).toHaveLength(1);
    fs.rmSync(file);
    writeQueryLine(entry('fd00::7'), t0 + 60_000);
    await settle();
    expect(fs.readFileSync(file, 'utf8')).toContain('from fd00::7,');
  });
});
