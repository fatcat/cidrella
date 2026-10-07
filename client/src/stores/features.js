import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

/**
 * Feature switches the UI reads before rendering: the IPv6 switch, which
 * hides every IPv6 affordance while it is off, and which backend-dependent
 * features the active DNS and DHCP backends support. Loaded once per session
 * after sign-in and again after the Interfaces page saves or the DHCP server
 * changes.
 */
export const useFeaturesStore = defineStore('features', () => {
  const ipv6 = ref(false);
  // id -> { supported, note, backend, label }, from GET /api/features.
  const backend = ref({});
  const loaded = ref(false);

  function set(payload) {
    ipv6.value = payload?.ipv6 === true;
    backend.value = Object.fromEntries((payload?.backendFeatures || []).map((f) => [f.id, f]));
    loaded.value = true;
  }

  async function load() {
    try {
      const res = await api.get('/features');
      set(res.data);
    } catch {
      // A failed read leaves every switch off, the safe default.
      loaded.value = true;
    }
  }

  return { ipv6, backend, loaded, load, set };
});
