import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';

// Mutable settings backing the mocked getSetting (hoisted so the vi.mock factory can see it).
const state = vi.hoisted(() => ({ settings: {} }));
vi.mock('../../../src/db/init.js', () => ({
  getDb: () => ({}),
  getSetting: (k) => (k in state.settings ? state.settings[k] : null),
}));
vi.mock('../../../src/models/rogue-dhcp.js', () => ({
  authorizedIpSet: () => new Set(),
  upsertRogueEvent: () => {},
}));

// A stand-in for dgram that records how each socket is bound and what it sends.
const sockets = vi.hoisted(() => []);
vi.mock('dgram', async () => {
  const { EventEmitter } = await import('events');
  const createSocket = () => {
    const sock = Object.assign(new EventEmitter(), {
      sends: [],
      bind(port, address, cb) {
        sock.bound = { port, address };
        setImmediate(cb);
      },
      setBroadcast() {},
      send(pkt, port, address, cb) {
        sock.sends.push({ port, address });
        cb?.(null);
      },
      close() {},
    });
    sockets.push(sock);
    return sock;
  };
  return { default: { createSocket }, createSocket };
});

const { getLanInterfaces, runProbe } = await import('../../../src/utils/dhcp-probe.js');

const IFACES = {
  lo: [
    {
      family: 'IPv4',
      internal: true,
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      mac: '00:00:00:00:00:00',
    },
  ],
  eth0: [
    {
      family: 'IPv4',
      internal: false,
      address: '10.0.0.1',
      netmask: '255.255.255.0',
      mac: 'aa:aa:aa:aa:aa:aa',
    },
  ],
  eth1: [
    {
      family: 'IPv4',
      internal: false,
      address: '10.0.1.1',
      netmask: '255.255.255.0',
      mac: 'bb:bb:bb:bb:bb:bb',
    },
  ],
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
      eth1: { dhcp: false, dns: true }, // DNS-only → must NOT be probed
    });
    expect(getLanInterfaces().map((i) => i.ifName)).toEqual(['eth0']);
  });

  it('skips an interface configured for neither dhcp nor dns', () => {
    state.settings.interface_config = JSON.stringify({
      eth0: { dhcp: false, dns: false },
      eth1: { dhcp: true },
    });
    expect(getLanInterfaces().map((i) => i.ifName)).toEqual(['eth1']);
  });

  it('fresh deploy (no interface_config), DHCP on → all real interfaces (not lo)', () => {
    expect(
      getLanInterfaces()
        .map((i) => i.ifName)
        .sort(),
    ).toEqual(['eth0', 'eth1']);
  });

  it('fresh deploy, DHCP off → []', () => {
    state.settings.dhcp_enabled = 'false';
    expect(getLanInterfaces()).toEqual([]);
  });

  it('carries the mac and address the DISCOVER leaves from', () => {
    state.settings.interface_config = JSON.stringify({ eth0: { dhcp: true } });
    const [e] = getLanInterfaces();
    expect(e).toEqual({ ifName: 'eth0', address: '10.0.0.1', mac: 'aa:aa:aa:aa:aa:aa' });
  });
});

// Kea's packet filter takes a DHCPv4 packet only when it is addressed to
// 255.255.255.255 or to Kea's own address, so the probe's DISCOVER to the
// directed broadcast (10.0.3.255) never reached it: a Kea server served
// testerella's LAN for four days while prod's probe saw nothing.
describe('runProbe: sends each DISCOVER the way a client does', () => {
  beforeEach(() => sockets.splice(0));

  it('listens on every address and sends 255.255.255.255 from each interface address', async () => {
    const result = await runProbe({}, { windowMs: 5 });
    expect(result.interfaces).toBe(2);
    const [listener, ...senders] = sockets;
    expect(listener.bound).toEqual({ port: 68, address: '0.0.0.0' });
    expect(listener.sends).toEqual([]);
    expect(senders.map((s) => s.bound)).toEqual([
      { port: 68, address: '10.0.0.1' },
      { port: 68, address: '10.0.1.1' },
    ]);
    for (const s of senders) expect(s.sends).toEqual([{ port: 67, address: '255.255.255.255' }]);
  });
});
