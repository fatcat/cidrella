import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import api from '../api/client.js';
import { isFrozen, singleBox } from '../utils/instances.js';

/**
 * Feature switches the UI reads before rendering: the IPv6 switch, which
 * hides every IPv6 affordance while it is off, and which backend-dependent
 * features the active DNS and DHCP backends support. Loaded once per session
 * after sign-in and again after the Interfaces page saves or the DHCP server
 * changes.
 *
 * The same read says what this instance is: the controller, which owns the
 * data, or a member holding a synced read-only copy of a controller's. A
 * single box is a controller with no members. A controller can also be
 * frozen: replaced by another one (fenced), or handing the role to a member.
 * It takes no changes then, which usePermissions reads as read-only.
 */
export const useFeaturesStore = defineStore('features', () => {
  const ipv6 = ref(false);
  // id -> { supported, note, backend, label }, from GET /api/features.
  const backend = ref({});
  const instance = ref(singleBox());
  const isMember = computed(() => instance.value.mode === 'member');
  const frozen = computed(() => isFrozen(instance.value));
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

  return { ipv6, backend, instance, isMember, frozen, loaded, load, set, reset };
});

function readInstance(raw) {
  if (!raw) return singleBox();
  const mode = raw.mode === 'member' ? 'member' : 'controller';
  return {
    mode,
    controller_name: raw.controller_name ?? null,
    // The controller's web UI, where a member sends someone for what it does
    // not show. Only an https URL is kept: it becomes a link.
    controller_url: safeControllerUrl(raw.controller_url),
    members: Number(raw.members) || 0,
    sync: raw.sync ?? null,
    // Whether this box answers DHCP. A server that does not say predates
    // moving DHCP, when the controller always served it.
    serves_dhcp: typeof raw.serves_dhcp === 'boolean' ? raw.serves_dhcp : mode === 'controller',
    // A server that says nothing of these predates changing the controller.
    fenced: raw.fenced === true,
    fenced_by: raw.fenced_by || null,
    handover_to: raw.handover_to || null,
  };
}

function safeControllerUrl(url) {
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}
