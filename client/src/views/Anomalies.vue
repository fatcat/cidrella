<template>
  <div class="analytics-tab">
    <div class="page-header">
      <h1>Anomaly Detection</h1>
      <div class="header-actions">
        <Button icon="pi pi-refresh" severity="secondary" text rounded size="small"
                data-track="anomalies-refresh" @click="refreshAll" :loading="store.loading" />
      </div>
    </div>

    <!-- Daemon / monitoring status strip -->
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
      <div class="stat" v-if="store.summary.daemon?.last_score">
        <span class="stat-value">{{ timeAgo(store.summary.daemon.last_score) }}</span>
        <span class="stat-label">Last Scored</span>
      </div>
      <div class="stat" v-if="store.summary.daemon?.last_train">
        <span class="stat-value">{{ timeAgo(store.summary.daemon.last_train) }}</span>
        <span class="stat-label">Last Trained</span>
      </div>
      <div class="stat" v-if="store.summary.daemon">
        <span class="stat-value">
          <span :class="store.summary.daemon.stale ? 'indicator-warn' : 'indicator-on'"></span>
          {{ store.summary.daemon.stale ? 'Stale' : 'Healthy' }}
        </span>
        <span class="stat-label">Daemon</span>
      </div>
    </div>

    <!-- Pattern summary tiles -->
    <div class="pattern-tiles">
      <div class="tile total" :class="{ on: patternFilter === null }" data-track="anomalies-filter-all"
           @click="patternFilter = null">
        <div class="num">{{ clients.length }}</div>
        <div class="lbl">Flagged Clients</div>
      </div>
      <div v-for="p in ['escalating', 'recurring', 'flagged', 'resolved', 'learning']" :key="p"
           class="tile" :class="[p, { on: patternFilter === p }]" data-track="anomalies-filter-pattern"
           @click="patternFilter = patternFilter === p ? null : p">
        <div class="num">{{ counts[p] || 0 }} <small>{{ PATTERNS[p].icon }}</small></div>
        <div class="lbl">{{ PATTERNS[p].label }}</div>
      </div>
    </div>

    <div class="board">
      <div class="panel">
        <div class="panel-head">
          <h2>Flagged Clients</h2>
          <span class="count">{{ filteredClients.length }} shown</span>
        </div>
        <div class="list" v-if="filteredClients.length" data-track="anomalies-client-list">
          <div v-for="c in filteredClients" :key="c.identity"
               class="host-row" :class="{ selected: c.identity === selectedIp }"
               data-track="anomalies-client-click" @click="selectClient(c.identity)">
            <div class="host-id">
              <div class="name">{{ c.hostname || c.client_ip }}</div>
              <div class="ip">{{ c.client_ip }}</div>
            </div>
            <span class="pattern-chip" :class="c.pattern">{{ PATTERNS[c.pattern].icon }} {{ PATTERNS[c.pattern].label }}</span>
            <span class="row-spark">
              <AnomalySparkline v-if="c.sparkline.length" :scores="c.sparkline.map(p => p.score)"
                                 :color="sparklineColor(c)" />
              <span v-else class="text-muted spark-empty">{{ c.trainingRows ?? 0 }}w</span>
            </span>
            <span class="row-score" :style="{ color: sparklineColor(c) }">
              {{ c.latestScore != null ? c.latestScore.toFixed(2) : EMPTY_CELL }}
            </span>
          </div>
        </div>
        <div class="empty-state" v-else>
          <i class="pi pi-check-circle empty-icon"></i>
          <p>No clients match this filter</p>
        </div>
      </div>

      <div class="panel">
        <div class="detail" v-if="selected">
          <div class="dhead">
            <div>
              <div class="name">{{ selected.hostname || selected.client_ip }}</div>
              <div class="ip">{{ selected.client_ip }}</div>
              <div class="meta">
                <span v-if="store.clientModel?.trained_at">Model trained {{ timeAgo(store.clientModel.trained_at) }}</span>
                <span v-if="store.clientModel?.training_rows != null">{{ store.clientModel.training_rows }} training windows</span>
              </div>
            </div>
            <div class="actions">
              <Button label="Whitelist" icon="pi pi-shield" severity="secondary" outlined size="small"
                      data-track="anomalies-whitelist" @click="handleWhitelist(selected)" />
            </div>
          </div>

          <div class="fingerprint-warning" v-if="store.fingerprintChanges.length" data-track="anomalies-fingerprint-drift">
            <i class="pi pi-exclamation-triangle"></i>
            <div>
              <strong>Device fingerprint changed</strong> {{ timeAgo(store.fingerprintChanges[0].changed_at) }} —
              previously identified as <b>{{ store.fingerprintChanges[0].previous_value }}</b>,
              now <b>{{ store.fingerprintChanges[0].new_value }}</b>. This can mean the physical device behind
              this address changed, including MAC spoofing.
            </div>
          </div>

          <template v-if="selected.pattern === 'learning'">
            <div class="learning-box">
              <div>
                <div class="lbig">{{ selected.trainingRows ?? 0 }}<small>&nbsp;windows</small></div>
                <div class="progress-track" v-if="expectedTrainingWindows">
                  <div class="progress-fill" :style="{ width: Math.min(100, (selected.trainingRows / expectedTrainingWindows) * 100) + '%' }"></div>
                </div>
              </div>
              <div class="learning-note">
                This client hasn't collected enough history to train a reliable baseline yet. Scoring it
                before then is how legitimate new devices end up mislabeled as "dangerous."
              </div>
            </div>
          </template>

          <template v-else>
            <div class="gauge-row">
              <AnomalyGauge :score="selected.latestScore" :severity="selected.latestSeverity" />
              <div class="gauge-caption" :class="selected.pattern">
                <div class="trend-line">{{ PATTERNS[selected.pattern].icon }} {{ PATTERNS[selected.pattern].label }}</div>
                <div>{{ selected.note }}</div>
              </div>
            </div>

            <div class="section" v-if="store.clientHistory.length">
              <div class="section-title">
                <span>Behavior Timeline</span>
                <span class="range">hour of day &times; day, darker = more anomalous</span>
              </div>
              <div class="card">
                <AnomalyHeatmap :history="store.clientHistory" />
              </div>
            </div>

            <div class="section" v-if="clientChartData">
              <div class="section-title"><span>Score History</span></div>
              <div class="card">
                <div class="client-chart">
                  <Line :data="clientChartData" :options="chartOptions" />
                </div>
              </div>
            </div>

            <div class="section" v-if="featureTrends.length">
              <div class="section-title">
                <span>Contributing Signals, Trended</span>
                <span class="range">each point is a window where this signal was a top factor</span>
              </div>
              <div class="features-grid">
                <AnomalyFeatureTrend v-for="f in featureTrends" :key="f.feature"
                                     :feature="f.feature" :label="f.label" :points="f.points" />
              </div>
            </div>

            <div class="section" v-if="currentFactors.length">
              <div class="section-title">Why the Latest Window Was Flagged</div>
              <div class="card">
                <div v-for="(f, i) in currentFactors" :key="f.feature" class="factor">
                  <div class="factor-top">
                    <span class="factor-rank">{{ i + 1 }}.</span>
                    <span class="factor-name">{{ f.label }}</span>
                    <span class="factor-dir" :class="f.observed > f.baseline ? 'up' : 'down'">
                      {{ f.observed > f.baseline ? '▲' : '▼' }}
                    </span>
                    <span class="factor-pct">{{ Math.round(f.contribution * 100) }}%</span>
                  </div>
                  <div class="factor-bar">
                    <div class="factor-bar-fill" :style="{ width: Math.min(f.contribution * 100, 100) + '%', background: contribColor(f.contribution) }"></div>
                  </div>
                  <div class="factor-vals">
                    observed <b>{{ formatFeatureValue(f.feature, f.observed) }}</b>
                    &middot; baseline {{ formatFeatureValue(f.feature, f.baseline) }}
                  </div>
                  <div class="factor-desc">{{ FACTOR_DESCRIPTIONS[f.label] || '' }}</div>
                </div>
              </div>
            </div>

            <div class="section" v-if="peerScores.length > 1">
              <div class="section-title">Network Context</div>
              <div class="card">
                <AnomalyPeerStrip :scores="peerScores" :mine="selected.latestScore" />
              </div>
            </div>
          </template>
        </div>
        <div class="empty-state" v-else>
          <p>Select a flagged client to see its history</p>
        </div>
      </div>
    </div>

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
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { apiError, EMPTY_CELL } from '../utils/format.js';
import Button from '../ui/Button.js';
import Dialog from '../ui/Dialog.js';
import InputText from '../ui/InputText.js';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  Title, Tooltip, Legend, Filler,
} from 'chart.js';
import { Line } from 'vue-chartjs';
import AnomalyGauge from '../components/anomaly/AnomalyGauge.vue';
import AnomalyHeatmap from '../components/anomaly/AnomalyHeatmap.vue';
import AnomalySparkline from '../components/anomaly/AnomalySparkline.vue';
import AnomalyFeatureTrend from '../components/anomaly/AnomalyFeatureTrend.vue';
import AnomalyPeerStrip from '../components/anomaly/AnomalyPeerStrip.vue';
import { classifyClients, summaryCounts, PATTERNS } from '../utils/anomaly-pattern.js';
import { formatFeatureValue, FACTOR_DESCRIPTIONS } from '../utils/anomaly-features.js';
import { useAnomalyStore } from '../stores/anomalies.js';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import '../assets/analytics-layout.css';
import { chartColor, chartFill } from '../utils/chart-config.js';
import { formatDateTime, formatRelativeTime as timeAgo } from '../utils/dateFormat.js';
import { useToast } from '../ui/useToast.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);
ChartJS.defaults.elements.line.borderWidth = 1;

