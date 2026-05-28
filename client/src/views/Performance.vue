<template>
  <div class="analytics-tab">
    <!-- Stats Bar -->
    <div class="stats-bar" v-if="services">
      <div class="stat">
        <span class="stat-value">
          <span :class="services.dnsmasq ? 'indicator-on' : 'indicator-off'"></span>
          {{ services.dnsmasq ? 'Running' : 'Stopped' }}
        </span>
        <span class="stat-label">DNSMASQ</span>
      </div>
      <div class="stat">
        <span class="stat-value">
          <span :class="services.geoip_proxy ? 'indicator-on' : 'indicator-off'"></span>
          {{ services.geoip_bypassed ? 'Bypassed' : services.geoip_proxy ? 'Running' : 'Stopped' }}
        </span>
        <span class="stat-label">DNS Proxy</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ proxyStats?.queriesPerMin ?? '—' }}</span>
        <span class="stat-label">Queries / min</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ proxyStats ? proxyStats.cacheHitRate + '%' : '—' }}</span>
        <span class="stat-label">Cache Hit Rate</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ proxyStats ? (proxyStats.avgLatency / 1000).toFixed(2) + ' ms' : '—' }}</span>
        <span class="stat-label">Avg Latency</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ proxyStats?.peakPending ?? '—' }}</span>
        <span class="stat-label">Peak Pending</span>
      </div>
      <div class="stat">
        <span class="stat-value" :class="{ 'text-danger': proxyStats?.timeouts > 0 }">
          {{ proxyStats?.timeouts ?? '—' }}
        </span>
        <span class="stat-label">Timeouts</span>
      </div>
    </div>

    <div class="dashboard-content">
      <!-- Time Range -->
      <div class="range-bar">
        <Select v-model="selectedRange" :options="rangeOptions" optionLabel="label" optionValue="value"
                size="small" style="width: 10rem" @change="refreshAll" />
        <Button icon="pi pi-refresh" size="small" text rounded @click="refreshAll" :loading="store.loading" title="Refresh" />
      </div>

      <LineChartCard title="DNS Requests Over Time" :data="dnsRequestsData" :options="dnsRequestsOptions" />

      <LineChartCard title="Proxy Query Latency" :data="latencyData" :options="latencyOptions"
                     emptyText="No proxy latency data in this range." />

      <LineChartCard title="Query Throughput" :data="throughputData" :options="throughputOptions"
                     emptyText="No query throughput data in this range." />

      <!-- Process Resources -->
      <div class="chart-card">
        <h4>Process Resources</h4>
        <div class="card-row">
          <div class="chart-card gauge-card">
            <div class="gauge-group">
              <div class="gauge-item">
                <div class="gauge-wrap">
                  <Doughnut :data="cpuGaugeData" :options="gaugeOptions" :plugins="[gaugeCenterText]" />
                  <span class="gauge-value">{{ processCpuPercent.toFixed(1) }}%</span>
                </div>
                <span class="gauge-label">CPU</span>
              </div>
              <div class="gauge-item">
                <div class="gauge-wrap">
                  <Doughnut :data="memGaugeData" :options="gaugeOptions" :plugins="[gaugeCenterText]" />
                  <span class="gauge-value">{{ latestPerf?.rss_mb?.toFixed(0) ?? '0' }} MB</span>
                </div>
                <span class="gauge-label">Memory</span>
              </div>
            </div>
          </div>
          <div class="chart-card">
            <div v-if="resourceData" class="chart-wrap" style="height: 240px">
              <Line :data="resourceData" :options="resourceOptions" />
            </div>
            <p v-else class="empty-chart">No resource data in this range.</p>
          </div>
        </div>
      </div>

      <LineChartCard title="Cache Performance" :data="cacheData" :options="cacheOptions"
                     emptyText="No cache data in this range." />

      <LineChartCard title="Memory Consumption" :data="memoryData" :options="memoryOptions"
                     emptyText="No memory data in this range." />

      <LineChartCard title="CPU Usage" :data="cpuData" :options="cpuOptions"
                     emptyText="No CPU data in this range." />

    </div>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { formatEpoch } from '../utils/dateFormat.js';
import Select from 'primevue/select';
import Button from 'primevue/button';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  ArcElement, Title, Tooltip, Legend, Filler
} from 'chart.js';
import { Line, Doughnut } from 'vue-chartjs';
import { useDashboardStore } from '../stores/dashboard.js';
import { RANGE_OPTIONS, chartColor, lineDataset, makeLineOptions } from '../utils/chart-config.js';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import LineChartCard from '../components/LineChartCard.vue';
import '../assets/analytics-layout.css';

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  ArcElement, Title, Tooltip, Legend, Filler
);
ChartJS.defaults.elements.line.borderWidth = 1;

const store = useDashboardStore();
const rangeOptions = RANGE_OPTIONS;
const selectedRange = computed({ get: () => store.selectedRange, set: (v) => store.setRange(v) });

