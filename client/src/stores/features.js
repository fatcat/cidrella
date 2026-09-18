import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

/**
 * Feature switches the UI reads before rendering. Today that is one switch,
 * IPv6 support, which hides every IPv6 affordance while it is off. Loaded
 * once per session after sign-in and again after the Interfaces page saves.
 */
export const useFeaturesStore = defineStore('features', () => {
  const ipv6 = ref(false);
  const loaded = ref(false);

  function set(payload) {
    ipv6.value = payload?.ipv6 === true;
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

  return { ipv6, loaded, load, set };
});
