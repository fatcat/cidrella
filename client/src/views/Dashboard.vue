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
      <div class="summary-card summary-card-link" @click="goToTab('networks')">
        <span class="summary-value">{{ systemStats.subnets }}</span>
        <span class="summary-label">Networks</span>
      </div>
      <div class="summary-card summary-card-link" @click="goToTab('dns')">
        <span class="summary-value">{{ systemStats.dns_zones }}</span>
        <span class="summary-label">DNS Zones</span>
      </div>
      <div class="summary-card summary-card-link" @click="goToTab('dhcp')">
        <span class="summary-value">{{ systemStats.dhcp_scopes }}</span>
        <span class="summary-label">DHCP Scopes</span>
      </div>
      <div class="summary-card summary-card-link" @click="goToTab('dhcp')">
        <span class="summary-value">{{ systemStats.dhcp_leases }}</span>
        <span class="summary-label">Leases</span>
      </div>
    </div>

    <div class="dashboard-content">
      <!-- Time Range -->
      <div class="range-bar">
        <Select v-model="selectedRange" :options="rangeOptions" optionLabel="label" optionValue="value" size="small"
          style="width: 10rem" @change="refreshAll" />
        <Button icon="pi pi-refresh" size="small" text rounded @click="refreshAll" :loading="store.loading"
          title="Refresh" />
      </div>

      <DoughnutTableCard title="DNS Queries by Host" :items="store.topClients" :chartData="hostChartData" labelHeader="Host">
        <template #label="{ data }">{{ data.hostname || data.client_ip }}</template>
      </DoughnutTableCard>

      <DoughnutTableCard title="Top 10 Domains Queried" :items="store.topDomains" :chartData="domainChartData"
                         labelField="domain" labelHeader="Domain" />

    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { saveJson } from '../utils/storage.js';
import { useRouter } from 'vue-router';
import Select from '../ui/Select.js';
import Button from '../ui/Button.js';
import {
  Chart as ChartJS, ArcElement, Tooltip, Legend,
} from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { useDashboardStore } from '../stores/dashboard.js';
import { RANGE_OPTIONS, makeDoughnutData } from '../utils/chart-config.js';
import { formatNumber, EMPTY_CELL } from '../utils/format.js';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import DoughnutTableCard from '../components/DoughnutTableCard.vue';
import '../assets/analytics-layout.css';
import api from '../api/client.js';

ChartJS.register(ArcElement, Tooltip, Legend, ChartDataLabels);

const store = useDashboardStore();
const router = useRouter();
const rangeOptions = RANGE_OPTIONS;
const selectedRange = computed({ get: () => store.selectedRange, set: (v) => store.setRange(v) });

const systemStats = ref({ subnets: EMPTY_CELL, dns_zones: EMPTY_CELL, dhcp_scopes: EMPTY_CELL, dhcp_leases: EMPTY_CELL });

async function fetchSystemStats() {
  try {
    const res = await api.get('/health/system');
    const s = res.data?.stats || {};
    systemStats.value = {
      subnets: s.subnets ?? EMPTY_CELL,
      dns_zones: s.dns_zones ?? EMPTY_CELL,
      dhcp_scopes: s.dhcp_scopes ?? EMPTY_CELL,
      dhcp_leases: s.dhcp_leases ?? EMPTY_CELL,
    };
  } catch { /* ignore */ }
}

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

function goToTab(tab) {
  saveJson('cidrella_b_active_tab', tab);
  router.push('/networks');
}

const hostChartData = computed(() => makeDoughnutData(store.topClients, r => r.hostname || r.client_ip || 'unknown'));

const domainChartData = computed(() => makeDoughnutData(store.topDomains, r => r.domain || 'unknown'));

async function refreshAll() {
  await Promise.all([
    store.fetchAll(selectedRange.value),
    fetchSystemStats(),
  ]);
}

onMounted(() => {
  refreshAll();
});

useAutoRefresh(refreshAll);
</script>

<style scoped>
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
  font-size: var(--app-fs-3xl);
  font-weight: 700;
  font-family: monospace;
  color: var(--p-primary-color);
}

.summary-label {
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-top: 0.25rem;
}

.summary-card-link {
  cursor: pointer;
  transition: border-color 0.2s, transform 0.15s;
}

.summary-card-link:hover {
  border-color: var(--p-primary-color);
  transform: translateY(-2px);
}
</style>
