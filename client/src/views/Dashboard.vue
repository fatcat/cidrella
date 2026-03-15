<template>
  <div class="dashboard-page">
    <!-- Stats Bar -->
    <div class="stats-bar" v-if="services">
      <div class="stat">
        <span class="stat-value">
          <span :class="services.dnsmasq ? 'indicator-on' : 'indicator-off'"></span>
          {{ services.dnsmasq ? 'Running' : 'Stopped' }}
        </span>
        <span class="stat-label">DNS Server</span>
      </div>
      <div class="stat">
        <span class="stat-value">
          <span :class="services.geoip_proxy ? 'indicator-on' : 'indicator-off'"></span>
          {{ services.geoip_bypassed ? 'Bypassed' : services.geoip_proxy ? 'Running' : 'Stopped' }}
        </span>
        <span class="stat-label">DNS Proxy</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ formatNumber(summary.dnsQueries) }}</span>
        <span class="stat-label">DNS Queries</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ formatNumber(summary.dhcpRequests) }}</span>
        <span class="stat-label">DHCP Requests</span>
      </div>
    </div>

    <!-- Summary Cards -->
    <div class="summary-row">
      <div class="summary-card">
        <span class="summary-value">{{ systemStats.subnets }}</span>
        <span class="summary-label">Networks</span>
      </div>
      <div class="summary-card">
        <span class="summary-value">{{ systemStats.dns_zones }}</span>
        <span class="summary-label">DNS Zones</span>
      </div>
      <div class="summary-card">
        <span class="summary-value">{{ systemStats.dhcp_scopes }}</span>
        <span class="summary-label">DHCP Scopes</span>
      </div>
      <div class="summary-card">
        <span class="summary-value">{{ systemStats.dhcp_leases }}</span>
        <span class="summary-label">Leases</span>
      </div>
    </div>

    <div class="dashboard-content">
      <!-- Time Range -->
      <div class="range-bar">
        <Select v-model="selectedRange" :options="rangeOptions" optionLabel="label" optionValue="value" size="small"
          style="width: 10rem" @change="onRangeChange" />
        <Button icon="pi pi-refresh" size="small" text rounded @click="refreshAll" :loading="store.loading"
          title="Refresh" />
      </div>

      <div class="chart-card">
        <h4>DNS Queries by Host</h4>
        <div class="card-row">
          <div class="chart-card">
            <div v-if="store.topClients.length" class="doughnut-wrap">
              <Doughnut :data="hostChartData" :options="doughnutWithLabelsOptions" :plugins="[ChartDataLabels]" />
            </div>
            <p v-else class="empty-chart">No data in this range.</p>
          </div>

          <div class="chart-card">
            <DataTable v-if="store.topClients.length" :value="store.topClients" size="small" style="margin: 0 10%">
              <Column header="Host">
                <template #body="{ data }">{{ data.hostname || data.client_ip }}</template>
              </Column>
              <Column field="count" header="Count">
                <template #body="{ data }">{{ Number(data.count).toLocaleString() }}</template>
              </Column>
            </DataTable>
            <p v-else class="empty-chart">No data in this range.</p>
          </div>
        </div>

      </div>

      <div class="chart-card">
        <h4>Top 10 Domains Queried</h4>
        <div class="card-row">
          <div class="chart-card">
            <div v-if="store.topDomains.length" class="doughnut-wrap">
              <Doughnut :data="domainChartData" :options="doughnutWithLabelsOptions" :plugins="[ChartDataLabels]" />
            </div>
            <p v-else class="empty-chart">No data in this range.</p>
          </div>

          <div class="chart-card">
            <DataTable v-if="store.topDomains.length" :value="store.topDomains" size="small" style="margin: 0 10%">
              <Column field="domain" header="Domain" />
              <Column field="count" header="Count">
                <template #body="{ data }">{{ Number(data.count).toLocaleString() }}</template>
              </Column>
            </DataTable>
            <p v-else class="empty-chart">No data in this range.</p>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import Select from 'primevue/select';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import {
  Chart as ChartJS, ArcElement, Tooltip, Legend,
} from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { Doughnut } from 'vue-chartjs';
import { useDashboardStore } from '../stores/dashboard.js';
import api from '../api/client.js';

