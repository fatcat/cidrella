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

  it('answers backend features from the server report, unknown ids as off', () => {
    setActivePinia(createPinia());
    const store = useFeaturesStore();
    const { supports, reason } = useFeatures();
    store.set({
      backendFeatures: [
        { id: 'ra', supported: true, reason: null },
        {
          id: 'dns-axfr-out',
          supported: false,
          reason: 'Zone transfer to secondaries (AXFR/IXFR) is not available with dnsmasq.',
        },
      ],
    });
    expect(supports('ra')).toBe(true);
    expect(reason('ra')).toBe(null);
    expect(supports('dns-axfr-out')).toBe(false);
    expect(reason('dns-axfr-out')).toMatch(/not available with dnsmasq/);
    expect(supports('never-reported')).toBe(false);
  });

  it('reads every backend feature as off with no Pinia', () => {
    setActivePinia(undefined);
    expect(useFeatures().supports('ra')).toBe(false);
  });
});
