import { describe, it, expect } from 'vitest';
import {
  formatLeaseFile,
  formatLeaseLine,
  parseLeaseFile,
  parseLeaseLine,
} from '../../../../src/backends/dnsmasq/dhcp.js';

const v4 = {
  ip: '10.0.0.50',
  mac: 'aa:bb:cc:dd:ee:50',
  hostname: 'laptop',
  clientId: '01:aa:bb:cc:dd:ee:50',
  expiresAt: '2031-05-20T12:00:00.000Z',
  dhcpVersion: 4,
  duid: null,
  iaid: null,
};
const v6 = {
  ip: 'fd00:5::150',
  mac: null,
  hostname: null,
  clientId: '00:01:00:01:aa:bb:cc:dd:00:00:01:50',
  expiresAt: 'infinite',
  dhcpVersion: 6,
  duid: '00:01:00:01:aa:bb:cc:dd:00:00:01:50',
  iaid: 336,
  temporary: false,
};

describe('dnsmasq lease lines', () => {
  it('writes the lines parseLeaseLine reads back, both families', () => {
    expect(formatLeaseLine(v4)).toBe(
      `${Date.parse(v4.expiresAt) / 1000} aa:bb:cc:dd:ee:50 10.0.0.50 laptop 01:aa:bb:cc:dd:ee:50`,
    );
    expect(formatLeaseLine(v6)).toBe('0 336 fd00:5::150 * 00:01:00:01:aa:bb:cc:dd:00:00:01:50');
    expect(parseLeaseLine(formatLeaseLine(v4))).toEqual(v4);
    expect(parseLeaseLine(formatLeaseLine(v6))).toEqual(v6);
    expect(parseLeaseLine(formatLeaseLine({ ...v6, temporary: true }))).toMatchObject({
      temporary: true,
      iaid: 336,
    });
  });

  it('writes a file in dnsmasq order with the server DUID ahead of the DHCPv6 leases', () => {
    const text = formatLeaseFile([v6, v4], { serverDuid: '00:01:00:01:11:22:33:44:55:66:77:88' });
    expect(text.split('\n')).toEqual([
      formatLeaseLine(v4),
      'duid 00:01:00:01:11:22:33:44:55:66:77:88',
      formatLeaseLine(v6),
      '',
    ]);
    expect(parseLeaseFile(text)).toEqual([v4, v6]);
    expect(formatLeaseFile([])).toBe('');
  });
});
