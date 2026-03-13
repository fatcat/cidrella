<template>
  <div class="dashboard-page">
    <div class="dashboard-content">
    <!-- Service Status -->
    <div class="service-status-row">
      <div class="service-item">
        <span class="status-dot" :class="services?.dnsmasq ? 'dot-up' : 'dot-down'"></span>
        <span class="service-label">dnsmasq</span>
      </div>
      <div class="service-item">
        <span class="status-dot" :class="geoipDotClass"></span>
        <span class="service-label">GeoIP Proxy</span>
      </div>
      <template v-if="services?.forwarders?.length">
        <div v-for="fwd in services.forwarders" :key="fwd.ip" class="service-item">
          <span class="status-dot" :class="fwd.reachable ? 'dot-up' : 'dot-down'"></span>
          <span class="service-label">{{ fwd.ip }}</span>
        </div>
      </template>
    </div>

    <!-- Time Range -->
    <div class="range-bar">
      <Select v-model="selectedRange" :options="rangeOptions" optionLabel="label" optionValue="value"
              size="small" style="width: 10rem" @change="onRangeChange" />
      <Button icon="pi pi-refresh" size="small" text rounded @click="refreshAll" :loading="store.loading" title="Refresh" />
    </div>

    <!-- Activity Line Chart -->
    <div class="chart-card">
      <h4>Activity</h4>
      <div v-if="lineData" class="chart-wrap" style="height: 280px">
        <Line :data="lineData" :options="lineOptions" />
      </div>
      <p v-else class="empty-chart">No data yet — metrics are collected every 60 seconds.</p>
    </div>

    <!-- Bar Charts -->
    <div class="bar-charts-row">
      <div class="chart-card half">
        <h4>Blocklist Hits by Category</h4>
        <div v-if="blocklistBarData" class="chart-wrap" style="height: 240px">
          <Bar :data="blocklistBarData" :options="barOptions" />
        </div>
        <p v-else class="empty-chart">No blocklist hits in this range.</p>
      </div>
      <div class="chart-card half">
        <h4>GeoIP Hits by Country</h4>
        <div v-if="geoipBarData" class="chart-wrap" style="height: 240px">
          <Bar :data="geoipBarData" :options="barOptions" />
        </div>
        <p v-else class="empty-chart">No GeoIP hits in this range.</p>
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
  BarElement, Title, Tooltip, Legend, Filler
} from 'chart.js';
import { Line, Bar } from 'vue-chartjs';
import { useDashboardStore } from '../stores/dashboard.js';

ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement,
  BarElement, Title, Tooltip, Legend, Filler
);

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
  try { const v = JSON.parse(localStorage.getItem('ipam_dashboard_range')); return v || '24h'; } catch { return '24h'; }
})());


let refreshTimer = null;

const services = computed(() => store.services);

const geoipDotClass = computed(() => {
  if (!services.value) return 'dot-unknown';
  return services.value.geoip_proxy ? 'dot-up' : 'dot-down';
});

function formatTs(epoch) {
  return formatEpoch(epoch, selectedRange.value);
}

const lineData = computed(() => {
  const ts = store.timeseries;
  if (!ts.length) return null;
  return {
    labels: ts.map(r => formatTs(r.ts)),
    datasets: [
      {
        label: 'DNS Queries',
        data: ts.map(r => r.dns_queries),
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
      },
      {
        label: 'DHCP Requests',
        data: ts.map(r => r.dhcp_requests),
        borderColor: '#10b981',
        backgroundColor: 'rgba(16,185,129,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
      },
      {
        label: 'Blocklist Blocks',
        data: ts.map(r => r.blocklist_blocks),
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245,158,11,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
      },
      {
        label: 'GeoIP Blocks',
        data: ts.map(r => r.geoip_blocks),
        borderColor: '#ef4444',
        backgroundColor: 'rgba(239,68,68,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
      },
    ],
  };
});

const lineOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
    tooltip: { mode: 'index', intersect: false },
  },
  scales: {
    x: {
      ticks: { maxTicksLimit: 12, maxRotation: 0 },
      grid: { display: false },
    },
    y: {
      beginAtZero: true,
      ticks: { precision: 0 },
    },
  },
};

const CHART_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

const blocklistBarData = computed(() => {
  const hits = store.blocklistHits;
  if (!hits.length) return null;
  return {
    labels: hits.map(r => r.category),
    datasets: [{
      label: 'Hits',
      data: hits.map(r => r.count),
      backgroundColor: hits.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
    }],
  };
});

const geoipBarData = computed(() => {
  const hits = store.geoipHits;
  if (!hits.length) return null;
  return {
    labels: hits.map(r => r.country),
    datasets: [{
      label: 'Hits',
      data: hits.map(r => r.count),
      backgroundColor: hits.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
    }],
  };
});

const barOptions = {
  responsive: true,
  maintainAspectRatio: false,
  indexAxis: 'y',
  plugins: {
    legend: { display: false },
  },
  scales: {
    x: { beginAtZero: true, ticks: { precision: 0 } },
    y: { grid: { display: false } },
  },
};

async function refreshAll() {
  await store.fetchAll(selectedRange.value);
}

function onRangeChange() {
  try { localStorage.setItem('ipam_dashboard_range', JSON.stringify(selectedRange.value)); } catch {}
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
  height: 100%;
  overflow-y: auto;
  padding: 1rem 7%;
}

.dashboard-content {
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.service-status-row {
  display: flex;
  gap: 1.5rem;
  align-items: center;
  flex-wrap: wrap;
}

.service-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.service-label {
  font-size: 0.85rem;
  font-weight: 500;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot-up { background: var(--p-green-500); }
.dot-down { background: var(--p-red-500); }
.dot-unknown { background: var(--p-surface-400); }

.range-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
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

.bar-charts-row {
  display: flex;
  gap: 1rem;
}
.bar-charts-row .half {
  flex: 1;
  min-width: 0;
}

.empty-chart {
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
  text-align: center;
  padding: 2rem 0;
}

@media (max-width: 768px) {
  .bar-charts-row {
    flex-direction: column;
  }
}
</style>
