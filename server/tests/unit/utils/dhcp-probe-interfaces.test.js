import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';

// Mutable settings backing the mocked getSetting (hoisted so the vi.mock factory can see it).
const state = vi.hoisted(() => ({ settings: {} }));
vi.mock('../../../src/db/init.js', () => ({
  getDb: () => ({}),
  getSetting: (k) => (k in state.settings ? state.settings[k] : null),
}));

const { getLanInterfaces } = await import('../../../src/utils/dhcp-probe.js');

const IFACES = {
  lo:   [{ family: 'IPv4', internal: true,  address: '127.0.0.1', netmask: '255.0.0.0',     mac: '00:00:00:00:00:00' }],
  eth0: [{ family: 'IPv4', internal: false, address: '10.0.0.1',  netmask: '255.255.255.0', mac: 'aa:aa:aa:aa:aa:aa' }],
  eth1: [{ family: 'IPv4', internal: false, address: '10.0.1.1',  netmask: '255.255.255.0', mac: 'bb:bb:bb:bb:bb:bb' }],
};

beforeEach(() => {
  state.settings = {};
  vi.spyOn(os, 'networkInterfaces').mockReturnValue(IFACES);
});

describe('getLanInterfaces: rogue DHCP probes only DHCP-enabled segments', () => {
  it('returns [] when DHCP is globally disabled (even if an interface is dhcp:true)', () => {
    state.settings.dhcp_enabled = 'false';
    state.settings.interface_config = JSON.stringify({ eth0: { dhcp: true } });
    expect(getLanInterfaces()).toEqual([]);
  });

  it('with config, probes only dhcp interfaces and skips dns-only ones', () => {
    state.settings.interface_config = JSON.stringify({
      eth0: { dhcp: true, dns: true },
      eth1: { dhcp: false, dns: true },   // DNS-only → must NOT be probed
    });
    expect(getLanInterfaces().map(i => i.ifName)).toEqual(['eth0']);
  });

  it('skips an interface configured for neither dhcp nor dns', () => {
    state.settings.interface_config = JSON.stringify({
      eth0: { dhcp: false, dns: false },
      eth1: { dhcp: true },
    });
    expect(getLanInterfaces().map(i => i.ifName)).toEqual(['eth1']);
  });

  it('fresh deploy (no interface_config), DHCP on → all real interfaces (not lo)', () => {
    expect(getLanInterfaces().map(i => i.ifName).sort()).toEqual(['eth0', 'eth1']);
  });

  it('fresh deploy, DHCP off → []', () => {
    state.settings.dhcp_enabled = 'false';
    expect(getLanInterfaces()).toEqual([]);
  });

  it('carries mac + directed broadcast for the probed interface', () => {
    state.settings.interface_config = JSON.stringify({ eth0: { dhcp: true } });
    const [e] = getLanInterfaces();
    expect(e).toMatchObject({ ifName: 'eth0', address: '10.0.0.1', mac: 'aa:aa:aa:aa:aa:aa', broadcast: '10.0.0.255' });
  });
});
