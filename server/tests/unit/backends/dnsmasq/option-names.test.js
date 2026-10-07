import { describe, it, expect } from 'vitest';
import { dnsmasqOptionToken } from '../../../../src/backends/dnsmasq/option-names.js';

describe('dnsmasqOptionToken', () => {
  it('writes DHCPv4 options by number', () => {
    expect(dnsmasqOptionToken(42, 4)).toBe('42');
  });

  it('names a DHCPv6 option dnsmasq knows, and numbers the rest', () => {
    expect(dnsmasqOptionToken(23, 6)).toBe('option6:dns-server');
    expect(dnsmasqOptionToken(56, 6)).toBe('option6:ntp-server');
    // Captive Portal (103) has no dnsmasq name; the name would be refused.
    expect(dnsmasqOptionToken(103, 6)).toBe('option6:103');
    expect(dnsmasqOptionToken(200, 6)).toBe('option6:200');
  });
});
