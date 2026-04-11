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
                size="small" style="width: 10rem" @change="refreshAll" />
        <Button icon="pi pi-refresh" size="small" text rounded @click="refreshAll" :loading="store.loading" title="Refresh" />
      </div>

      <DoughnutTableCard title="Top 10 Blocked Domains" :items="store.blocklistTopDomains"
                         :chartData="blockedDomainsChartData" labelField="domain" labelHeader="Domain" />

      <DoughnutTableCard title="Top 10 Blocked Categories" :items="store.blocklistTopCategories"
                         :chartData="blockedCategoriesChartData" labelField="block_reason" labelHeader="Category" />

      <DoughnutTableCard title="Top 10 GeoIP Blocked Hosts" :items="store.geoipTopClients"
                         :chartData="geoipHostsChartData" labelHeader="Host">
        <template #label="{ data }">{{ data.hostname || data.client_ip }}</template>
      </DoughnutTableCard>

      <DoughnutTableCard title="Top 10 GeoIP Blocked Domains" :items="store.geoipTopDomains"
                         :chartData="geoipDomainsChartData" labelField="domain" labelHeader="Domain" />

      <DoughnutTableCard title="Top 10 Blocked Hosts" :items="store.blocklistTopClients"
                         :chartData="blockedHostsChartData" labelHeader="Host">
        <template #label="{ data }">{{ data.hostname || data.client_ip }}</template>
      </DoughnutTableCard>

    </div>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import Select from 'primevue/select';
import Button from 'primevue/button';
import {
  Chart as ChartJS, ArcElement, Tooltip, Legend,
} from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { useDashboardStore } from '../stores/dashboard.js';
import { RANGE_OPTIONS, makeDoughnutData } from '../utils/chart-config.js';
import { formatNumber } from '../utils/format.js';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import DoughnutTableCard from '../components/DoughnutTableCard.vue';
import '../assets/analytics-layout.css';

ChartJS.register(ArcElement, Tooltip, Legend, ChartDataLabels);

const store = useDashboardStore();
const rangeOptions = RANGE_OPTIONS;
const selectedRange = computed({ get: () => store.selectedRange, set: (v) => store.setRange(v) });

const summary = computed(() => {
  const ts = store.timeseries;
  return {
    blocklistBlocks: ts.reduce((s, r) => s + (r.blocklist_blocks || 0), 0),
    geoipBlocks: ts.reduce((s, r) => s + (r.geoip_blocks || 0), 0),
  };
});

const blockedHostsChartData = computed(() => makeDoughnutData(store.blocklistTopClients, r => r.hostname || r.client_ip || 'unknown'));

const blockedDomainsChartData = computed(() => makeDoughnutData(store.blocklistTopDomains, r => r.domain || 'unknown'));

const blockedCategoriesChartData = computed(() => makeDoughnutData(store.blocklistTopCategories, r => r.block_reason || 'unknown'));

const geoipHostsChartData = computed(() => makeDoughnutData(store.geoipTopClients, r => r.hostname || r.client_ip || 'unknown'));

const geoipDomainsChartData = computed(() => makeDoughnutData(store.geoipTopDomains, r => r.domain || 'unknown'));

async function refreshAll() {
  await store.fetchAll(selectedRange.value);
}

onMounted(() => {
  refreshAll();
});

useAutoRefresh(refreshAll);
</script>

<style scoped>
/* Page-specific styles only — shared styles come from analytics-layout.css */
</style>
