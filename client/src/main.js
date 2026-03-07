import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { updatePreset, updateSurfacePalette } from '@primeuix/themes';
import Aura from '@primevue/themes/aura';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import 'primeicons/primeicons.css';

import App from './App.vue';
import router from './router/index.js';
import api from './api/client.js';
import { useDebugStore } from './stores/debug.js';
import { useThemeStore } from './stores/theme.js';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);

// Dev-only interaction tracking — tree-shaken out of production builds
if (import.meta.env.VITE_TRACKING) {
  import('./utils/tracker.js').then(({ initTracker }) => {
    initTracker({ router, apiClient: api, pinia });
  });
}
app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      darkModeSelector: '.p-dark'
    }
  }
});
app.use(ToastService);
app.directive('tooltip', Tooltip);

// Theme switching — listen for theme change events and update PrimeVue preset
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
        light: { surface: { 0: '#ffffff', ...surface } },
        dark: { surface: { 0: '#ffffff', ...surface } },
      }
    }
  });

  updateSurfacePalette(surface);

  // Apply custom ipam variables if defined
  if (theme.customIpam) {
    document.documentElement.style.setProperty('--ipam-ground', theme.customIpam.ground);
    document.documentElement.style.setProperty('--ipam-card', theme.customIpam.card);
  } else {
    document.documentElement.style.removeProperty('--ipam-ground');
    document.documentElement.style.removeProperty('--ipam-card');
  }
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
