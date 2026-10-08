import { describe, it, expect } from 'vitest';
import { parseNeighTable, findNeighbor } from '../../../src/utils/nd-cache.js';

describe('parseNeighTable', () => {
  it('reads reachable and stale neighbors with their interface and MAC, in canonical spelling', () => {
    const table = parseNeighTable(
      [
        'fd00:a::1600 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE',
        'FD00:000A::0010 dev eth0 lladdr AA:BB:CC:DD:EE:10 STALE',
        'fe80::1 dev eth0 lladdr aa:bb:cc:dd:ee:01 router STALE',
        'fd00:a::9 dev eth0 FAILED',
        'fd00:a::8 dev eth0 INCOMPLETE',
        'fd00:a::7 dev eth1 lladdr 00:00:00:00:00:00 DELAY',
        '',
        'garbage line',
      ].join('\n'),
    );
    // A link-local address is keyed with its interface; a global is not.
    expect([...table.keys()]).toEqual(['fd00:a::1600', 'fd00:a::10', 'fe80::1%eth0', 'fd00:a::7']);
    expect(table.get('fd00:a::1600')).toEqual({
      ip: 'fd00:a::1600',
      mac: 'aa:bb:cc:dd:ee:ff',
      interface: 'eth0',
      state: 'REACHABLE',
    });
    expect(table.get('fd00:a::10').mac).toBe('aa:bb:cc:dd:ee:10');
    expect(table.get('fe80::1%eth0')).toEqual({
      ip: 'fe80::1',
      mac: 'aa:bb:cc:dd:ee:01',
      interface: 'eth0',
      state: 'STALE',
    });
    // An all-zero MAC is no MAC.
    expect(table.get('fd00:a::7')).toEqual({
      ip: 'fd00:a::7',
      mac: null,
      interface: 'eth1',
      state: 'DELAY',
    });
  });

  it('keeps one link-local address on two links apart (IPV6-14)', () => {
    const table = parseNeighTable(
      [
        'fe80::1 dev eth0 lladdr 66:66:66:66:66:66 router REACHABLE',
        'fe80::1 dev eth1 lladdr aa:aa:aa:aa:aa:01 router REACHABLE',
        'fe80::9 dev eth1 lladdr aa:aa:aa:aa:aa:09 STALE',
        'FD00:A::5 dev eth0 lladdr aa:aa:aa:aa:aa:05 REACHABLE',
      ].join('\n'),
    );
    expect(table.size).toBe(4);
    expect(findNeighbor(table, 'fe80::1', 'eth0').mac).toBe('66:66:66:66:66:66');
    expect(findNeighbor(table, 'fe80::1', 'eth1').mac).toBe('aa:aa:aa:aa:aa:01');
    expect(findNeighbor(table, 'fe80::1%eth1').mac).toBe('aa:aa:aa:aa:aa:01');
    expect(findNeighbor(table, 'fe80::1', 'eth2')).toBeNull();
    // Without an interface, only an address one link has answers.
    expect(findNeighbor(table, 'fe80::1')).toBeNull();
    expect(findNeighbor(table, 'fe80::9').mac).toBe('aa:aa:aa:aa:aa:09');
    // A global address is one neighbor whatever the interface or spelling.
    expect(findNeighbor(table, 'fd00:a:0::5').mac).toBe('aa:aa:aa:aa:aa:05');
    expect(findNeighbor(table, '10.0.0.1')).toBeNull();
  });

  it('returns an empty table for no output', () => {
    expect(parseNeighTable('').size).toBe(0);
    expect(parseNeighTable(undefined).size).toBe(0);
  });
});
