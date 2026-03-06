import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useGeoipStore = defineStore('geoip', () => {
  const rules = ref([]);
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

  return {
    rules, status, stats, loading,
    fetchStatus, fetchRules, addRules, toggleRule, deleteRule,
    updateSettings, refreshDb, fetchStats
  };
});
