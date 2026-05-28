<template>
  <div class="analytics-tab">
    <div class="page-header">
      <h1>Anomaly Detection</h1>
      <div class="header-actions">
        <Select v-model="severityFilter" :options="severityOptions" optionLabel="label"
                optionValue="value" placeholder="All Severities" data-track="anomalies-severity-filter"
                class="severity-select" @change="refreshActive" />
        <Button icon="pi pi-refresh" severity="secondary" text rounded size="small"
                data-track="anomalies-refresh" @click="refreshAll" :loading="store.loading" />
      </div>
    </div>

    <!-- Stats Bar -->
    <div class="stats-bar" v-if="store.summary">
      <div class="stat">
        <span class="stat-value">
          <span :class="store.summary.enabled ? 'indicator-on' : 'indicator-off'"></span>
          {{ store.summary.enabled ? 'Enabled' : 'Disabled' }}
        </span>
        <span class="stat-label">Status</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ store.summary.clients_monitored }}</span>
        <span class="stat-label">Clients Monitored</span>
      </div>
      <div class="stat">
        <span class="stat-value">{{ store.summary.clients_learning }}</span>
        <span class="stat-label">Clients Learning</span>
      </div>
      <div class="stat">
        <span class="stat-value" :class="{ 'text-danger': store.summary.total_active > 0 }">
          {{ store.summary.total_active }}
        </span>
        <span class="stat-label">Active Anomalies</span>
      </div>
      <div class="stat" v-if="store.summary.by_severity?.high">
        <span class="stat-value text-danger">{{ store.summary.by_severity.high }}</span>
        <span class="stat-label">High Severity</span>
      </div>
      <div class="stat" v-if="store.summary.by_severity?.medium">
        <span class="stat-value text-warning">{{ store.summary.by_severity.medium }}</span>
        <span class="stat-label">Medium Severity</span>
      </div>
      <div class="stat" v-if="store.summary.daemon?.last_score">
        <span class="stat-value">{{ timeAgo(store.summary.daemon.last_score) }}</span>
        <span class="stat-label">Last Scored</span>
      </div>
      <div class="stat" v-if="store.summary.daemon?.last_train">
        <span class="stat-value">{{ timeAgo(store.summary.daemon.last_train) }}</span>
        <span class="stat-label">Last Trained</span>
      </div>
      <div class="stat" v-if="store.summary.daemon?.score_duration_sec != null">
        <span class="stat-value" :class="{ 'text-danger': store.summary.daemon.score_overrun }">
          {{ store.summary.daemon.score_duration_sec }}s
        </span>
        <span class="stat-label">Score Cycle</span>
      </div>
      <div class="stat" v-if="store.summary.daemon?.train_duration_sec != null">
        <span class="stat-value">{{ store.summary.daemon.train_duration_sec }}s</span>
        <span class="stat-label">Train Cycle</span>
      </div>
    </div>

    <!-- Active Anomalies Table -->
    <DataTable :value="store.active" :loading="store.loading" stripedRows
               responsiveLayout="scroll" class="anomalies-table"
               :paginator="store.active.length > 20" :rows="20"
               sortField="scored_at" :sortOrder="-1"
               data-track="anomalies-table">
      <template #empty>
        <div class="empty-state">
          <i class="pi pi-check-circle empty-icon"></i>
          <p>All clients are behaving normally</p>
        </div>
      </template>

      <Column field="client_ip" header="Client IP" sortable style="min-width: 120px">
        <template #body="{ data }">
          <a href="#" class="client-link" data-track="anomalies-client-click"
             @click.prevent="openClientDetail(data.client_ip)">{{ data.client_ip }}</a>
        </template>
      </Column>

      <Column field="hostname" header="Hostname" sortable style="min-width: 120px">
        <template #body="{ data }">
          <span v-if="data.hostname">{{ data.hostname }}</span>
          <span v-else class="text-muted">--</span>
        </template>
      </Column>

      <Column field="severity" header="Severity" sortable style="min-width: 90px">
        <template #body="{ data }">
          <Tag :value="data.severity" :severity="severityColor(data.severity)" />
        </template>
      </Column>

      <Column field="anomaly_score" header="Score" sortable style="min-width: 80px">
        <template #body="{ data }">
          {{ data.anomaly_score.toFixed(3) }}
        </template>
      </Column>

      <Column field="scored_at" header="Detected" sortable style="min-width: 140px">
        <template #body="{ data }">
          {{ formatTime(data.scored_at) }}
        </template>
      </Column>

      <Column header="" style="width: 130px; text-align: center">
        <template #body="{ data }">
          <div class="action-btns">
            <Button icon="pi pi-info-circle" severity="secondary" text rounded size="small"
                    title="View details" data-track="anomalies-details"
                    @click="toggleFactorPopover($event, data)" />
            <Button icon="pi pi-shield" severity="secondary" text rounded size="small"
                    title="Whitelist client" data-track="anomalies-whitelist"
                    @click="handleWhitelist(data)" />
            <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                    title="Delete" data-track="anomalies-delete"
                    @click="confirmDelete($event, data.id)" />
          </div>
        </template>
      </Column>
    </DataTable>

    <!-- Factor Detail Popover -->
    <Popover ref="factorPopoverRef" class="factor-popover-panel" data-track="anomalies-factor-popover">
      <div v-if="popoverData" class="factor-popover">
        <div class="popover-header">
          <Tag :value="popoverData.severity" :severity="severityColor(popoverData.severity)" />
          <span class="popover-score">Score: {{ popoverData.anomaly_score?.toFixed(3) }}</span>
        </div>
        <div class="popover-client">
          {{ popoverData.client_ip }}
          <span v-if="popoverData.hostname" class="text-muted">({{ popoverData.hostname }})</span>
        </div>
        <div class="popover-time text-muted">Detected: {{ formatTime(popoverData.scored_at) }}</div>

        <div class="factor-list" v-if="popoverFactors.length">
          <div v-for="(f, i) in popoverFactors" :key="f.feature" class="factor-item">
            <div class="factor-item-header">
              <span class="factor-rank">{{ i + 1 }}.</span>
              <span class="factor-name">{{ f.label }}</span>
              <span v-if="f.observed != null" class="factor-direction"
                    :class="f.observed > f.baseline ? 'dir-up' : 'dir-down'">
                {{ f.observed > f.baseline ? '\u25B2' : '\u25BC' }}
              </span>
              <span class="factor-contrib">{{ Math.round(f.contribution * 100) }}%</span>
            </div>
            <div v-if="f.observed != null" class="factor-values">
              Observed: <strong>{{ formatFeatureValue(f.feature, f.observed) }}</strong>
              <span class="text-muted"> / Baseline: {{ formatFeatureValue(f.feature, f.baseline) }}</span>
            </div>
            <div class="factor-bar">
              <div class="factor-bar-fill" :class="contribBarClass(f.contribution)"
                   :style="{ width: Math.min(f.contribution * 100, 100) + '%' }"></div>
            </div>
            <div class="factor-desc text-muted">{{ FACTOR_DESCRIPTIONS[f.label] || '' }}</div>
          </div>
        </div>
        <div v-else class="text-muted" style="font-size: 0.85rem; padding: 0.5rem 0;">
          No contributing factor data available.
        </div>

        <div class="popover-actions">
          <Button label="Whitelist" icon="pi pi-shield" severity="secondary" text size="small"
                  data-track="anomalies-popover-whitelist"
                  @click="handleWhitelist(popoverData); factorPopoverRef.hide()" />
          <Button label="View History" icon="pi pi-history" severity="secondary" text size="small"
                  data-track="anomalies-popover-history"
                  @click="openClientDetail(popoverData.client_ip); factorPopoverRef.hide()" />
        </div>
      </div>
    </Popover>

    <!-- Delete Confirmation -->
    <ConfirmPopup />

    <!-- Whitelist Confirmation Dialog -->
    <Dialog v-model:visible="whitelistDialogVisible" header="Whitelist Client" :modal="true"
            :closable="true" :style="{ width: '26rem' }">
      <p>
        Whitelist <strong>{{ whitelistTarget?.client_ip }}</strong>
        <span v-if="whitelistTarget?.hostname"> ({{ whitelistTarget.hostname }})</span>
        from anomaly detection?
      </p>
      <p class="text-muted" style="font-size: 0.85rem;">
        This will stop monitoring this client and delete all existing anomaly scores and model data for it.
      </p>
      <div class="field" style="margin-top: 0.75rem;">
        <label style="font-size: 0.85rem;">Reason (optional)</label>
        <InputText v-model="whitelistReason" placeholder="e.g. Known scanner, expected behavior"
                   fluid style="margin-top: 0.25rem;" />
      </div>
      <template #footer>
        <Button label="Cancel" text @click="whitelistDialogVisible = false" />
        <Button label="Whitelist" icon="pi pi-shield" severity="warn"
                data-track="anomalies-whitelist-confirm" @click="confirmWhitelist" />
      </template>
    </Dialog>

    <!-- Client Detail Dialog -->
    <Dialog v-model:visible="clientDialogVisible" :header="`Anomaly History: ${selectedClient}`"
            :style="{ width: '700px' }" modal data-track="anomalies-client-dialog">
      <div v-if="store.clientModel" class="client-model-info">
        <span>Status: <strong>{{ store.clientModel.status }}</strong></span>
        <span v-if="store.clientModel.trained_at">Last trained: {{ formatTime(store.clientModel.trained_at) }}</span>
        <span v-if="store.clientModel.training_rows">Training windows: {{ store.clientModel.training_rows }}</span>
      </div>

      <div v-if="clientChartData" class="client-chart">
        <Line :data="clientChartData" :options="chartOptions" />
      </div>

      <DataTable :value="store.clientHistory" stripedRows :rows="10" :paginator="store.clientHistory.length > 10"
                 sortField="window_start" :sortOrder="-1" class="client-history-table">
        <Column field="window_start" header="Window" sortable>
          <template #body="{ data }">{{ formatTime(data.window_start) }}</template>
        </Column>
        <Column field="anomaly_score" header="Score" sortable>
          <template #body="{ data }">{{ data.anomaly_score.toFixed(3) }}</template>
        </Column>
        <Column field="is_anomaly" header="Anomaly" sortable>
          <template #body="{ data }">
            <Tag v-if="data.is_anomaly" :value="data.severity || 'anomaly'" :severity="severityColor(data.severity)" />
            <span v-else class="text-muted">Normal</span>
          </template>
        </Column>
        <Column field="resolved" header="Status">
          <template #body="{ data }">
            <span v-if="data.resolved" class="text-muted">Resolved</span>
            <span v-else-if="data.is_anomaly" class="severity-high">Active</span>
            <span v-else class="text-muted">--</span>
          </template>
        </Column>
      </DataTable>
    </Dialog>

  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Tag from 'primevue/tag';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import Popover from 'primevue/popover';
