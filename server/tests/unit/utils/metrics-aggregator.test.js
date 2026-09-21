import { describe, expect, it } from 'vitest';
import { parseLogLines } from '../../../src/utils/metrics-aggregator.js';

describe('parseLogLines', () => {
  it('counts DNS queries and both halves of the DHCP conversation apart', () => {
    const lines = [
      'Sep 20 21:00:01 dnsmasq[12]: query[A] apple.com from 10.0.0.22',
      'Sep 20 21:00:01 dnsmasq[12]: forwarded apple.com to 9.9.9.9',
      'Sep 20 21:00:02 dnsmasq-dhcp[12]: DHCPDISCOVER(eth0) 38:8a:06:92:26:ce',
      'Sep 20 21:00:02 dnsmasq-dhcp[12]: DHCPOFFER(eth0) 10.0.0.22 38:8a:06:92:26:ce',
      'Sep 20 21:00:02 dnsmasq-dhcp[12]: DHCPREQUEST(eth0) 10.0.0.22 38:8a:06:92:26:ce',
      'Sep 20 21:00:02 dnsmasq-dhcp[12]: DHCPACK(eth0) 10.0.0.22 38:8a:06:92:26:ce S24-Ultra',
      'Sep 20 21:00:09 dnsmasq-dhcp[12]: DHCPREQUEST(eth0) 10.0.0.99 aa:bb:cc:dd:ee:ff',
      'Sep 20 21:00:09 dnsmasq-dhcp[12]: DHCPNAK(eth0) 10.0.0.99 aa:bb:cc:dd:ee:ff wrong network',
      'Sep 20 21:00:30 dnsmasq-dhcp[12]: DHCPRELEASE(eth0) 10.0.0.40 00:11:22:33:44:55',
      'Sep 20 21:00:31 dnsmasq[12]: query[AAAA] icloud.com from 10.0.0.22',
    ];
    expect(parseLogLines(lines)).toEqual({ dnsQueries: 2, dhcpClientMsgs: 4, dhcpServerMsgs: 3 });
  });

  it('returns zeros for an empty tail', () => {
    expect(parseLogLines([])).toEqual({ dnsQueries: 0, dhcpClientMsgs: 0, dhcpServerMsgs: 0 });
  });
});
