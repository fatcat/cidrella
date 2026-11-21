import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import api from '../api/client.js';

/**
 * Feature switches the UI reads before rendering: the IPv6 switch, which
 * hides every IPv6 affordance while it is off, and which backend-dependent
 * features the active DNS and DHCP backends support. Loaded once per session
 * after sign-in and again after the Interfaces page saves or the DHCP server
 * changes.
 *
 * The same read says what this instance is: the controller, which owns the
 * data, or a member holding a synced read-only copy of a controller's. A
 * single box is a controller with no members.
 */
export const useFeaturesStore = defineStore('features', () => {
  const ipv6 = ref(false);
  // id -> { supported, note, backend, label }, from GET /api/features.
  const backend = ref({});
  const instance = ref(singleBox());
  const isMember = computed(() => instance.value.mode === 'member');
  const loaded = ref(false);

  function set(payload) {
    ipv6.value = payload?.ipv6 === true;
    backend.value = Object.fromEntries((payload?.backendFeatures || []).map((f) => [f.id, f]));
    instance.value = readInstance(payload?.instance);
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

  // The next sign-in reads everything again: joining a controller changes
  // the mode under a page that is still open.
  function reset() {
    loaded.value = false;
  }

  return { ipv6, backend, instance, isMember, loaded, load, set, reset };
});

// What a server that says nothing about instances is: one box, as before 0.7.0.
function singleBox() {
  return { mode: 'controller', controller_name: null, members: 0, sync: null };
}

function readInstance(raw) {
  if (!raw) return singleBox();
  return {
    mode: raw.mode === 'member' ? 'member' : 'controller',
    controller_name: raw.controller_name ?? null,
    members: Number(raw.members) || 0,
    sync: raw.sync ?? null,
  };
}