import ConfirmPopup from 'primevue/confirmpopup';
import InputText from 'primevue/inputtext';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  Title, Tooltip, Legend, Filler
} from 'chart.js';
import { Line } from 'vue-chartjs';
import { useAnomalyStore } from '../stores/anomalies.js';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import '../assets/analytics-layout.css';
import { chartColor, chartFill } from '../utils/chart-config.js';
import { formatDateTime } from '../utils/dateFormat.js';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);
ChartJS.defaults.elements.line.borderWidth = 1;

const store = useAnomalyStore();
const toast = useToast();
const confirm = useConfirm();

const severityFilter = ref(null);
const clientDialogVisible = ref(false);
const selectedClient = ref('');

// Factor detail popover
const factorPopoverRef = ref(null);
const popoverData = ref(null);

const popoverFactors = computed(() => {
  if (!popoverData.value?.top_features?.length) return [];
  return [...popoverData.value.top_features].sort((a, b) => b.contribution - a.contribution);
});

const FACTOR_DESCRIPTIONS = {
  "Unusual time of day": "DNS queries are happening at hours this client doesn't normally generate traffic.",
  "Unusual day of week": "Query patterns differ from this client's typical day-of-week behavior.",
  "Abnormal query volume": "The total number of DNS queries is significantly different from this client's learned baseline.",
  "Bursty query pattern": "Queries are arriving in sharp bursts rather than the client's normal steady pattern.",
  "Unusual number of distinct domains": "The client is querying far more or fewer unique domains than usual.",
  "High ratio of never-before-seen domains": "A large proportion of queried domains have never been seen before from this client.",
  "High-entropy domains (possible DGA)": "Domain names have unusually random character patterns, which can indicate domain generation algorithms used by malware.",
  "Unusually long domain names": "Queries include abnormally long domain names, sometimes used for DNS tunneling or data exfiltration.",
  "Deep subdomain nesting": "Domains have more subdomain levels than typical, which can indicate tunneling.",
  "Unusual TLD diversity": "The client is querying an unusual variety of top-level domains compared to its baseline.",
  "High NXDOMAIN rate": "A large fraction of queries are returning NXDOMAIN (non-existent domain), which can indicate scanning or DGA activity.",
  "High blocked query rate": "An unusually high percentage of this client's queries are being blocked by the blocklist.",
  "Unusual A record ratio": "The proportion of A (IPv4) record queries differs significantly from this client's normal mix.",
  "Unusual AAAA record ratio": "The proportion of AAAA (IPv6) record queries differs significantly from this client's normal mix.",
  "Unusual non-A/AAAA query types": "The client is making an unusual number of non-standard query types (MX, TXT, SRV, etc.).",
  "Unusual query type diversity": "The variety of DNS query types is different from this client's typical behavior.",
  "Unusual number of resolved IPs": "Queries are resolving to a significantly different number of unique IP addresses than expected.",
  "High unresolved query ratio": "A large fraction of queries are failing to resolve, which can indicate probing or misconfiguration.",
};

