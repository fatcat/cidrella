/**
 * The resolver performance test: for a minute, time queries to every preset
 * resolver and any custom ones, over one protocol, straight over the wire.
 * Nothing goes through dnsmasq, so its cache plays no part. Half the queries
 * ask for common names (what clients feel: the resolver usually answers from
 * its own cache), half for a random name it cannot have cached (a full trip to
 * the zone's servers). One run at a time, kept in memory.
 */
import crypto from 'crypto';
import { DOH_PROVIDERS } from '../data/doh-providers.js';
import { createUpstreamPool } from '../utils/upstream-pool.js';
import {
  COMMON_NAMES,
  UNCACHED_ZONES,
  timeQuery as wireQuery,
  uncachedName,
} from '../utils/upstream-probe.js';
import { createReservoir, quantileOfSorted } from '../utils/samples.js';

export const BENCHMARK_DURATION_MS = 60_000;
export const BENCHMARK_INTERVAL_MS = 2000;
export const BENCHMARK_QUERY_TIMEOUT_MS = 3000;

// The forwarding mode the settings page uses, and the protocol it tests.
export const PROTOCOL_FOR_MODE = Object.freeze({ off: 'plain', tls: 'dot', https: 'doh' });

/** Thrown while a run is going; `run` is { id, mode } of that run. */
export class BenchmarkBusyError extends Error {
  constructor(run) {
    super('A resolver test is already running');
    this.run = run;
  }
}

let run = null;

/** The resolvers a run tests: every preset, then the custom ones not already among them. */
export function benchmarkCandidates(protocol, custom = []) {
  const keyOf = (resolver) =>
    protocol === 'plain'
      ? [...resolver.addresses].sort().join(',')
      : String(resolver.hostname).toLowerCase();
  const list = [];
  const seen = new Set();
  const add = (resolver) => {
    const key = keyOf(resolver);
    if (seen.has(key)) return;
    seen.add(key);
    list.push(resolver);
  };
  for (const p of DOH_PROVIDERS) {
    add({
      id: p.id,
      label: p.label,
      hostname: p.hostname,
      addresses: p.addresses,
      doh_url: p.doh_url,
      preset: true,
    });
  }
  custom.forEach((c, i) =>
    add({
      id: `custom-${i + 1}`,
      label: c.label || c.hostname || c.addresses.join(', '),
      hostname: c.hostname || '',
      addresses: c.addresses,
      doh_url: c.doh_url || '',
      preset: false,
    }),
  );
  return list;
}

function newStats(resolver) {
  return {
    cached: createReservoir(1000),
    uncached: createReservoir(1000),
    byAddress: new Map(resolver.addresses.map((a) => [a, createReservoir(1000)])),
    sent: 0,
    failed: 0,
    lastProblem: null,
  };
}

const round = (ms) => (ms == null ? null : Math.round(ms * 10) / 10);

function percentiles(reservoir) {
  const { sorted, seen } = reservoir.peek();
  return {
    count: seen,
    p50: round(quantileOfSorted(sorted, 0.5)),
    p95: round(quantileOfSorted(sorted, 0.95)),
  };
}

function resultsOf(current) {
  const rows = current.candidates.map((resolver) => {
    const stats = current.stats.get(resolver.id);
    return {
      id: resolver.id,
      label: resolver.label,
      hostname: resolver.hostname,
      addresses: resolver.addresses,
      doh_url: resolver.doh_url,
      preset: resolver.preset,
      cached: percentiles(stats.cached),
      uncached: percentiles(stats.uncached),
      by_address: [...stats.byAddress].map(([address, r]) => ({
        address,
        p50: percentiles(r).p50,
      })),
      sent: stats.sent,
      failed: stats.failed,
      failure_rate: stats.sent ? stats.failed / stats.sent : 0,
      last_problem: stats.lastProblem,
    };
  });
  // Fewest failures first, then the fastest cached answer; no answers at all last.
  rows.sort(
    (a, b) =>
      a.failure_rate - b.failure_rate || (a.cached.p50 ?? Infinity) - (b.cached.p50 ?? Infinity),
  );
  rows.forEach((row, i) => {
    row.fastest = i === 0 && row.cached.p50 != null;
  });
  return rows;
}

function stop(current, state) {
  for (const timer of current.timers) clearTimeout(timer);
  current.timers = [];
  for (const pool of current.pools.values()) pool.closeAll();
  current.pools.clear();
  current.state = state;
  current.finishedAt = Date.now();
}

