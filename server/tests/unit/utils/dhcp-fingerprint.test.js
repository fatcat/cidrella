import { describe, it, expect } from 'vitest';
import { drainFinalized, ingestLine } from '../../../src/utils/dhcp-fingerprint.js';

// dnsmasq deliberately wraps requested options after roughly 40 characters and
// writes the ACK before the option detail generated for that response.
const WIN_TX = [
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 available DHCP range: 10.0.0.50 -- 10.0.0.150',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 vendor class: MSFT 5.0',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 DHCPDISCOVER(eth0) aa:bb:cc:dd:ee:ff',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 tags: known, eth0',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 DHCPOFFER(eth0) 10.0.0.55 aa:bb:cc:dd:ee:ff',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 requested options: 1:netmask, 3:router, 6:dns-server, 15:domain-name, ',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 requested options: 31:router-discovery, 33:static-route, 43:vendor-encap, ',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 client provides name: DESKTOP-AB12CD',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 DHCPREQUEST(eth0) 10.0.0.55 aa:bb:cc:dd:ee:ff',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 DHCPACK(eth0) 10.0.0.55 aa:bb:cc:dd:ee:ff DESKTOP-AB12CD',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 requested options: 1:netmask, 3:router, 6:dns-server, 15:domain-name, ',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 requested options: 31:router-discovery, 33:static-route, 43:vendor-encap, ',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 requested options: 44:netbios-ns, 46:netbios-nodetype, 47:netbios-scope, ',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 requested options: 121:classless-static-route, 249:ms-classless-static-route, ',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 requested options: 252:ms-proxy-autoconfig',
];

describe('ingestLine (log-dhcp transaction parsing)', () => {
  it('accumulates split option 55 detail written after DHCPACK', () => {
    const pending = new Map();
    for (const line of WIN_TX) ingestLine(line, pending, 1000);
    expect(drainFinalized(pending, { now: 1999 })).toEqual([]);
    const [finalized] = drainFinalized(pending, { now: 2000 });
    expect(finalized.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(finalized.opt60).toBe('MSFT 5.0');
    expect(finalized.hostname).toBe('DESKTOP-AB12CD');
    expect(finalized.opt55).toBe('1,3,6,15,31,33,43,44,46,47,121,249,252');
    // transaction is evicted from pending after finalize
    expect(pending.size).toBe(0);
  });

  it('ignores non-dhcp lines', () => {
    const pending = new Map();
    expect(ingestLine('Jun 8 query[A] example.com from 10.0.0.5', pending)).toBeNull();
    expect(pending.size).toBe(0);
  });

  it('does not finalize a DHCPACK with no MAC seen', () => {
    const pending = new Map();
    ingestLine('host dnsmasq-dhcp[1]: 999 DHCPACK(eth0) 10.0.0.9', pending, 1000);
    expect(drainFinalized(pending, { now: 2000 })).toEqual([]);
  });

  it('captures a renewal whose requested options appear only after the ACK', () => {
    const pending = new Map();
    const prefix = 'host dnsmasq-dhcp[8]: 456 ';
    ingestLine(`${prefix}DHCPREQUEST(eth0) 10.0.0.9 11:22:33:44:55:66`, pending, 1000);
    ingestLine(`${prefix}DHCPACK(eth0) 10.0.0.9 11:22:33:44:55:66`, pending, 1000);
    ingestLine(`${prefix}requested options: 1:netmask, 3:router, 6:dns-server, `, pending, 1000);
    ingestLine(`${prefix}requested options: 15:domain-name, 119:domain-search, 252:ms-proxy-autoconfig`, pending, 1000);

    expect(drainFinalized(pending, { now: 2000 })).toEqual([expect.objectContaining({
      mac: '11:22:33:44:55:66',
      opt55: '1,3,6,15,119,252'
    })]);
  });

  it('does not combine the same xid across dnsmasq processes', () => {
    const pending = new Map();
    ingestLine('host dnsmasq-dhcp[1]: 999 vendor class: MSFT 5.0', pending, 1000);
    ingestLine('host dnsmasq-dhcp[2]: 999 DHCPACK(eth0) 10.0.0.9 11:22:33:44:55:66', pending, 1000);
    const [finalized] = drainFinalized(pending, { now: 2000 });
    expect(finalized.opt60).toBeNull();
  });
});