// Features that are counts (display as integers), rest are ratios (display as decimals)
const COUNT_FEATURES = new Set([
  'query_count', 'unique_domain_count', 'max_domain_length', 'unique_resolved_ips',
]);
const RATIO_FEATURES = new Set([
  'burst_ratio', 'new_domain_ratio', 'nxdomain_ratio', 'block_ratio',
  'type_a_ratio', 'type_aaaa_ratio', 'type_other_ratio', 'null_resolved_ratio',
]);

function formatFeatureValue(feature, value) {
  if (value == null) return '--';
  if (COUNT_FEATURES.has(feature)) return Math.round(value).toLocaleString();
  if (RATIO_FEATURES.has(feature)) return (value * 100).toFixed(1) + '%';
  return value.toFixed(2); // entropy, diversity, depth
}

function contribBarClass(contribution) {
  const pct = contribution * 100;
  if (pct >= 30) return 'bar-high';
  if (pct >= 15) return 'bar-medium';
  return 'bar-low';
}

function toggleFactorPopover(event, row) {
  popoverData.value = row;
  factorPopoverRef.value.toggle(event);
}

// Whitelist dialog state
const whitelistDialogVisible = ref(false);
const whitelistTarget = ref(null);
const whitelistReason = ref('');

const severityOptions = [
  { label: 'All Severities', value: null },
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
];

