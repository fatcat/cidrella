<template>
  <div class="dashboard-page">
    <!-- Stats Bar -->
    <div class="stats-bar" v-if="services">
      <div class="stat">
        <span class="stat-value">{{ proxyStats?.queriesPerMin ?? '—' }}</span>
        <span class="stat-label">Queries / min</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ proxyStats ? proxyStats.cacheHitRate + '%' : '—' }}</span>
        <span class="stat-label">Cache Hit Rate</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ proxyStats ? proxyStats.avgLatency + ' µs' : '—' }}</span>
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
                size="small" style="width: 10rem" @change="onRangeChange" />
        <Button icon="pi pi-refresh" size="small" text rounded @click="refreshAll" :loading="store.loading" title="Refresh" />
      </div>

      <!-- DNS Requests Over Time -->
      <div class="chart-card">
        <h4>DNS Requests Over Time</h4>
        <div class="card-row">
          <div class="chart-card">
            <div v-if="dnsRequestsData" class="chart-wrap" style="height: 240px">
              <Line :data="dnsRequestsData" :options="dnsRequestsOptions" />
            </div>
            <p v-else class="empty-chart">No data in this range.</p>
          </div>
        </div>
      </div>

      <!-- Proxy Query Latency -->
      <div class="chart-card">
        <h4>Proxy Query Latency</h4>
        <div class="card-row">
          <div class="chart-card">
            <div v-if="latencyData" class="chart-wrap" style="height: 240px">
              <Line :data="latencyData" :options="latencyOptions" />
            </div>
            <p v-else class="empty-chart">No proxy latency data in this range.</p>
          </div>
        </div>
      </div>

      <!-- Query Throughput -->
      <div class="chart-card">
        <h4>Query Throughput</h4>
        <div class="card-row">
          <div class="chart-card">
            <div v-if="throughputData" class="chart-wrap" style="height: 240px">
              <Line :data="throughputData" :options="throughputOptions" />
            </div>
            <p v-else class="empty-chart">No query throughput data in this range.</p>
          </div>
        </div>
      </div>

      <!-- Process Resources -->
      <div class="chart-card">
        <h4>Process Resources</h4>
        <div class="card-row">
          <div class="chart-card gauge-card">
            <div class="gauge-group">
              <div class="gauge-item">
                <div class="gauge-wrap">
                  <Doughnut :data="cpuGaugeData" :options="gaugeOptions" :plugins="[gaugeCenterText]" />
                  <span class="gauge-value">{{ latestPerf?.cpu_percent?.toFixed(1) ?? '0' }}%</span>
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

      <!-- Cache Performance -->
      <div class="chart-card">
        <h4>Cache Performance</h4>
        <div class="card-row">
          <div class="chart-card">
            <div v-if="cacheData" class="chart-wrap" style="height: 240px">
              <Line :data="cacheData" :options="cacheOptions" />
            </div>
            <p v-else class="empty-chart">No cache data in this range.</p>
          </div>
        </div>
      </div>

      <!-- Memory Consumption -->
      <div class="chart-card">
        <h4>Memory Consumption</h4>
        <div class="card-row">
          <div class="chart-card">
            <div v-if="memoryData" class="chart-wrap" style="height: 240px">
              <Line :data="memoryData" :options="memoryOptions" />
            </div>
            <p v-else class="empty-chart">No memory data in this range.</p>
          </div>
        </div>
      </div>

      <!-- CPU Usage -->
      <div class="chart-card">
        <h4>CPU Usage</h4>
        <div class="card-row">
          <div class="chart-card">
            <div v-if="cpuData" class="chart-wrap" style="height: 240px">
              <Line :data="cpuData" :options="cpuOptions" />
            </div>
            <p v-else class="empty-chart">No CPU data in this range.</p>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
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

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  ArcElement, Title, Tooltip, Legend, Filler
);
ChartJS.defaults.elements.line.borderWidth = 1;

const store = useDashboardStore();

const rangeOptions = [
  { label: 'Last 1 hour', value: '1h' },
  { label: 'Last 4 hours', value: '4h' },
  { label: 'Last 12 hours', value: '12h' },
  { label: 'Last 24 hours', value: '24h' },
  { label: 'Last 2 days', value: '2d' },
  { label: 'Last 1 week', value: '1w' },
];
const selectedRange = ref((() => {
  try { const v = JSON.parse(localStorage.getItem('ipam_perf_range')); return v || '24h'; } catch { return '24h'; }
})());

let refreshTimer = null;

const services = computed(() => store.services);

