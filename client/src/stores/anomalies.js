import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useAnomalyStore = defineStore('anomalies', () => {
  const active = ref([]);
  const summary = ref(null);
  const clientHistory = ref([]);
  const clientModel = ref(null);
  const settings = ref(null);
  const loading = ref(false);

  async function fetchActive(severity = null) {
    const params = severity ? `?severity=${severity}` : '';
    const res = await api.get(`/anomalies/active${params}`);
    active.value = res.data;
    return res.data;
  }

  async function fetchSummary() {
    const res = await api.get('/anomalies/summary');
    summary.value = res.data;
    return res.data;
  }

  async function fetchClientHistory(ip, limit = 100) {
    const res = await api.get(`/anomalies/client/${ip}?limit=${limit}`);
    clientHistory.value = res.data;
    return res.data;
  }

  async function fetchClientModel(ip) {
    const res = await api.get(`/anomalies/client/${ip}/model`);
    clientModel.value = res.data;
    return res.data;
  }

  async function dismissAnomaly(id) {
    const dismissed = active.value.find(a => a.id === id);
    await api.post(`/anomalies/${id}/dismiss`);
    active.value = active.value.filter(a => a.id !== id);
    if (summary.value) {
      summary.value.total_active = Math.max(0, summary.value.total_active - 1);
      // Update severity breakdown
      const sev = dismissed?.severity;
      if (sev && summary.value.by_severity[sev]) {
        summary.value.by_severity[sev] = Math.max(0, summary.value.by_severity[sev] - 1);
        if (summary.value.by_severity[sev] === 0) {
          delete summary.value.by_severity[sev];
        }
      }
    }
  }

  async function fetchSettings() {
    const res = await api.get('/anomalies/settings');
    settings.value = res.data;
    return res.data;
  }

  async function updateSettings(data) {
    await api.put('/anomalies/settings', data);
    await fetchSettings();
  }

  async function fetchAll(severity = null) {
    loading.value = true;
    try {
      await Promise.all([
        fetchActive(severity),
        fetchSummary(),
      ]);
    } finally {
      loading.value = false;
    }
  }

  return {
    active, summary, clientHistory, clientModel, settings, loading,
    fetchActive, fetchSummary, fetchClientHistory, fetchClientModel,
    dismissAnomaly, fetchSettings, updateSettings, fetchAll,
  };
});
