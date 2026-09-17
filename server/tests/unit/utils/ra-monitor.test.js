import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/db/init.js', () => ({
  getDb: () => ({}),
  getSetting: () => null,
}));

const { parseRaRoutes, raSupportedOn, classifyRouter } =
  await import('../../../src/utils/ra-monitor.js');

const ROUTES = `
default via fe80::1 dev eth0 proto ra metric 1024 expires 1755sec hoplimit 64 pref medium
default via FE80::BAD:1 dev eth0 proto ra metric 1024 expires 1790sec hoplimit 64 pref high
fd00:1234::/64 dev eth0 proto ra metric 1024 expires 86391sec pref medium
2001:db8:bad::/64 dev eth0 proto ra metric 1024 expires 1790sec pref medium
fd00:9::/64 dev eth1 proto ra metric 1024 expires 86391sec pref medium
default via fe80::5 dev eth1 proto ra metric 1024 expires 1700sec hoplimit 64 pref medium
default via fe80::static dev eth2 metric 1024 pref medium
fd00:5::/64 dev eth2 proto kernel metric 256 pref medium
`;

describe('parseRaRoutes', () => {
  it('lists the routers the kernel learned from RAs, per interface, canonicalized', () => {
    const { routers } = parseRaRoutes(ROUTES);
    expect(routers).toEqual([
      { address: 'fe80::1', iface: 'eth0', expiresSec: 1755, preference: 'medium' },
      { address: 'fe80::bad:1', iface: 'eth0', expiresSec: 1790, preference: 'high' },
      { address: 'fe80::5', iface: 'eth1', expiresSec: 1700, preference: 'medium' },
    ]);
  });

  it('collects the advertised prefixes per interface and ignores non-RA routes', () => {
    const { prefixes } = parseRaRoutes(ROUTES);
    expect(prefixes.get('eth0')).toEqual(['fd00:1234::/64', '2001:db8:bad::/64']);
    expect(prefixes.get('eth1')).toEqual(['fd00:9::/64']);
    expect(prefixes.has('eth2')).toBe(false);
  });

  it('is empty on empty input', () => {
    expect(parseRaRoutes('').routers).toEqual([]);
    expect(parseRaRoutes(null).routers).toEqual([]);
  });
});

describe('raSupportedOn', () => {
  const sysctls = (values) => (iface, key) => values[`${iface}/${key}`] ?? null;

  it('accept_ra=2 always processes RAs', () => {
    expect(
      raSupportedOn('eth0', { read: sysctls({ 'eth0/accept_ra': '2', 'eth0/forwarding': '1' }) }),
    ).toBe(true);
  });

  it('accept_ra=1 only while forwarding is off', () => {
    expect(
      raSupportedOn('eth0', { read: sysctls({ 'eth0/accept_ra': '1', 'eth0/forwarding': '0' }) }),
    ).toBe(true);
    expect(
      raSupportedOn('eth0', { read: sysctls({ 'eth0/accept_ra': '1', 'eth0/forwarding': '1' }) }),
    ).toBe(false);
  });

  it('accept_ra=0 or a missing sysctl tree is unsupported', () => {
    expect(raSupportedOn('eth0', { read: sysctls({ 'eth0/accept_ra': '0' }) })).toBe(false);
    expect(raSupportedOn('eth0', { read: sysctls({}) })).toBe(false);
  });
});

describe('classifyRouter', () => {
  const trusted = {
    selfIps: new Set(['fe80::self']),
    authorized: {
      ips: new Set(['fe80::2']),
      macs: new Set(['aa:aa:aa:aa:aa:aa']),
      duids: new Set(),
    },
    gatewayMacs: new Set(['cc:cc:cc:cc:cc:cc']),
  };

  it('trusts ourselves, the allowlist by IP or MAC, and a configured gateway by MAC', () => {
    expect(classifyRouter({ address: 'fe80::self' }, trusted).reason).toBe('self');
    expect(classifyRouter({ address: 'fe80::2' }, trusted).reason).toBe('authorized');
    expect(
      classifyRouter({ address: 'fe80::9' }, { ...trusted, mac: 'AA:AA:AA:AA:AA:AA' }).reason,
    ).toBe('authorized');
    expect(
      classifyRouter({ address: 'fe80::9' }, { ...trusted, mac: 'cc:cc:cc:cc:cc:cc' }).reason,
    ).toBe('configured-gateway');
  });

  it('flags an unknown router, with or without a MAC', () => {
    expect(classifyRouter({ address: 'fe80::9' }, trusted)).toEqual({
      rogue: true,
      reason: 'unauthorized',
    });
    expect(
      classifyRouter({ address: 'fe80::9' }, { ...trusted, mac: 'dd:dd:dd:dd:dd:dd' }).rogue,
    ).toBe(true);
  });
});
