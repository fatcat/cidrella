import { describe, it, expect } from 'vitest';
import { canonicalizeIp, addressFamily, sortKey, isValidIp } from '@shared/address.js';
import { ipToLong } from '../../../src/utils/ip.js';

/**
 * Proves the @shared alias resolves from the client package, and that the
 * address core behaves identically here and on the server.
 *
 * The point of this file is the IMPORT LINE. docs/CROSS-TIER-DUPLICATION.md
 * warns that the cost of a shared module is plumbing that "only shows up in a
 * built artifact": Vite resolution, release staging, and the staging guard. A
 * unit test catches the resolution half in CI. The build half is covered by
 * `npm run build:client`, which fails outright if the alias is wrong.
 *
 * The expected values below are duplicated from the server suite ON PURPOSE.
 * If someone points @shared somewhere else, or ships a client-local fork of
 * the module, these stop matching and this goes red. That is the whole job.
 */
describe('@shared/address.js resolves and behaves identically in the client', () => {
  it('imports through the alias at all', () => {
    expect(typeof canonicalizeIp).toBe('function');
    expect(typeof addressFamily).toBe('function');
  });

  it('canonicalizes v6 the same way the server does', () => {
    expect(canonicalizeIp('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(canonicalizeIp('1:2:3:4:5:0:7:8')).toBe('1:2:3:4:5:0:7:8');
    expect(canonicalizeIp('1:0:0:2:0:0:3:4')).toBe('1::2:0:0:3:4');
    expect(canonicalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(canonicalizeIp('::')).toBe('::');
  });

  it('classifies families the same way', () => {
    expect(addressFamily('10.0.0.1')).toBe(4);
    expect(addressFamily('2001:db8::1')).toBe(6);
    expect(addressFamily('::ffff:10.0.0.1')).toBe(4);
    expect(addressFamily('nonsense')).toBeNull();
  });

  it('produces the same fixed-width sort keys', () => {
    expect(sortKey('10.0.0.1')).toBe('4' + '0'.repeat(24) + '0a000001');
    expect(sortKey('::1')).toBe('6' + '0'.repeat(31) + '1');
    expect(sortKey('bad')).toBeNull();
  });

  it('agrees with the client-local v4 helper on v4 addresses', () => {
    // client/src/utils/ip.js still owns the v4 math and is migrated later.
    // Until then the two must not disagree about what a v4 address is worth.
    for (const s of ['0.0.0.0', '10.0.0.1', '192.168.1.1', '255.255.255.255']) {
      expect(BigInt(ipToLong(s)), s).toBe(BigInt('0x' + sortKey(s).slice(-8)));
      expect(isValidIp(s), s).toBe(true);
    }
  });
});