function severityColor(severity) {
  if (severity === 'high') return 'danger';
  if (severity === 'medium') return 'warn';
  return 'info';
}

function timeAgo(iso) {
  if (!iso) return '—';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTime(iso) {
  if (!iso) return '--';
  return formatDateTime(iso);
}

async function refreshActive() {
  await store.fetchActive(severityFilter.value);
}

async function refreshAll() {
  await store.fetchAll(severityFilter.value);
}

function confirmDelete(event, id) {
  confirm.require({
    target: event.currentTarget,
    message: 'Delete this anomaly? This cannot be undone.',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel',
    acceptLabel: 'Delete',
    acceptClass: 'p-button-danger p-button-sm',
    rejectClass: 'p-button-text p-button-sm',
    accept: async () => {
      try {
        await store.deleteAnomaly(id);
      } catch {
        toast.add({ severity: 'error', summary: 'Failed to delete anomaly', life: 3000 });
      }
    },
  });
}

function handleWhitelist(row) {
  whitelistTarget.value = row;
  whitelistReason.value = '';
  whitelistDialogVisible.value = true;
}

async function confirmWhitelist() {
  try {
    await store.whitelistClient(whitelistTarget.value.client_ip, whitelistReason.value || null);
    whitelistDialogVisible.value = false;
    toast.add({ severity: 'success', summary: 'Client whitelisted', detail: whitelistTarget.value.client_ip, life: 3000 });
  } catch (err) {
    const msg = err.response?.data?.error || 'Failed to whitelist client';
    toast.add({ severity: 'error', summary: msg, life: 4000 });
  }
}

async function openClientDetail(ip) {
  selectedClient.value = ip;
  clientDialogVisible.value = true;
  await Promise.all([
    store.fetchClientHistory(ip),
    store.fetchClientModel(ip),
  ]);
}

// Pre-sorted client history for chart
const sortedHistory = computed(() => {
  if (!store.clientHistory.length) return [];
  return [...store.clientHistory].sort((a, b) => a.window_start.localeCompare(b.window_start));
});

const clientChartData = computed(() => {
  const sorted = sortedHistory.value;
  if (!sorted.length) return null;
  return {
    labels: sorted.map(r => formatTime(r.window_start)),
    datasets: [{
      label: 'Anomaly Score',
      data: sorted.map(r => r.anomaly_score),
      borderColor: chartColor(3),
      backgroundColor: chartFill(3, 0.12),
      fill: true,
      tension: 0.3,
      pointRadius: sorted.map(r => r.is_anomaly ? 5 : 2),
      pointBackgroundColor: sorted.map(r => r.is_anomaly ? chartColor('err') : chartColor(3)),
    }],
  };
});

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    y: {
      title: { display: true, text: 'Score', color: chartColor('text') },
      ticks: { color: chartColor('text') },
      grid: { color: chartColor('grid') },
    },
    x: { display: false },
  },
  plugins: {
    legend: { display: false },
    tooltip: {
      callbacks: {
        afterLabel: (ctx) => {
          const item = sortedHistory.value[ctx.dataIndex];
          if (item?.is_anomaly && item?.top_features?.length) {
            return item.top_features.map(f => `  ${f.label}`).join('\n');
          }
          return '';
        }
      }
    },
    // ChartDataLabels is globally registered by Dashboard/Intelligence; suppress
    // on-point labels here — tooltip already covers that information.
    datalabels: { display: false },
  },
}));

