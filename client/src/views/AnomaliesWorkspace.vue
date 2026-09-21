<!-- Anomaly triage: the Analytics "Anomalies" section. A queue of flagged
     devices and a map of every monitored one, linked by hover; picking a
     device opens the Evidence drawer. The drawer animates open and closed,
     but picking another device while it is open only swaps its content. -->
<template>
  <div
    class="workspace anomaly-triage"
    :class="{ 'drawer-open': drawerOpen }"
    data-track="anomalies-workspace"
  >
    <header class="workspace-head">
      <div>
        <h1>Anomaly triage</h1>
        <p class="lede">
          One dot per monitored device. Where it sits says whether it is merely unusual for itself,
          or shaped like an attack. Open a dot or a queue row for the evidence.
        </p>
      </div>
      <Button
        icon="pi pi-refresh"
        severity="secondary"
        text
        rounded
        size="small"
        aria-label="Refresh"
        data-track="triage-refresh"
        :loading="state === 'loading'"
        @click="refresh"
      />
    </header>

    <section class="status-rail" aria-label="Detector status">
      <span class="chip">
        <StatusDot :kind="rail.sidecarOk ? 'ok' : 'warn'" label="Detector" decorative /> Detector
        <b>{{ rail.sidecar }}</b>
      </span>
      <span class="chip"
        >Monitored <b>{{ rail.monitored }}</b></span
      >
      <span class="chip"
        >Learning <b>{{ rail.learning }}</b></span
      >
      <span class="chip"
        >Flagged windows, 7d <b>{{ rail.flaggedWindows }}</b></span
      >
      <span class="chip"
        >Last scored <b>{{ rail.lastScored }}</b></span
      >
      <span class="chip"
        >Last trained <b>{{ rail.lastTrained }}</b></span
      >
    </section>

    <div class="triage-board">
      <TriageQueue
        v-model:filter="filter"
        :rows="queueRows"
        :counts="counts"
        :open-id="openId"
        :hover-id="hoverId"
        :state="state"
        :error="error"
        :note="queueNote"
        @select="select"
        @hover="hoverId = $event"
      />
      <TriageMap
        :points="mapPoints"
        :open-id="openId"
        :hover-id="hoverId"
        @select="select"
        @hover="hoverId = $event"
      />
      <Transition name="drawer">
        <EvidenceDrawer
          v-if="drawerOpen"
          ref="drawerRef"
          :detail="detail"
          :state="clientState"
          :error="clientError"
          :evidence-state="evidenceState"
          :evidence-error="evidenceError"
          :has-prev="hasPrev"
          :has-next="hasNext"
          :position="position"
          :peer-scores="peerScores"
          @close="close"
          @prev="step(-1)"
          @next="step(1)"
          @allowlist="openAllowlist"
          @acknowledge="acknowledge"
        />
      </Transition>
    </div>
    <div class="drawer-backdrop" v-if="drawerOpen" aria-hidden="true"></div>

    <AllowlistDialog
      v-model:visible="allowlistVisible"
      :target="allowlistTarget"
      @allowlisted="onAllowlisted"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import Button from '../ui/Button.js';
import StatusDot from '../components/StatusDot.vue';
import TriageQueue from '../components/anomaly-triage/TriageQueue.vue';
import TriageMap from '../components/anomaly-triage/TriageMap.vue';
import EvidenceDrawer from '../components/anomaly-triage/EvidenceDrawer.vue';
import AllowlistDialog from '../components/anomaly/AllowlistDialog.vue';
import { useAnomalyStore } from '../stores/anomalies.js';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import '../assets/analytics-workspace.css';
import { classifyClients, summaryCounts, PATTERNS } from '../utils/anomaly-pattern.js';
import { buildFeatureTrends, SIGNAL_EVIDENCE_FEATURES } from '../utils/anomaly-features.js';
import { chartColor } from '../utils/chart-config.js';
import { apiError, EMPTY_CELL } from '../utils/format.js';
import { formatDateTime, formatRelativeTime as timeAgo } from '../utils/dateFormat.js';
import { useToast } from '../ui/useToast.js';

const store = useAnomalyStore();
const toast = useToast();

