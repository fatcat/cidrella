import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findExecutable } from '../../../src/utils/executable.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executable-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const make = (relative, mode) => {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, mode);
  return file;
};

describe('findExecutable', () => {
  const sbin = path.join(dir, 'sbin');
  const bin = path.join(dir, 'bin');
  const envPath = [bin, sbin].join(path.delimiter);

  it('finds a bare name on PATH, as a shell would, and not in the working directory', () => {
    const kea = make('sbin/kea-dhcp4', 0o755);
    expect(findExecutable('kea-dhcp4', { envPath })).toBe(kea);
    expect(findExecutable('kea-dhcp4', { envPath: '' })).toBeNull();
  });

  it('takes the first PATH directory that has it, skipping a file it cannot run', () => {
    make('bin/kea-dhcp6', 0o644);
    const runnable = make('sbin/kea-dhcp6', 0o755);
    expect(findExecutable('kea-dhcp6', { envPath })).toBe(runnable);
  });

  it('checks a name with a slash as the path it is', () => {
    const file = make('opt/kea', 0o755);
    expect(findExecutable(file, { envPath: '' })).toBe(file);
    expect(findExecutable(path.join(dir, 'opt/missing'), { envPath })).toBeNull();
    expect(findExecutable('sbin', { envPath: dir })).toBeNull();
  });
});
