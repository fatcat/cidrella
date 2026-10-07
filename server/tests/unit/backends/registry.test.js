import { describe, it, expect } from 'vitest';
import {
  getService,
  getDnsBackend,
  getDhcpBackend,
  getRaBackend,
  uniqueServices,
  supports,
  featureReport,
} from '../../../src/backends/index.js';
import { FEATURE_IDS } from '../../../src/backends/features.js';

describe('backend registry', () => {
  it('fills every role with dnsmasq, built once', () => {
    expect(getService('dns').name).toBe('dnsmasq');
    expect(getService('dhcp')).toBe(getService('dns'));
    expect(getDnsBackend()).toBe(getService('dns').dns);
    expect(getDhcpBackend()).toBe(getService('dhcp').dhcp);
    expect(uniqueServices()).toEqual([getService('dns')]);
  });

  it('has a backend sending Router Advertisements', () => {
    expect(getRaBackend().capabilities().ra).toBe(true);
    expect(supports('ra')).toBe(true);
  });

  it('answers per feature, and refuses an id the catalog lacks', () => {
    expect(supports('dhcp6-stateful')).toBe(true);
    expect(supports('dns-axfr-out')).toBe(false);
    expect(() => supports('zone-transfers')).toThrow('Unknown backend feature: zone-transfers');
  });

  it('reports every catalog feature with its backend and a reason when off', () => {
    const report = featureReport();
    expect(report.map((f) => f.id)).toEqual(FEATURE_IDS);
    const ttl = report.find((f) => f.id === 'dns-record-ttl');
    expect(ttl).toMatchObject({ backend: 'dnsmasq', role: 'dns', supported: false });
    expect(ttl.reason).toMatch(/^TTL per record, as served is not available with dnsmasq\. /);
    expect(report.find((f) => f.id === 'ra')).toMatchObject({ supported: true, reason: null });
  });

  it('refuses a role it does not know', () => {
    expect(() => getService('ntp')).toThrow('Unknown backend role: ntp');
  });
});
