import { defineStore } from 'pinia';
import { ref } from 'vue';
import api from '../api/client.js';

export const useDashboardStore = defineStore('dashboard', () => {
  const timeseries = ref([]);
  const blocklistHits = ref([]);
  const geoipHits = ref([]);
  const proxyPerf = ref([]);
  const services = ref(null);
  const loading = ref(false);

  // Shared time range across all analytics tabs
  const selectedRange = ref((() => {
    try { const v = JSON.parse(localStorage.getItem('ipam_analytics_range')); return v || '24h'; } catch { return '24h'; }
  })());

  function setRange(value) {
    selectedRange.value = value;
    try { localStorage.setItem('ipam_analytics_range', JSON.stringify(value)); } catch {}
  }

  // Analytics top-N data
  const topClients = ref([]);
  const topDomains = ref([]);
  const blocklistTopClients = ref([]);
  const blocklistTopDomains = ref([]);
  const blocklistTopCategories = ref([]);
  const geoipTopClients = ref([]);
  const geoipTopDomains = ref([]);

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

  async function fetchProxyPerf(range = '24h') {
    const res = await api.get(`/metrics/proxy-perf?range=${range}`);
    proxyPerf.value = res.data;
    return res.data;
  }

  async function fetchServices() {
    const res = await api.get('/metrics/services');
    services.value = res.data;
    return res.data;
  }

  async function fetchTopClients(range = '24h') {
    const res = await api.get(`/analytics/top-clients?range=${range}&limit=10`);
    topClients.value = res.data;
  }

  async function fetchTopDomains(range = '24h') {
    const res = await api.get(`/analytics/top-domains?range=${range}&limit=10`);
    topDomains.value = res.data;
  }

  async function fetchBlocklistTopClients(range = '24h') {
    const res = await api.get(`/analytics/blocklist/top-clients?range=${range}&limit=10`);
    blocklistTopClients.value = res.data;
  }

  async function fetchBlocklistTopDomains(range = '24h') {
    const res = await api.get(`/analytics/blocklist/top-domains?range=${range}&limit=10`);
    blocklistTopDomains.value = res.data;
  }

  async function fetchBlocklistTopCategories(range = '24h') {
    const res = await api.get(`/analytics/blocklist/top-categories?range=${range}&limit=10`);
    blocklistTopCategories.value = res.data;
  }

  async function fetchGeoipTopClients(range = '24h') {
    const res = await api.get(`/analytics/geoip/top-clients?range=${range}&limit=10`);
    geoipTopClients.value = res.data;
  }

  async function fetchGeoipTopDomains(range = '24h') {
    const res = await api.get(`/analytics/geoip/top-domains?range=${range}&limit=10`);
    geoipTopDomains.value = res.data;
  }

  async function fetchAll(range = '24h') {
    loading.value = true;
    try {
      await Promise.all([
        fetchTimeseries(range),
        fetchBlocklistHits(range),
        fetchGeoipHits(range),
        fetchProxyPerf(range),
        fetchServices(),
        fetchTopClients(range),
        fetchTopDomains(range),
        fetchBlocklistTopClients(range),
        fetchBlocklistTopDomains(range),
        fetchBlocklistTopCategories(range),
        fetchGeoipTopClients(range),
        fetchGeoipTopDomains(range),
      ]);
    } finally {
      loading.value = false;
    }
  }

  return {
    timeseries, blocklistHits, geoipHits, proxyPerf, services, loading,
    selectedRange, setRange,
    topClients, topDomains,
    blocklistTopClients, blocklistTopDomains, blocklistTopCategories,
    geoipTopClients, geoipTopDomains,
    fetchTimeseries, fetchBlocklistHits, fetchGeoipHits, fetchProxyPerf, fetchServices,
    fetchTopClients, fetchTopDomains,
    fetchBlocklistTopClients, fetchBlocklistTopDomains, fetchBlocklistTopCategories,
    fetchGeoipTopClients, fetchGeoipTopDomains,
    fetchAll,
  };
});
