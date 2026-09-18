import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';

const execFile = vi.fn((...args) => {
  const cb = args[args.length - 1];
  if (typeof cb === 'function') cb(null, '');
});
vi.mock('child_process', () => ({
  execFile: (...args) => execFile(...args),
  execFileSync: vi.fn(),
}));
vi.mock('../../../src/db/init.js', () => ({
  getSetting: vi.fn((key) => (key === 'ipv6_enabled' ? 'true' : null)),
  getDb: vi.fn(),
}));

const { discoverIpv6Hosts } = await import('../../../src/utils/scanner.js');
const { parseNetwork } = await import('../../../src/utils/cidr.js');

beforeEach(() => execFile.mockClear());

describe('discoverIpv6Hosts', () => {
  it('pings all-nodes on each attached interface and keeps neighbors inside the prefix', async () => {
    const spy = vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth0: [
        { family: 'IPv4', address: '10.0.1.2' },
        { family: 'IPv6', address: 'fd00:a::2' },
        { family: 'IPv6', address: 'fe80::1' },
      ],
      eth1: [{ family: 'IPv6', address: 'fd00:b::2' }],
    });
    const neighbors = vi.fn(
      () =>
        new Map([
          ['fd00:a::1600', { mac: 'aa:bb:cc:dd:ee:ff', interface: 'eth0', state: 'REACHABLE' }],
          ['fd00:b::5', { mac: 'aa:bb:cc:dd:ee:05', interface: 'eth1', state: 'STALE' }],
          ['fe80::9', { mac: 'aa:bb:cc:dd:ee:09', interface: 'eth0', state: 'STALE' }],
        ]),
    );
    try {
      const result = await discoverIpv6Hosts(parseNetwork('fd00:a::/64'), { neighbors });
      expect(result.interfaces).toEqual(['eth0']);
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile.mock.calls[0][0]).toBe('ping');
      expect(execFile.mock.calls[0][1]).toEqual([
        '-6',
        '-c',
        '2',
        '-W',
        expect.any(String),
        'ff02::1%eth0',
      ]);
      expect(neighbors).toHaveBeenCalledWith({ force: true });
      // The link-local neighbor on eth0 rides along; the one on eth1 does not.
      expect(result.hosts).toEqual([
        { ip: 'fd00:a::1600', mac: 'aa:bb:cc:dd:ee:ff', interface: 'eth0' },
        { ip: 'fe80::9', mac: 'aa:bb:cc:dd:ee:09', interface: 'eth0' },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('finds nothing without an attached interface and never sweeps the prefix', async () => {
    const spy = vi
      .spyOn(os, 'networkInterfaces')
      .mockReturnValue({ eth0: [{ family: 'IPv4', address: '10.0.1.2' }] });
    try {
      const result = await discoverIpv6Hosts(parseNetwork('fd00:a::/64'), {
        neighbors: () => new Map(),
      });
      expect(result).toEqual({ interfaces: [], hosts: [] });
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
