import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import Aura from '@primevue/themes/aura';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import 'primeicons/primeicons.css';

import App from './App.vue';
import router from './router/index.js';
import { useDebugStore } from './stores/debug.js';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
app.use(PrimeVue, {
  theme: {
    preset: Aura
  }
});
app.use(ToastService);
app.directive('tooltip', Tooltip);

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