const store = useAnomalyStore();
const toast = useToast();

const patternFilter = ref(null);
const selectedIp = ref(null);

const clients = computed(() => classifyClients(store.events, store.learning));
const counts = computed(() => summaryCounts(clients.value));
const filteredClients = computed(() => patternFilter.value
  ? clients.value.filter(c => c.pattern === patternFilter.value)
  : clients.value);
const selected = computed(() => clients.value.find(c => c.identity === selectedIp.value) || null);

const peerScores = computed(() => clients.value.filter(c => c.latestScore != null).map(c => c.latestScore));

function sparklineColor(c) {
  if (c.latestSeverity === 'high') return chartColor('err');
  if (c.latestSeverity === 'medium') return chartColor('warn');
  return chartColor('info');
}
function contribColor(contribution) {
  if (contribution > 0.3) return chartColor('err');
  if (contribution > 0.15) return chartColor('warn');
  return chartColor('info');
}

const expectedTrainingWindows = computed(() => {
  const hours = parseInt(store.settings?.anomaly_min_training_hours, 10);
  const intervalMin = parseInt(store.settings?.anomaly_scoring_interval_min, 10);
  if (!hours || !intervalMin) return null;
  return Math.ceil((hours * 60) / intervalMin);
});

const currentFactors = computed(() => {
  if (!selected.value?.latestTopFeatures?.length) return [];
  return [...selected.value.latestTopFeatures].sort((a, b) => b.contribution - a.contribution);
});

