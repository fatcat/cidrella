import { describe, it, expect, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../../../src/api/client.js', () => ({ default: { get: vi.fn() } }));

const { useFeatures } = await import('../../../src/composables/useFeatures.js');
const { useFeaturesStore } = await import('../../../src/stores/features.js');

describe('useFeatures', () => {
  it('reads every switch as off when no Pinia is active', async () => {
    setActivePinia(undefined);
    const { ipv6, reload } = useFeatures();
    expect(ipv6.value).toBe(false);
    await expect(reload()).resolves.toBeUndefined();
  });

  it('mirrors the store when one is active', () => {
    setActivePinia(createPinia());
    const store = useFeaturesStore();
    const { ipv6 } = useFeatures();
    expect(ipv6.value).toBe(false);
    store.set({ ipv6: true });
    expect(ipv6.value).toBe(true);
  });
});
