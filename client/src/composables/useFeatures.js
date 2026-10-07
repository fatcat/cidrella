import { computed } from 'vue';
import { useFeaturesStore } from '../stores/features.js';

/**
 * Read the feature switches from a component.
 *
 * Components use this rather than the store directly so they can still mount
 * without a Pinia instance, which is how several component tests run: with
 * no store every switch reads as off, matching the shipped default.
 *
 * `supports(id)` says whether the active backend has a backend feature
 * (server/src/backends/features.js), and `reason(id)` the words to show
 * beside a control it disables. An id the server did not report reads as
 * unsupported.
 */
export function useFeatures() {
  let store = null;
  try {
    store = useFeaturesStore();
  } catch {
    store = null;
  }
  const entry = (id) => store?.backend?.[id];
  return {
    ipv6: computed(() => (store ? store.ipv6 : false)),
    supports: (id) => entry(id)?.supported === true,
    reason: (id) => entry(id)?.reason ?? null,
    reload: () => (store ? store.load() : Promise.resolve()),
  };
}
