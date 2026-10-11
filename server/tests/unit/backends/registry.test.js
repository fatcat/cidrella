import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  STACKS,
  getBackend,
  onBackendChanged,
  selectStack,
  stackName,
  stackServices,
  servesDhcp,
  setDhcpServing,
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
  it('fills every role with dnsmasq by default, built once', () => {
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

describe('choosing the stack', () => {
  afterEach(() => {
    selectStack('dnsmasq');
    setDhcpServing('kea', true);
  });

  it('moves every role: PowerDNS for DNS, Kea for DHCP, radvd for the RAs', () => {
    selectStack('pdns-kea');
    expect(stackName()).toBe('pdns-kea');
    expect(getService('dns')).toBe(getBackend('pdns'));
    expect(getService('dhcp')).toBe(getBackend('kea'));
    expect(getRaBackend()).toBe(getBackend('radvd'));
    expect(uniqueServices()).toEqual([getBackend('pdns'), getBackend('kea'), getBackend('radvd')]);
    expect(stackServices('pdns-kea')).toEqual(uniqueServices());
    expect(stackServices('dnsmasq')).toEqual([getBackend('dnsmasq')]);
    expect(supports('forensic-log')).toBe(true);
    expect(supports('ra')).toBe(true);
    expect(supports('dns-record-ttl')).toBe(true);
  });

  it('names a backend for every role in every stack', () => {
    for (const roles of Object.values(STACKS)) {
      expect(Object.keys(roles).sort()).toEqual(['dhcp', 'dns', 'ra']);
    }
  });

  it("serves DHCP from the stack's DHCP backend only, and not while held quiet", () => {
    expect(servesDhcp('dnsmasq')).toBe(true);
    expect(servesDhcp('kea')).toBe(false);
    selectStack('pdns-kea');
    expect(servesDhcp('dnsmasq')).toBe(false);
    expect(servesDhcp('kea')).toBe(true);
    setDhcpServing('kea', false);
    expect(servesDhcp('kea')).toBe(false);
  });

  it('tells listeners of each role that moved, and only then', () => {
    const heard = vi.fn();
    const stop = onBackendChanged(heard);
    selectStack('dnsmasq');
    expect(heard).not.toHaveBeenCalled();
    selectStack('pdns-kea');
    expect(heard.mock.calls.map(([role]) => role)).toEqual(['dns', 'dhcp', 'ra']);
    stop();
    selectStack('dnsmasq');
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it('refuses a stack it does not know', () => {
    expect(() => selectStack('bind-isc')).toThrow('Unknown backend stack: bind-isc');
    expect(stackName()).toBe('dnsmasq');
  });
});
