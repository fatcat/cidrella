import { defineStore } from 'pinia';
import { ref, reactive, toRefs } from 'vue';
import api from '../api/client.js';
import { loadJson, saveJson } from '../utils/storage.js';

const METRIC_CONFIG = [
  { key: 'timeseries', url: '/metrics/timeseries' },
  { key: 'blocklistHits', url: '/metrics/blocklist-hits' },
  { key: 'geoipHits', url: '/metrics/geoip-hits' },
  { key: 'proxyPerf', url: '/metrics/proxy-perf' },
  { key: 'topClients', url: '/analytics/top-clients', params: { limit: 10 } },
  { key: 'topDomains', url: '/analytics/top-domains', params: { limit: 10 } },
  {
    key: 'dnssecUnsupportedDomains',
    url: '/analytics/dnssec/top-unsupported-domains',
    params: { limit: 10 },
  },
  { key: 'blocklistTopClients', url: '/analytics/blocklist/top-clients', params: { limit: 10 } },
  { key: 'blocklistTopDomains', url: '/analytics/blocklist/top-domains', params: { limit: 10 } },
  {
    key: 'blocklistTopCategories',
    url: '/analytics/blocklist/top-categories',
    params: { limit: 10 },
  },
  {
    key: 'blocklistTopClientDomains',
    url: '/analytics/blocklist/top-client-domains',
    params: { limit: 20 },
  },
  { key: 'geoipTopClients', url: '/analytics/geoip/top-clients', params: { limit: 10 } },
  { key: 'geoipTopDomains', url: '/analytics/geoip/top-domains', params: { limit: 10 } },
];

export const useDashboardStore = defineStore('dashboard', () => {
  const metrics = reactive({
    timeseries: [],
    blocklistHits: [],
    geoipHits: [],
    proxyPerf: [],
    topClients: [],
    topDomains: [],
    dnssecUnsupportedDomains: [],
    blocklistTopClients: [],
    blocklistTopDomains: [],
    blocklistTopCategories: [],
    blocklistTopClientDomains: [],
    geoipTopClients: [],
    geoipTopDomains: [],
  });

  const services = ref(null);
  const systemHealth = ref(null);
  const loading = ref(false);

  // Shared time range across all analytics tabs
  const selectedRange = ref(loadJson('cidrella_analytics_range', '24h'));

  function setRange(value) {
    selectedRange.value = value;
    saveJson('cidrella_analytics_range', value);
  }

  async function fetchMetric(key, range = '24h') {
    const cfg = METRIC_CONFIG.find((c) => c.key === key);
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

  async function fetchSystemHealth() {
    const res = await api.get('/health/system');
    systemHealth.value = res.data;
    return res.data;
  }

  // Thin wrappers kept for backward compatibility with existing callers
  const fetchTimeseries = (range) => fetchMetric('timeseries', range);
  const fetchBlocklistHits = (range) => fetchMetric('blocklistHits', range);
  const fetchGeoipHits = (range) => fetchMetric('geoipHits', range);
  const fetchProxyPerf = (range) => fetchMetric('proxyPerf', range);
  const fetchTopClients = (range) => fetchMetric('topClients', range);
  const fetchTopDomains = (range) => fetchMetric('topDomains', range);
  const fetchDnssecUnsupportedDomains = (range) => fetchMetric('dnssecUnsupportedDomains', range);
  const fetchBlocklistTopClients = (range) => fetchMetric('blocklistTopClients', range);
  const fetchBlocklistTopDomains = (range) => fetchMetric('blocklistTopDomains', range);
  const fetchBlocklistTopCategories = (range) => fetchMetric('blocklistTopCategories', range);
  const fetchBlocklistTopClientDomains = (range) => fetchMetric('blocklistTopClientDomains', range);
  const fetchGeoipTopClients = (range) => fetchMetric('geoipTopClients', range);
  const fetchGeoipTopDomains = (range) => fetchMetric('geoipTopDomains', range);

  // Everything the health board reads, in one round. Each source settles on
  // its own so a failing one leaves its panel saying "unavailable" instead of
  // taking the page down with it. The range-driven sources (timeseries, proxy
  // perf, top lists) are the only ones a range change refetches.
  const health = reactive({
    services: null,
    system: null,
    lifecycle: null,
    networkDhcp: null,
    rogueDhcp: null,
    anomalies: null,
    failed: [],
  });

  async function fetchHealthBoard(range = '24h', { rangeOnly = false } = {}) {
    loading.value = true;
    const settle = (key, promise) =>
      promise.then(
        (data) => ({ key, data }),
        () => ({ key, data: null, failed: true }),
      );
    try {
      const rangeSources = [
        settle('timeseries', fetchMetric('timeseries', range)),
        settle('proxyPerf', fetchMetric('proxyPerf', range)),
        settle('topClients', fetchMetric('topClients', range)),
        settle('topDomains', fetchMetric('topDomains', range)),
      ];
      const stateSources = rangeOnly
        ? []
        : [
            settle(
              'services',
              api.get('/metrics/services').then((r) => r.data),
            ),
            settle(
              'system',
              api.get('/health/system').then((r) => r.data),
            ),
            settle(
              'lifecycle',
              api.get('/metrics/ip-lifecycle').then((r) => r.data),
            ),
            settle(
              'networkDhcp',
              api.get('/metrics/network-dhcp').then((r) => r.data),
            ),
            settle(
              'rogueDhcp',
              api.get('/dhcp/rogue/status').then((r) => r.data),
            ),
            settle(
              'anomalies',
              api.get('/anomalies/summary').then((r) => r.data),
            ),
          ];
      const results = await Promise.all([...rangeSources, ...stateSources]);
      const failed = new Set(rangeOnly ? health.failed.filter((k) => !(k in metrics)) : []);
      for (const { key, data, failed: didFail } of results) {
        if (didFail) failed.add(key);
        if (key in health) health[key] = data;
        if (key === 'services') services.value = data;
      }
      health.failed = [...failed];
    } finally {
      loading.value = false;
    }
  }

  async function fetchAll(range = '24h') {
    loading.value = true;
    try {
      await Promise.all([
        ...METRIC_CONFIG.map((c) => fetchMetric(c.key, range)),
        fetchServices(),
        fetchSystemHealth(),
      ]);
    } finally {
      loading.value = false;
    }
  }

  return {
    metrics,
    ...toRefs(metrics), // live-linked refs so store.timeseries stays in sync with metrics.timeseries
    services,
    systemHealth,
    loading,
    selectedRange,
    setRange,
    fetchMetric,
    health,
    fetchHealthBoard,
    fetchTimeseries,
    fetchBlocklistHits,
    fetchGeoipHits,
    fetchProxyPerf,
    fetchServices,
    fetchSystemHealth,
    fetchTopClients,
    fetchTopDomains,
    fetchDnssecUnsupportedDomains,
    fetchBlocklistTopClients,
    fetchBlocklistTopDomains,
    fetchBlocklistTopCategories,
    fetchBlocklistTopClientDomains,
    fetchGeoipTopClients,
    fetchGeoipTopDomains,
    fetchAll,
  };
});
