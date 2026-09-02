/**
 * Global test setup for component tests.
 *
 * The app registers a handful of things globally in main.js (PrimeVue's tooltip
 * directive, the toast service, and so on). A component mounted in isolation has
 * none of that, and Vue fails on an unresolved directive rather than ignoring it,
 * so `v-tooltip` alone would break most mounts.
 *
 * Registering no-op stubs here keeps individual tests focused on behavior instead
 * of each one rebuilding app context. Anything a test actually wants to assert on
 * (a store, a router, real PrimeVue components) should be provided per-test via
 * mount options, not added here, or the stubs start hiding real breakage.
 */
import { config } from '@vue/test-utils';

// PrimeVue's tooltip. Components use `v-tooltip.top="..."` widely; the tooltip
// content itself is asserted through the binding value where it matters.
config.global.directives = {
  ...config.global.directives,
  tooltip: {
    mounted(el, binding) {
      // Reflect it into an attribute so tests can assert the text without
      // needing PrimeVue's overlay machinery.
      if (binding.value) el.setAttribute('data-tooltip', String(binding.value));
    },
    updated(el, binding) {
      if (binding.value) el.setAttribute('data-tooltip', String(binding.value));
      else el.removeAttribute('data-tooltip');
    },
  },
};
