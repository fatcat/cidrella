import { describe, it, expect } from 'vitest';
import { renderRadvdConfig } from '../../../../src/backends/radvd/render.js';

const scope = (network, mode, leaseTime, options = []) => ({
  network,
  prefix: 64,
  mode,
  leaseTime,
  options,
});

describe('renderRadvdConfig', () => {
  it('renders nothing when no link has a scope (radvd refuses an empty file)', () => {
    expect(renderRadvdConfig([])).toBeNull();
    expect(renderRadvdConfig([{ name: 'eth0', mtu: 1500, scopes: [] }])).toBeNull();
  });

  it('sets the flags per mode, as dnsmasq does', () => {
    const flags = (mode) => {
      const text = renderRadvdConfig([
        { name: 'eth0', mtu: null, scopes: [scope('fd00:1::', mode, '1h')] },
      ]);
      return [
        /AdvManagedFlag (on|off)/.exec(text)[1],
        /AdvOtherConfigFlag (on|off)/.exec(text)[1],
        /AdvAutonomous (on|off)/.exec(text)[1],
      ];
    };
    expect(flags('slaac')).toEqual(['off', 'off', 'on']);
    expect(flags('stateless')).toEqual(['off', 'on', 'on']);
    expect(flags('stateful')).toEqual(['on', 'on', 'off']);
  });

  it('never offers CIDRella as a default router', () => {
    const text = renderRadvdConfig([
      { name: 'eth0', mtu: null, scopes: [scope('fd00:1::', 'slaac', '1h')] },
    ]);
    expect(text).toContain('AdvDefaultLifetime 0;');
    expect(text).not.toContain('AdvLinkMTU');
  });

  it('gives the DNS options the shortest finite prefix lifetime', () => {
    const dns = { code: 23, addresses: ['fd00:1::2'] };
    const search = { code: 24, text: 'a.test, b.test' };
    const text = renderRadvdConfig([
      {
        name: 'eth0',
        mtu: 9000,
        scopes: [
          scope('fd00:1::', 'stateless', 'infinite', [dns, search]),
          scope('fd00:2::', 'slaac', '30m', [dns]),
        ],
      },
    ]);
    expect(text).toContain('AdvValidLifetime infinity;');
    expect(text).toContain('AdvValidLifetime 1800;');
    expect(text).toContain('  RDNSS fd00:1::2 {\n    AdvRDNSSLifetime 1800;');
    expect(text).toContain('  DNSSL a.test b.test {\n    AdvDNSSLLifetime 1800;');
    expect(text).toContain('AdvLinkMTU 9000;');
  });
});
