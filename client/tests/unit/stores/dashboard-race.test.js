// Overlapping Analytics reads. The minute's auto-refresh can still be out
// when the operator picks another range; whichever answer lands last used to
// win, so a slow refresh put the old range back on screen, and the first read
// to finish switched the loading state off under the other.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import api from '../../../src/api/client.js';
import { useDashboardStore } from '../../../src/stores/dashboard.js';

vi.mock('../../../src/api/client.js', () => ({ default: { get: vi.fn() } }));

// Every read waits until the test answers it, so the test sets the order.
let pending;
function answer(predicate, data) {
  const matches = pending.filter(predicate);
  if (!matches.length) throw new Error('no such read is out');
  for (const read of matches) {
    pending.splice(pending.indexOf(read), 1);
    read.resolve({ data: data(read) });
  }
}
const ofRange = (range) => (read) => read.params?.range === range;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
// Each range's metrics carry the range, so the screen shows which one won.
const byRange = (read) => [{ range: read.params?.range ?? null, url: read.url }];

beforeEach(() => {
  setActivePinia(createPinia());
  pending = [];
  api.get.mockReset();
  api.get.mockImplementation(
    (url, config = {}) =>
      new Promise((resolve) => pending.push({ url, params: config.params, resolve })),
  );
});

describe('overlapping Analytics reads', () => {
  it('keeps the newest range when an older read answers last', async () => {
    const store = useDashboardStore();
    const refresh = store.fetchHealthBoard('24h');
    const picked = store.fetchHealthBoard('1h', { rangeOnly: true });

    answer(ofRange('1h'), byRange);
    await picked;
    expect(store.metrics.timeseries).toEqual([{ range: '1h', url: '/metrics/timeseries' }]);

    // The auto-refresh started before the pick answers now.
    answer(ofRange('24h'), byRange);
    answer(
      () => true,
      () => ({ ok: true }),
    );
    await refresh;
    expect(store.metrics.timeseries).toEqual([{ range: '1h', url: '/metrics/timeseries' }]);
    expect(store.metrics.topDomains[0].range).toBe('1h');
  });

  it('takes an older run’s answer when it is the newest read of that metric', async () => {
    const store = useDashboardStore();
    const board = store.fetchHealthBoard('24h');
    answer(() => true, byRange);
    await board;
    expect(store.metrics.timeseries[0].range).toBe('24h');
  });

  it('does the same on the Intelligence page', async () => {
    const store = useDashboardStore();
    const refresh = store.fetchIntelligence('24h');
    const picked = store.fetchIntelligence('1w', { rangeOnly: true });
    answer(ofRange('1w'), byRange);
    await picked;
    answer(() => true, byRange);
    await refresh;
    expect(store.metrics.queryVolume[0].range).toBe('1w');
    expect(store.metrics.blocklistTopDomains[0].range).toBe('1w');
  });

  it('stays loading until the last read is back', async () => {
    const store = useDashboardStore();
    const refresh = store.fetchHealthBoard('24h');
    const picked = store.fetchHealthBoard('1h', { rangeOnly: true });
    expect(store.loading).toBe(true);

    answer(ofRange('1h'), byRange);
    await picked;
    expect(store.loading).toBe(true);

    answer(() => true, byRange);
    await refresh;
    await flush();
    expect(store.loading).toBe(false);
  });

  it('lets an overtaken run leave the health state and failures alone', async () => {
    const store = useDashboardStore();
    const refresh = store.fetchHealthBoard('24h');
    const newer = store.fetchHealthBoard('24h');
    // The newer run's reads are the later half of the queue.
    const newerReads = pending.slice(pending.length / 2);
    for (const read of newerReads) {
      pending.splice(pending.indexOf(read), 1);
      read.resolve({ data: read.url === '/metrics/services' ? { run: 'newer' } : [] });
    }
    await newer;
    expect(store.health.services).toEqual({ run: 'newer' });

    answer(
      () => true,
      (read) => (read.url === '/metrics/services' ? { run: 'older' } : []),
    );
    await refresh;
    expect(store.health.services).toEqual({ run: 'newer' });
  });
});
