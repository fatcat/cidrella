// What a lease in a member's report must look like (src/sync/lease-intake.js),
// the wire format, and the queue of releases that rides back.
import { describe, it, expect, beforeEach } from 'vitest';

const { cleanLease } = await import('../../../src/sync/lease-intake.js');
const { packReport, unpackReport } = await import('../../../src/sync/lease-wire.js');
const { clearReleases, queueRelease, queuedReleases, releasesFor } =
  await import('../../../src/sync/dhcp-release-queue.js');

const v4 = {
  ip: '10.1.0.20',
  mac: 'aa:bb:cc:00:00:20',
  hostname: 'desk',
  clientId: '01:aa:bb:cc:00:00:20',
  expiresAt: '2030-01-01T00:00:00.000Z',
  dhcpVersion: 4,
  duid: null,
  iaid: null,
};
const v6 = {
  ip: 'fd00:1::20',
  mac: null,
  hostname: 'desk6',
  clientId: null,
  expiresAt: 'infinite',
  dhcpVersion: 6,
  duid: '00:01:00:01:00:00:00:20',
  iaid: 7,
};

describe('cleanLease', () => {
  it('passes a good lease of either family through as it is', () => {
    expect(cleanLease(v4)).toEqual(v4);
    expect(cleanLease(v6)).toEqual(v6);
    expect(cleanLease({ ...v6, temporary: true })).toEqual({ ...v6, temporary: true });
  });

  it('canonicalizes the address and the identities, and ignores unknown fields', () => {
    expect(
      cleanLease({ ...v6, ip: 'FD00:1:0:0::20', duid: '00:01:00:01:00:00:00:AB', subnetId: 99 }),
    ).toEqual({ ...v6, duid: '00:01:00:01:00:00:00:ab' });
    expect(cleanLease({ ...v4, mac: 'AA:BB:CC:00:00:20', lifecycleValidated: true })).toEqual(v4);
  });

  it('keeps a lease whose name could not be a DNS name, without the name', () => {
    for (const hostname of ['two words', 'a\nlocal=/x/', 'x'.repeat(300), '-dash', '@', '']) {
      expect(cleanLease({ ...v4, hostname })).toEqual({ ...v4, hostname: null });
      expect(cleanLease({ ...v6, hostname })).toEqual({ ...v6, hostname: null });
    }
    expect(cleanLease({ ...v4, hostname: 'desk.example.test' }).hostname).toBe('desk.example.test');
    expect(cleanLease({ ...v6, temporary: false })).toEqual({ ...v6, temporary: false });
  });

  it('takes the family from the address when none is given', () => {
    const bare = (lease) =>
      Object.fromEntries(Object.entries(lease).filter(([key]) => key !== 'dhcpVersion'));
    const [bare4, bare6] = [bare(v4), bare(v6)];
    expect(cleanLease(bare4).dhcpVersion).toBe(4);
    expect(cleanLease(bare6).dhcpVersion).toBe(6);
  });

  it.each([
    ['not an object', 'lease'],
    ['an array', [v4]],
    ['no address', { ...v4, ip: undefined }],
    ['an address that is not one', { ...v4, ip: '10.1.0.999' }],
    ['an address with a prefix', { ...v6, ip: 'fd00:1::20/64' }],
    ['an over-long address', { ...v4, ip: '1'.repeat(100) }],
    ['an IPv6 address on a DHCPv4 lease', { ...v4, ip: 'fd00:1::20' }],
    ['an IPv4 address on a DHCPv6 lease', { ...v6, ip: '10.1.0.20' }],
    ['a MAC that is not one', { ...v4, mac: 'aa:bb:cc' }],
    ['a MAC that is an object', { ...v4, mac: { $ne: null } }],
    ['a DUID that is not one', { ...v6, duid: 'zz' }],
    ['a name that is not text', { ...v4, hostname: 42 }],
    ['an over-long client id', { ...v4, clientId: 'a'.repeat(513) }],
    ['a client id with a line break', { ...v4, clientId: '01:aa\n0 aa:bb:cc:00:00:01 10.1.0.9' }],
    ['a client id with a space', { ...v6, clientId: '00:01 00:02' }],
    ['a negative IAID', { ...v6, iaid: -1 }],
    ['an IAID past 32 bits', { ...v6, iaid: 2 ** 32 }],
    ['no expiry', { ...v4, expiresAt: undefined }],
    ['an expiry that is not a time', { ...v4, expiresAt: 'tomorrow' }],
    ['an expiry that is a number', { ...v4, expiresAt: 1893456000 }],
    ['an expiry with something after it', { ...v4, expiresAt: '2030-01-01T00:00:00Z\n1' }],
    ['an expiry in another spelling', { ...v4, expiresAt: 'Jan 1 2030' }],
  ])('refuses %s', (_what, raw) => {
    expect(cleanLease(raw)).toBeNull();
  });
});

describe('the wire format', () => {
  it('round-trips a report, and reads anything else as nothing', () => {
    const body = { term: 3, leases: [v4, v6] };
    expect(unpackReport(packReport(body))).toEqual(body);
    expect(unpackReport(Buffer.from('not gzip'))).toBeNull();
    expect(unpackReport(packReport([v4]))).toBeNull();
    expect(unpackReport({ term: 3 })).toBeNull();
    expect(unpackReport(Buffer.alloc(0))).toBeNull();
  });
});

describe('the release queue', () => {
  beforeEach(() => clearReleases());

  it('answers a report with the queued releases it still holds, both families', () => {
    queueRelease(v4);
    queueRelease(v6);
    expect(releasesFor([v4, v6, { ...v4, ip: '10.1.0.21' }])).toEqual([v4, v6]);
    // Still queued: nothing says they are done.
    expect(queuedReleases()).toBe(2);
  });

  it('counts a release done once a report no longer holds the lease', () => {
    queueRelease(v4);
    queueRelease(v6);
    expect(releasesFor([v6])).toEqual([v6]);
    expect(queuedReleases()).toBe(1);
    expect(releasesFor([])).toEqual([]);
    expect(queuedReleases()).toBe(0);
  });

  it('tells clients on one address apart, and drops a release nobody acted on', () => {
    queueRelease(v4);
    // The address has moved to another client: that lease is not the one to release.
    expect(releasesFor([{ ...v4, mac: 'aa:bb:cc:00:00:99' }])).toEqual([]);
    const start = Date.now();
    queueRelease(v6, start);
    expect(releasesFor([v6], start + 9 * 60_000)).toEqual([v6]);
    expect(releasesFor([v6], start + 11 * 60_000)).toEqual([]);
    expect(queuedReleases()).toBe(0);
  });
});
