// What each encrypted-forwarding upstream did over a range, from the minute
// rows of /api/metrics/forwarder: one row per provider address per minute,
// plus a provider-wide row (address '') holding its failovers. The
// Performance page's Resolver board reads this.

import { formatNumber } from './format.js';

const COUNTS = ['queries', 'answers', 'timeouts', 'drops', 'connect_failures', 'failovers'];

const toMs = (us) => (typeof us === 'number' ? us / 1000 : null);

export function summarizeForwarder(rows = []) {
  const providers = new Map();
  const minutes = new Map();
  for (const r of rows) {
    let p = providers.get(r.provider);
    if (!p) {
      p = { provider: r.provider, protocol: r.protocol, p95: [], ...zero() };
      providers.set(r.provider, p);
    }
    let m = minutes.get(r.ts);
    if (!m) {
      m = { ts: r.ts, ...zero() };
      minutes.set(r.ts, m);
    }
    for (const key of COUNTS) {
      p[key] += r[key] || 0;
      m[key] += r[key] || 0;
    }
    const p95 = toMs(r.latency_p95_us);
    if (p95 !== null) {
      p.p95.push(p95);
      m[`p95:${r.provider}`] = Math.max(m[`p95:${r.provider}`] ?? 0, p95);
    }
  }
  const list = [...providers.values()].map(({ p95, ...p }) => ({
    ...p,
    // The worst address's p95 each minute, averaged over the range.
    p95: p95.length ? p95.reduce((a, b) => a + b, 0) / p95.length : null,
  }));
  return {
    providers: list,
    failovers: list.reduce((t, p) => t + p.failovers, 0),
    rows: [...minutes.values()].sort((a, b) => a.ts - b.ts),
  };
}

function zero() {
  return Object.fromEntries(COUNTS.map((key) => [key, 0]));
}

/** The p95 series of each provider, for SeriesChart over summary.rows. */
export function providerLatencySeries(providers) {
  return providers.map((p, i) => ({
    key: `p95:${p.provider}`,
    label: p.provider,
    color: i + 1,
    aggregate: 'max',
    summary: 'avg',
  }));
}

/** The Failovers FigureCard. Null with nothing forwarded in the range. */
export function failoverFigureOf(summary) {
  const on = summary.providers.length > 0;
  return {
    label: 'Failovers',
    value: on ? summary.failovers : null,
    sub: on
      ? 'queries one provider could not answer, sent to the next'
      : 'nothing was forwarded',
    tone: summary.failovers ? 'warn' : 'ok',
    series: summary.rows.map((r) => r.failovers),
  };
}

/** Each provider as a TopList row: answers, then what went wrong. */
export function providerListRows(summary) {
  return summary.providers
    .filter((p) => p.provider)
    .map((p) => ({
      key: p.provider,
      label: p.provider,
      count: p.answers,
      sub: [
        `${formatNumber(p.timeouts)} timeouts`,
        `${formatNumber(p.drops)} resent`,
        `${formatNumber(p.failovers)} failovers`,
        p.p95 === null ? null : `p95 ${Math.round(p.p95)} ms`,
      ]
        .filter(Boolean)
        .join(' · '),
    }));
}