// Group every historical occurrence of each feature named in the latest
// anomalous window's top factors, so "why" (the ranked list below) and
// "how long has this been building" (these trends) tell the same story.
const featureTrends = computed(() => {
  if (!currentFactors.value.length) return [];
  const wanted = new Map(currentFactors.value.map(f => [f.feature, f.label]));
  const series = new Map([...wanted.keys()].map(k => [k, []]));
  for (const row of store.clientHistory) {
    if (!row.top_features?.length) continue;
    for (const f of row.top_features) {
      if (series.has(f.feature) && f.observed != null) {
        series.get(f.feature).push({ t: row.window_start, value: f.observed });
      }
    }
  }
  return [...series.entries()]
    .filter(([, points]) => points.length > 0)
    .map(([feature, points]) => ({
      feature,
      label: wanted.get(feature),
      points: points.sort((a, b) => a.t.localeCompare(b.t)),
    }));
});

function formatTime(iso) {
  return formatDateTime(iso);
}

async function selectClient(identity) {
  selectedIp.value = identity;
  store.clearClient();
  await Promise.all([
    store.fetchClientHistory(identity, 500),
    store.fetchClientModel(identity),
    store.fetchFingerprintChanges(identity),
  ]);
}

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
        },
      },
    },
    datalabels: { display: false },
  },
}));

// Whitelist dialog state
const whitelistDialogVisible = ref(false);
const whitelistTarget = ref(null);
const whitelistReason = ref('');

function handleWhitelist(client) {
  whitelistTarget.value = client;
  whitelistReason.value = '';
  whitelistDialogVisible.value = true;
}

