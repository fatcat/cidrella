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
import { useDebugStore } from './stores/debug.js';
import { useThemeStore } from './stores/theme.js';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
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
window.addEventListener('ipam:theme-change', (e) => {
  const theme = e.detail;
  updatePreset({
    semantic: {
      primary: {
        50: `{${theme.primary}.50}`,
        100: `{${theme.primary}.100}`,
        200: `{${theme.primary}.200}`,
        300: `{${theme.primary}.300}`,
        400: `{${theme.primary}.400}`,
        500: `{${theme.primary}.500}`,
        600: `{${theme.primary}.600}`,
        700: `{${theme.primary}.700}`,
        800: `{${theme.primary}.800}`,
        900: `{${theme.primary}.900}`,
        950: `{${theme.primary}.950}`,
      },
      colorScheme: {
        light: {
          surface: {
            0: '#ffffff',
            50: `{${theme.surface}.50}`,
            100: `{${theme.surface}.100}`,
            200: `{${theme.surface}.200}`,
            300: `{${theme.surface}.300}`,
            400: `{${theme.surface}.400}`,
            500: `{${theme.surface}.500}`,
            600: `{${theme.surface}.600}`,
            700: `{${theme.surface}.700}`,
            800: `{${theme.surface}.800}`,
            900: `{${theme.surface}.900}`,
            950: `{${theme.surface}.950}`,
          }
        },
        dark: {
          surface: {
            0: '#ffffff',
            50: `{${theme.surface}.50}`,
            100: `{${theme.surface}.100}`,
            200: `{${theme.surface}.200}`,
            300: `{${theme.surface}.300}`,
            400: `{${theme.surface}.400}`,
            500: `{${theme.surface}.500}`,
            600: `{${theme.surface}.600}`,
            700: `{${theme.surface}.700}`,
            800: `{${theme.surface}.800}`,
            900: `{${theme.surface}.900}`,
            950: `{${theme.surface}.950}`,
          }
        }
      }
    }
  });

  // Also update the surface palette directly so semantic tokens (ground, card, etc.) resolve
  updateSurfacePalette({
    50: `{${theme.surface}.50}`,
    100: `{${theme.surface}.100}`,
    200: `{${theme.surface}.200}`,
    300: `{${theme.surface}.300}`,
    400: `{${theme.surface}.400}`,
    500: `{${theme.surface}.500}`,
    600: `{${theme.surface}.600}`,
    700: `{${theme.surface}.700}`,
    800: `{${theme.surface}.800}`,
    900: `{${theme.surface}.900}`,
    950: `{${theme.surface}.950}`,
  });
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
