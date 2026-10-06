import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readServerDuid } from '../../../../src/backends/dnsmasq/lease-file.js';

describe('readServerDuid', () => {
  // IPV6-16: dnsmasq writes every DHCPv4 lease first, then the duid line, then
  // the DHCPv6 leases (lease.c), so on a dual-stack box it is not line one.
  it('reads the duid line dnsmasq writes after its DHCPv4 leases', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-duid-'));
    const file = path.join(dir, 'dnsmasq.leases');
    fs.writeFileSync(
      file,
      '1800000000 aa:bb:cc:dd:ee:01 10.0.0.5 printer *\n' +
        'duid 00:01:00:01:2E:3F:40:51:AA:BB:CC:DD:EE:FF\n' +
        '1800000000 12345 fd00:1234::1500 laptop *\n',
    );
    expect(readServerDuid({ leaseFile: file })).toBe('00:01:00:01:2e:3f:40:51:aa:bb:cc:dd:ee:ff');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is null when the file is missing or has no header', () => {
    expect(readServerDuid({ leaseFile: '/nonexistent/dnsmasq.leases' })).toBeNull();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-duid-'));
    const file = path.join(dir, 'dnsmasq.leases');
    fs.writeFileSync(file, '1800000000 aa:bb:cc:dd:ee:ff 10.0.0.5 host *\n');
    expect(readServerDuid({ leaseFile: file })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
