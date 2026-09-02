import { describe, it, expect, vi } from 'vitest';

let stored = null;
vi.mock('../../../src/db/init.js', () => ({ getSetting: () => stored }));

const { selectInterfaceNames, readInterfaceConfig } =
  await import('../../../src/utils/interface-config.js');

/**
 * Duplicate-logic audit #9. dnsmasq.js, dns-proxy.js and dhcp-probe.js each
 * parsed interface_config and walked it themselves. dhcp-probe's copy carried a
 * comment saying it "mirrors dnsmasq.js exactly", which named the risk without
 * doing anything about it. Selection is now shared, so these are the rules all
 * three obey.
 */
const SYS = {
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  eth0: [{ family: 'IPv4', address: '10.0.0.2', internal: false }],
  eth1: [{ family: 'IPv4', address: '10.0.1.2', internal: false }],
  eth2: [{ family: 'IPv4', address: '10.0.2.2', internal: false }],
};

describe('selectInterfaceNames with an explicit config', () => {
  const config = {
    eth0: { dns: true, dhcp: true },
    eth1: { dns: true, dhcp: false },
    eth2: { dns: false, dhcp: false },
  };

  it('dns picks the DNS-enabled interfaces', () => {
    expect(selectInterfaceNames('dns', { config, sysIfaces: SYS }).names).toEqual(['eth0', 'eth1']);
  });

  it('dhcp picks only the DHCP-enabled ones, not the dns-only interface', () => {
    expect(selectInterfaceNames('dhcp', { config, sysIfaces: SYS }).names).toEqual(['eth0']);
  });

  it("'any' picks anything enabled for either, which is dnsmasq's rule", () => {
    expect(selectInterfaceNames('any', { config, sysIfaces: SYS }).names).toEqual(['eth0', 'eth1']);
  });

  it('reports explicit: true', () => {
    expect(selectInterfaceNames('dns', { config, sysIfaces: SYS }).explicit).toBe(true);
  });

  it('drops a configured interface that no longer exists on the host', () => {
    const stale = { eth0: { dns: true }, ghost0: { dns: true } };
    expect(selectInterfaceNames('dns', { config: stale, sysIfaces: SYS }).names).toEqual(['eth0']);
  });

  it('does not resolve prototype keys up the chain', () => {
    // Naked indexing on 'constructor' returns a function, and the callers then
    // do for...of over it and crash. The validator rejects these at write time;
    // this is the defence-in-depth path for older stored config.
    for (const key of ['constructor', '__proto__', 'toString', 'valueOf']) {
      const evil = { [key]: { dns: true, dhcp: true } };
      expect(selectInterfaceNames('any', { config: evil, sysIfaces: SYS }).names, key).toEqual([]);
    }
  });
});

describe('selectInterfaceNames with no config (fresh deploy)', () => {
  it('returns every real interface and excludes loopback', () => {
    const r = selectInterfaceNames('dhcp', { config: {}, sysIfaces: SYS });
    expect(r.explicit).toBe(false);
    expect(r.names).toEqual(['eth0', 'eth1', 'eth2']);
    expect(r.names).not.toContain('lo');
  });

  it('gives the same answer whatever the service, matching dnsmasq on a fresh deploy', () => {
    const dns = selectInterfaceNames('dns', { config: {}, sysIfaces: SYS }).names;
    const dhcp = selectInterfaceNames('dhcp', { config: {}, sysIfaces: SYS }).names;
    const any = selectInterfaceNames('any', { config: {}, sysIfaces: SYS }).names;
    expect(dns).toEqual(dhcp);
    expect(dhcp).toEqual(any);
  });
});

describe('readInterfaceConfig', () => {
  it('returns {} for missing, malformed, or non-object settings', () => {
    for (const v of [null, '', 'not json', '[1,2]', '"a string"', '42']) {
      stored = v;
      expect(readInterfaceConfig(), JSON.stringify(v)).toEqual({});
    }
  });

  it('parses a real config', () => {
    stored = JSON.stringify({ eth0: { dns: true } });
    expect(readInterfaceConfig()).toEqual({ eth0: { dns: true } });
  });
});
