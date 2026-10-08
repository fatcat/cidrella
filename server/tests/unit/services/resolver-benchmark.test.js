import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  benchmarkCandidates,
  startBenchmark,
  getBenchmark,
  cancelBenchmark,
  resetBenchmark,
  BenchmarkBusyError,
} from '../../../src/services/resolver-benchmark.js';
import { DOH_PROVIDERS } from '../../../src/data/doh-providers.js';
import { plainDnsServer } from '../../helpers/plain-dns-server.js';

// The runner's schedule, ranking and bookkeeping, with fake timers and a
// stand-in for the query. The real queries are tested in upstream-probe.test.js.
afterEach(() => {
  resetBenchmark();
  vi.useRealTimers();
});

// Each resolver answers after its own delay, or never ('silent').
function fakeQuery(delays) {
  const calls = [];
  const timeQuery = vi.fn(async (args) => {
    calls.push(args);
    const delay = delays[args.provider.id];
    if (delay === 'silent') {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return { ms: 3000, problem: 'no answer' };
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    return { ms: delay, problem: null };
  });
  return { timeQuery, calls };
}

const resolver = (id, addresses) => ({ id, label: id, addresses, preset: false });

describe('benchmarkCandidates', () => {
  it('lists every preset, then custom resolvers that are not presets', () => {
    const list = benchmarkCandidates('dot', [
      { hostname: 'dns.example.net', addresses: ['192.0.2.53'] },
      { hostname: 'DNS10.quad9.net', addresses: ['9.9.9.10'] }, // a preset, by hostname
    ]);
    expect(list.map((c) => c.id)).toEqual([...DOH_PROVIDERS.map((p) => p.id), 'custom-1']);
    expect(list.at(-1)).toMatchObject({ label: 'dns.example.net', preset: false });
  });

  it('matches plain resolvers by their addresses, either family', () => {
    const list = benchmarkCandidates('plain', [
      { addresses: ['1.0.0.1', '1.1.1.1'] }, // Cloudflare's, in another order
      { addresses: ['fd00::53'] },
    ]);
    expect(list.filter((c) => !c.preset)).toEqual([
      expect.objectContaining({ id: 'custom-2', label: 'fd00::53', addresses: ['fd00::53'] }),
    ]);
  });
});

describe('a run', () => {
  it.each([
    ['IPv4', ['192.0.2.1', '192.0.2.2'], ['198.51.100.1']],
    ['IPv6', ['2001:db8::1', '2001:db8::2'], ['2001:db8::9']],
  ])('ranks the faster resolver first and the silent one last (%s)', async (_f, a, b) => {
    vi.useFakeTimers();
    const { timeQuery, calls } = fakeQuery({ fast: 10, slow: 40, silent: 'silent' });
    const candidates = [resolver('silent', b), resolver('slow', b), resolver('fast', a)];
    const id = startBenchmark({ protocol: 'plain' }, { candidates, timeQuery });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(getBenchmark(id)).toMatchObject({ state: 'running', progress_pct: 50 });
    await vi.advanceTimersByTimeAsync(40_000);

    const run = getBenchmark(id);
    expect(run).toMatchObject({ state: 'done', progress_pct: 100 });
    expect(run.results.map((r) => r.id)).toEqual(['fast', 'slow', 'silent']);
    const [fast, , silent] = run.results;
    // A query every 2 s for a minute; common and random names take turns.
    expect(fast).toMatchObject({ sent: 30, failed: 0, fastest: true });
    expect(fast.cached).toEqual({ count: 15, p50: 10, p95: 10 });
    expect(fast.uncached.count).toBe(15);
    // Its two addresses take turns too.
    expect(fast.by_address).toEqual([
      { address: a[0], p50: 10 },
      { address: a[1], p50: 10 },
    ]);
    expect(silent).toMatchObject({ failure_rate: 1, fastest: false, last_problem: 'no answer' });

    const names = calls.filter((c) => c.provider.id === 'fast').map((c) => c.name);
    expect(names[0]).toBe('wikipedia.org');
    expect(names[1]).toMatch(/^[0-9a-f]{16}\.amazon\.com$/);
  });

  it('refuses a second run while one is going, and cancels', async () => {
    vi.useFakeTimers();
    const { timeQuery } = fakeQuery({ a: 10 });
    const id = startBenchmark(
      { protocol: 'plain', mode: 'off' },
      { candidates: [resolver('a', ['192.0.2.1'])], timeQuery },
    );
    expect(() => startBenchmark({ protocol: 'plain' })).toThrow(BenchmarkBusyError);
    try {
      startBenchmark({ protocol: 'dot', mode: 'tls' });
    } catch (err) {
      expect(err.run).toEqual({ id, mode: 'off' });
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(cancelBenchmark(id)).toBe(true);
    expect(getBenchmark(id)).toMatchObject({ state: 'cancelled', progress_pct: 100 });
    // Nothing more is sent after a cancel.
    const sent = timeQuery.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(timeQuery.mock.calls.length).toBe(sent);
    expect(cancelBenchmark('nope')).toBe(false);
    expect(getBenchmark('nope')).toBeNull();
  });

  it('times a real plain resolver end to end', async () => {
    const server = await plainDnsServer('127.0.0.1');
    try {
      const id = startBenchmark(
        { protocol: 'plain' },
        {
          durationMs: 400,
          intervalMs: 200,
          timeoutMs: 2000,
          port: server.port,
          candidates: [resolver('local', ['127.0.0.1'])],
        },
      );
      const until = Date.now() + 8000;
      while (getBenchmark(id).state === 'running' && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(getBenchmark(id).results[0]).toMatchObject({ sent: 2, failed: 0 });
    } finally {
      server.close();
    }
  }, 10_000);
});
