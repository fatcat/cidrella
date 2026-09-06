import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useAnomalyStore = defineStore('anomalies', () => {
  const summary = ref(null);
  const events = ref([]);
  const learning = ref([]);
  const clientHistory = ref([]);
  const clientModel = ref(null);
  const settings = ref(null);
  const loading = ref(false);

  async function fetchSummary() {
    const res = await api.get('/anomalies/summary');
    summary.value = res.data;
    return res.data;
  }

  async function fetchEvents(days = 7) {
    const res = await api.get(`/anomalies/events?days=${days}`);
    events.value = res.data.events;
    learning.value = res.data.learning;
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

  function clearClient() {
    clientHistory.value = [];
    clientModel.value = null;
  }

  async function whitelistClient(clientIp, reason) {
    await api.post('/anomalies/whitelist', { client_ip: clientIp, reason });
    // Remove all entries for this client from every locally-held list
    events.value = events.value.filter(e => e.client_ip !== clientIp);
    learning.value = learning.value.filter(l => l.client_ip !== clientIp);
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

  async function fetchAll() {
    loading.value = true;
    try {
      await Promise.all([
        fetchSummary(),
        fetchEvents(),
      ]);
    } finally {
      loading.value = false;
    }
  }

  return {
    summary, events, learning, clientHistory, clientModel, settings, loading,
    fetchSummary, fetchEvents, fetchClientHistory, fetchClientModel, clearClient,
    whitelistClient,
    fetchSettings, updateSettings, acknowledgeCounter, fetchAll,
  };
});
