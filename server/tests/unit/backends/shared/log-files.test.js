import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeLogFiles } from '../../../../src/backends/shared/log-files.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-files-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('removeLogFiles', () => {
  it('removes a log and its rotated copies, nothing else beside it', () => {
    const gone = [
      'dnsmasq.log',
      'dnsmasq.log-20261011',
      'dnsmasq.log-20261010.gz',
      'kea-dhcp4.log',
      'kea-dhcp4.log.1',
      'kea-dhcp4.log.4',
    ];
    const kept = [
      'dnsmasq.leases',
      'dnsmasq.conf',
      'dnsmasq.log.lock',
      'dnsmasq.log-old',
      'kea-dhcp4.log.lock',
      'kea-legal4.20261011.txt',
      'kea-dhcp6.log',
    ];
    for (const name of [...gone, ...kept]) fs.writeFileSync(path.join(dir, name), 'x');

    expect(removeLogFiles(path.join(dir, 'dnsmasq.log'))).toBe(3);
    expect(removeLogFiles(path.join(dir, 'kea-dhcp4.log'))).toBe(3);
    expect(fs.readdirSync(dir).sort()).toEqual([...kept].sort());
  });

  it('counts nothing for a directory that is not there', () => {
    expect(removeLogFiles(path.join(dir, 'missing', 'pdns.log'))).toBe(0);
  });
});
