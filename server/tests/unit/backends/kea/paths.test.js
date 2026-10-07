import { DATA_DIR } from '../../../helpers/isolated-data-dir.js';
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { KEA_LOG_DIR, newestLegalLog, pruneLegalLogs } from '../../../../src/backends/kea/paths.js';
import { ensureKeaSecret, readKeaSecret } from '../../../../src/backends/kea/secret.js';

afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

describe('newestLegalLog', () => {
  it('is null before Kea writes one, then the newest dated file of the family', () => {
    expect(newestLegalLog(4)).toBeNull();
    fs.mkdirSync(KEA_LOG_DIR, { recursive: true });
    for (const name of [
      'kea-legal4.20261006.txt',
      'kea-legal4.20261007.txt',
      'kea-legal6.20261008.txt',
      'kea-legal4.txt',
    ]) {
      fs.writeFileSync(path.join(KEA_LOG_DIR, name), '');
    }
    expect(newestLegalLog(4)).toBe(path.join(KEA_LOG_DIR, 'kea-legal4.20261007.txt'));
  });
});

describe('pruneLegalLogs', () => {
  it('deletes dated legal logs older than the retention, both families, nothing else', () => {
    fs.mkdirSync(KEA_LOG_DIR, { recursive: true });
    const names = [
      'kea-legal4.20260901.txt',
      'kea-legal6.20260901.txt',
      'kea-legal4.20261001.txt',
      'kea-legal6.20261006.txt',
      'kea-dhcp4.log',
    ];
    for (const name of names) fs.writeFileSync(path.join(KEA_LOG_DIR, name), '');
    const now = Date.parse('2026-10-07T12:00:00Z');
    expect(pruneLegalLogs(7, { now })).toBe(2);
    const left = fs.readdirSync(KEA_LOG_DIR);
    expect(left).not.toContain('kea-legal4.20260901.txt');
    expect(left).not.toContain('kea-legal6.20260901.txt');
    expect(left).toEqual(expect.arrayContaining(names.slice(2)));
  });
});

describe('Kea control secret', () => {
  it('is made once, readable only by its owner, and read back the same', () => {
    expect(readKeaSecret()).toBeNull();
    const secret = ensureKeaSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(ensureKeaSecret()).toBe(secret);
    expect(readKeaSecret()).toBe(secret);
    const file = path.join(DATA_DIR, 'kea', 'secret', 'api-pw');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