async function confirmWhitelist() {
  try {
    await store.whitelistClient(whitelistTarget.value.client_ip, whitelistReason.value || null);
    whitelistDialogVisible.value = false;
    if (selectedIp.value === whitelistTarget.value.identity) selectedIp.value = null;
    toast.add({ severity: 'success', summary: 'Client whitelisted', detail: whitelistTarget.value.client_ip, life: 3000 });
  } catch (err) {
    const msg = apiError(err);
    toast.add({ severity: 'error', summary: msg, life: 4000 });
  }
}

async function refreshAll() {
  await Promise.all([store.fetchAll(), store.fetchSettings()]);
  if (selectedIp.value) await selectClient(selectedIp.value);
}

watch(clients, (list) => {
  if (!selectedIp.value && list.length) selectClient(list[0].identity);
});

onMounted(refreshAll);

useAutoRefresh(refreshAll);
</script>

<style scoped>
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.25rem; }
.page-header h1 { font-size: 1.3rem; font-weight: 700; margin: 0; }
.header-actions { display: flex; align-items: center; gap: 0.5rem; }

.pattern-tiles { display: grid; grid-template-columns: repeat(6, 1fr); gap: .7rem; }
.tile {
  background: var(--p-surface-card); border: 1px solid var(--p-surface-border); border-radius: 8px;
  padding: .7rem .85rem; cursor: pointer; transition: border-color .12s;
}
.tile:hover { border-color: var(--p-primary-color); }
.tile.on { box-shadow: 0 0 0 1px var(--p-primary-color) inset; border-color: var(--p-primary-color); }
.tile .num { font-family: monospace; font-size: 1.3rem; font-weight: 700; display: flex; align-items: baseline; gap: .3rem; }
.tile .lbl { font-size: .66rem; text-transform: uppercase; letter-spacing: .06em; color: var(--p-text-muted-color); font-weight: 600; margin-top: .1rem; }
.tile.escalating .num { color: var(--cid-status-err); }
.tile.recurring .num { color: var(--cid-status-info); }
.tile.resolved .num { color: var(--p-text-muted-color); }
.tile.flagged .num { color: var(--cid-status-warn); }
.tile.learning .num { color: var(--p-primary-color); }

.board { display: grid; grid-template-columns: 340px 1fr; gap: 1rem; align-items: start; }
@media (max-width: 900px) { .board { grid-template-columns: 1fr; } }

