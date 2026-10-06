import { describe, it, expect } from 'vitest';
import {
  getService,
  getDnsBackend,
  getDhcpBackend,
  getRaBackend,
  uniqueServices,
} from '../../../src/backends/index.js';

describe('backend registry', () => {
  it('fills every role with dnsmasq, built once', () => {
    expect(getService('dns').name).toBe('dnsmasq');
    expect(getService('dhcp')).toBe(getService('dns'));
    expect(getDnsBackend()).toBe(getService('dns').dns);
    expect(getDhcpBackend()).toBe(getService('dhcp').dhcp);
    expect(uniqueServices()).toEqual([getService('dns')]);
  });

  it('has a backend sending Router Advertisements', () => {
    expect(getRaBackend().capabilities().routerAdvertisements).toBe(true);
  });

  it('refuses a role it does not know', () => {
    expect(() => getService('ntp')).toThrow('Unknown backend role: ntp');
  });
});
