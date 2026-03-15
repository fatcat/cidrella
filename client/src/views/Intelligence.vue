<template>
  <div class="dashboard-page">
    <!-- Stats Bar -->
    <div class="stats-bar" v-if="store.services">
      <div class="stat">
        <span class="stat-value" :class="{ 'text-danger': summary.blocklistBlocks > 0 }">
          {{ formatNumber(summary.blocklistBlocks) }}
        </span>
        <span class="stat-label">Blocklist Blocks</span>
      </div>
      <div class="stat">
        <span class="stat-value" :class="{ 'text-danger': summary.geoipBlocks > 0 }">
          {{ formatNumber(summary.geoipBlocks) }}
        </span>
        <span class="stat-label">GeoIP Blocks</span>
      </div>
    </div>

    <div class="dashboard-content">
      <!-- Time Range -->
      <div class="range-bar">
        <Select v-model="selectedRange" :options="rangeOptions" optionLabel="label" optionValue="value"
                size="small" style="width: 10rem" @change="onRangeChange" />
        <Button icon="pi pi-refresh" size="small" text rounded @click="refreshAll" :loading="store.loading" title="Refresh" />
      </div>

      <!-- Blocklist: Top 10 Blocked Domains -->
      <div class="chart-card">
        <h4>Top 10 Blocked Domains</h4>
        <div class="card-row">
          <div class="chart-card">
            <div v-if="store.blocklistTopDomains.length" class="doughnut-wrap">
              <Doughnut :data="blockedDomainsChartData" :options="doughnutWithLabelsOptions" :plugins="[ChartDataLabels]" />
            </div>
            <p v-else class="empty-chart">No data in this range.</p>
          </div>

          <div class="chart-card">
            <DataTable v-if="store.blocklistTopDomains.length" :value="store.blocklistTopDomains" size="small" style="margin: 0 10%">
              <Column field="domain" header="Domain" />
              <Column field="count" header="Count">
                <template #body="{ data }">{{ Number(data.count).toLocaleString() }}</template>
              </Column>
            </DataTable>
            <p v-else class="empty-chart">No data in this range.</p>
          </div>
        </div>
      </div>

      <!-- Blocklist: Top 10 Blocked Categories -->
      <div class="chart-card">
        <h4>Top 10 Blocked Categories</h4>
        <div class="card-row">
          <div class="chart-card">
            <div v-if="store.blocklistTopCategories.length" class="doughnut-wrap">
              <Doughnut :data="blockedCategoriesChartData" :options="doughnutWithLabelsOptions" :plugins="[ChartDataLabels]" />
            </div>
            <p v-else class="empty-chart">No data in this range.</p>
          </div>

          <div class="chart-card">
            <DataTable v-if="store.blocklistTopCategories.length" :value="store.blocklistTopCategories" size="small" style="margin: 0 10%">
              <Column field="block_reason" header="Category" />
              <Column field="count" header="Count">
                <template #body="{ data }">{{ Number(data.count).toLocaleString() }}</template>
              </Column>
            </DataTable>
            <p v-else class="empty-chart">No data in this range.</p>
          </div>
        </div>
      </div>

      <!-- GeoIP: Top 10 Blocked Hosts -->
      <div class="chart-card">
        <h4>Top 10 GeoIP Blocked Hosts</h4>
        <div class="card-row">
          <div class="chart-card">
            <div v-if="store.geoipTopClients.length" class="doughnut-wrap">
              <Doughnut :data="geoipHostsChartData" :options="doughnutWithLabelsOptions" :plugins="[ChartDataLabels]" />
            </div>
            <p v-else class="empty-chart">No data in this range.</p>
          </div>

          <div class="chart-card">
            <DataTable v-if="store.geoipTopClients.length" :value="store.geoipTopClients" size="small" style="margin: 0 10%">
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

      <!-- GeoIP: Top 10 Blocked Domains -->
      <div class="chart-card">
        <h4>Top 10 GeoIP Blocked Domains</h4>
        <div class="card-row">
          <div class="chart-card">
            <div v-if="store.geoipTopDomains.length" class="doughnut-wrap">
              <Doughnut :data="geoipDomainsChartData" :options="doughnutWithLabelsOptions" :plugins="[ChartDataLabels]" />
            </div>
            <p v-else class="empty-chart">No data in this range.</p>
          </div>

          <div class="chart-card">
            <DataTable v-if="store.geoipTopDomains.length" :value="store.geoipTopDomains" size="small" style="margin: 0 10%">
              <Column field="domain" header="Domain" />
              <Column field="count" header="Count">
                <template #body="{ data }">{{ Number(data.count).toLocaleString() }}</template>
              </Column>
            </DataTable>
            <p v-else class="empty-chart">No data in this range.</p>
          </div>
        </div>
      </div>

     <!-- Blocklist: Top 10 Blocked Hosts -->
      <div class="chart-card">
        <h4>Top 10 Blocked Hosts</h4>
        <div class="card-row">
          <div class="chart-card">
            <div v-if="store.blocklistTopClients.length" class="doughnut-wrap">
              <Doughnut :data="blockedHostsChartData" :options="doughnutWithLabelsOptions" :plugins="[ChartDataLabels]" />
            </div>
            <p v-else class="empty-chart">No data in this range.</p>
          </div>

          <div class="chart-card">
            <DataTable v-if="store.blocklistTopClients.length" :value="store.blocklistTopClients" size="small" style="margin: 0 10%">
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
  try { const v = JSON.parse(localStorage.getItem('ipam_intelligence_range')); return v || '24h'; } catch { return '24h'; }
})());

