import { describe, expect, it } from 'vitest';
import {
  FALLBACK_SECONDARY_DNS,
  networkOptionFills,
} from '../../../src/utils/dhcp-network-options.js';
import { parseNetwork } from '../../../src/utils/ip.js';
import { fillScopeOptions, USE_DEFAULT } from '../../../src/services/subnet-dhcp-topology.js';

// DHCP-02: one rule for what a scope takes from its network, shared with the
// scope dialog through @shared.
describe('networkOptionFills', () => {
  it('IPv4: topology values replace, the rest fill a blank', () => {
    const parsed = parseNetwork('10.60.0.0/24');
    expect(
      networkOptionFills({
        family: 4,
        mask: parsed.mask,
        broadcast: parsed.broadcast,
        gateway: '10.60.0.1',
        domain: 'lab.test',
        serverIp: '10.60.0.2',
      }),
    ).toEqual([
      { code: 3, value: '10.60.0.1', overwrite: true },
      { code: 1, value: '255.255.255.0', overwrite: true },
      { code: 28, value: '10.60.0.255', overwrite: true },
      { code: 15, value: 'lab.test', overwrite: false },
      { code: 119, value: 'lab.test', overwrite: false },
      { code: 6, value: `10.60.0.2, ${FALLBACK_SECONDARY_DNS}`, overwrite: false },
    ]);
  });

  it('IPv6: the search list and DNS only, no fallback, nothing the network lacks', () => {
    expect(
      networkOptionFills({ family: 6, domain: 'six.test', serverIp: 'fd00:60::53' }),
    ).toEqual([
      { code: 24, value: 'six.test', overwrite: false },
      { code: 23, value: 'fd00:60::53', overwrite: false },
    ]);
    expect(networkOptionFills({ family: 6, domain: 'six.test' })).toEqual([
      { code: 24, value: 'six.test', overwrite: false },
    ]);
  });

  it('is what fillScopeOptions applies, both families', () => {
    const v4 = fillScopeOptions(
      [
        { code: 6, value: '' },
        { code: 15, value: 'own.test' },
        { code: 1, value: USE_DEFAULT },
      ],
      {
        parsed: parseNetwork('10.60.0.0/24'),
        gateway: '10.60.0.1',
        domain: 'lab.test',
        serverIp: '10.60.0.2',
      },
    );
    expect(Object.fromEntries(v4)).toEqual({
      1: '255.255.255.0',
      3: '10.60.0.1',
      6: `10.60.0.2, ${FALLBACK_SECONDARY_DNS}`,
      15: 'own.test',
      28: '10.60.0.255',
      119: 'lab.test',
    });
    const v6 = fillScopeOptions([{ code: 23, value: '' }, { code: 24, value: USE_DEFAULT }], {
      parsed: parseNetwork('fd00:60::/64'),
      domain: 'six.test',
      serverIp: 'fd00:60::53',
    });
    expect(v6.get(23)).toBe('fd00:60::53');
    expect(v6.get(24)).toBe(USE_DEFAULT);
  });
});
