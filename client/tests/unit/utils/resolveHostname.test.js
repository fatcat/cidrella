import { describe, expect, it, vi } from 'vitest';
import { resolveHostname } from '../../../src/utils/resolveHostname.js';

// 2.pool.ntp.org answers with both families; the other pool names only IPv4.
const ANSWERS = {
  '2.pool.ntp.org': ['192.0.2.1', '192.0.2.2', '2001:db8::1', '2001:db8::2'],
  'pool.ntp.org': ['192.0.2.3'],
};
const api = {
  get: vi.fn(async (url) => {
    const name = decodeURIComponent(url.split('name=')[1]);
    if (!ANSWERS[name]) throw new Error('not found');
    return { data: { name, ips: ANSWERS[name] } };
  }),
};

describe('resolveHostname', () => {
  it('keeps only the addresses of the option family', async () => {
    const toast = { add: vi.fn() };
    expect(await resolveHostname('2.pool.ntp.org', api, toast, 4)).toBe('192.0.2.1,192.0.2.2');
    expect(await resolveHostname('2.pool.ntp.org', api, toast, 6)).toBe('2001:db8::1,2001:db8::2');
    expect(await resolveHostname('2.pool.ntp.org', api, toast)).toBe('192.0.2.1,192.0.2.2');
    expect(toast.add).not.toHaveBeenCalled();
  });

  it('keeps a name with no address of the family and says why', async () => {
    const toast = { add: vi.fn() };
    expect(await resolveHostname('pool.ntp.org, 2001:db8::9', api, toast, 6)).toBe(
      'pool.ntp.org,2001:db8::9',
    );
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ summary: '"pool.ntp.org" has no IPv6 address' }),
    );
  });

  it('leaves out an address literal of the other family, and says so (IPV6-47)', async () => {
    const toast = { add: vi.fn() };
    expect(await resolveHostname('192.168.1.53', api, toast, 6)).toBe('');
    expect(await resolveHostname('fd00::53, 192.168.1.53', api, toast, 6)).toBe('fd00::53');
    expect(await resolveHostname('fd00::53', api, toast, 4)).toBe('');
    expect(toast.add).toHaveBeenCalledTimes(3);
    expect(toast.add.mock.calls[0][0].summary).toMatch(/192\.168\.1\.53.*not an IPv6 address/);
    // Same-family literals pass through untouched, alone or in a list.
    const quiet = { add: vi.fn() };
    expect(await resolveHostname('192.168.1.53', api, quiet, 4)).toBe('192.168.1.53');
    expect(await resolveHostname('fd00::53', api, quiet, 6)).toBe('fd00::53');
    expect(quiet.add).not.toHaveBeenCalled();
  });

  it('still warns about a name that does not resolve at all', async () => {
    const toast = { add: vi.fn() };
    expect(await resolveHostname('nowhere.test', api, toast, 4)).toBe('nowhere.test');
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Could not resolve "nowhere.test"' }),
    );
  });
});
