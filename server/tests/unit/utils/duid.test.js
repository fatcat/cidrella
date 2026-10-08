import { describe, it, expect } from 'vitest';
import { macFromDuid, normalizeDuid } from '../../../src/utils/duid.js';

describe('macFromDuid', () => {
  it('reads the Ethernet MAC of a DUID-LLT and a DUID-LL', () => {
    expect(macFromDuid('00:01:00:01:2e:3f:40:51:AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(macFromDuid('00:03:00:01:aa:bb:cc:dd:ee:01')).toBe('aa:bb:cc:dd:ee:01');
  });

  it('has none for DUID-EN, DUID-UUID, another hardware type or a malformed DUID', () => {
    expect(macFromDuid('00:02:00:00:ab:11:65:6e:74:65:72:70:72:69:73:65')).toBeNull();
    expect(macFromDuid(`00:04:${'11:'.repeat(15)}11`)).toBeNull();
    // Hardware type 6 (IEEE 802) is not Ethernet.
    expect(macFromDuid('00:03:00:06:aa:bb:cc:dd:ee:01')).toBeNull();
    // A DUID-LL whose address is not six bytes.
    expect(macFromDuid('00:03:00:01:aa:bb:cc:dd')).toBeNull();
    expect(macFromDuid('not a duid')).toBeNull();
    expect(macFromDuid(null)).toBeNull();
  });

  it('agrees with the canonical spelling', () => {
    expect(normalizeDuid(' 00:03:00:01:AA:BB:CC:DD:EE:01 ')).toBe('00:03:00:01:aa:bb:cc:dd:ee:01');
  });
});
