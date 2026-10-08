import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const api = { get: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const { useFeaturesStore } = await import('../../../src/stores/features.js');

beforeEach(() => {
  setActivePinia(createPinia());
  api.get.mockReset();
});

describe('features store', () => {
  it('starts with every switch off and nothing loaded', () => {
    const store = useFeaturesStore();
    expect(store.ipv6).toBe(false);
    expect(store.loaded).toBe(false);
  });

  it('loads the switches from /features', async () => {
    api.get.mockResolvedValueOnce({ data: { ipv6: true } });
    const store = useFeaturesStore();
    await store.load();
    expect(api.get).toHaveBeenCalledWith('/features');
    expect(store.ipv6).toBe(true);
    expect(store.loaded).toBe(true);
  });

  it('keeps the switches off when the read fails, but counts as loaded', async () => {
    api.get.mockRejectedValueOnce(new Error('offline'));
    const store = useFeaturesStore();
    await store.load();
    expect(store.ipv6).toBe(false);
    expect(store.loaded).toBe(true);
  });

  it('only the literal true turns a switch on', () => {
    const store = useFeaturesStore();
    store.set({ ipv6: 'true' });
    expect(store.ipv6).toBe(false);
    store.set({ ipv6: true });
    expect(store.ipv6).toBe(true);
    store.set({});
    expect(store.ipv6).toBe(false);
  });
});
