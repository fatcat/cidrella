import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();
vi.mock('child_process', () => ({ execFileSync }));

const { releaseDnsmasqLease, routeInterfaceForIp } = await import(
  '../../../src/utils/dhcp-release.js'
);

beforeEach(() => execFileSync.mockReset());

describe('routeInterfaceForIp', () => {
  it('uses the kernel route decision to select the DHCP interface', () => {
    execFileSync.mockReturnValue('10.0.1.23 via 10.0.1.1 dev eth0 src 10.0.1.2\n');

    expect(routeInterfaceForIp('10.0.1.23')).toBe('eth0');
    expect(execFileSync).toHaveBeenCalledWith('ip', ['route', 'get', '10.0.1.23'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  });

  it('returns null for invalid addresses and missing routes', () => {
    expect(routeInterfaceForIp('not-an-ip')).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();

    execFileSync.mockReturnValue('unreachable 10.0.1.23\n');
    expect(routeInterfaceForIp('10.0.1.23')).toBeNull();
  });
});

describe('releaseDnsmasqLease', () => {
  it('sends an exact DHCPRELEASE request without a shell', () => {
    execFileSync
      .mockReturnValueOnce('10.0.1.23 dev br0 src 10.0.1.1\n')
      .mockReturnValueOnce('');

    expect(releaseDnsmasqLease({
      ip_address: '10.0.1.23',
      mac_address: 'aa:bb:cc:dd:ee:23',
      client_id: 'client-23'
    })).toEqual({ released: true, interface: 'br0' });
    expect(execFileSync).toHaveBeenLastCalledWith('dhcp_release', [
      'br0', '10.0.1.23', 'aa:bb:cc:dd:ee:23', 'client-23'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('skips unsafe identities and reports a missing utility', () => {
    expect(releaseDnsmasqLease({
      ip_address: '10.0.1.23;reboot',
      mac_address: 'aa:bb:cc:dd:ee:23'
    })).toEqual({ released: false, skipped: 'invalid-identity' });
    expect(execFileSync).not.toHaveBeenCalled();

    execFileSync
      .mockReturnValueOnce('10.0.1.23 dev eth0 src 10.0.1.1\n')
      .mockImplementationOnce(() => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      });
    expect(releaseDnsmasqLease({
      ip_address: '10.0.1.23',
      mac_address: 'aa:bb:cc:dd:ee:23'
    })).toEqual({ released: false, skipped: 'dhcp_release-not-installed' });
  });
});
