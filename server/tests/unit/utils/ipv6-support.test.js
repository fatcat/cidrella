import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ settings: {} }));
vi.mock('../../../src/db/init.js', () => ({
  getDb: () => ({}),
  getSetting: (k) => (k in state.settings ? state.settings[k] : null),
}));
vi.mock('../../../src/utils/dhcp-probe.js', () => ({
  runProbe: vi.fn(async () => ({ supported: true, interfaces: 1, offers: 0, rogues: [] })),
  selectProbeInterfaceNames: vi.fn(() => []),
}));
vi.mock('../../../src/utils/dhcpv6-probe.js', () => ({
  runProbe6: vi.fn(async () => ({ supported: true, interfaces: 1, advertisements: 0, rogues: [] })),
}));
vi.mock('../../../src/utils/ra-monitor.js', () => ({
  checkRouterAdvertisements: vi.fn(() => ({
    supported: true,
    interfaces: 1,
    routers: 0,
    rogues: [],
  })),
}));

const { ipv6Enabled, refuseIpv6Unless, IPV6_DISABLED_ERROR } =
  await import('../../../src/utils/ipv6-support.js');
const { runRogueDetection } = await import('../../../src/utils/rogue-detection.js');
const { runProbe6 } = await import('../../../src/utils/dhcpv6-probe.js');
const { checkRouterAdvertisements } = await import('../../../src/utils/ra-monitor.js');

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

beforeEach(() => {
  state.settings = {};
  vi.mocked(runProbe6).mockClear();
  vi.mocked(checkRouterAdvertisements).mockClear();
});

describe('ipv6Enabled', () => {
  it('is off by default and on only for the literal string true', () => {
    expect(ipv6Enabled()).toBe(false);
    state.settings.ipv6_enabled = 'false';
    expect(ipv6Enabled()).toBe(false);
    state.settings.ipv6_enabled = 'true';
    expect(ipv6Enabled()).toBe(true);
  });
});

describe('refuseIpv6Unless', () => {
  it('sends the one 400 message when off and returns true', () => {
    const res = fakeRes();
    expect(refuseIpv6Unless(res)).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: IPV6_DISABLED_ERROR });
  });

  it('sends nothing and returns false when on', () => {
    state.settings.ipv6_enabled = 'true';
    const res = fakeRes();
    expect(refuseIpv6Unless(res)).toBe(false);
    expect(res.statusCode).toBeNull();
  });
});

describe('runRogueDetection with IPv6 off', () => {
  it('runs the DHCPv4 probe only and reports the IPv6 detectors as disabled', async () => {
    const result = await runRogueDetection({});
    expect(result.dhcp.supported).toBe(true);
    expect(runProbe6).not.toHaveBeenCalled();
    expect(checkRouterAdvertisements).not.toHaveBeenCalled();
    expect(result.dhcpv6).toEqual({
      supported: false,
      disabled: true,
      error: IPV6_DISABLED_ERROR,
      interfaces: 0,
      advertisements: 0,
      rogues: [],
    });
    expect(result.routerAdvertisements).toMatchObject({ disabled: true, routers: 0, rogues: [] });
  });

  it('runs all three when on', async () => {
    state.settings.ipv6_enabled = 'true';
    const result = await runRogueDetection({});
    expect(runProbe6).toHaveBeenCalledTimes(1);
    expect(checkRouterAdvertisements).toHaveBeenCalledTimes(1);
    expect(result.dhcpv6.supported).toBe(true);
    expect(result.routerAdvertisements.supported).toBe(true);
  });
});
