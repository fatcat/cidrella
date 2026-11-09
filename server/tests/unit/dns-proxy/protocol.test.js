import { describe, expect, it } from 'vitest';
import { metricsToWire, metricsFromWire } from '../../../src/dns-proxy/protocol.js';

describe('the proxy protocol', () => {
  it('carries the counters, Maps and all', () => {
    const metrics = {
      blocklistHits: { delta: 2, categoryHits: new Map([['ads', 2]]) },
      blockedDelta: 1,
      countryHits: new Map([['RU', 1]]),
      performance: { queryCount: 3 },
    };
    const back = metricsFromWire(JSON.parse(JSON.stringify(metricsToWire(metrics))));
    expect(back).toEqual(metrics);
  });
});