const services = computed(() => store.services);

function formatTs(epoch) {
  return formatEpoch(epoch, selectedRange.value);
}

function normalizeProcessCpuPercent(row) {
  const cores = store.systemHealth?.cpu?.cores || 1;
  return (row?.cpu_percent ?? 0) / cores;
}

// ── Stats bar ──────────────────────────────────────────
const proxyStats = computed(() => {
  const pp = store.proxyPerf;
  if (!pp.length) return null;

  const totalHits = pp.reduce((s, r) => s + (r.cache_hits || 0), 0);
  const totalMisses = pp.reduce((s, r) => s + (r.cache_misses || 0), 0);
  const totalLookups = totalHits + totalMisses;
  const cacheHitRate = totalLookups > 0 ? Math.round(totalHits / totalLookups * 100) : 0;

  const withLatency = pp.filter(r => r.latency_avg != null);
  const avgLatency = withLatency.length > 0
    ? Math.round(withLatency.reduce((s, r) => s + r.latency_avg, 0) / withLatency.length)
    : 0;

  const timeouts = pp.reduce((s, r) => s + (r.timeouts || 0), 0);
  const totalQueries = pp.reduce((s, r) => s + (r.query_count || 0), 0);
  const queriesPerMin = pp.length > 0 ? Math.round(totalQueries / pp.length) : 0;
  const peakPending = Math.max(0, ...pp.map(r => r.pending_queries || 0));

  return { cacheHitRate, avgLatency, timeouts, queriesPerMin, peakPending };
});

// ── DNS Requests Over Time ─────────────────────────────
const dnsRequestsData = computed(() => {
  const ts = store.timeseries;
  if (!ts.length) return null;
  return {
    labels: ts.map(r => formatTs(r.ts)),
    datasets: [
      {
        ...lineDataset({ label: 'DNS Queries', data: ts.map(r => r.dns_queries), color: 1, fill: true }),
      },
      {
        ...lineDataset({ label: 'DHCP Requests', data: ts.map(r => r.dhcp_requests), color: 2, fill: true, alpha: 0.12 }),
      },
    ],
  };
});

const dnsRequestsOptions = makeLineOptions({ yLabel: 'count' });

// ── Proxy Query Latency ────────────────────────────────
const latencyData = computed(() => {
  const pp = store.proxyPerf;
  if (!pp.length) return null;
  return {
    labels: pp.map(r => formatTs(r.ts)),
    datasets: [
      {
        ...lineDataset({ label: 'Avg', data: pp.map(r => (r.latency_avg || 0) / 1000), color: 1 }),
      },
      {
        ...lineDataset({ label: 'P95', data: pp.map(r => (r.latency_p95 || 0) / 1000), color: 'warn' }),
      },
      {
        ...lineDataset({ label: 'Max', data: pp.map(r => (r.latency_max || 0) / 1000), color: 'err' }),
      },
    ],
  };
});

