import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogFollower, readLogTail } from '../../../src/utils/log-reader.js';

const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function logFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-log-reader-'));
  dirs.push(dir);
  const file = path.join(dir, 'dnsmasq.log');
  fs.writeFileSync(file, content);
  return file;
}

describe('readLogTail', () => {
  it('leaves an incomplete trailing line for the next read', () => {
    const file = logFile('complete\npartial');
    const first = readLogTail(file, 0);
    expect(first).toEqual({ lines: ['complete'], newOffset: 9 });

    fs.appendFileSync(file, '-line\n');
    expect(readLogTail(file, first.newOffset)).toEqual({
      lines: ['partial-line'],
      newOffset: 22,
    });
  });

  it('returns all complete lines and advances to EOF', () => {
    const file = logFile('one\ntwo\n');
    expect(readLogTail(file, 0)).toEqual({ lines: ['one', 'two'], newOffset: 8 });
  });
});

describe('createLogFollower', () => {
  it('starts at the end of the log and returns what is written after', () => {
    const file = logFile('old line\n');
    const log = createLogFollower({ path: file });
    expect(log.read()).toEqual([]);
    fs.appendFileSync(file, 'new line\n');
    expect(log.read()).toEqual(['new line']);
  });

  it('follows the log onto a new file from its start', () => {
    const dir = path.dirname(logFile(''));
    const source = { path: null };
    const log = createLogFollower(source);
    expect(log.read()).toEqual([]);
    source.path = path.join(dir, 'kea-legal4.20261007.txt');
    fs.writeFileSync(source.path, 'first day\n');
    expect(log.read()).toEqual(['first day']);
    source.path = path.join(dir, 'kea-legal4.20261008.txt');
    fs.writeFileSync(source.path, 'second day\n');
    expect(log.read()).toEqual(['second day']);
    expect(log.path).toBe(source.path);
  });

  it('reads nothing without a source', () => {
    expect(createLogFollower(null).read()).toEqual([]);
  });
});
