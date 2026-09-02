/**
 * One anomaly counter, shared by the header badge and the Anomalies page.
 *
 * HeaderBar.vue used to keep its own `anomalySummary` ref and POST
 * `/anomalies/acknowledge` itself, zeroing only its copy. The store did the
 * same for the page. The two never talked, so acknowledging in one place left
 * the other showing the old number until its 60-second poll came round, in
 * both directions, for a number the user can see in two places at once.
 *
 * See REVIEW.md, duplicate-logic audit #49.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../../src/api/client.js', () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a) },
}));

const { useAnomalyStore } = await import('../../../src/stores/anomalies.js');

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
});

describe('anomaly counter is single-sourced', () => {
  it('acknowledging zeroes the count every reader sees', () => {
    // Both the header badge and the page read store.summary, so one write is
    // enough. Previously each maintained its own copy.
    const store = useAnomalyStore();
    return (async () => {
      get.mockResolvedValue({ data: { unacknowledged_active: 7, total_active: 7, acknowledged_through_id: 3 } });
      await store.fetchSummary();
      expect(store.summary.unacknowledged_active).toBe(7);

      post.mockResolvedValue({ data: { acknowledged_through_id: 9 } });
      await store.acknowledgeCounter();

      expect(store.summary.unacknowledged_active).toBe(0);
      expect(store.summary.acknowledged_through_id).toBe(9);
    })();
  });

  it('acknowledges through the shared endpoint exactly once', async () => {
    const store = useAnomalyStore();
    get.mockResolvedValue({ data: { unacknowledged_active: 2 } });
    await store.fetchSummary();
    post.mockResolvedValue({ data: { acknowledged_through_id: 4 } });
    await store.acknowledgeCounter();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/anomalies/acknowledge');
  });

  it('keeps the previous acknowledged_through_id when the server omits one', async () => {
    const store = useAnomalyStore();
    get.mockResolvedValue({ data: { unacknowledged_active: 5, acknowledged_through_id: 11 } });
    await store.fetchSummary();
    post.mockResolvedValue({ data: {} });
    await store.acknowledgeCounter();
    expect(store.summary.acknowledged_through_id).toBe(11);
    expect(store.summary.unacknowledged_active).toBe(0);
  });

  it('does not throw when acknowledging before any summary was fetched', async () => {
    const store = useAnomalyStore();
    post.mockResolvedValue({ data: { acknowledged_through_id: 1 } });
    await expect(store.acknowledgeCounter()).resolves.toBeDefined();
  });
});