const state = ref('idle'); // idle | loading | error | ready
const error = ref('');
const filter = ref('all');
const hoverId = ref(null);
const openId = ref(null);
const drawerOpen = ref(false);
const drawerRef = ref(null);
const clientState = ref('idle');
const clientError = ref('');
const evidenceState = ref('idle');
const evidenceError = ref('');
const allowlistVisible = ref(false);
const allowlistTarget = ref(null);
// feature -> ranked names for the open device's flagged window, or null
// while loading; missing means the signal has no name-level evidence.
const signalEvidence = ref({});

// ── queue ────────────────────────────────────────────────────────────
// Learning devices have nothing scored to triage; they are a count in the
// rail. Everything else the classifier returns is a flagged device.
const clients = computed(() =>
  classifyClients(store.events, store.learning).filter((c) => c.pattern !== 'learning'),
);
const counts = computed(() => ({ all: clients.value.length, ...summaryCounts(clients.value) }));
const queueClients = computed(() =>
  clients.value
    .filter((c) => filter.value === 'all' || c.pattern === filter.value)
    .slice()
    // Most anomalous first: the LOWEST score, since negative means anomalous.
    .sort((a, b) => (a.latestScore ?? 1) - (b.latestScore ?? 1)),
);

function severityColor(severity) {
  if (severity === 'high') return chartColor('err');
  if (severity === 'medium') return chartColor('warn');
  return chartColor('info');
}

const queueRows = computed(() =>
  queueClients.value.map((c) => ({
    id: c.identity,
    name: c.hostname || c.client_ip,
    ip: c.client_ip,
    patternLabel: PATTERNS[c.pattern]?.label || c.pattern,
    scoreLabel: c.latestScore != null ? c.latestScore.toFixed(2) : EMPTY_CELL,
    color: severityColor(c.latestSeverity),
    spark: c.sparkline.map((p) => p.score),
  })),
);
const queueNote = computed(() =>
  state.value === 'ready' ? `${queueRows.value.length} devices, ranked by score` : '',
);

// ── map ──────────────────────────────────────────────────────────────
function dotColor(row) {
  if (row.is_anomaly && !row.resolved) return severityColor(row.severity);
  if (row.flagged_24h > 0) return chartColor('info');
  return chartColor('track');
}
const mapPoints = computed(() =>
  store.map.map((row) => ({
    id: row.identity,
    name: row.hostname || row.client_ip,
    ip: row.client_ip,
    score: row.anomaly_score,
    threat: row.threat_score,
    severity: row.severity,
    flagged24h: row.flagged_24h || 0,
    actionable: !!row.is_anomaly || row.flagged_24h > 0,
    color: dotColor(row),
  })),
);
const peerScores = computed(() =>
  store.map.map((r) => r.anomaly_score).filter((v) => typeof v === 'number'),
);

// ── rail ─────────────────────────────────────────────────────────────
const rail = computed(() => {
  const summary = store.summary;
  const daemon = summary?.daemon;
  return {
    monitored: summary?.clients_monitored ?? EMPTY_CELL,
    learning: summary?.clients_learning ?? EMPTY_CELL,
    flaggedWindows: store.events.length,
    lastScored: daemon?.last_score ? timeAgo(daemon.last_score) : EMPTY_CELL,
    lastTrained: daemon?.last_train ? timeAgo(daemon.last_train) : EMPTY_CELL,
    sidecar: !summary
      ? EMPTY_CELL
      : !summary.enabled
        ? 'disabled'
        : daemon?.stale
          ? 'stale'
          : 'healthy',
    sidecarOk: !!summary?.enabled && !daemon?.stale,
  };
});

// ── detail ───────────────────────────────────────────────────────────
const isMac = (id) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(id || '');

// Window bounds arrive in whichever shape wrote the row: the scoring sidecar
// writes Python isoformat ('2026-09-07T02:00:00+00:00'), SQLite's own
// datetime() writes '2026-09-07 02:00:00'. The second carries no zone marker
// and would be read as local time, so mark it UTC.
function isoish(value) {
  if (!value) return value;
  const withT = String(value).replace(' ', 'T');
  return /([zZ]|[+-]\d{2}:?\d{2})$/.test(withT) ? withT : `${withT}Z`;
}