const latencyOptions = makeLineOptions({ yLabel: 'ms', tooltipCallback: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(2) ?? '—'} ms` });

// ── Query Throughput ───────────────────────────────────
const throughputData = computed(() => {
  const pp = store.proxyPerf;
  if (!pp.length) return null;
  return {
    labels: pp.map(r => formatTs(r.ts)),
    datasets: [
      {
        ...lineDataset({ label: 'Queries / min', data: pp.map(r => r.query_count || 0), color: 1, fill: true }),
      },
      {
        ...lineDataset({ label: 'Timeouts', data: pp.map(r => r.timeouts || 0), color: 'err', fill: true, alpha: 0.12 }),
      },
    ],
  };
});

const throughputOptions = makeLineOptions({ yLabel: 'count' });

// ── Process Resources (combined line chart) ────────────
const resourceData = computed(() => {
  const pp = store.proxyPerf;
  if (!pp.length) return null;
  return {
    labels: pp.map(r => formatTs(r.ts)),
    datasets: [
      {
        ...lineDataset({ label: 'RSS (MB)', data: pp.map(r => r.rss_mb), color: 1, yAxisID: 'y' }),
      },
      {
        ...lineDataset({ label: 'Heap (MB)', data: pp.map(r => r.heap_mb), color: 2, yAxisID: 'y' }),
      },
      {
        ...lineDataset({ label: 'CPU %', data: pp.map(r => normalizeProcessCpuPercent(r)), color: 7, yAxisID: 'y1' }),
      },
    ],
  };
});

const resourceOptions = makeLineOptions({
  yLabel: 'MB',
  extraScales: {
    y1: {
      position: 'right',
      beginAtZero: true,
      title: { display: true, text: 'CPU %', color: chartColor('text') },
      ticks: { color: chartColor('text') },
      grid: { drawOnChartArea: false },
    },
  },
});

// ── Gauges (current CPU & Memory) ──────────────────────
const latestPerf = computed(() => {
  const pp = store.proxyPerf;
  return pp.length ? pp[pp.length - 1] : null;
});

const systemMemoryTotalMb = computed(() => {
  const totalBytes = store.systemHealth?.memory?.total;
  if (totalBytes) return totalBytes / 1048576;
  const observedPeak = Math.max(0, ...store.proxyPerf.map(r => r.rss_mb || 0));
  return Math.max(512, observedPeak * 1.25);
});

const processCpuPercent = computed(() => {
  return normalizeProcessCpuPercent(latestPerf.value);
});

const cpuGaugeData = computed(() => {
  const val = processCpuPercent.value;
  const clamped = Math.min(100, Math.max(0, val));
  return {
    labels: ['CPU', ''],
    datasets: [{
      data: [clamped, 100 - clamped],
      backgroundColor: [clamped > 80 ? chartColor('err') : clamped > 50 ? chartColor('warn') : chartColor('ok'), chartColor('track')],
      borderWidth: 0,
    }],
  };
});

const memGaugeData = computed(() => {
  const rss = latestPerf.value?.rss_mb ?? 0;
  const cap = systemMemoryTotalMb.value || 512;
  const pct = Math.min(100, (rss / cap) * 100);
  return {
    labels: ['Memory', ''],
    datasets: [{
      data: [pct, 100 - pct],
      backgroundColor: [pct > 80 ? chartColor('err') : pct > 50 ? chartColor('warn') : chartColor(1), chartColor('track')],
      borderWidth: 0,
    }],
  };
});

const gaugeOptions = {
  responsive: true,
  maintainAspectRatio: false,
  rotation: -90,
  circumference: 180,
  cutout: '75%',
  plugins: {
    legend: { display: false },
    tooltip: { enabled: false },
    datalabels: { display: false },
  },
};

// Empty plugin object — value shown via HTML overlay
const gaugeCenterText = { id: 'gaugeCenterText' };

// ── Cache Performance ──────────────────────────────────
const cacheData = computed(() => {
  const pp = store.proxyPerf;
  if (!pp.length) return null;
  return {
    labels: pp.map(r => formatTs(r.ts)),
    datasets: [
      {
        ...lineDataset({ label: 'Hits', data: pp.map(r => r.cache_hits || 0), color: 'ok', fill: true }),
      },
      {
        ...lineDataset({ label: 'Misses', data: pp.map(r => r.cache_misses || 0), color: 'warn', fill: true }),
      },
    ],
  };
});

const cacheOptions = makeLineOptions({ yLabel: 'lookups' });

// ── Memory Consumption ─────────────────────────────────
const memoryData = computed(() => {
  const pp = store.proxyPerf;
  if (!pp.length) return null;
  return {
    labels: pp.map(r => formatTs(r.ts)),
    datasets: [
      {
        ...lineDataset({ label: 'RSS', data: pp.map(r => r.rss_mb), color: 1, fill: true }),
      },
      {
        ...lineDataset({ label: 'Heap', data: pp.map(r => r.heap_mb), color: 2, fill: true }),
      },
    ],
  };
});

const memoryOptions = makeLineOptions({ yLabel: 'MB', tooltipCallback: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1) ?? '—'} MB` });

// ── CPU Usage ──────────────────────────────────────────
const cpuData = computed(() => {
  const pp = store.proxyPerf;
  if (!pp.length) return null;
  return {
    labels: pp.map(r => formatTs(r.ts)),
    datasets: [
      {
        ...lineDataset({ label: 'CPU %', data: pp.map(r => normalizeProcessCpuPercent(r)), color: 7, fill: true }),
      },
    ],
  };
});

const cpuOptions = makeLineOptions({ yLabel: '%', tooltipCallback: (ctx) => `CPU: ${ctx.parsed.y?.toFixed(1) ?? '—'}%` });

// ── Data fetching ──────────────────────────────────────
async function refreshAll() {
  store.loading = true;
  try {
    await Promise.all([
      store.fetchTimeseries(selectedRange.value),
      store.fetchProxyPerf(selectedRange.value),
      store.fetchSystemHealth(),
      store.fetchServices(),
    ]);
  } finally {
    store.loading = false;
  }
}

onMounted(() => {
  refreshAll();
});

useAutoRefresh(refreshAll);
</script>

<style scoped>
/* Page-specific styles only — shared styles come from analytics-layout.css */

.gauge-card {
  display: flex;
  align-items: center;
  justify-content: center;
  max-width: 280px;
}

.gauge-group {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  align-items: center;
  width: 100%;
}

.gauge-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.gauge-wrap {
  width: 140px;
  height: 80px;
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.gauge-wrap canvas {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
}

.gauge-value {
  position: relative;
  font-size: 1rem;
  font-weight: 700;
  font-family: monospace;
  color: var(--p-text-color);
  line-height: 1;
  margin-bottom: 2px;
}

.gauge-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  margin-top: 0.25rem;
}

@media (max-width: 768px) {
  .gauge-card {
    max-width: none;
  }
}
</style>
