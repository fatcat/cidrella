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

      <Column field="top_features" header="Factors" style="min-width: 180px">
        <template #body="{ data }">
          <div v-if="data.top_features?.length" class="factor-cell">
            <Tag :value="topFactor(data).label" severity="info" class="feature-tag" />
            <Button v-if="data.top_features.length > 1"
                    :label="`+${data.top_features.length - 1}`"
                    severity="secondary" text size="small" rounded
                    class="factor-more-btn"
                    @click="toggleFactors($event, data)"
                    data-track="anomalies-factors-expand" />
          </div>
          <span v-else class="text-muted">--</span>
        </template>
      </Column>

      <Column header="Actions" style="width: 100px; text-align: center">
        <template #body="{ data }">
          <div class="action-btns">
            <Button icon="pi pi-shield" severity="secondary" text rounded size="small"
                    title="Whitelist client" data-track="anomalies-whitelist"
                    @click="handleWhitelist(data)" />
            <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                    title="Delete" data-track="anomalies-delete"
                    @click="handleDelete(data.id)" />
          </div>
        </template>
      </Column>
    </DataTable>

    <!-- Factor Detail Popover -->
    <Popover ref="factorPopoverRef">
      <div class="factor-popover">
        <div v-for="f in factorPopoverData" :key="f.feature" class="factor-row">
          <Tag :value="f.label" severity="info" class="feature-tag" />
          <div class="factor-bar-track">
            <div class="factor-bar-fill" :style="{ width: Math.min(f.contribution * 100, 100) + '%' }"></div>
          </div>
          <span class="factor-pct">{{ Math.round(f.contribution * 100) }}%</span>
        </div>
      </div>
    </Popover>

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
import { formatDateTime } from '../utils/dateFormat.js';
import { useToast } from 'primevue/usetoast';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);
ChartJS.defaults.elements.line.borderWidth = 1;

const store = useAnomalyStore();
const toast = useToast();

const severityFilter = ref(null);
const clientDialogVisible = ref(false);
const selectedClient = ref('');

// Factor popover state
const factorPopoverRef = ref(null);
const factorPopoverData = ref([]);

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

function topFactor(row) {
  return [...row.top_features].sort((a, b) => b.contribution - a.contribution)[0];
}

function toggleFactors(event, row) {
  factorPopoverData.value = [...row.top_features].sort((a, b) => b.contribution - a.contribution);
  factorPopoverRef.value.toggle(event);
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

async function handleDelete(id) {
  try {
    await store.deleteAnomaly(id);
  } catch {
    toast.add({ severity: 'error', summary: 'Failed to delete anomaly', life: 3000 });
  }
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
      borderColor: '#6366f1',
      backgroundColor: 'rgba(99, 102, 241, 0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: sorted.map(r => r.is_anomaly ? 5 : 2),
      pointBackgroundColor: sorted.map(r => r.is_anomaly ? '#ef4444' : '#6366f1'),
    }],
  };
});

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    y: { title: { display: true, text: 'Score' } },
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
    }
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

/* Contributing factors — inline top factor + popover */
.factor-cell {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.feature-tag {
  font-size: 0.7rem;
}

.factor-more-btn {
  font-size: 0.7rem;
  padding: 0.15rem 0.4rem;
  min-width: unset;
}

/* Factor popover detail */
.factor-popover {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 240px;
  max-width: 320px;
}

.factor-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.factor-bar-track {
  flex: 1;
  height: 4px;
  background: var(--p-surface-200);
  border-radius: 2px;
  overflow: hidden;
}

.factor-bar-fill {
  height: 100%;
  background: var(--p-primary-color);
  border-radius: 2px;
  transition: width 0.2s ease;
}

.factor-pct {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
  min-width: 2rem;
  text-align: right;
}

/* Action buttons */
.action-btns {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
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
