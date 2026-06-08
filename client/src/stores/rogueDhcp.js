import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useRogueDhcpStore = defineStore('rogueDhcp', () => {
  const status = ref(null);
  const events = ref([]);
  const authorized = ref([]);
  const loading = ref(false);

  async function fetchStatus() {
    const res = await api.get('/dhcp/rogue/status');
    status.value = res.data;
    return res.data;
  }

  async function fetchEvents() {
    loading.value = true;
    try {
      const res = await api.get('/dhcp/rogue/events');
      events.value = res.data;
      return res.data;
    } finally {
      loading.value = false;
    }
  }

  async function probeNow() {
    const res = await api.post('/dhcp/rogue/probe');
    return res.data;
  }

  async function acknowledge(id) {
    await api.post(`/dhcp/rogue/events/${id}/acknowledge`);
    await fetchEvents();
  }

  async function acknowledgeAll() {
    await api.post('/dhcp/rogue/acknowledge-all');
    await fetchEvents();
  }

  async function clearEvent(id) {
    await api.delete(`/dhcp/rogue/events/${id}`);
    await fetchEvents();
  }

  async function updateSettings({ enabled, intervalMin }) {
    const res = await api.put('/dhcp/rogue/settings', { enabled, intervalMin });
    return res.data;
  }

  async function fetchAuthorized() {
    const res = await api.get('/dhcp/rogue/authorized');
    authorized.value = res.data;
    return res.data;
  }

  async function addAuthorized(entry) {
    const res = await api.post('/dhcp/rogue/authorized', entry);
    await fetchAuthorized();
    return res.data;
  }

  async function deleteAuthorized(id) {
    await api.delete(`/dhcp/rogue/authorized/${id}`);
    await fetchAuthorized();
  }

  return {
    status, events, authorized, loading,
    fetchStatus, fetchEvents, probeNow, acknowledge, acknowledgeAll, clearEvent,
    updateSettings, fetchAuthorized, addAuthorized, deleteAuthorized,
  };
});
