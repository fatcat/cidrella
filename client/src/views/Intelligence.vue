<template>
  <div class="analytics-tab">
    <!-- Stats Bar -->
    <div class="stats-bar" v-if="store.services">
      <div class="stat">
        <span class="stat-value">
          <span :class="store.services.dnsmasq ? 'indicator-on' : 'indicator-off'"></span>
          {{ store.services.dnsmasq ? 'Running' : 'Stopped' }}
        </span>
        <span class="stat-label">DNSMASQ</span>
      </div>
      <div class="stat">
        <span class="stat-value">
          <span :class="store.services.geoip_proxy ? 'indicator-on' : 'indicator-off'"></span>
          {{ store.services.geoip_bypassed ? 'Bypassed' : store.services.geoip_proxy ? 'Running' : 'Stopped' }}
        </span>
        <span class="stat-label">DNS Proxy</span>
      </div>
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
import { computed, onMounted, onUnmounted } from 'vue';
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
import { CHART_COLORS, RANGE_OPTIONS, DOUGHNUT_OPTIONS } from '../utils/chart-config.js';
import '../assets/analytics-layout.css';

ChartJS.register(ArcElement, Tooltip, Legend);

const store = useDashboardStore();
const rangeOptions = RANGE_OPTIONS;
const selectedRange = computed({ get: () => store.selectedRange, set: (v) => store.setRange(v) });

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

const doughnutWithLabelsOptions = DOUGHNUT_OPTIONS;

async function refreshAll() {
  await store.fetchAll(selectedRange.value);
}

function onRangeChange() {
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
/* Page-specific styles only — shared styles come from analytics-layout.css */
</style>