/**
 * Start a run. `protocol` is 'plain', 'dot' or 'doh', and `mode` the settings
 * page's name for it, kept so a page that finds a run going can follow it.
 * `custom` are resolvers already validated by the caller. Throws BenchmarkBusyError while one runs.
 * `options` lets tests shorten the run, point it at local servers, or stand
 * in for the query itself.
 */
export function startBenchmark({ protocol, mode = null, custom = [] }, options = {}) {
  if (run?.state === 'running') throw new BenchmarkBusyError({ id: run.id, mode: run.mode });
  const {
    durationMs = BENCHMARK_DURATION_MS,
    intervalMs = BENCHMARK_INTERVAL_MS,
    timeoutMs = BENCHMARK_QUERY_TIMEOUT_MS,
    port,
    poolOptions = {},
    candidates = benchmarkCandidates(protocol, custom),
    timeQuery = wireQuery,
  } = options;

  const current = {
    id: crypto.randomUUID(),
    protocol,
    mode,
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    durationMs,
    candidates,
    stats: new Map(candidates.map((c) => [c.id, newStats(c)])),
    pools: new Map(),
    timers: [],
    inFlight: 0,
    ticksLeft: 0,
  };
  run = current;

  const poolFor = (resolver) => {
    if (protocol === 'plain') return null;
    let pool = current.pools.get(resolver.id);
    if (!pool) {
      pool = createUpstreamPool({
        protocol,
        timeoutMs,
        onError: (error) => {
          current.stats.get(resolver.id).lastProblem = error.message.trim();
        },
        ...poolOptions,
      });
      current.pools.set(resolver.id, pool);
    }
    return pool;
  };

  const finishIfDone = () => {
    if (current.state === 'running' && current.ticksLeft === 0 && current.inFlight === 0) {
      stop(current, 'done');
    }
  };

  const ticks = Math.max(1, Math.floor(durationMs / intervalMs));
  current.ticksLeft = ticks * candidates.length;
  candidates.forEach((resolver, i) => {
    // Stagger the resolvers across one interval so their queries don't all leave at once.
    const offset = Math.floor((intervalMs * i) / candidates.length);
    for (let k = 0; k < ticks; k++) {
      const timer = setTimeout(
        async () => {
          current.ticksLeft--;
          if (current.state !== 'running') return;
          const uncached = k % 2 === 1;
          const turn = Math.floor(k / 2);
          const name = uncached
            ? uncachedName(UNCACHED_ZONES[turn % UNCACHED_ZONES.length])
            : COMMON_NAMES[turn % COMMON_NAMES.length];
          const address = resolver.addresses[turn % resolver.addresses.length];
          const stats = current.stats.get(resolver.id);
          stats.sent++;
          current.inFlight++;
          try {
            const { ms, problem } = await timeQuery({
              protocol,
              provider: resolver,
              address,
              name,
              pool: poolFor(resolver),
              timeoutMs,
              port,
            });
            if (current.state !== 'running') return;
            if (problem) {
              stats.failed++;
              stats.lastProblem = problem;
            } else {
              (uncached ? stats.uncached : stats.cached).add(ms);
              stats.byAddress.get(address).add(ms);
            }
          } catch (error) {
            stats.failed++;
            stats.lastProblem = error.message;
          } finally {
            current.inFlight--;
            finishIfDone();
          }
        },
        offset + k * intervalMs,
      );
      current.timers.push(timer);
    }
  });
  return current.id;
}

/** The run's state, progress and results so far; null for an unknown id. */
export function getBenchmark(id, now = Date.now()) {
  if (!run || run.id !== id) return null;
  const elapsed = (run.finishedAt ?? now) - run.startedAt;
  return {
    id: run.id,
    protocol: run.protocol,
    mode: run.mode,
    state: run.state,
    progress_pct:
      run.state === 'running' ? Math.min(99, Math.floor((elapsed / run.durationMs) * 100)) : 100,
    results: resultsOf(run),
  };
}

/** Stop a running test; false for an unknown id. */
export function cancelBenchmark(id) {
  if (!run || run.id !== id) return false;
  if (run.state === 'running') stop(run, 'cancelled');
  return true;
}

/** Forget the last run (tests). */
export function resetBenchmark() {
  if (run?.state === 'running') stop(run, 'cancelled');
  run = null;
}