onMounted(() => {
  refreshAll();
});

useAutoRefresh(refreshAll);
</script>

<style scoped>
/* Page-specific styles only — shared styles come from analytics-layout.css */

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.25rem;
}

.page-header h1 {
  font-size: 1.3rem;
  font-weight: 700;
  margin: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.severity-select {
  width: 180px;
}

.empty-state {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--p-text-muted-color);
}

.empty-icon {
  font-size: 2.5rem;
  color: var(--p-green-500);
  margin-bottom: 0.5rem;
}

.client-link {
  color: var(--p-primary-color);
  text-decoration: none;
  font-weight: 500;
}
.client-link:hover {
  text-decoration: underline;
}

/* Action buttons */
.action-btns {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.15rem;
}

/* Factor detail popover */
.factor-popover {
  max-width: 380px;
  min-width: 320px;
}

.popover-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}

.popover-score {
  font-family: monospace;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.popover-client {
  font-weight: 600;
  font-size: 0.9rem;
  margin-bottom: 0.15rem;
}

.popover-time {
  font-size: 0.75rem;
  margin-bottom: 0.75rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--p-surface-border);
}

.factor-list {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.factor-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.factor-item-header {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.factor-rank {
  font-weight: 600;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  min-width: 1.2rem;
}

.factor-name {
  font-weight: 600;
  font-size: 0.85rem;
  flex: 1;
}

.factor-direction {
  font-size: 0.75rem;
}
.dir-up { color: var(--p-red-500); }
.dir-down { color: var(--p-blue-500); }

.factor-contrib {
  font-family: monospace;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

.factor-values {
  font-size: 0.78rem;
  font-family: monospace;
  padding-left: 1.2rem;
}

.factor-bar {
  height: 4px;
  background: var(--p-surface-200);
  border-radius: 2px;
  overflow: hidden;
  margin: 0.15rem 0 0.1rem 1.2rem;
}

.factor-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.2s ease;
}
.bar-high { background: var(--p-red-500); }
.bar-medium { background: var(--p-orange-500); }
.bar-low { background: var(--p-blue-500); }

.factor-desc {
  font-size: 0.72rem;
  line-height: 1.35;
  padding-left: 1.2rem;
}

.popover-actions {
  display: flex;
  justify-content: space-between;
  margin-top: 0.75rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--p-surface-border);
}

.text-muted {
  color: var(--p-text-muted-color);
}

.client-model-info {
  display: flex;
  gap: 1.5rem;
  margin-bottom: 1rem;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}

.client-chart {
  height: 200px;
  margin-bottom: 1rem;
}
</style>
