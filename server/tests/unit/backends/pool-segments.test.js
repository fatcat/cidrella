import { describe, it, expect } from 'vitest';
import { poolSegments } from '../../../src/backends/shared/pool-segments.js';

describe('poolSegments', () => {
  it('carves reserved IPv4 addresses out of each pool', () => {
    const pools = [
      { start_ip: '10.0.0.10', end_ip: '10.0.0.20' },
      { start_ip: '10.0.0.100', end_ip: '10.0.0.100' },
    ];
    expect(
      poolSegments(pools, ['10.0.0.10', '10.0.0.15', '10.0.0.15', '10.0.0.50', 'fd00::1'], 4),
    ).toEqual([
      ['10.0.0.11', '10.0.0.14'],
      ['10.0.0.16', '10.0.0.20'],
      ['10.0.0.100', '10.0.0.100'],
    ]);
  });

  it('carves reserved IPv6 addresses out of a large pool', () => {
    const pools = [{ start_ip: 'fd00:5::', end_ip: 'fd00:5::ffff:ffff:ffff:ffff' }];
    expect(poolSegments(pools, ['fd00:5::1', '10.0.0.1', 'not-an-ip'], 6)).toEqual([
      ['fd00:5::', 'fd00:5::'],
      ['fd00:5::2', 'fd00:5::ffff:ffff:ffff:ffff'],
    ]);
  });

  it('drops a pool reserved end to end', () => {
    expect(poolSegments([{ start_ip: '10.0.0.5', end_ip: '10.0.0.5' }], ['10.0.0.5'], 4)).toEqual(
      [],
    );
  });
});
