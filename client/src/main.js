import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { UiPlugin, ToastService, ConfirmationService, Tooltip } from './ui/plugin.js';
import { updatePreset, updateSurfacePalette, BasePreset } from './ui/theme.js';
// primeicons is a SEPARATE MIT package, unaffected by the PrimeVue relicense,
// and backs 269 `pi pi-*` usages across the app. It stays regardless of which
// widget library sits behind ./ui, so it is imported directly rather than
// through the seam.
import 'primeicons/primeicons.css';

import App from './App.vue';
import router from './router/index.js';
import api from './api/client.js';
import { useDebugStore } from './stores/debug.js';
import { useThemeStore } from './stores/theme.js';
import { migrateStorageKeys } from './utils/storage.js';

// One-time migration from ipam_ to cidrella_ localStorage keys
migrateStorageKeys();

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);

// Dev-only interaction tracking, tree-shaken out of production builds
if (import.meta.env.VITE_TRACKING) {
  import('./utils/tracker.js').then(({ initTracker }) => {
    initTracker({ router, apiClient: api, pinia });
  });
}
app.use(UiPlugin, {
  theme: {
    preset: BasePreset,
    options: {
      darkModeSelector: '.p-dark'
    }
  }
});
app.use(ToastService);
app.use(ConfirmationService);
app.directive('tooltip', Tooltip);

// Theme switching. stores/theme.js emits `ipam:theme-change` carrying plain hex
// ramps and imports nothing from the widget library, so this listener is the
// only place the 13-theme system meets it. Both calls come through ./ui/theme.js.
function buildPalette(colorName, customPalette) {
  if (customPalette) return { ...customPalette };
  const shades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
  return Object.fromEntries(shades.map(s => [s, `{${colorName}.${s}}`]));
}

window.addEventListener('ipam:theme-change', (e) => {
  const theme = e.detail;
  const primary = buildPalette(theme.primary, theme.customPrimary);
  const surface = buildPalette(theme.surface, theme.customSurface);

  updatePreset({
    semantic: {
      primary,
      colorScheme: {
        light: { surface },
        dark: { surface },
      }
    }
  });

  updateSurfacePalette(surface);
});

// Initialize theme store (applies saved theme)
const themeStore = useThemeStore();
themeStore.init();

// Global error handlers → debug store
const debug = useDebugStore();

app.config.errorHandler = (err, instance, info) => {
  debug.logError(`Vue: ${err.message}`, { info, stack: err.stack });
  console.error(err);
};

window.addEventListener('unhandledrejection', (event) => {
  const msg = event.reason?.message || String(event.reason);
  debug.logError(`Unhandled: ${msg}`, event.reason?.stack);
});

app.mount('#app');
