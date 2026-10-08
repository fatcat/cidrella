import { computed } from 'vue';
import { useFeaturesStore } from '../stores/features.js';

/**
 * Read the feature switches from a component.
 *
 * Components use this rather than the store directly so they can still mount
 * without a Pinia instance, which is how several component tests run: with
 * no store every switch reads as off, matching the shipped default.
 */
export function useFeatures() {
  let store = null;
  try {
    store = useFeaturesStore();
  } catch {
    store = null;
  }
  return {
    ipv6: computed(() => (store ? store.ipv6 : false)),
    reload: () => (store ? store.load() : Promise.resolve()),
  };
}
