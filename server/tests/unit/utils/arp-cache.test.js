import { describe, it, expect } from 'vitest';
import { parseArpingMac, parseArpTable } from '../../../src/utils/arp-cache.js';

describe('parseArpingMac', () => {
  // Regression: the original parser only matched the bracketed iputils form, so
  // on any host running the other arping every MAC was dropped. Nothing
  // downstream could recover it, because a successful arping skips the ICMP
  // fallback and arping does not populate the kernel neighbour table.
  it('reads the arping package (Habets) format, MAC bare with address in parens', () => {
    const out = '60 bytes from b2:56:20:67:46:66 (10.0.0.4): index=0 time=26.789 msec';
    expect(parseArpingMac(out)).toBe('b2:56:20:67:46:66');
  });

  it('reads the iputils-arping format, MAC in square brackets', () => {
    const out = 'ARPING 10.0.0.4 from 10.0.3.250 eth0\nUnicast reply from 10.0.0.4 [B2:56:20:67:46:66]  0.746ms';
    expect(parseArpingMac(out)).toBe('b2:56:20:67:46:66');
  });

  it('lowercases the result', () => {
    expect(parseArpingMac('reply [AA:BB:CC:DD:EE:FF]')).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('returns null when there is no MAC in the output', () => {
    expect(parseArpingMac('ARPING 10.0.0.9\nTimeout')).toBeNull();
    expect(parseArpingMac('')).toBeNull();
    expect(parseArpingMac(undefined)).toBeNull();
  });

  it('does not mistake an all-zero MAC for a real one', () => {
    expect(parseArpingMac('from 00:00:00:00:00:00 (10.0.0.4)')).toBeNull();
  });

  it('is not fooled by the timing or index fields', () => {
    // Guards the loose original character class, which would happily match any
    // run of hex and colons.
    const out = '60 bytes from aa:bb:cc:11:22:33 (10.0.0.4): index=0 time=1.5 msec';
    expect(parseArpingMac(out)).toBe('aa:bb:cc:11:22:33');
  });
});

describe('parseArpTable', () => {
  const table = [
    'IP address       HW type     Flags       HW address            Mask     Device',
    '10.0.0.131       0x1         0x2         F0:AD:4E:3E:95:EB     *        eth0',
    '10.0.3.198       0x1         0x0         00:00:00:00:00:00     *        eth0',
    '10.0.8.228       0x1         0x2         bc:24:11:6d:60:81     *        eth2',
    ''
  ].join('\n');

  it('maps addresses to lowercased MACs and skips the header', () => {
    const map = parseArpTable(table);
    expect(map.get('10.0.0.131')).toBe('f0:ad:4e:3e:95:eb');
    expect(map.get('10.0.8.228')).toBe('bc:24:11:6d:60:81');
    expect(map.has('IP')).toBe(false);
  });

  it('skips incomplete entries, which are probes that got no answer', () => {
    expect(parseArpTable(table).has('10.0.3.198')).toBe(false);
  });

  it('returns an empty map for empty or missing input', () => {
    expect(parseArpTable('').size).toBe(0);
    expect(parseArpTable(undefined).size).toBe(0);
  });
});