.panel { background: var(--p-surface-card); border: 1px solid var(--p-surface-border); border-radius: 8px; overflow: hidden; }
.panel-head { padding: .7rem .9rem; border-bottom: 1px solid var(--p-surface-border); display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
.panel-head h2 { font-size: .86rem; margin: 0; font-weight: 700; }
.panel-head .count { font-size: .72rem; color: var(--p-text-muted-color); font-family: monospace; }

.list { max-height: 74vh; overflow-y: auto; }
.host-row { display: flex; align-items: center; gap: .6rem; padding: .6rem .9rem; border-bottom: 1px solid var(--p-surface-border); cursor: pointer; }
.host-row:last-child { border-bottom: none; }
.host-row:hover { background: var(--p-surface-ground); }
.host-row.selected { background: color-mix(in srgb, var(--p-primary-color) 12%, transparent); box-shadow: inset 3px 0 0 var(--p-primary-color); }
.host-id { flex: 1; min-width: 0; }
.host-id .name { font-weight: 600; font-size: .82rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.host-id .ip { font-family: monospace; font-size: .70rem; color: var(--p-text-muted-color); }
.spark-empty { font-size: .68rem; font-family: monospace; color: var(--p-text-muted-color); }

.pattern-chip {
  font-size: .62rem; font-weight: 700; padding: .16rem .4rem; border-radius: 5px; text-transform: uppercase;
  letter-spacing: .03em; white-space: nowrap; background: var(--p-surface-ground); color: var(--p-text-muted-color);
}
.pattern-chip.escalating { color: var(--cid-status-err); }
.pattern-chip.recurring { color: var(--cid-status-info); }
.pattern-chip.flagged { color: var(--cid-status-warn); }
.pattern-chip.learning { color: var(--p-primary-color); }

.row-score { font-family: monospace; font-size: .78rem; font-weight: 700; width: 2.6rem; text-align: right; flex: none; }

.detail { padding: 1rem 1.1rem 1.3rem; }
.dhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; margin-bottom: .9rem; }
.dhead .name { font-size: 1.05rem; font-weight: 700; }
.dhead .ip { font-family: monospace; color: var(--p-text-muted-color); font-size: .82rem; }
.dhead .meta { font-size: .74rem; color: var(--p-text-muted-color); margin-top: .3rem; display: flex; gap: 1rem; flex-wrap: wrap; }

.gauge-row { display: flex; gap: 1.3rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
.gauge-caption { font-size: .78rem; color: var(--p-text-muted-color); max-width: 340px; }
.gauge-caption .trend-line { font-weight: 700; margin-bottom: .15rem; font-size: .86rem; }
.gauge-caption.escalating .trend-line { color: var(--cid-status-err); }
.gauge-caption.recurring .trend-line { color: var(--cid-status-info); }
.gauge-caption.flagged .trend-line { color: var(--cid-status-warn); }
.gauge-caption.resolved .trend-line { color: var(--p-text-color); }

.section { margin-top: 1.1rem; }
.section-title { font-size: .72rem; text-transform: uppercase; letter-spacing: .07em; color: var(--p-text-muted-color); font-weight: 700; margin-bottom: .5rem; display: flex; align-items: center; justify-content: space-between; }
.section-title .range { font-size: .68rem; text-transform: none; letter-spacing: 0; font-weight: 500; }

.card { background: var(--p-surface-ground); border: 1px solid var(--p-surface-border); border-radius: 8px; padding: .75rem .85rem; }
.client-chart { height: 180px; }

.features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: .7rem; }

.factor { padding: .65rem 0; border-bottom: 1px solid var(--p-surface-border); }
.factor:last-child { border-bottom: none; }
.factor-top { display: flex; align-items: center; gap: .4rem; }
.factor-rank { font-family: monospace; font-size: .72rem; color: var(--p-text-muted-color); width: 1.1rem; }
.factor-name { font-weight: 600; font-size: .82rem; flex: 1; }
.factor-dir { font-size: .72rem; }
.factor-dir.up { color: var(--cid-status-err); }
.factor-dir.down { color: var(--cid-status-info); }
.factor-pct { font-family: monospace; font-size: .74rem; color: var(--p-text-muted-color); width: 2.4rem; text-align: right; }
.factor-bar { height: 5px; background: var(--p-surface-border); border-radius: 3px; overflow: hidden; margin: .35rem 0 .3rem 1.5rem; }
.factor-bar-fill { height: 100%; border-radius: 3px; }
.factor-vals { font-family: monospace; font-size: .71rem; color: var(--p-text-muted-color); padding-left: 1.5rem; }
.factor-vals b { color: var(--p-text-color); font-weight: 700; }
.factor-desc { font-size: .72rem; color: var(--p-text-muted-color); padding-left: 1.5rem; margin-top: .15rem; }

.fingerprint-warning {
  display: flex; align-items: flex-start; gap: .6rem; padding: .75rem .9rem; margin-bottom: 1rem;
  background: var(--cid-status-warn-bg, rgba(217, 119, 6, .1)); border: 1px solid var(--cid-status-warn); border-radius: 8px;
  font-size: .82rem; color: var(--p-text-color);
}
.fingerprint-warning i { color: var(--cid-status-warn); margin-top: .15rem; }

.learning-box { display: flex; align-items: center; gap: 1.2rem; padding: 1.2rem; background: var(--p-surface-ground); border: 1px solid var(--p-surface-border); border-radius: 8px; }
.learning-box .lbig { font-family: monospace; font-size: 1.4rem; font-weight: 700; color: var(--p-primary-color); }
.learning-box .lbig small { font-family: sans-serif; font-size: .65rem; font-weight: 600; color: var(--p-text-muted-color); }
.progress-track { height: 6px; background: var(--p-surface-border); border-radius: 3px; overflow: hidden; margin-top: .4rem; width: 180px; }
.progress-fill { height: 100%; background: var(--p-primary-color); border-radius: 3px; }
.learning-note { font-size: .82rem; color: var(--p-text-muted-color); max-width: 420px; }

.empty-state { text-align: center; padding: 3rem 1rem; color: var(--p-text-muted-color); }
.empty-icon { font-size: 2.5rem; color: var(--p-green-500); margin-bottom: 0.5rem; }
.text-muted { color: var(--p-text-muted-color); }
</style>
