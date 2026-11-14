import { describe, expect, it } from 'vitest';
import {
  counterDelta,
  emptyDhcpCounts,
  parseLogLines,
} from '../../../src/utils/metrics-aggregator.js';

describe('parseLogLines', () => {
  it('counts both halves of a DHCPv6 conversation', () => {
    const duid = '00:01:00:01:2c:5e:7b:11:38:8a:06:92:26:ce';
    const lines = [
      `Sep 20 21:00:02 dnsmasq-dhcp[12]: DHCPSOLICIT(eth0) ${duid}`,
      `Sep 20 21:00:02 dnsmasq-dhcp[12]: DHCPADVERTISE(eth0) fd00:6::22 ${duid}`,
      `Sep 20 21:00:02 dnsmasq-dhcp[12]: DHCPREQUEST(eth0) ${duid}`,
      `Sep 20 21:00:02 dnsmasq-dhcp[12]: DHCPREPLY(eth0) fd00:6::22 ${duid} S24-Ultra`,
      `Sep 20 21:30:02 dnsmasq-dhcp[12]: DHCPRENEW(eth0) ${duid}`,
      `Sep 20 21:30:02 dnsmasq-dhcp[12]: DHCPREPLY(eth0) fd00:6::22 ${duid}`,
      `Sep 20 21:31:00 dnsmasq-dhcp[12]: DHCPREBIND(eth0) ${duid}`,
      `Sep 20 21:31:05 dnsmasq-dhcp[12]: DHCPCONFIRM(eth0) ${duid}`,
      `Sep 20 21:32:00 dnsmasq-dhcp[12]: DHCPINFORMATION-REQUEST(eth0) ${duid}`,
      `Sep 20 21:32:00 dnsmasq-dhcp[12]: DHCPREPLY(eth0) ${duid}`,
    ];
    expect(parseLogLines(lines)).toEqual({
      dnsQueries: 0,
      dhcp: { 4: { client: 0, server: 0 }, 6: { client: 6, server: 4 } },
    });
  });

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
    expect(parseLogLines(lines)).toEqual({
      dnsQueries: 2,
      dhcp: { 4: { client: 4, server: 3 }, 6: { client: 0, server: 0 } },
    });
  });

  it('tells the families apart on the message types both share', () => {
    const duid = '00:01:00:01:2c:5e:7b:11:38:8a:06:92:26:ce';
    const lines = [
      'Sep 20 21:00:02 dnsmasq-dhcp[12]: DHCPREQUEST(eth0) 10.0.0.22 38:8a:06:92:26:ce',
      'Sep 20 21:00:30 dnsmasq-dhcp[12]: DHCPRELEASE(eth0) 10.0.0.40 00:11:22:33:44:55',
      'Sep 20 21:00:31 dnsmasq-dhcp[12]: DHCPDECLINE(eth0) 10.0.0.41 00:11:22:33:44:66',
      `Sep 20 21:00:02 dnsmasq-dhcp[12]: DHCPREQUEST(eth0) ${duid}`,
      `Sep 20 21:00:40 dnsmasq-dhcp[12]: DHCPRELEASE(eth0) fd00:6::22 ${duid}`,
      `Sep 20 21:00:41 dnsmasq-dhcp[12]: DHCPDECLINE(eth0) ${duid}`,
    ];
    expect(parseLogLines(lines).dhcp).toEqual({
      4: { client: 3, server: 0 },
      6: { client: 3, server: 0 },
    });
  });

  it('returns zeros for an empty tail', () => {
    expect(parseLogLines([])).toEqual({ dnsQueries: 0, dhcp: emptyDhcpCounts() });
  });
});

describe('counterDelta', () => {
  it('counts nothing on the first read, then the change since the last, per family', () => {
    const t0 = { 4: { received: 40, sent: 30 }, 6: { received: 7, sent: 5 } };
    const t1 = { 4: { received: 52, sent: 41 }, 6: { received: 9, sent: 8 } };
    expect(counterDelta(null, t0)).toEqual(emptyDhcpCounts());
    expect(counterDelta(t0, t1)).toEqual({
      4: { client: 12, server: 11 },
      6: { client: 2, server: 3 },
    });
  });

  it('takes a total that went down as a restarted daemon, all of it new', () => {
    expect(
      counterDelta({ 4: { received: 40, sent: 30 } }, { 4: { received: 5, sent: 4 } }),
    ).toEqual({ 4: { client: 5, server: 4 }, 6: { client: 0, server: 0 } });
  });

  it('counts a family that just started serving from zero, and leaves one not served at zero', () => {
    expect(
      counterDelta(
        { 4: { received: 40, sent: 30 } },
        { 4: { received: 41, sent: 31 }, 6: { received: 3, sent: 2 } },
      ),
    ).toEqual({ 4: { client: 1, server: 1 }, 6: { client: 3, server: 2 } });
  });
});
