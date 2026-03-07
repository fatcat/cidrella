import api from '../api/client.js';

const FLUSH_INTERVAL = 3000;
const MAX_BUFFER = 20;

let buffer = [];
let flushTimer = null;

function flush() {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0);
  // Fire and forget — don't let tracking failures break the app
  api.post('/dev/tracking', batch).catch(() => {});
}

function record(type, data) {
  buffer.push({
    type,
    timestamp: new Date().toISOString(),
    ...data
  });
  if (buffer.length >= MAX_BUFFER) flush();
}

// Track click events — capture element info and component context
function trackClicks() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-track], button, a, [role="menuitem"], [role="tab"], .p-menuitem');
    if (!el) return;

    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().slice(0, 80);
    const trackId = el.dataset?.track || null;
    const ariaLabel = el.getAttribute('aria-label');
    const classList = [...el.classList].slice(0, 5).join(' ');

    // Walk up to find Vue component name
    let component = null;
    let node = el;
    while (node && !component) {
      if (node.__vueParentComponent?.type?.name) {
        component = node.__vueParentComponent.type.name;
      } else if (node.__vueParentComponent?.type?.__name) {
        component = node.__vueParentComponent.type.__name;
      }
      node = node.parentElement;
    }

    record('click', {
      tag,
      text: text || undefined,
      trackId: trackId || undefined,
      ariaLabel: ariaLabel || undefined,
      classes: classList || undefined,
      component: component || undefined,
      path: window.location.pathname
    });
  }, true);
}

// Track route changes
function trackRoutes(router) {
  router.afterEach((to, from) => {
    record('route', {
      from: from.fullPath,
      to: to.fullPath,
      name: to.name || undefined
    });
  });
}

// Track API calls via axios interceptor
function trackApi(apiClient) {
  apiClient.interceptors.request.use((config) => {
    config._trackStart = Date.now();
    return config;
  });

  apiClient.interceptors.response.use(
    (response) => {
      if (response.config.url?.includes('/dev/tracking') || response.config.url?.includes('/health/')) return response;
      const duration = response.config._trackStart
        ? Date.now() - response.config._trackStart
        : undefined;
      record('api', {
        method: response.config.method?.toUpperCase(),
        url: response.config.url,
        status: response.status,
        duration
      });
      return response;
    },
    (error) => {
      const duration = error.config?._trackStart
        ? Date.now() - error.config._trackStart
        : undefined;
      record('api', {
        method: error.config?.method?.toUpperCase(),
        url: error.config?.url,
        status: error.response?.status || 'NETWORK_ERROR',
        duration,
        error: error.response?.data?.error || error.message
      });
      return Promise.reject(error);
    }
  );
}

// Track Pinia store actions
function trackStoreActions(pinia) {
  pinia.use(({ store }) => {
    store.$onAction(({ name: actionName, store: actionStore, after, onError }) => {
      const start = Date.now();
      after(() => {
        record('action', {
          store: actionStore.$id,
          action: actionName,
          duration: Date.now() - start
        });
      });
      onError((error) => {
        record('action', {
          store: actionStore.$id,
          action: actionName,
          duration: Date.now() - start,
          error: error.message
        });
      });
    });
  });
}

export function initTracker({ router, apiClient, pinia }) {
  trackClicks();
  trackRoutes(router);
  trackApi(apiClient);
  trackStoreActions(pinia);

  // Periodic flush
  flushTimer = setInterval(flush, FLUSH_INTERVAL);

  // Flush on page unload
  window.addEventListener('beforeunload', flush);

  console.log('%c[CIDRella Tracker] Dev tracking enabled', 'color: #f59e0b; font-weight: bold');
}