ChartJS.register(ArcElement, Tooltip, Legend);

const CHART_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

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

const systemStats = ref({ subnets: '--', dns_zones: '--', dhcp_scopes: '--', dhcp_leases: '--' });

async function fetchSystemStats() {
  try {
    const res = await api.get('/health/system');
    const s = res.data?.stats || {};
    systemStats.value = {
      subnets: s.subnets ?? '--',
      dns_zones: s.dns_zones ?? '--',
      dhcp_scopes: s.dhcp_scopes ?? '--',
      dhcp_leases: s.dhcp_leases ?? '--',
    };
  } catch { /* ignore */ }
}

let refreshTimer = null;

const services = computed(() => store.services);

const summary = computed(() => {
  const ts = store.timeseries;
  return {
    dnsQueries: ts.reduce((s, r) => s + (r.dns_queries || 0), 0),
    dhcpRequests: ts.reduce((s, r) => s + (r.dhcp_requests || 0), 0),
    blocklistBlocks: ts.reduce((s, r) => s + (r.blocklist_blocks || 0), 0),
    geoipBlocks: ts.reduce((s, r) => s + (r.geoip_blocks || 0), 0),
  };
});

function formatNumber(n) {
  return (n || 0).toLocaleString();
}

const hostChartData = computed(() => {
  const d = store.topClients;
  return {
    labels: d.map(r => r.hostname || r.client_ip || 'unknown'),
    datasets: [{
      data: d.map(r => Number(r.count)),
      backgroundColor: d.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
      borderWidth: 0,
    }],
  };
});

const domainChartData = computed(() => {
  const d = store.topDomains;
  return {
    labels: d.map(r => r.domain || 'unknown'),
    datasets: [{
      data: d.map(r => Number(r.count)),
      backgroundColor: d.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
      borderWidth: 0,
    }],
  };
});

const doughnutOptions = {
  responsive: true,
  maintainAspectRatio: false,
  cutout: '60%',
  plugins: {
    legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 8 } },
    tooltip: { enabled: true },
  },
};

const doughnutWithLabelsOptions = {
  ...doughnutOptions,
  plugins: {
    ...doughnutOptions.plugins,
    datalabels: {
      color: '#fff',
      font: { weight: 'bold', size: 11 },
      formatter: (value, ctx) => {
        const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
        const pct = ((value / total) * 100).toFixed(1);
        return pct >= 5 ? `${pct}%` : '';
      },
    },
  },
};

async function refreshAll() {
  await Promise.all([
    store.fetchAll(selectedRange.value),
    fetchSystemStats(),
  ]);
}

function onRangeChange() {
  try { localStorage.setItem('ipam_dashboard_range', JSON.stringify(selectedRange.value)); } catch { }
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

.summary-row {
  display: flex;
  gap: 1rem;
}

.summary-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 1rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
}

.summary-value {
  font-size: 1.75rem;
  font-weight: 700;
  font-family: monospace;
  color: var(--p-primary-color);
}

.summary-label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  margin-top: 0.25rem;
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

.stat {
  display: flex;
  flex-direction: column;
}

.stat-value {
  font-size: 1.25rem;
  font-weight: 700;
  font-family: monospace;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.stat-label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
}

.indicator-on {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--p-green-500);
  display: inline-block;
}

.indicator-off {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--p-red-500);
  display: inline-block;
}

.text-danger {
  color: var(--p-red-500);
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

.chart-card h4 {
  margin: 0 0 0.75rem;
  font-size: 0.9rem;
}

.doughnut-wrap {
  position: relative;
  aspect-ratio: 2 / 1;
}

.empty-chart {
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
  text-align: center;
  padding: 2rem 0;
}
</style>
