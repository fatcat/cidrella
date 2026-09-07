import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useAnomalyStore = defineStore('anomalies', () => {
  const summary = ref(null);
  const events = ref([]);
  const learning = ref([]);
  const clientHistory = ref([]);
  const clientModel = ref(null);
  const fingerprintChanges = ref([]);
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

  // Recent device_type/os_family/vendor_class drift for a MAC identity --
  // e.g. a device that suddenly classifies as a different kind of hardware,
  // which can indicate spoofing or a rogue device taking over the address.
  // Silently empty for an IP-fallback identity (no MAC, so no fingerprint).
  async function fetchFingerprintChanges(identity) {
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(identity)) {
      fingerprintChanges.value = [];
      return [];
    }
    const res = await api.get(`/devices/${identity}/fingerprint/history`);
    fingerprintChanges.value = res.data;
    return res.data;
  }

  function clearClient() {
    clientHistory.value = [];
    clientModel.value = null;
    fingerprintChanges.value = [];
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
    summary, events, learning, clientHistory, clientModel, fingerprintChanges, settings, loading,
    fetchSummary, fetchEvents, fetchClientHistory, fetchClientModel, fetchFingerprintChanges, clearClient,
    whitelistClient,
    fetchSettings, updateSettings, acknowledgeCounter, fetchAll,
  };
});
