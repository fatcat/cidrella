import { computed } from 'vue';
import { useDashboardStore } from '../stores/dashboard.js';

/**
 * The instance filter of an Analytics page, for its WorkspaceHead:
 *
 *   <WorkspaceHead :instance="instance" :instances="instances"
 *                  @update:instance="onInstance" />
 *
 * `instance` is undefined on a box with no members, which hides the select.
 * The choice is the dashboard store's, shared by every Analytics page and
 * remembered in this browser like the range. `refresh` reads the page again
 * once it changes.
 */
export function useInstanceFilter(refresh) {
  const store = useDashboardStore();
  return {
    instance: computed(() => (store.instanceFilterOn ? store.selectedInstance : undefined)),
    instances: computed(() => store.instances),
    async onInstance(value) {
      store.setInstance(value);
      await refresh();
    },
  };
}
