// The numbers behind the Resolution figures, computed once from the minute
// rows of /api/metrics/proxy-perf. The Dashboard shows three of them and the
// Performance page shows them all; both read this so a definition (what
// "p95" means over a range, when hit rate is unknown) cannot drift.
//
// Latencies arrive in microseconds and leave here in milliseconds. A figure
// with nothing to stand on is null, never 0, so the views can say "no queries
// in this range" instead of drawing a zero.

import { formatNumber } from './format.js';
import { EDE_NAMES, FAILURE_CAUSES, FAILURE_LABELS } from '@shared/dns-ede.js';

// The minute-row column of each failed-answer cause (utils/dns-ede.js).
export const FAILURE_COLUMNS = Object.freeze(
  Object.fromEntries(FAILURE_CAUSES.map((cause) => [cause, `servfail_${cause}`])),
);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sum = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
const mean = (values) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);
const toMs = (us) => (us === null ? null : us / 1000);

// Whole milliseconds once there are enough of them; one decimal below 10 so a
// cache hit at 0.3 ms does not round to nothing.
export function formatMs(ms) {
  if (ms === null || ms === undefined) return null;
  return ms >= 10 ? Math.round(ms) : Math.round(ms * 10) / 10;
}

// cpu_percent is process CPU time over wall time, so 100 is one core busy,
// the way top reads a process. It is not divided by the host's cores: on a
// 16-core box that turns a proxy at 30% of a core into 1.9%, which hides it.
export function summarizeProxyPerf(rows = []) {
  const withQueries = rows.filter((r) => (r.query_count || 0) > 0);
  const queries = sum(rows, 'query_count');
  const hits = sum(rows, 'cache_hits');
  const misses = sum(rows, 'cache_misses');
  const timeouts = sum(rows, 'timeouts');
  const first = rows[0]?.ts;
  const last = rows[rows.length - 1]?.ts;
  // One row per minute from the aggregator, but a restart leaves a gap, so
  // the span comes from the clock, not the row count.
  const minutes = rows.length ? Math.round(((last || 0) - (first || 0)) / 60) + 1 : 0;
  const cpuOf = (r) => num(r?.cpu_percent);
  const latest = rows[rows.length - 1] || null;
  const cpuValues = rows.map(cpuOf).filter((v) => v !== null);

  const failures = Object.fromEntries(
    FAILURE_CAUSES.map((cause) => [cause, sum(rows, FAILURE_COLUMNS[cause])]),
  );
  const failed = FAILURE_CAUSES.reduce((total, cause) => total + failures[cause], 0);
  const failedOf = (r) =>
    FAILURE_CAUSES.reduce((t, c) => t + (Number(r[FAILURE_COLUMNS[c]]) || 0), 0);

  return {
    minutes,
    queries,
    failures,
    failed,
    // Of every answer the proxy gave, how many failed: a rate, so a quiet
    // night and a busy one read the same.
    failedRate: queries ? (failed / queries) * 100 : null,
    perMinute: minutes ? Math.round(queries / minutes) : null,
    hits,
    misses,
    hitRate: hits + misses ? Math.round((hits / (hits + misses)) * 100) : null,
    timeouts,
    peakPending: rows.length ? Math.max(0, ...rows.map((r) => r.pending_queries || 0)) : null,
    latency: {
      min: toMs(
        withQueries.length
          ? Math.min(...withQueries.map((r) => num(r.latency_min) ?? Infinity))
          : null,
      ),
      avg: toMs(mean(withQueries.map((r) => num(r.latency_avg)).filter((v) => v !== null))),
      p95: toMs(mean(withQueries.map((r) => num(r.latency_p95)).filter((v) => v !== null))),
      max: toMs(
        withQueries.length
          ? Math.max(...withQueries.map((r) => num(r.latency_max) ?? -Infinity))
          : null,
      ),
    },
    cpu: { latest: cpuOf(latest), avg: mean(cpuValues) },
    memory: { rss: num(latest?.rss_mb), heap: num(latest?.heap_mb) },
    series: {
      p95: rows.map((r) => toMs(num(r.latency_p95))),
      hitRate: rows.map((r) =>
        r.cache_hits + r.cache_misses
          ? (r.cache_hits / (r.cache_hits + r.cache_misses)) * 100
          : null,
      ),
      timeouts: rows.map((r) => r.timeouts || 0),
      queries: rows.map((r) => r.query_count || 0),
      pending: rows.map((r) => r.pending_queries || 0),
      cpu: rows.map(cpuOf),
      rss: rows.map((r) => num(r.rss_mb)),
      failed: rows.map(failedOf),
      dnssec: rows.map((r) => r.servfail_dnssec || 0),
      upstream: rows.map((r) => (r.servfail_upstream || 0) + (r.servfail_timeout || 0)),
    },
  };
}

