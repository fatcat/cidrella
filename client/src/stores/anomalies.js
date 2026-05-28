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

  async function deleteAnomaly(id) {
    const removed = active.value.find(a => a.id === id);
    await api.delete(`/anomalies/${id}`);
    active.value = active.value.filter(a => a.id !== id);
    if (summary.value && removed?.is_anomaly) {
      summary.value.total_active = Math.max(0, summary.value.total_active - 1);
      if (removed.id > (summary.value.acknowledged_through_id || 0)) {
        summary.value.unacknowledged_active = Math.max(0, (summary.value.unacknowledged_active || 0) - 1);
      }
      const sev = removed?.severity;
      if (sev && summary.value.by_severity[sev]) {
        summary.value.by_severity[sev] = Math.max(0, summary.value.by_severity[sev] - 1);
        if (summary.value.by_severity[sev] === 0) {
          delete summary.value.by_severity[sev];
        }
      }
    }
  }

  // Kept for backwards compat
  async function dismissAnomaly(id) {
    const dismissed = active.value.find(a => a.id === id);
    await api.post(`/anomalies/${id}/dismiss`);
    active.value = active.value.filter(a => a.id !== id);
    if (summary.value) {
      summary.value.total_active = Math.max(0, summary.value.total_active - 1);
      if (dismissed?.id > (summary.value.acknowledged_through_id || 0)) {
        summary.value.unacknowledged_active = Math.max(0, (summary.value.unacknowledged_active || 0) - 1);
      }
      const sev = dismissed?.severity;
      if (sev && summary.value.by_severity[sev]) {
        summary.value.by_severity[sev] = Math.max(0, summary.value.by_severity[sev] - 1);
        if (summary.value.by_severity[sev] === 0) {
          delete summary.value.by_severity[sev];
        }
      }
    }
  }

  async function whitelistClient(clientIp, reason) {
    await api.post('/anomalies/whitelist', { client_ip: clientIp, reason });
    // Remove all entries for this client from the active list
    active.value = active.value.filter(a => a.client_ip !== clientIp);
    if (summary.value) {
      await fetchSummary();
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

  async function acknowledgeCounter() {
    const res = await api.post('/anomalies/acknowledge');
    if (summary.value) {
      summary.value.unacknowledged_active = 0;
      summary.value.acknowledged_through_id = res.data.acknowledged_through_id || summary.value.acknowledged_through_id || 0;
    }
    return res.data;
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
    deleteAnomaly, dismissAnomaly, whitelistClient,
    fetchSettings, updateSettings, acknowledgeCounter, fetchAll,
  };
});