const detail = computed(() => {
  if (!openId.value) return null;
  const c = clients.value.find((x) => x.identity === openId.value) || null;
  const p = store.map.find((x) => x.identity === openId.value) || null;
  if (!c && !p) return null;
  const score = c?.latestScore ?? p?.anomaly_score ?? null;
  const factors = [...(c?.latestTopFeatures || [])]
    .sort((a, b) => b.contribution - a.contribution)
    .map((f) => ({ ...f, evidence: signalEvidence.value[f.feature] ?? null }));
  const ev = store.clientEvidence;
  const model = store.clientModel;
  const modelParts = [];
  if (model?.trained_at) modelParts.push(`model trained ${timeAgo(model.trained_at)}`);
  if (model?.training_rows != null) modelParts.push(`${model.training_rows} training windows`);
  return {
    identity: openId.value,
    name: c?.hostname || p?.hostname || c?.client_ip || p?.client_ip,
    ip: c?.client_ip || p?.client_ip,
    mac: isMac(openId.value) ? openId.value : null,
    modelNote: modelParts.join(', '),
    pattern: c?.pattern || null,
    patternLabel: c ? PATTERNS[c.pattern]?.label || c.pattern : 'Within baseline',
    patternIcon: c ? PATTERNS[c.pattern]?.icon || '' : '',
    note: c?.note || 'Every recent window scored inside the learned baseline.',
    score,
    severity: c?.latestSeverity ?? p?.severity ?? null,
    history: store.clientHistory,
    factors,
    trends: buildFeatureTrends(store.clientHistory, factors),
    fingerprint: store.fingerprintChanges[0] || null,
    evidence: {
      rows: (ev?.rows || []).map((row) => ({
        domain: row.domain,
        type: row.query_type,
        response:
          row.action && row.action.startsWith('blocked')
            ? 'BLOCKED'
            : row.response_code || 'NOERROR',
        count: row.count,
      })),
      summary: ev?.summary || null,
      truncated: !!ev?.truncated,
      windowLabel: ev
        ? `${formatDateTime(isoish(ev.window_start))} to ${formatDateTime(isoish(ev.window_end))}`
        : '',
      withinRetention: ev ? ev.window_within_retention !== false : true,
      retentionDays: ev?.retention_days ?? 7,
    },
  };
});

// ── selection and the drawer ─────────────────────────────────────────
// Previous and Next walk the queue as it is currently filtered, which is the
// list the user is looking at. A device opened from the map that is not in
// the queue (within baseline) has no neighbors.
const openIndex = computed(() => queueRows.value.findIndex((r) => r.id === openId.value));
const hasPrev = computed(() => openIndex.value > 0);
const hasNext = computed(
  () => openIndex.value >= 0 && openIndex.value < queueRows.value.length - 1,
);
const position = computed(() =>
  openIndex.value >= 0 ? `${openIndex.value + 1} of ${queueRows.value.length}` : '',
);

let loadSeq = 0;
async function loadClient(identity) {
  const token = ++loadSeq;
  clientState.value = 'loading';
  clientError.value = '';
  evidenceState.value = 'loading';
  evidenceError.value = '';
  signalEvidence.value = {};
  store.clearClient();
  // The history, model and fingerprint calls are independent of the evidence
  // call: a device with no flagged window 404s on evidence and still has a
  // timeline worth showing.
  const history = store.fetchClientHistory(identity, 500).catch((err) => {
    if (token === loadSeq) clientError.value = apiError(err);
  });
  const model = store.fetchClientModel(identity).catch(() => {});
  const fingerprint = store.fetchFingerprintChanges(identity).catch(() => {});
  const evidence = store
    .fetchClientEvidence(identity)
    .then(() => {
      if (token === loadSeq) evidenceState.value = 'ready';
    })
    .catch((err) => {
      if (token !== loadSeq) return;
      evidenceState.value = err?.response?.status === 404 ? 'none' : 'error';
      evidenceError.value = apiError(err);
    });
  await Promise.all([history, model, fingerprint, evidence]);
  if (token === loadSeq && evidenceState.value === 'ready') loadSignalEvidence(identity, token);
  if (token === loadSeq) clientState.value = clientError.value ? 'error' : 'ready';
}

// One request per contributing factor that has name-level evidence, in
// parallel, after the window itself is known. A factor whose request fails
// simply shows no list; the factor line above it still stands.
async function loadSignalEvidence(identity, token) {
  const client = clients.value.find((x) => x.identity === identity);
  const features = (client?.latestTopFeatures || [])
    .map((f) => f.feature)
    .filter((f) => SIGNAL_EVIDENCE_FEATURES.has(f));
  const windowStart = store.clientEvidence?.window_start || null;
  await Promise.all(
    features.map(async (feature) => {
      try {
        const data = await store.fetchSignalEvidence(identity, feature, { windowStart });
        if (token === loadSeq) signalEvidence.value = { ...signalEvidence.value, [feature]: data };
      } catch {
        /* the factor stays, just without its list */
      }
    }),
  );
}

