import { describe, it, expect } from 'vitest';
import {
  summarizeForwarder,
  providerLatencySeries,
  failoverFigureOf,
  providerListRows,
} from '../../../src/utils/forwarder-perf.js';

const row = (ts, provider, address, extra = {}) => ({
  ts,
  provider,
  address,
  protocol: 'dot',
  queries: 0,
  answers: 0,
  timeouts: 0,
  drops: 0,
  connect_failures: 0,
  failovers: 0,
  latency_p50_us: null,
  latency_p95_us: null,
  ...extra,
});

const ROWS = [
  row(60, 'dns10.quad9.net', '9.9.9.10', {
    queries: 10,
    answers: 6,
    timeouts: 4,
    latency_p95_us: 3_000_000,
  }),
  row(60, 'dns10.quad9.net', '2620:fe::10', { queries: 2, answers: 2, latency_p95_us: 20_000 }),
  row(60, 'dns10.quad9.net', '', { failovers: 4 }),
  row(120, 'unfiltered.adguard-dns.com', '94.140.14.140', {
    queries: 9,
    answers: 9,
    drops: 1,
    latency_p95_us: 30_000,
  }),
];

describe('summarizeForwarder', () => {
  it('totals each provider over its addresses, both families, and each minute', () => {
    const s = summarizeForwarder(ROWS);
    expect(s.failovers).toBe(4);
    expect(s.providers).toEqual([
      {
        provider: 'dns10.quad9.net',
        protocol: 'dot',
        queries: 12,
        answers: 8,
        timeouts: 4,
        drops: 0,
        connect_failures: 0,
        failovers: 4,
        p95: (3000 + 20) / 2,
      },
      {
        provider: 'unfiltered.adguard-dns.com',
        protocol: 'dot',
        queries: 9,
        answers: 9,
        timeouts: 0,
        drops: 1,
        connect_failures: 0,
        failovers: 0,
        p95: 30,
      },
    ]);
    // A minute carries each provider's slowest address.
    expect(s.rows.map((r) => [r.ts, r.timeouts, r.failovers, r['p95:dns10.quad9.net']])).toEqual([
      [60, 4, 4, 3000],
      [120, 0, 0, undefined],
    ]);
    expect(providerLatencySeries(s.providers).map((x) => x.key)).toEqual([
      'p95:dns10.quad9.net',
      'p95:unfiltered.adguard-dns.com',
    ]);
  });

  it('says encrypted forwarding is off rather than showing zero failovers', () => {
    const s = summarizeForwarder([]);
    expect(failoverFigureOf(s)).toMatchObject({ value: null, sub: 'encrypted forwarding is off' });
    expect(providerListRows(s)).toEqual([]);
  });

  it('lists each provider by answers, with what went wrong', () => {
    const s = summarizeForwarder(ROWS);
    expect(failoverFigureOf(s)).toMatchObject({ value: 4, tone: 'warn' });
    expect(providerListRows(s)[0]).toEqual({
      key: 'dns10.quad9.net',
      label: 'dns10.quad9.net',
      count: 8,
      sub: '4 timeouts · 0 resent · 4 failovers · p95 1510 ms',
    });
  });
});
