import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/utils/run-command.js', async () =>
  (await import('../../../helpers/fake-run-command.js')).fakeRunCommandModule(execFileSync),
);
// dnsmasq's server DUID, as the lease file would give it.
const serverDuid = vi.hoisted(() => ({ value: '00:01:00:01:aa:bb:cc:dd:00:00:5e:00:53:01' }));
vi.mock('../../../../src/backends/dnsmasq/lease-file.js', () => ({
  LEASE_FILE: '/nonexistent/dnsmasq.leases',
  readServerDuid: () => serverDuid.value,
}));

const { releaseDnsmasqLease, routeInterfaceForIp } =
  await import('../../../../src/backends/dnsmasq/lease-release.js');

beforeEach(() => execFileSync.mockReset());

describe('routeInterfaceForIp', () => {
  it('uses the kernel route decision to select the DHCP interface', async () => {
    execFileSync.mockReturnValue('10.0.1.23 via 10.0.1.1 dev eth0 src 10.0.1.2\n');

    expect(await routeInterfaceForIp('10.0.1.23')).toBe('eth0');
    expect(execFileSync).toHaveBeenCalledWith('ip', ['route', 'get', '10.0.1.23'], expect.anything());
  });

  it('returns null for invalid addresses and missing routes', async () => {
    expect(await routeInterfaceForIp('not-an-ip')).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();

    execFileSync.mockReturnValue('unreachable 10.0.1.23\n');
    expect(await routeInterfaceForIp('10.0.1.23')).toBeNull();
  });
});

describe('releaseDnsmasqLease', () => {
  it('sends an exact DHCPRELEASE request without a shell', async () => {
    execFileSync.mockReturnValueOnce('10.0.1.23 dev br0 src 10.0.1.1\n').mockReturnValueOnce('');

    expect(await releaseDnsmasqLease({
        ip: '10.0.1.23',
        mac: 'aa:bb:cc:dd:ee:23',
        clientId: 'client-23',
      }),
    ).toEqual({ released: true, interface: 'br0' });
    expect(execFileSync).toHaveBeenLastCalledWith(
      'dhcp_release',
      ['br0', '10.0.1.23', 'aa:bb:cc:dd:ee:23', 'client-23'],
      expect.anything(),
    );
  });

  it('skips unsafe identities and reports a missing utility', async () => {
    expect(await releaseDnsmasqLease({
        ip: '10.0.1.23;reboot',
        mac: 'aa:bb:cc:dd:ee:23',
      }),
    ).toEqual({ released: false, skipped: 'invalid-identity' });
    expect(execFileSync).not.toHaveBeenCalled();

    execFileSync
      .mockReturnValueOnce('10.0.1.23 dev eth0 src 10.0.1.1\n')
      .mockImplementationOnce(() => {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      });
    expect(await releaseDnsmasqLease({
        ip: '10.0.1.23',
        mac: 'aa:bb:cc:dd:ee:23',
      }),
    ).toEqual({ released: false, skipped: 'dhcp_release-not-installed' });
  });
});

describe('releaseDnsmasqLease for DHCPv6', () => {
  // IPV6-11: --server-id is dnsmasq's server DUID (from its lease file), not an
  // address; dnsmasq drops a RELEASE whose server id is not its own.
  it('uses dhcp_release6 with the server DUID, client DUID and IAID', async () => {
    execFileSync
      .mockReturnValueOnce('fd00:a::1600 dev eth0 src fd00:a::2\n')
      .mockReturnValueOnce('');
    expect(await releaseDnsmasqLease({
        ip: 'fd00:a::1600',
        dhcpVersion: 6,
        duid: '00:01:00:01:cc:dd:ee:ff:11:22',
        iaid: 12345,
      }),
    ).toEqual({ released: true, interface: 'eth0' });
    expect(execFileSync).toHaveBeenNthCalledWith(1, 'ip', ['-6', 'route', 'get', 'fd00:a::1600'], expect.anything());
    expect(execFileSync).toHaveBeenLastCalledWith(
      'dhcp_release6',
      [
        '--iface',
        'eth0',
        '--server-id',
        '00:01:00:01:aa:bb:cc:dd:00:00:5e:00:53:01',
        '--client-id',
        '00:01:00:01:cc:dd:ee:ff:11:22',
        '--iaid',
        '12345',
        '--ip',
        'fd00:a::1600',
      ],
      // Bounded: an unanswered release retries for about five seconds.
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('leaves the lease alone until dnsmasq has a server DUID', async () => {
    serverDuid.value = null;
    try {
      execFileSync.mockReturnValueOnce('fd00:a::1600 dev eth0 src fd00:a::2\n');
      expect(await releaseDnsmasqLease({
          ip: 'fd00:a::1600',
          dhcpVersion: 6,
          duid: '00:01:00:01:cc:dd:ee:ff:11:22',
          iaid: 12345,
        }),
      ).toEqual({ released: false, skipped: 'no-server-duid' });
      expect(execFileSync).toHaveBeenCalledTimes(1);
    } finally {
      serverDuid.value = '00:01:00:01:aa:bb:cc:dd:00:00:5e:00:53:01';
    }
  });

  it('skips an IPv6 lease without a DUID or IAID', async () => {
    expect(await releaseDnsmasqLease({ ip: 'fd00:a::1600', dhcpVersion: 6 })).toEqual({
      released: false,
      skipped: 'invalid-identity',
    });
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
