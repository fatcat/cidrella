import { defineStore } from 'pinia';
import { ref, reactive, computed } from 'vue';
import api from '../api/client.js';

/**
 * First-run setup: the server-side step markers (so an interrupted setup
 * resumes where it stopped) and the in-progress choices the wizard screens
 * share before Start applies them. Nothing but the password is written to the
 * appliance until Start; the markers only remember what was chosen.
 */
export const useSetupStore = defineStore('setup', () => {
  const state = ref({ password: false, totp: null, deployment: null, import: null, done: false });
  const passwordPolicy = ref(null);
  const passwordComplexity = ref(true);
  const loaded = ref(false);

  // What the operator has picked so far. Seeded from `state` on load so a
  // resumed setup shows the earlier answers.
  const draft = reactive({
    role: 'both',
    interfaces: [], // [{ name, addresses, state, dns, dhcp }] from GET /api/interfaces
    importKind: 'fresh',
    network: { cidr: '', domain: '' }, // Pi-hole path only
  });

  // Both GET and PUT answer with the markers plus the served policy and the
  // complexity switch; one reader for both.
  function absorb(data) {
    const { password_policy: policy, password_complexity: complexity, ...rest } = data;
    state.value = rest;
    passwordPolicy.value = policy ?? null;
    passwordComplexity.value = complexity !== false;
    return state.value;
  }

  async function load() {
    const res = await api.get('/setup/state');
    absorb(res.data);
    if (state.value.deployment?.role) draft.role = state.value.deployment.role;
    if (state.value.import?.kind) draft.importKind = state.value.import.kind;
    loaded.value = true;
    return state.value;
  }

  async function mark(patch) {
    const res = await api.put('/setup/state', patch);
    return absorb(res.data);
  }

  // Interfaces the role uses, in the shape PUT /api/interfaces/config takes.
  // Only ticked interfaces are listed, the way the classic wizard did it, so
  // an untouched interface stays out of dnsmasq entirely. A setup resumed
  // past the deployment step has no interface rows loaded, so the saved
  // choice stands in for them.
  const interfaceConfig = computed(() => {
    if (draft.interfaces.length === 0) {
      const saved = state.value.deployment?.interfaces;
      if (saved && state.value.deployment.role === draft.role) return { ...saved };
    }
    const out = {};
    for (const iface of draft.interfaces) {
      const dns = draft.role !== 'dhcp' && iface.dns;
      const dhcp = draft.role !== 'dns' && iface.dhcp;
      if (dns || dhcp) out[iface.name] = { dns, dhcp };
    }
    return out;
  });

  const deploymentPayload = computed(() => ({
    interfaces: interfaceConfig.value,
    dns_enabled: draft.role !== 'dhcp',
    dhcp_enabled: draft.role !== 'dns',
  }));

  function applyInterfaceState(saved) {
    if (!saved) return;
    for (const iface of draft.interfaces) {
      const cfg = saved[iface.name];
      if (cfg) {
        iface.dns = cfg.dns === true;
        iface.dhcp = cfg.dhcp === true;
      }
    }
  }

  function reset() {
    state.value = { password: false, totp: null, deployment: null, import: null, done: false };
    passwordPolicy.value = null;
    passwordComplexity.value = true;
    loaded.value = false;
    draft.role = 'both';
    draft.interfaces = [];
    draft.importKind = 'fresh';
    draft.network = { cidr: '', domain: '' };
  }

  return {
    state,
    passwordPolicy,
    passwordComplexity,
    loaded,
    draft,
    interfaceConfig,
    deploymentPayload,
    load,
    mark,
    applyInterfaceState,
    reset,
  };
});
