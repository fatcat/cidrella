import { describe, it, expect } from 'vitest';
import { serviceChips } from '../../../src/utils/service-chips.js';

const base = { dnsmasq: true, geoip_proxy: true, geoip_bypassed: false };
const forwarders = (services) => serviceChips(services).find((c) => c.key === 'forwarders');

describe('serviceChips: forwarders', () => {
  it('names each encrypted provider address with its time or its problem, either family', () => {
    const chip = forwarders({
      ...base,
      forwarders: [
        {
          ip: '9.9.9.10',
          label: 'dns10.quad9.net',
          protocol: 'dot',
          reachable: false,
          latency_ms: null,
          problem: 'DoT timeout',
        },
        {
          ip: '2620:fe::10',
          label: 'dns10.quad9.net',
          protocol: 'dot',
          reachable: true,
          latency_ms: 14,
          problem: null,
        },
      ],
    });
    expect(chip).toMatchObject({ value: '1 of 2', tone: 'warn' });
    expect(chip.title).toBe(
      'dns10.quad9.net 9.9.9.10 (DoT): DoT timeout\ndns10.quad9.net 2620:fe::10 (DoT): 14 ms',
    );
  });

  it('shows a plain server by its address alone, and an older reply without times', () => {
    const chip = forwarders({
      ...base,
      forwarders: [
        { ip: '8.8.8.8', label: '8.8.8.8', protocol: 'dns', reachable: true, latency_ms: 9 },
        { ip: '1.1.1.1', reachable: true },
      ],
    });
    expect(chip).toMatchObject({ value: '2 of 2', tone: 'ok' });
    expect(chip.title).toBe('8.8.8.8: 9 ms\n1.1.1.1: reachable');
  });

  it('is muted with no forwarders', () => {
    expect(forwarders({ ...base, forwarders: [] })).toMatchObject({ value: 'none', tone: 'muted' });
  });
});

describe('serviceChips: backends', () => {
  it('shows each daemon of the PowerDNS + Kea stack by its label, radvd idle when unneeded', () => {
    const backends = {
      dns: { name: 'pdns', label: 'PowerDNS', running: true },
      dhcp: { name: 'kea', label: 'Kea', running: false },
      ra: { name: 'radvd', label: 'radvd', running: false, idle: true },
    };
    const chips = serviceChips({ ...base, backends }).slice(0, 3);
    expect(chips.map((c) => [c.label, c.value, c.tone])).toEqual([
      ['PowerDNS', 'Running', 'ok'],
      ['Kea', 'Stopped', 'err'],
      ['radvd', 'Idle', 'muted'],
    ]);
  });

  it('shows a daemon switched off, and the DNS proxy, as off rather than failed', () => {
    const backends = {
      dns: { name: 'pdns', label: 'PowerDNS', running: true, off: true },
      dhcp: { name: 'kea', label: 'Kea', running: true, off: true },
      ra: { name: 'radvd', label: 'radvd', running: false, idle: true },
    };
    const chips = serviceChips({ ...base, geoip_proxy: false, backends });
    expect(chips.slice(0, 4).map((c) => [c.label, c.value, c.tone])).toEqual([
      ['PowerDNS', 'Off', 'muted'],
      ['Kea', 'Off', 'muted'],
      ['radvd', 'Idle', 'muted'],
      ['DNS proxy', 'Off', 'muted'],
    ]);
  });
});
