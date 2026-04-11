import { defineStore } from 'pinia';
import { ref, reactive, toRefs } from 'vue';
import api from '../api/client.js';
import { loadJson, saveJson } from '../utils/storage.js';

const METRIC_CONFIG = [
  { key: 'timeseries',            url: '/metrics/timeseries' },
  { key: 'blocklistHits',         url: '/metrics/blocklist-hits' },
  { key: 'geoipHits',             url: '/metrics/geoip-hits' },
  { key: 'proxyPerf',             url: '/metrics/proxy-perf' },
  { key: 'topClients',            url: '/analytics/top-clients',          params: { limit: 10 } },
  { key: 'topDomains',            url: '/analytics/top-domains',          params: { limit: 10 } },
  { key: 'blocklistTopClients',   url: '/analytics/blocklist/top-clients', params: { limit: 10 } },
  { key: 'blocklistTopDomains',   url: '/analytics/blocklist/top-domains', params: { limit: 10 } },
  { key: 'blocklistTopCategories',url: '/analytics/blocklist/top-categories', params: { limit: 10 } },
  { key: 'geoipTopClients',       url: '/analytics/geoip/top-clients',    params: { limit: 10 } },
  { key: 'geoipTopDomains',       url: '/analytics/geoip/top-domains',    params: { limit: 10 } },
];

export const useDashboardStore = defineStore('dashboard', () => {
  const metrics = reactive({
    timeseries: [],
    blocklistHits: [],
    geoipHits: [],
    proxyPerf: [],
    topClients: [],
    topDomains: [],
    blocklistTopClients: [],
    blocklistTopDomains: [],
    blocklistTopCategories: [],
    geoipTopClients: [],
    geoipTopDomains: [],
  });

  const services = ref(null);
  const loading = ref(false);

  // Shared time range across all analytics tabs
  const selectedRange = ref(loadJson('cidrella_analytics_range', '24h'));

  function setRange(value) {
    selectedRange.value = value;
    saveJson('cidrella_analytics_range', value);
  }

  async function fetchMetric(key, range = '24h') {
    const cfg = METRIC_CONFIG.find(c => c.key === key);
    if (!cfg) return;
    const res = await api.get(cfg.url, { params: { range, ...cfg.params } });
    metrics[key] = res.data;
    return res.data;
  }

  async function fetchServices() {
    const res = await api.get('/metrics/services');
    services.value = res.data;
    return res.data;
  }

  // Thin wrappers kept for backward compatibility with existing callers
  const fetchTimeseries            = (range) => fetchMetric('timeseries', range);
  const fetchBlocklistHits         = (range) => fetchMetric('blocklistHits', range);
  const fetchGeoipHits             = (range) => fetchMetric('geoipHits', range);
  const fetchProxyPerf             = (range) => fetchMetric('proxyPerf', range);
  const fetchTopClients            = (range) => fetchMetric('topClients', range);
  const fetchTopDomains            = (range) => fetchMetric('topDomains', range);
  const fetchBlocklistTopClients   = (range) => fetchMetric('blocklistTopClients', range);
  const fetchBlocklistTopDomains   = (range) => fetchMetric('blocklistTopDomains', range);
  const fetchBlocklistTopCategories= (range) => fetchMetric('blocklistTopCategories', range);
  const fetchGeoipTopClients       = (range) => fetchMetric('geoipTopClients', range);
  const fetchGeoipTopDomains       = (range) => fetchMetric('geoipTopDomains', range);

  async function fetchAll(range = '24h') {
    loading.value = true;
    try {
      await Promise.all([
        ...METRIC_CONFIG.map(c => fetchMetric(c.key, range)),
        fetchServices(),
      ]);
    } finally {
      loading.value = false;
    }
  }

  return {
    metrics,
    ...toRefs(metrics),  // live-linked refs so store.timeseries stays in sync with metrics.timeseries
    services, loading,
    selectedRange, setRange,
    fetchMetric,
    fetchTimeseries, fetchBlocklistHits, fetchGeoipHits, fetchProxyPerf, fetchServices,
    fetchTopClients, fetchTopDomains,
    fetchBlocklistTopClients, fetchBlocklistTopDomains, fetchBlocklistTopCategories,
    fetchGeoipTopClients, fetchGeoipTopDomains,
    fetchAll,
  };
});