function formatTs(epoch) {
  return formatEpoch(epoch, selectedRange.value);
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
        label: 'DNS Queries',
        data: ts.map(r => r.dns_queries),
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.15)',
        fill: true, tension: 0.3, pointRadius: 0,
      },
      {
        label: 'DHCP Requests',
        data: ts.map(r => r.dhcp_requests),
        borderColor: '#10b981',
        backgroundColor: 'rgba(16,185,129,0.1)',
        fill: true, tension: 0.3, pointRadius: 0,
      },
    ],
  };
});

const dnsRequestsOptions = {
  responsive: true, maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
    tooltip: { mode: 'index', intersect: false },
  },
  scales: {
    x: { ticks: { maxTicksLimit: 12, maxRotation: 0 }, grid: { display: false } },
    y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'count' } },
  },
};

// ── Proxy Query Latency ────────────────────────────────
const latencyData = computed(() => {
  const pp = store.proxyPerf;
  if (!pp.length) return null;
  return {
    labels: pp.map(r => formatTs(r.ts)),
    datasets: [
      {
        label: 'Avg',
        data: pp.map(r => r.latency_avg),
        borderColor: '#3b82f6', fill: false, tension: 0.3, pointRadius: 0,
      },
      {
        label: 'P95',
        data: pp.map(r => r.latency_p95),
        borderColor: '#f59e0b', fill: false, tension: 0.3, pointRadius: 0,
      },
      {
        label: 'Max',
        data: pp.map(r => r.latency_max),
        borderColor: '#ef4444', borderDash: [4, 4],
        fill: false, tension: 0.3, pointRadius: 0,
      },
    ],
  };
});

const latencyOptions = {
  responsive: true, maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
    tooltip: { mode: 'index', intersect: false,
      callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y?.toLocaleString() ?? '—'} µs` }
    },
  },
  scales: {
    x: { ticks: { maxTicksLimit: 12, maxRotation: 0 }, grid: { display: false } },
    y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'µs' } },
  },
};

// ── Query Throughput ───────────────────────────────────
const throughputData = computed(() => {
  const pp = store.proxyPerf;
  if (!pp.length) return null;
  return {
    labels: pp.map(r => formatTs(r.ts)),
    datasets: [
      {
        label: 'Queries / min',
        data: pp.map(r => r.query_count || 0),
        borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.15)',
        fill: true, tension: 0.3, pointRadius: 0,
      },
      {
        label: 'Timeouts',
        data: pp.map(r => r.timeouts || 0),
        borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)',
        fill: true, tension: 0.3, pointRadius: 0,
      },
    ],
  };
});

const throughputOptions = {
  responsive: true, maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
    tooltip: { mode: 'index', intersect: false },
  },
  scales: {
    x: { ticks: { maxTicksLimit: 12, maxRotation: 0 }, grid: { display: false } },
    y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'count' } },
  },
};

// ── Process Resources (combined line chart) ────────────
const resourceData = computed(() => {
  const pp = store.proxyPerf;
  if (!pp.length) return null;
  return {
    labels: pp.map(r => formatTs(r.ts)),
    datasets: [
      {
        label: 'RSS (MB)',
        data: pp.map(r => r.rss_mb),
        borderColor: '#3b82f6', fill: false, tension: 0.3, pointRadius: 0, yAxisID: 'y',
      },
      {
        label: 'Heap (MB)',
        data: pp.map(r => r.heap_mb),
        borderColor: '#10b981', fill: false, tension: 0.3, pointRadius: 0, yAxisID: 'y',
      },
      {
        label: 'CPU %',
        data: pp.map(r => r.cpu_percent),
        borderColor: '#f59e0b', fill: false, tension: 0.3, pointRadius: 0, yAxisID: 'y1',
      },
    ],
  };
});

const resourceOptions = {
  responsive: true, maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
    tooltip: { mode: 'index', intersect: false },
  },
  scales: {
    x: { ticks: { maxTicksLimit: 12, maxRotation: 0 }, grid: { display: false } },
    y: { position: 'left', beginAtZero: true, title: { display: true, text: 'MB' } },
    y1: { position: 'right', beginAtZero: true, title: { display: true, text: 'CPU %' }, grid: { drawOnChartArea: false } },
  },
};

// ── Gauges (current CPU & Memory) ──────────────────────
const latestPerf = computed(() => {
  const pp = store.proxyPerf;
  return pp.length ? pp[pp.length - 1] : null;
});

const cpuGaugeData = computed(() => {
  const val = latestPerf.value?.cpu_percent ?? 0;
  const clamped = Math.min(100, Math.max(0, val));
  return {
    labels: ['CPU', ''],
    datasets: [{
      data: [clamped, 100 - clamped],
      backgroundColor: [clamped > 80 ? '#ef4444' : clamped > 50 ? '#f59e0b' : '#10b981', 'rgba(255,255,255,0.08)'],
      borderWidth: 0,
    }],
  };
});

const memGaugeData = computed(() => {
  const rss = latestPerf.value?.rss_mb ?? 0;
  const cap = 512; // scale reference
  const pct = Math.min(100, (rss / cap) * 100);
  return {
    labels: ['Memory', ''],
    datasets: [{
      data: [pct, 100 - pct],
      backgroundColor: [pct > 80 ? '#ef4444' : pct > 50 ? '#f59e0b' : '#3b82f6', 'rgba(255,255,255,0.08)'],
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
        label: 'Hits',
        data: pp.map(r => r.cache_hits || 0),
        borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.15)',
        fill: true, tension: 0.3, pointRadius: 0,
      },
      {
        label: 'Misses',
        data: pp.map(r => r.cache_misses || 0),
        borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.15)',
        fill: true, tension: 0.3, pointRadius: 0,
      },
    ],
  };
});

const cacheOptions = {
  responsive: true, maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
    tooltip: { mode: 'index', intersect: false },
  },
  scales: {
    x: { ticks: { maxTicksLimit: 12, maxRotation: 0 }, grid: { display: false } },
    y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'lookups' } },
  },
};

// ── Memory Consumption ─────────────────────────────────
const memoryData = computed(() => {
  const pp = store.proxyPerf;
  if (!pp.length) return null;
  return {
    labels: pp.map(r => formatTs(r.ts)),
    datasets: [
      {
        label: 'RSS',
        data: pp.map(r => r.rss_mb),
        borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.15)',
        fill: true, tension: 0.3, pointRadius: 0,
      },
      {
        label: 'Heap',
        data: pp.map(r => r.heap_mb),
        borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.15)',
        fill: true, tension: 0.3, pointRadius: 0,
      },
    ],
  };
});

const memoryOptions = {
  responsive: true, maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
    tooltip: { mode: 'index', intersect: false,
      callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1) ?? '—'} MB` }
    },
  },
  scales: {
    x: { ticks: { maxTicksLimit: 12, maxRotation: 0 }, grid: { display: false } },
    y: { beginAtZero: true, title: { display: true, text: 'MB' } },
  },
};