// Failed answers above 1% are worth a look, above 5% something is broken: the
// night Quad9 timed out ran at 10%, a normal one well under 1%.
const failedTone = (rate) => (rate === null ? 'ok' : rate > 5 ? 'err' : rate > 1 ? 'warn' : 'ok');

// The figures as FigureCard props, keyed so a page picks the ones it shows.
export function proxyPerfFigures(s) {
  const { min, avg, p95 } = s.latency;
  const cpuTone = (v) => (v === null ? 'ok' : v > 80 ? 'err' : v > 50 ? 'warn' : 'ok');
  return {
    perMinute: {
      label: 'Queries per minute',
      value: s.perMinute,
      sub: s.minutes
        ? `${formatNumber(s.queries)} over ${formatNumber(s.minutes)} min`
        : 'no samples in this range',
      series: s.series.queries,
    },
    p95: {
      label: 'p95 latency',
      value: formatMs(p95),
      unit: 'ms',
      sub:
        min !== null && avg !== null
          ? `min ${formatMs(min)} · avg ${formatMs(avg)}`
          : 'no queries in this range',
      series: s.series.p95,
    },
    hitRate: {
      label: 'Cache hit rate',
      value: s.hitRate,
      unit: '%',
      sub:
        s.hits + s.misses
          ? `${formatNumber(s.hits)} hits · ${formatNumber(s.misses)} misses`
          : 'no cache activity',
      series: s.series.hitRate,
    },
    timeouts: {
      label: 'Timeouts',
      value: s.minutes ? s.timeouts : null,
      sub: s.timeouts > 0 ? 'upstream did not answer' : 'every query answered',
      tone: s.timeouts > 0 ? 'warn' : 'ok',
      series: s.series.timeouts,
    },
    failedRate: {
      label: 'Failed answers',
      value: s.failedRate === null ? null : Math.round(s.failedRate * 100) / 100,
      unit: '%',
      sub: s.queries
        ? `${formatNumber(s.failed)} of ${formatNumber(s.queries)} answers`
        : 'no queries in this range',
      tone: failedTone(s.failedRate),
      series: s.series.failed,
    },
    dnssecFailed: {
      label: 'DNSSEC failures',
      value: s.minutes ? s.failures.dnssec : null,
      sub: s.failures.dnssec ? 'answers that failed validation' : 'none failed validation',
      tone: s.failures.dnssec ? 'warn' : 'ok',
      series: s.series.dnssec,
    },
    upstreamFailed: {
      label: 'Upstream failures',
      value: s.minutes ? s.failures.upstream + s.failures.timeout : null,
      sub: `${formatNumber(s.failures.upstream)} no upstream answer · ${formatNumber(
        s.failures.timeout,
      )} timed out`,
      tone: s.failures.upstream + s.failures.timeout ? 'warn' : 'ok',
      series: s.series.upstream,
    },
    peakPending: {
      label: 'Peak pending',
      value: s.peakPending,
      sub: 'queries waiting on upstream at once',
      series: s.series.pending,
    },
    cpu: {
      label: 'CPU',
      value: s.cpu.latest === null ? null : Math.round(s.cpu.latest * 10) / 10,
      unit: '%',
      sub:
        s.cpu.avg === null
          ? 'no samples in this range'
          : `of one core · avg ${Math.round(s.cpu.avg * 10) / 10}%`,
      tone: cpuTone(s.cpu.latest),
      series: s.series.cpu,
    },
    memory: {
      label: 'Memory',
      value: s.memory.rss === null ? null : Math.round(s.memory.rss),
      unit: 'MB',
      sub:
        s.memory.heap === null
          ? 'no samples in this range'
          : `heap ${Math.round(s.memory.heap)} MB`,
      series: s.series.rss,
    },
  };
}

// /api/metrics/dns-failures as TopList rows: the name, how often it failed,
// and its usual cause and error code.
export function failedNameRows(failures = []) {
  return (failures || []).map((r) => ({
    key: r.domain,
    label: r.domain,
    count: r.count,
    sub: [FAILURE_LABELS[r.failure], EDE_NAMES[r.ede]].filter(Boolean).join(' · '),
  }));
}
