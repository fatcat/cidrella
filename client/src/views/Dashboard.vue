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
import { useRouter } from 'vue-router';
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
import api from '../api/client.js';

ChartJS.register(ArcElement, Tooltip, Legend);

const store = useDashboardStore();
const router = useRouter();
const rangeOptions = RANGE_OPTIONS;
const selectedRange = computed({ get: () => store.selectedRange, set: (v) => store.setRange(v) });

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

function goToTab(tab) {
  localStorage.setItem('ipam_b_active_tab', JSON.stringify(tab));
  router.push('/networks');
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

const doughnutWithLabelsOptions = DOUGHNUT_OPTIONS;

async function refreshAll() {
  await Promise.all([
    store.fetchAll(selectedRange.value),
    fetchSystemStats(),
  ]);
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

.summary-card-link {
  cursor: pointer;
  transition: border-color 0.2s, transform 0.15s;
}

.summary-card-link:hover {
  border-color: var(--p-primary-color);
  transform: translateY(-2px);
}
</style>
