import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useDnsStore = defineStore('dns', () => {
  const zones = ref([]);
  const loading = ref(false);

  async function fetchZones() {
    loading.value = true;
    try {
      const res = await api.get('/dns/zones');
      zones.value = res.data;
      return res.data;
    } finally {
      loading.value = false;
    }
  }

  async function getZone(id) {
    const res = await api.get(`/dns/zones/${id}`);
    return res.data;
  }

  async function createZone(data) {
    const res = await api.post('/dns/zones', data);
    await fetchZones();
    return res.data;
  }

  async function updateZone(id, data) {
    const res = await api.put(`/dns/zones/${id}`, data);
    await fetchZones();
    return res.data;
  }

  async function deleteZone(id) {
    await api.delete(`/dns/zones/${id}`);
    await fetchZones();
  }

  async function getRecords(zoneId) {
    const res = await api.get(`/dns/zones/${zoneId}/records`);
    return res.data;
  }

  async function createRecord(zoneId, data) {
    const res = await api.post(`/dns/zones/${zoneId}/records`, data);
    return res.data;
  }

  async function updateRecord(zoneId, recordId, data) {
    const res = await api.put(`/dns/zones/${zoneId}/records/${recordId}`, data);
    return res.data;
  }

  async function deleteRecord(zoneId, recordId) {
    await api.delete(`/dns/zones/${zoneId}/records/${recordId}`);
  }

  async function applyConfig() {
    const res = await api.post('/dns/apply');
    return res.data;
  }

  async function getForwarders() {
    const res = await api.get('/dns/forwarders');
    return res.data.servers;
  }

  async function updateForwarders(servers) {
    const res = await api.put('/dns/forwarders', { servers });
    return res.data.servers;
  }

  return {
    zones, loading,
    fetchZones, getZone, createZone, updateZone, deleteZone,
    getRecords, createRecord, updateRecord, deleteRecord,
    applyConfig, getForwarders, updateForwarders
  };
});
