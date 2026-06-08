import { describe, it, expect } from 'vitest';
import { ingestLine } from '../../../src/utils/dhcp-fingerprint.js';

// A captured dnsmasq log-dhcp transaction (Windows client), each line prefixed
// with the shared transaction id (1140525447) after `dnsmasq-dhcp[pid]:`.
const WIN_TX = [
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 available DHCP range: 10.0.0.50 -- 10.0.0.150',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 vendor class: MSFT 5.0',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 DHCPDISCOVER(eth0) aa:bb:cc:dd:ee:ff',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 tags: known, eth0',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 DHCPOFFER(eth0) 10.0.0.55 aa:bb:cc:dd:ee:ff',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 requested options: 1:netmask, 3:router, 6:dns-server, 15:domain-name, 31:router-discovery, 33:static-route, 43:vendor-encap, 44:netbios-ns, 46:netbios-nodetype, 47:netbios-scope, 121:classless-static-route, 249:ms-classless-static-route, 252:ms-proxy-autoconfig',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 client provides name: DESKTOP-AB12CD',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 DHCPREQUEST(eth0) 10.0.0.55 aa:bb:cc:dd:ee:ff',
  'Jun  8 12:00:00 host dnsmasq-dhcp[123]: 1140525447 DHCPACK(eth0) 10.0.0.55 aa:bb:cc:dd:ee:ff DESKTOP-AB12CD',
];

describe('ingestLine (log-dhcp transaction parsing)', () => {
  it('accumulates opt55/opt60/hostname/mac across the block and finalizes on DHCPACK', () => {
    const pending = new Map();
    let finalized = null;
    for (const line of WIN_TX) {
      const r = ingestLine(line, pending);
      if (r) finalized = r;
    }
    expect(finalized).not.toBeNull();
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
    const r = ingestLine('host dnsmasq-dhcp[1]: 999 DHCPACK(eth0) 10.0.0.9', pending);
    expect(r).toBeNull();
  });
});
