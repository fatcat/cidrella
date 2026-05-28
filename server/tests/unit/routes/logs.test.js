import { describe, expect, it } from 'vitest';
import { isDhcpLine } from '../../../src/routes/logs.js';

describe('log line classification', () => {
  it('classifies dnsmasq DHCP option-detail lines as DHCP', () => {
    expect(isDhcpLine('May 28 10:59:13 dnsmasq-dhcp[80430]: 3020524912 sent size:  8 option:  6 dns-server  10.0.3.249, 9.9.9.9')).toBe(true);
    expect(isDhcpLine('May 28 10:59:13 dnsmasq-dhcp[80430]: 3020524912 requested options: 1:netmask, 3:router, 6:dns-server')).toBe(true);
    expect(isDhcpLine('May 28 10:59:13 dnsmasq-dhcp[80430]: 3020524912 vendor class: udhcp 1.22.1')).toBe(true);
  });

  it('does not classify DNS query lines as DHCP', () => {
    expect(isDhcpLine('May 28 10:59:13 dnsmasq[80430]: query[A] example.com from 10.0.3.10')).toBe(false);
    expect(isDhcpLine('May 28 10:59:13 dnsmasq[80430]: forwarded example.com to 9.9.9.9')).toBe(false);
  });
});