// Opening animates the drawer in. Picking another device while it is open
// only swaps the content: the drawer element never leaves, so no transition
// runs.
async function select(id) {
  if (!id) return;
  openId.value = id;
  drawerOpen.value = true;
  await loadClient(id);
}
function close() {
  drawerOpen.value = false;
  openId.value = null;
  store.clearClient();
}
function step(delta) {
  const next = queueRows.value[openIndex.value + delta];
  if (next) select(next.id);
}

// A click anywhere outside the drawer collapses it, unless it landed on
// another map dot or queue row (those carry data-triage-target and repopulate
// instead). The allowlist dialog and toasts are teleported to body and are
// not "outside" either.
function onPointerDown(event) {
  if (!drawerOpen.value) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (
    target.closest('.evidence-drawer') ||
    target.closest('[data-triage-target]') ||
    target.closest('.p-dialog, .p-dialog-mask, .p-toast, .p-popover')
  ) {
    return;
  }
  close();
}
function onKeydown(event) {
  if (!drawerOpen.value || allowlistVisible.value) return;
  if (event.key === 'Escape') close();
  else if (event.key === 'ArrowLeft') step(-1);
  else if (event.key === 'ArrowRight') step(1);
}

// ── actions ──────────────────────────────────────────────────────────
function openAllowlist() {
  if (!detail.value) return;
  allowlistTarget.value = {
    client_ip: detail.value.ip,
    hostname: detail.value.name !== detail.value.ip ? detail.value.name : null,
    identity: detail.value.identity,
  };
  allowlistVisible.value = true;
}
async function onAllowlisted() {
  close();
  await Promise.all([store.fetchMap(), store.fetchSummary()]).catch(() => {});
}
async function acknowledge() {
  try {
    await store.acknowledgeCounter();
    toast.add({ severity: 'success', summary: 'Notification counter cleared', life: 2500 });
  } catch (err) {
    toast.add({ severity: 'error', summary: apiError(err), life: 4000 });
  }
}

// ── loading ──────────────────────────────────────────────────────────
async function load() {
  state.value = 'loading';
  error.value = '';
  try {
    await Promise.all([store.fetchSummary(), store.fetchEvents(7), store.fetchMap()]);
    state.value = 'ready';
  } catch (err) {
    state.value = 'error';
    error.value = apiError(err);
  }
}
async function refresh() {
  await load();
  if (drawerOpen.value && openId.value) await loadClient(openId.value);
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeydown);
  load();
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', onPointerDown);
  window.removeEventListener('keydown', onKeydown);
});
useAutoRefresh(refresh);
</script>

<style scoped>
/* The page fills the analytics content area and, from 860px up, hands all
   scrolling to its panels: the queue and the Evidence drawer scroll inside
   themselves, so the content area itself only scrolls when the header and
   rail alone do not fit. */
@media (min-width: 860px) {
  .anomaly-triage {
    height: 100%;
    min-height: 0;
  }
  .triage-board {
    flex: 1;
    min-height: 0;
    grid-template-rows: minmax(0, 1fr);
  }
  .triage-board > * {
    max-height: 100%;
    overflow: auto;
  }
}
.triage-board {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
@media (max-width: 860px) {
  .triage-board {
    grid-template-columns: 1fr;
  }
}

/* Wide screens: the drawer takes a third column so the map stays in view.
   Narrow screens: it overlays from the right over a backdrop. */
@media (min-width: 1200px) {
  .drawer-open .triage-board {
    grid-template-columns: 240px minmax(0, 1fr) minmax(400px, 40%);
  }
  .triage-board :deep(.evidence-drawer) {
    height: 100%;
    overflow: auto;
  }
  .drawer-backdrop {
    display: none;
  }
}
@media (max-width: 1199px) {
  .triage-board :deep(.evidence-drawer) {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(600px, 100vw);
    border-radius: 0;
    overflow: auto;
    z-index: 1100;
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
  }
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 1099;
  }
}
.drawer-enter-active,
.drawer-leave-active {
  transition:
    transform 0.2s ease,
    opacity 0.2s ease;
}
.drawer-enter-from,
.drawer-leave-to {
  transform: translateX(40px);
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .drawer-enter-active,
  .drawer-leave-active {
    transition: none;
  }
}
</style>
