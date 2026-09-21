import { describe, expect, it } from 'vitest';
import { formatMs, proxyPerfFigures, summarizeProxyPerf } from '../../../src/utils/proxy-perf.js';

const row = (i, extra = {}) => ({
  ts: 1789900000 + i * 60,
  query_count: 20,
  latency_min: 3000,
  latency_avg: 8000,
  latency_p95: 17000,
  latency_max: 40000,
  cache_hits: 14,
  cache_misses: 6,
  timeouts: 0,
  pending_queries: 2,
  cpu_percent: 12,
  rss_mb: 210.4,
  heap_mb: 90.2,
  ...extra,
});

describe('summarizeProxyPerf', () => {
  it('sums counts, averages latency over the minutes that had queries, and reports in ms', () => {
    const s = summarizeProxyPerf([
      row(0),
      row(1, {
        query_count: 0,
        latency_avg: null,
        latency_p95: null,
        latency_min: null,
        cache_hits: 0,
        cache_misses: 0,
      }),
      row(2, {
        latency_p95: 19000,
        cache_hits: 7,
        cache_misses: 3,
        timeouts: 2,
        pending_queries: 5,
      }),
    ]);
    expect(s.queries).toBe(40);
    expect(s.minutes).toBe(3);
    expect(s.perMinute).toBe(13);
    expect(s.hitRate).toBe(70);
    expect(s.timeouts).toBe(2);
    expect(s.peakPending).toBe(5);
    expect(s.latency).toEqual({ min: 3, avg: 8, p95: 18, max: 40 });
    expect(s.series.p95).toEqual([17, null, 19]);
    expect(s.series.hitRate).toEqual([70, null, 70]);
  });

  it('counts a gap in the rows as elapsed minutes', () => {
    const s = summarizeProxyPerf([row(0), row(9)]);
    expect(s.minutes).toBe(10);
    expect(s.perMinute).toBe(4);
  });

  it('leaves every figure null on no rows instead of drawing zeros', () => {
    const s = summarizeProxyPerf([]);
    expect(s.perMinute).toBeNull();
    expect(s.hitRate).toBeNull();
    expect(s.peakPending).toBeNull();
    expect(s.latency.p95).toBeNull();
    expect(s.cpu.latest).toBeNull();
    expect(s.memory.rss).toBeNull();
    const f = proxyPerfFigures(s);
    expect(f.p95.value).toBeNull();
    expect(f.p95.sub).toBe('no queries in this range');
    expect(f.timeouts.value).toBeNull();
    expect(f.hitRate.sub).toBe('no cache activity');
  });

  it('reads process CPU as a share of one core, the way top does', () => {
    const s = summarizeProxyPerf([row(0, { cpu_percent: 40 }), row(1, { cpu_percent: 80 })]);
    expect(s.cpu).toEqual({ latest: 80, avg: 60 });
    expect(s.series.cpu).toEqual([40, 80]);
  });

  it('builds the figure props with the tones the values call for', () => {
    const f = proxyPerfFigures(
      summarizeProxyPerf([row(0, { timeouts: 3, cpu_percent: 90, latency_min: 300 })]),
    );
    expect(f.p95).toMatchObject({ value: 17, unit: 'ms', sub: 'min 0.3 · avg 8' });
    expect(f.timeouts).toMatchObject({ value: 3, tone: 'warn' });
    expect(f.cpu).toMatchObject({
      value: 90,
      unit: '%',
      tone: 'err',
      sub: 'of one core · avg 90%',
    });
    expect(f.memory).toMatchObject({ value: 210, unit: 'MB', sub: 'heap 90 MB' });
    expect(f.perMinute).toMatchObject({ value: 20, sub: '20 over 1 min' });
  });
});

describe('formatMs', () => {
  it('keeps one decimal under 10 ms and none above', () => {
    expect(formatMs(0.34)).toBe(0.3);
    expect(formatMs(9.96)).toBe(10);
    expect(formatMs(18.4)).toBe(18);
    expect(formatMs(null)).toBeNull();
  });
});