// ── CPU Usage ──────────────────────────────────────────
const cpuData = computed(() => {
  const pp = store.proxyPerf;
  if (!pp.length) return null;
  return {
    labels: pp.map(r => formatTs(r.ts)),
    datasets: [
      {
        label: 'CPU %',
        data: pp.map(r => r.cpu_percent),
        borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.15)',
        fill: true, tension: 0.3, pointRadius: 0,
      },
    ],
  };
});

const cpuOptions = {
  responsive: true, maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
    tooltip: { mode: 'index', intersect: false,
      callbacks: { label: (ctx) => `CPU: ${ctx.parsed.y?.toFixed(1) ?? '—'}%` }
    },
  },
  scales: {
    x: { ticks: { maxTicksLimit: 12, maxRotation: 0 }, grid: { display: false } },
    y: { beginAtZero: true, title: { display: true, text: '%' } },
  },
};

// ── Data fetching ──────────────────────────────────────
async function refreshAll() {
  store.loading = true;
  try {
    await Promise.all([
      store.fetchTimeseries(selectedRange.value),
      store.fetchProxyPerf(selectedRange.value),
      store.fetchServices(),
    ]);
  } finally {
    store.loading = false;
  }
}

function onRangeChange() {
  try { localStorage.setItem('ipam_perf_range', JSON.stringify(selectedRange.value)); } catch {}
  refreshAll();
}

onMounted(() => {
  refreshAll();
  refreshTimer = setInterval(refreshAll, 60_000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<style scoped>
.dashboard-page {
  padding: 1rem 7%;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.stats-bar {
  display: flex;
  gap: 2rem;
  padding: 1rem 1.25rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  flex-wrap: wrap;
}
.stat { display: flex; flex-direction: column; }
.stat-value { font-size: 1.25rem; font-weight: 700; font-family: monospace; display: flex; align-items: center; gap: 0.4rem; }
.stat-label { font-size: 0.75rem; color: var(--p-text-muted-color); text-transform: uppercase; }
.text-danger { color: var(--p-red-500); }

.dashboard-content {
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.range-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.card-row {
  display: flex;
  gap: 1rem;
}

.card-row .chart-card {
  flex: 1;
  min-width: 0;
}

.chart-card {
  background: var(--p-surface-ground);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  padding: 1rem;
}

.chart-wrap {
  position: relative;
}

.chart-card h4 {
  margin: 0 0 0.75rem;
  font-size: 0.9rem;
}

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

.empty-chart {
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
  text-align: center;
  padding: 2rem 0;
}

@media (max-width: 768px) {
  .card-row {
    flex-direction: column;
  }
  .gauge-card {
    max-width: none;
  }
}
</style>
