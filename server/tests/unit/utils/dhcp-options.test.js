import { describe, it, expect } from 'vitest';
import {
  DHCP_OPTIONS,
  DHCP6_OPTIONS,
  DHCP6_OPTIONS_BY_CODE,
  DHCP6_INTERNAL_CODES,
  optionCatalogFor,
  isOptionCodeAllowed,
} from '../../../src/utils/dhcp-options.js';

describe('DHCPv6 option catalog', () => {
  it('has unique codes, option6 names and no code dnsmasq builds itself', () => {
    const codes = DHCP6_OPTIONS.map((o) => o.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const opt of DHCP6_OPTIONS) {
      expect(opt.dnsmasqName).toBe(`option6:${opt.name}`);
      expect(DHCP6_INTERNAL_CODES.has(opt.code)).toBe(false);
      expect(['ip-list', 'text-list', 'text', 'number']).toContain(opt.type);
      expect(opt.rfcUrl).toMatch(/^https:\/\/datatracker\.ietf\.org\//);
    }
    expect(DHCP6_OPTIONS_BY_CODE[23]).toMatchObject({ name: 'dns-server', type: 'ip-list' });
    expect(DHCP6_OPTIONS_BY_CODE[24]).toMatchObject({ name: 'domain-search', type: 'text-list' });
    expect(DHCP6_OPTIONS_BY_CODE[56]).toMatchObject({ name: 'ntp-server', type: 'ip-list' });
  });

  it('has no mask, router or broadcast entry', () => {
    // Those come from Router Advertisements in IPv6. Codes are not comparable
    // across families (v6 28 is nis+-server), so check by name.
    const names = new Set(DHCP6_OPTIONS.map((o) => o.name));
    for (const name of ['subnet-mask', 'router', 'broadcast']) expect(names.has(name)).toBe(false);
  });

  it('picks the catalog by family and falls back to IPv4', () => {
    expect(optionCatalogFor(6).options).toBe(DHCP6_OPTIONS);
    expect(optionCatalogFor(6)).toMatchObject({ maxCode: 65535, customRange: [1, 65535] });
    expect(optionCatalogFor(4).options).toBe(DHCP_OPTIONS);
    expect(optionCatalogFor(4)).toMatchObject({ maxCode: 254, customRange: [128, 254] });
    expect(optionCatalogFor(undefined).options).toBe(DHCP_OPTIONS);
    expect(optionCatalogFor('6').options).toBe(DHCP6_OPTIONS);
  });

  it('allows user-settable codes only', () => {
    expect(isOptionCodeAllowed(23, 6)).toBe(true);
    expect(isOptionCodeAllowed(200, 6)).toBe(true);
    expect(isOptionCodeAllowed(65535, 6)).toBe(true);
    for (const internal of [1, 7, 15, 39]) expect(isOptionCodeAllowed(internal, 6)).toBe(false);
    expect(isOptionCodeAllowed(65536, 6)).toBe(false);
    expect(isOptionCodeAllowed(0, 6)).toBe(false);
    expect(isOptionCodeAllowed(254, 4)).toBe(true);
    expect(isOptionCodeAllowed(255, 4)).toBe(false);
    expect(isOptionCodeAllowed(1.5, 4)).toBe(false);
  });
});
