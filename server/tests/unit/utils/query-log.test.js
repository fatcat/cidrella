import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({ source: null }));
vi.mock('../../../src/backends/index.js', () => ({
  getService: () => ({ logSource: () => registry.source }),
}));

const { queryLogPath } = await import('../../../src/utils/query-log.js');
const { writeQueryLine, setQueryLogPath, resetQueryLogWriter } = await import('../../../src/utils/query-log-writer.js');

// What the proxy facade does with the path: hand it to the writer.
const bindQueryLog = () => setQueryLogPath(queryLogPath());

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
  resetQueryLogWriter();
});

afterEach(() => {
  resetQueryLogWriter();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the query log for the DNS backend', () => {
  it("appends to a backend's log that asks for the proxy's lines, either family", async () => {
    registry.source = { path: file, proxyQueries: true };
    fs.writeFileSync(file, 'Oct 11 13:00:00 a daemon line\n');
    bindQueryLog();
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
    bindQueryLog();
    writeQueryLine(entry('10.0.0.5'));
    await settle();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('stops writing when the DNS role moves to a backend that logs its own queries', async () => {
    registry.source = { path: file, proxyQueries: true };
    bindQueryLog();
    writeQueryLine(entry('10.0.0.5'));
    registry.source = { path: path.join(dir, 'dnsmasq.log') };
    bindQueryLog();
    writeQueryLine(entry('10.0.0.6'));
    await settle();
    expect(fs.readFileSync(file, 'utf8')).not.toContain('10.0.0.6');
    expect(fs.existsSync(path.join(dir, 'dnsmasq.log'))).toBe(false);
  });

  it('keeps writing after the log is cleared, and reopens one that was removed', async () => {
    registry.source = { path: file, proxyQueries: true };
    bindQueryLog();
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
