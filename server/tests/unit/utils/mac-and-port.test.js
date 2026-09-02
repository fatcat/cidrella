import { describe, it, expect } from 'vitest';
import { extractMac, isNullMac, NULL_MAC } from '../../../src/utils/mac.js';
import { resolveDnsListenPort } from '../../../src/config/defaults.js';

/**
 * #13: the MAC regex was duplicated character-for-character, but only
 * arp-cache.js knew the all-zero MAC is not a device. arping prints it for an
 * unanswered probe and dnsmasq logs it for a DHCP packet with no client
 * hwaddr, so the fingerprinter recorded a phantom host and merged every such
 * packet on the network into it.
 *
 * #10: the LAN DNS port was resolved two ways. dnsmasq.js range-checked and
 * fell back to 53; dns-proxy.js used `Number(x) || 53`, so a stored 70000
 * became a bind attempt on 70000 while dnsmasq stayed on 53.
 *
 * See REVIEW.md, duplicate-logic audit #13 and #10.
 */

describe('extractMac', () => {
  it('refuses the all-zero MAC, which the old fingerprint regex accepted', () => {
    expect(extractMac(`DHCPACK(eth0) 10.0.0.5 ${NULL_MAC}`)).toBeNull();
    expect(extractMac('00:00:00:00:00:00')).toBeNull();
    expect(extractMac('00:00:00:00:00:00'.toUpperCase())).toBeNull();
  });

  it('pulls a real MAC out of surrounding log text, lowercased', () => {
    expect(extractMac('DHCPACK(eth0) 10.0.0.5 AA:BB:CC:11:22:33 laptop')).toBe('aa:bb:cc:11:22:33');
    expect(extractMac('Unicast reply from 10.0.0.1 [00:1A:2B:3C:4D:5E] 1.9ms')).toBe('00:1a:2b:3c:4d:5e');
  });

  it('returns null when there is no MAC at all', () => {
    for (const t of ['', null, undefined, 'no mac here', '00:1A:2B:3C:4D']) {
      expect(extractMac(t), JSON.stringify(t)).toBeNull();
    }
  });

  it('isNullMac tolerates case and padding', () => {
    expect(isNullMac(' 00:00:00:00:00:00 ')).toBe(true);
    expect(isNullMac('00:00:00:00:00:01')).toBe(false);
    expect(isNullMac(null)).toBe(false);
  });
});

describe('resolveDnsListenPort', () => {
  it('refuses an out-of-range port instead of trying to bind it', () => {
    // The exact divergence: `Number('70000') || 53` is 70000.
    expect(resolveDnsListenPort('70000')).toBe(53);
    expect(resolveDnsListenPort(70000)).toBe(53);
    expect(resolveDnsListenPort(-1)).toBe(53);
    expect(resolveDnsListenPort(0)).toBe(53);
  });

  it('accepts a usable port', () => {
    expect(resolveDnsListenPort('53')).toBe(53);
    expect(resolveDnsListenPort(5353)).toBe(5353);
    expect(resolveDnsListenPort(65535)).toBe(65535);
    expect(resolveDnsListenPort(1)).toBe(1);
  });

  it('falls back for junk and for absent settings', () => {
    for (const v of [null, undefined, '', 'abc', '53.5', {}, []]) {
      expect(resolveDnsListenPort(v), JSON.stringify(v)).toBe(53);
    }
  });
});
