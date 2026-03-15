<template>
  <div class="anomalies-page">
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

      <Column field="client_ip" header="Client IP" sortable style="min-width: 140px">
        <template #body="{ data }">
          <a href="#" class="client-link" data-track="anomalies-client-click"
             @click.prevent="openClientDetail(data.client_ip)">{{ data.client_ip }}</a>
        </template>
      </Column>

      <Column field="severity" header="Severity" sortable style="min-width: 100px">
        <template #body="{ data }">
          <Tag :value="data.severity" :severity="severityColor(data.severity)" />
        </template>
      </Column>

      <Column field="anomaly_score" header="Score" sortable style="min-width: 90px">
        <template #body="{ data }">
          {{ data.anomaly_score.toFixed(3) }}
        </template>
      </Column>

      <Column field="scored_at" header="Detected" sortable style="min-width: 160px">
        <template #body="{ data }">
          {{ formatTime(data.scored_at) }}
        </template>
      </Column>

      <Column field="top_features" header="Contributing Factors" style="min-width: 250px">
        <template #body="{ data }">
          <div v-if="data.top_features?.length" class="feature-tags">
            <Tag v-for="f in data.top_features" :key="f.feature"
                 :value="f.label" severity="info" class="feature-tag" />
          </div>
          <span v-else class="text-muted">--</span>
        </template>
      </Column>

      <Column header="" style="width: 80px">
        <template #body="{ data }">
          <Button icon="pi pi-times" severity="secondary" text rounded size="small"
                  title="Dismiss" data-track="anomalies-dismiss"
                  @click="handleDismiss(data.id)" />
        </template>
      </Column>
    </DataTable>

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
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Tag from 'primevue/tag';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  Title, Tooltip, Legend, Filler
} from 'chart.js';
import { Line } from 'vue-chartjs';
import { useAnomalyStore } from '../stores/anomalies.js';
import { formatDateTime } from '../utils/dateFormat.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);
ChartJS.defaults.elements.line.borderWidth = 1;

const router = useRouter();
const store = useAnomalyStore();

const severityFilter = ref(null);
const clientDialogVisible = ref(false);
const selectedClient = ref('');
let refreshTimer = null;

const severityOptions = [
  { label: 'All Severities', value: null },
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
];

function goToSettings() {
  localStorage.setItem('ipam_system_tab', '13');
  router.push('/system');
}

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

async function handleDismiss(id) {
  await store.dismissAnomaly(id);
}

async function openClientDetail(ip) {
  selectedClient.value = ip;
  clientDialogVisible.value = true;
  await Promise.all([
    store.fetchClientHistory(ip),
    store.fetchClientModel(ip),
  ]);
}

// Pre-sorted client history for chart (avoids re-sorting on every hover)
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
  refreshTimer = setInterval(refreshAll, 60_000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<style scoped>
.anomalies-page {
  padding: 1rem 7%;
}

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

.stats-bar {
  display: flex;
  gap: 2rem;
  padding: 1rem 1.25rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
}
.stat { display: flex; flex-direction: column; }
.stat-value { font-size: 1.25rem; font-weight: 700; font-family: monospace; display: flex; align-items: center; gap: 0.4rem; }
.stat-label { font-size: 0.75rem; color: var(--p-text-muted-color); text-transform: uppercase; }
.indicator-on { width: 8px; height: 8px; border-radius: 50%; background: var(--p-green-500); display: inline-block; }
.indicator-off { width: 8px; height: 8px; border-radius: 50%; background: var(--p-red-500); display: inline-block; }
.text-danger { color: var(--p-red-500); }
.text-warning { color: var(--p-orange-500); }

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

.feature-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.feature-tag {
  font-size: 0.7rem;
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

.settings-link {
  text-decoration: none;
}
</style>
