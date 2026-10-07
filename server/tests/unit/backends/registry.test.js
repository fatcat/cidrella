import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DHCP_BACKENDS,
  dhcpBackendName,
  getBackend,
  onBackendChanged,
  selectDhcpBackend,
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

describe('choosing the DHCP backend', () => {
  afterEach(() => {
    selectDhcpBackend('dnsmasq');
    for (const name of DHCP_BACKENDS) setDhcpServing(name, true);
  });

  it('moves only the DHCP role; dnsmasq keeps DNS and the RAs', () => {
    selectDhcpBackend('kea');
    expect(dhcpBackendName()).toBe('kea');
    expect(getService('dhcp')).toBe(getBackend('kea'));
    expect(getService('dns')).toBe(getBackend('dnsmasq'));
    expect(getRaBackend()).toBe(getBackend('dnsmasq'));
    expect(uniqueServices()).toEqual([getBackend('dnsmasq'), getBackend('kea')]);
    expect(supports('forensic-log')).toBe(true);
    expect(supports('ra')).toBe(true);
  });

  it('serves DHCP from the selected backend only, and not while held quiet', () => {
    expect(servesDhcp('dnsmasq')).toBe(true);
    expect(servesDhcp('kea')).toBe(false);
    setDhcpServing('dnsmasq', false);
    expect(servesDhcp('dnsmasq')).toBe(false);
    selectDhcpBackend('kea');
    expect(servesDhcp('kea')).toBe(true);
  });

  it('tells listeners when the role moves, and only then', () => {
    const heard = vi.fn();
    const stop = onBackendChanged(heard);
    selectDhcpBackend('dnsmasq');
    expect(heard).not.toHaveBeenCalled();
    selectDhcpBackend('kea');
    expect(heard).toHaveBeenCalledWith('dhcp');
    stop();
    selectDhcpBackend('dnsmasq');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('refuses a backend it does not know', () => {
    expect(() => selectDhcpBackend('isc-dhcpd')).toThrow('Unknown DHCP backend: isc-dhcpd');
    expect(dhcpBackendName()).toBe('dnsmasq');
  });
});
