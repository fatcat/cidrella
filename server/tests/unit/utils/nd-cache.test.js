import { describe, it, expect } from 'vitest';
import { parseNeighTable } from '../../../src/utils/nd-cache.js';

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
    expect([...table.keys()]).toEqual(['fd00:a::1600', 'fd00:a::10', 'fe80::1', 'fd00:a::7']);
    expect(table.get('fd00:a::1600')).toEqual({ mac: 'aa:bb:cc:dd:ee:ff', interface: 'eth0', state: 'REACHABLE' });
    expect(table.get('fd00:a::10').mac).toBe('aa:bb:cc:dd:ee:10');
    expect(table.get('fe80::1')).toEqual({ mac: 'aa:bb:cc:dd:ee:01', interface: 'eth0', state: 'STALE' });
    // An all-zero MAC is no MAC.
    expect(table.get('fd00:a::7')).toEqual({ mac: null, interface: 'eth1', state: 'DELAY' });
  });

  it('returns an empty table for no output', () => {
    expect(parseNeighTable('').size).toBe(0);
    expect(parseNeighTable(undefined).size).toBe(0);
  });
});
