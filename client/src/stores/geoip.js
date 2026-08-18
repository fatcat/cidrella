import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useGeoipStore = defineStore('geoip', () => {
  const rules = ref([]);
  const ipAllowlist = ref([]);
  const status = ref(null);
  const stats = ref({ total: 0, blocked: 0, allowed: 0 });
  const loading = ref(false);

  async function fetchStatus() {
    const res = await api.get('/geoip/status');
    status.value = res.data;
    return res.data;
  }

  async function fetchRules() {
    loading.value = true;
    try {
      const res = await api.get('/geoip/rules');
      rules.value = res.data;
      return res.data;
    } finally {
      loading.value = false;
    }
  }

  async function addRules(countries) {
    const res = await api.post('/geoip/rules', { countries });
    await fetchRules();
    return res.data;
  }

  async function toggleRule(id, enabled) {
    const res = await api.put(`/geoip/rules/${id}`, { enabled });
    await fetchRules();
    return res.data;
  }

  async function deleteRule(id) {
    await api.delete(`/geoip/rules/${id}`);
    await fetchRules();
  }

  async function updateSettings(data) {
    const res = await api.put('/geoip/settings', data);
    await fetchStatus();
    return res.data;
  }

  async function refreshDb() {
    const res = await api.post('/geoip/db/refresh');
    await fetchStatus();
    return res.data;
  }

  async function fetchStats() {
    const res = await api.get('/geoip/stats');
    stats.value = res.data;
    return res.data;
  }

  // The domain-whitelist wrapper that used to sit here was a second copy of the
  // one in stores/blocklists.js against the same /api/blocklists/whitelist
  // endpoint, and nothing read it (duplicate-logic audit #59). Deleted rather
  // than wired up: the settings shell keeps its panels alive with <keep-alive>,
  // so a second cached copy of one server-side list would go stale the moment
  // either view edited it. Use stores/blocklists.js.
  //
  // Not to be confused with the GeoIP IP/CIDR allowlist below, which is a
  // different list on a different endpoint.

  // GeoIP IP/CIDR allowlist. Addresses/ranges never GeoIP-blocked.
  async function fetchIpAllowlist() {
    const res = await api.get('/geoip/allowlist');
    ipAllowlist.value = res.data;
    return res.data;
  }

  async function addIpAllow(value, reason) {
    const res = await api.post('/geoip/allowlist', { value, reason });
    await fetchIpAllowlist();
    return res.data;
  }

  async function removeIpAllow(id) {
    await api.delete(`/geoip/allowlist/${id}`);
    await fetchIpAllowlist();
  }

  return {
    rules, ipAllowlist, status, stats, loading,
    fetchStatus, fetchRules, addRules, toggleRule, deleteRule,
    updateSettings, refreshDb, fetchStats,
    fetchIpAllowlist, addIpAllow, removeIpAllow
  };
});
