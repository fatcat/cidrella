import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLogTail } from '../../../src/utils/log-reader.js';

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
      newOffset: 22
    });
  });

  it('returns all complete lines and advances to EOF', () => {
    const file = logFile('one\ntwo\n');
    expect(readLogTail(file, 0)).toEqual({ lines: ['one', 'two'], newOffset: 8 });
  });
});