let refreshTimer = null;

const summary = computed(() => {
  const ts = store.timeseries;
  return {
    blocklistBlocks: ts.reduce((s, r) => s + (r.blocklist_blocks || 0), 0),
    geoipBlocks: ts.reduce((s, r) => s + (r.geoip_blocks || 0), 0),
  };
});

function formatNumber(n) {
  return (n || 0).toLocaleString();
}

const blockedHostsChartData = computed(() => {
  const d = store.blocklistTopClients;
  return {
    labels: d.map(r => r.hostname || r.client_ip || 'unknown'),
    datasets: [{
      data: d.map(r => Number(r.count)),
      backgroundColor: d.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
      borderWidth: 0,
    }],
  };
});

const blockedDomainsChartData = computed(() => {
  const d = store.blocklistTopDomains;
  return {
    labels: d.map(r => r.domain || 'unknown'),
    datasets: [{
      data: d.map(r => Number(r.count)),
      backgroundColor: d.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
      borderWidth: 0,
    }],
  };
});

const blockedCategoriesChartData = computed(() => {
  const d = store.blocklistTopCategories;
  return {
    labels: d.map(r => r.block_reason || 'unknown'),
    datasets: [{
      data: d.map(r => Number(r.count)),
      backgroundColor: d.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
      borderWidth: 0,
    }],
  };
});

const geoipHostsChartData = computed(() => {
  const d = store.geoipTopClients;
  return {
    labels: d.map(r => r.hostname || r.client_ip || 'unknown'),
    datasets: [{
      data: d.map(r => Number(r.count)),
      backgroundColor: d.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
      borderWidth: 0,
    }],
  };
});

const geoipDomainsChartData = computed(() => {
  const d = store.geoipTopDomains;
  return {
    labels: d.map(r => r.domain || 'unknown'),
    datasets: [{
      data: d.map(r => Number(r.count)),
      backgroundColor: d.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
      borderWidth: 0,
    }],
  };
});

const doughnutWithLabelsOptions = {
  responsive: true,
  maintainAspectRatio: false,
  cutout: '60%',
  plugins: {
    legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 8 } },
    tooltip: { enabled: true },
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
  await store.fetchAll(selectedRange.value);
}

function onRangeChange() {
  try { localStorage.setItem('ipam_intelligence_range', JSON.stringify(selectedRange.value)); } catch {}
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
