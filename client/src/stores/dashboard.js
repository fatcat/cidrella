import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useDashboardStore = defineStore('dashboard', () => {
  const timeseries = ref([]);
  const blocklistHits = ref([]);
  const geoipHits = ref([]);
  const services = ref(null);
  const loading = ref(false);

  async function fetchTimeseries(range = '24h') {
    const res = await api.get(`/metrics/timeseries?range=${range}`);
    timeseries.value = res.data;
    return res.data;
  }

  async function fetchBlocklistHits(range = '24h') {
    const res = await api.get(`/metrics/blocklist-hits?range=${range}`);
    blocklistHits.value = res.data;
    return res.data;
  }

  async function fetchGeoipHits(range = '24h') {
    const res = await api.get(`/metrics/geoip-hits?range=${range}`);
    geoipHits.value = res.data;
    return res.data;
  }

  async function fetchServices() {
    const res = await api.get('/metrics/services');
    services.value = res.data;
    return res.data;
  }

  async function fetchAll(range = '24h') {
    loading.value = true;
    try {
      await Promise.all([
        fetchTimeseries(range),
        fetchBlocklistHits(range),
        fetchGeoipHits(range),
        fetchServices(),
      ]);
    } finally {
      loading.value = false;
    }
  }

  return {
    timeseries, blocklistHits, geoipHits, services, loading,
    fetchTimeseries, fetchBlocklistHits, fetchGeoipHits, fetchServices, fetchAll,
  };
});
