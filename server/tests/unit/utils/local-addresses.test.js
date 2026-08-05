import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'os';
import { localIpv4Set, isLocalAddress, resetLocalAddressCache } from '../../../src/utils/local-addresses.js';

function mockInterfaces(map) {
  resetLocalAddressCache();
  return vi.spyOn(os, 'networkInterfaces').mockReturnValue(map);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLocalAddressCache();
});

describe('localIpv4Set', () => {
  it('collects external IPv4 addresses across interfaces', () => {
    mockInterfaces({
      eth0: [{ address: '10.0.3.250', family: 'IPv4', internal: false }],
      eth1: [{ address: '192.168.0.250', family: 'IPv4', internal: false }],
      eth2: [{ address: '10.0.8.250', family: 'IPv4', internal: false }]
    });

    const set = localIpv4Set({ force: true });
    expect([...set].sort()).toEqual(['10.0.3.250', '10.0.8.250', '192.168.0.250']);
  });

  it('skips loopback and IPv6', () => {
    mockInterfaces({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [
        { address: '10.0.3.250', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false }
      ]
    });

    expect([...localIpv4Set({ force: true })]).toEqual(['10.0.3.250']);
  });

  it('accepts the numeric family older Node reports', () => {
    mockInterfaces({ eth0: [{ address: '10.0.3.250', family: 4, internal: false }] });
    expect(localIpv4Set({ force: true }).has('10.0.3.250')).toBe(true);
  });

  it('returns an empty set when enumeration throws', () => {
    resetLocalAddressCache();
    vi.spyOn(os, 'networkInterfaces').mockImplementation(() => { throw new Error('nope'); });
    expect(localIpv4Set({ force: true }).size).toBe(0);
  });
});

describe('isLocalAddress', () => {
  it('is true for an appliance address and false for anything else', () => {
    mockInterfaces({ eth1: [{ address: '192.168.0.250', family: 'IPv4', internal: false }] });
    localIpv4Set({ force: true });

    expect(isLocalAddress('192.168.0.250')).toBe(true);
    expect(isLocalAddress('192.168.0.251')).toBe(false);
    expect(isLocalAddress(null)).toBe(false);
  });
});
