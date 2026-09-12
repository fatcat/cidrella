<template>
  <div class="anomaly-preview" data-track="anomalies-workspace-preview">
    <header class="preview-banner">
      <div>
        <div class="preview-kicker">Interactive concept</div>
        <h1>Anomaly triage</h1>
        <p v-if="mode === 'sample'">
          The detector reports {{ SAMPLE_STATUS.flaggedWindows }} flagged windows. Six of them are worth your
          evening. This surface separates <b>unusual for this device</b> from <b>shaped like an attack</b>,
          then shows the DNS traffic that earned the flag.
        </p>
        <p v-else>
          Your own detector, in the new layout. The queue, the score history and the evidence table are live.
          Threat shape and peer medians are not, because nothing computes them yet.
        </p>
      </div>
      <div class="preview-banner-actions">
        <div class="mode-switch" role="group" aria-label="Data source">
          <button type="button" :aria-pressed="mode === 'sample'" data-track="anomaly-preview-mode"
                  @click="setMode('sample')">Sample</button>
          <button type="button" :aria-pressed="mode === 'live'" data-track="anomaly-preview-mode"
                  @click="setMode('live')">Live data</button>
        </div>
        <router-link to="/analytics" class="quiet-link" data-track="anomaly-preview-back">
          <i class="pi pi-arrow-left" /> Current interface
        </router-link>
      </div>
    </header>

    <section class="status-rail" aria-label="Detector status">
      <div>
        <span class="k">Needs review</span>
        <span class="v lead">{{ rail.needsReview }}</span>
      </div>
      <div>
        <span class="k">Flagged windows, {{ mode === 'sample' ? '24h' : '7d' }}</span>
        <span class="v">{{ rail.flaggedWindows }}</span>
      </div>
      <div>
        <span class="k">Devices monitored</span>
        <span class="v">{{ rail.monitored }} <small>/ {{ rail.learning }} learning</small></span>
      </div>
      <div>
        <span class="k">Last scored</span>
        <span class="v">{{ rail.lastScored }}</span>
      </div>
      <div>
        <span class="k">Model trained</span>
        <span class="v">{{ rail.lastTrained }}</span>
      </div>
      <div>
        <span class="k">Sidecar</span>
        <span class="v" :class="rail.sidecarOk ? 'ok' : 'warn'">
          {{ rail.sidecar }} <small v-if="rail.sidecarNote">{{ rail.sidecarNote }}</small>
        </span>
      </div>
    </section>

    <div class="triage-row">
      <section class="panel queue-panel" aria-label="Triage queue">
        <div class="panel-head">
          <h2>Queue</h2>
          <span class="panel-note">{{ queueNote }}</span>
        </div>
        <div class="queue-filters">
          <button v-for="filter in FILTERS" :key="filter.id" type="button" class="chip"
                  :aria-pressed="activeFilter === filter.id" data-track="anomaly-preview-filter"
                  @click="activeFilter = filter.id">
            {{ filter.label }} {{ allRows.filter(filter.match).length }}
          </button>
        </div>

        <div class="queue-state" v-if="mode === 'live' && liveState === 'loading'">Loading your detector data...</div>
        <div class="queue-state error" v-else-if="mode === 'live' && liveState === 'error'">{{ liveError }}</div>
        <div class="queue-state" v-else-if="!queueRows.length">
          No devices match this filter.
        </div>
        <div class="queue" v-else>
          <div v-for="row in queueRows" :key="row.id" class="queue-item"
               :class="{ current: row.id === selectedId }">
            <button type="button" class="queue-row"
                    :aria-current="row.id === selectedId" data-track="anomaly-preview-queue-row"
                    @click="selectDevice(row.id)">
              <span class="row-stripe" :style="{ background: BAND_COLORS[row.band] }"></span>
              <span class="row-main">
                <span class="row-who">
                  <b>{{ row.name }}</b>
                  <code>{{ row.ip }}</code>
                </span>
                <span class="row-why">{{ row.why }}</span>
                <span class="row-tags" v-if="row.tags.length">
                  <span v-for="(tag, index) in row.tags" :key="tag"
                        class="row-tag" :class="{ hot: index === 0 && row.band === 'critical' }">{{ tag }}</span>
                </span>
              </span>
              <span class="row-right">
                <span class="row-urgency" :style="{ color: BAND_COLORS[row.band] }">{{ row.scoreLabel }}</span>
                <svg v-if="row.spark.length > 1" class="row-spark" viewBox="0 0 76 20" width="76" height="20"
                     aria-hidden="true">
                  <path :d="sparkPath(row.spark)" fill="none" :stroke="BAND_COLORS[row.band]"
                        stroke-width="1.4" stroke-linejoin="round" transform="translate(0 1)" />
                </svg>
              </span>
            </button>
            <button type="button" class="row-detail" data-track="anomaly-preview-row-detail"
                    :aria-label="`Show detail for ${row.name}`" @click="openDetail(row.id)">
              <i class="pi pi-window-maximize" aria-hidden="true" />
              <span>Detail</span>
            </button>
          </div>
        </div>
      </section>

      <section class="panel map-panel" v-if="mode === 'sample'">
        <div class="panel-head">
          <h2>Triage map, last 24 hours</h2>
          <span class="panel-note">One dot per device. Click a dot to open it.</span>
        </div>
        <div class="map-body">
          <svg class="map-svg" :viewBox="`0 0 ${MAP.w} ${MAP.h}`" role="img"
               aria-label="Devices plotted by deviation from their own baseline against threat shape">
            <rect :x="mapX(50)" :y="mapY(100)" :width="mapX(100) - mapX(50)" :height="mapY(50) - mapY(100)"
                  fill="var(--p-red-400)" opacity="0.07" />
            <g v-for="tick in MAP_TICKS" :key="tick">
              <line :x1="mapX(tick)" :y1="mapY(0)" :x2="mapX(tick)" :y2="mapY(100)"
                    stroke="var(--preview-line)" stroke-width="1" />
              <line :x1="mapX(0)" :y1="mapY(tick)" :x2="mapX(100)" :y2="mapY(tick)"
                    stroke="var(--preview-line)" stroke-width="1" />
              <text :x="mapX(tick)" :y="MAP.h - MAP.pad.b + 16" text-anchor="middle"
                    class="axis-num">{{ tick }}</text>
              <text :x="MAP.pad.l - 9" :y="mapY(tick) + 3" text-anchor="end" class="axis-num">{{ tick }}</text>
            </g>
            <text :x="(mapX(0) + mapX(100)) / 2" :y="MAP.h - 8" text-anchor="middle" class="axis-label">
              Deviation from this device's own baseline
            </text>
            <text :x="14" :y="(mapY(0) + mapY(100)) / 2" text-anchor="middle" class="axis-label"
                  :transform="`rotate(-90 14 ${(mapY(0) + mapY(100)) / 2})`">
              Threat shape index
            </text>
            <text :x="mapX(98)" :y="mapY(96)" text-anchor="end" class="quad-label hot">INVESTIGATE</text>
            <text :x="mapX(2)" :y="mapY(96)" class="quad-label">Suspicious, steady</text>
            <text :x="mapX(98)" :y="mapY(2)" text-anchor="end" class="quad-label">Just unusual</text>

            <circle v-for="point in mapPoints" :key="point.id"
                    class="map-dot" :class="{ selected: point.selected, actionable: point.actionable }"
                    :cx="point.cx" :cy="point.cy" :r="point.r"
                    :fill="point.color" :fill-opacity="point.actionable ? 0.85 : 0.45"
                    :stroke="point.ringed ? point.color : 'transparent'" stroke-width="1.5" stroke-opacity="0.55"
                    data-track="anomaly-preview-map-dot" @click="selectDevice(point.id)">
              <title>{{ point.title }}</title>
            </circle>
            <text :x="leadLabel.x" :y="leadLabel.y" text-anchor="end" class="lead-label">{{ leadLabel.text }}</text>
          </svg>

          <div class="map-legend">
            <div class="legend-row" v-for="entry in LEGEND" :key="entry.band">
              <span class="legend-swatch" :style="{ background: BAND_COLORS[entry.band] }"></span>
              <span>
                <b>{{ entry.title }}</b>
                <small>{{ entry.body }}</small>
              </span>
            </div>
            <p class="legend-foot">
              Dot size is query volume in the window. A ring means the device was flagged on 3 or more
              of the last 24 windows.
            </p>
          </div>
        </div>
      </section>

      <section class="panel missing-axis" v-else>
        <i class="pi pi-info-circle" />
        <p>
          The triage map is sample only. Its vertical axis is a threat shape score over entropy, NXDOMAIN rate,
          name length, subdomain depth and block rate, and nothing computes that yet. Switch back to Sample to
          see the shape of it.
        </p>
      </section>
    </div>

    <div class="detail-backdrop" v-if="detailOpen" @click="closeDetail"></div>

    <div class="board as-modal" v-if="detailOpen">
      <section class="panel entity-panel" aria-live="polite" role="dialog" aria-modal="true"
               :aria-label="`Detail for ${detail ? detail.name : 'device'}`">
        <div class="detail-nav">
          <button type="button" class="nav-button" :disabled="!hasPrev" data-track="anomaly-preview-detail-prev"
                  @click="stepDetail(-1)">
            <i class="pi pi-chevron-left" aria-hidden="true" /> Previous
          </button>
          <button type="button" class="nav-button" :disabled="!hasNext" data-track="anomaly-preview-detail-next"
                  @click="stepDetail(1)">
            Next <i class="pi pi-chevron-right" aria-hidden="true" />
          </button>
          <span class="detail-pos" v-if="detailIndex >= 0">{{ detailIndex + 1 }} of {{ queueRows.length }}</span>
          <button type="button" class="nav-close" aria-label="Close detail" data-track="anomaly-preview-detail-close"
                  @click="closeDetail">
            <i class="pi pi-times" aria-hidden="true" />
          </button>
        </div>

        <div class="entity-body">
        <div class="queue-state" v-if="!detail">
          {{ mode === 'live' ? 'Select a flagged device to see its history and evidence.' : 'Select a device.' }}
        </div>
        <template v-else>
          <div class="entity-head">
            <div>
              <h3>{{ detail.name }}</h3>
              <div class="entity-ids">
                <span>{{ detail.ip }}</span>
                <span v-if="detail.mac">{{ detail.mac }}</span>
                <span v-if="detail.role">{{ detail.role }}</span>
              </div>
            </div>
            <div class="entity-badges">
              <span class="badge strong" :style="{ color: BAND_COLORS[detail.band], borderColor: BAND_COLORS[detail.band] }">
                {{ detail.severity || 'unscored' }} severity
              </span>
              <span class="badge">{{ detail.patternLabel }}</span>
              <span class="badge" v-if="detail.modelNote">{{ detail.modelNote }}</span>
            </div>
          </div>

          <div class="verdict">
            <span class="verdict-bar" :style="{ background: BAND_COLORS[detail.band] }"></span>
            <div>
              <p class="verdict-lede">{{ detail.verdictLede }}</p>
              <p class="verdict-body">{{ detail.verdict }}</p>
            </div>
          </div>

          <div class="entity-section" v-if="chart">
            <h4>Score history, {{ detail.scores.length }} windows</h4>
            <p class="section-hint">
              One point per scored window. Lower is more anomalous. Raw isolation forest score, latest
              <b>{{ detail.rawScore != null ? detail.rawScore.toFixed(2) : EMPTY_CELL }}</b>.
            </p>
            <svg class="score-chart" :viewBox="`0 0 ${CHART.w} ${CHART.h}`" role="img"
                 :aria-label="`Anomaly score history for ${detail.name}`">
              <rect :x="CHART.pad.l" :y="chart.bandTop" :width="CHART.w - CHART.pad.l - CHART.pad.r"
                    :height="chart.bandHeight" fill="var(--p-green-400)" opacity="0.13" />
              <text :x="CHART.pad.l + 6" :y="chart.bandTop + 12" class="axis-num">learned normal range</text>
              <g v-for="row in chart.rows" :key="row.value">
                <line :x1="CHART.pad.l" :y1="row.y" :x2="CHART.w - CHART.pad.r" :y2="row.y"
                      stroke="var(--preview-line)" stroke-width="1" />
                <text :x="CHART.pad.l - 8" :y="row.y + 3" text-anchor="end" class="axis-num">{{ row.label }}</text>
              </g>
              <line :x1="CHART.pad.l" :y1="chart.thresholdY" :x2="CHART.w - CHART.pad.r" :y2="chart.thresholdY"
                    stroke="var(--p-orange-400)" stroke-width="1.2" stroke-dasharray="5 4" />
              <text :x="CHART.w - CHART.pad.r" :y="chart.thresholdY - 5" text-anchor="end" class="threshold-label">
                flag threshold {{ FLAG_THRESHOLD.toFixed(2) }}
              </text>
              <path :d="chart.line" fill="none" :stroke="BAND_COLORS[detail.band]" stroke-width="1.8"
                    stroke-linejoin="round" />
              <circle v-for="(point, index) in chart.flagged" :key="index" :cx="point.x" :cy="point.y" r="2.6"
                      :fill="BAND_COLORS[detail.band]" />
              <circle :cx="chart.last.x" :cy="chart.last.y" r="4.2" :fill="BAND_COLORS[detail.band]"
                      stroke="var(--p-surface-card)" stroke-width="1.5" />
              <text v-for="mark in chart.marks" :key="mark.label" :x="mark.x" :y="CHART.h - 8"
                    :text-anchor="mark.anchor" class="axis-num">{{ mark.label }}</text>
            </svg>
          </div>

          <div class="entity-section" v-if="detail.signals.length">
            <h4>Why it was flagged</h4>
            <p class="section-hint">
              Observed value against this device's own median.
              <template v-if="mode === 'sample'">
                Peer median is the median across the other {{ SAMPLE_STATUS.monitored - 1 }} monitored devices.
              </template>
              <template v-else>
                Peer median needs the full feature vector per window, which is not stored yet.
              </template>
            </p>
            <div class="table-scroll">
              <table class="signal-table">
                <thead>
                  <tr>
                    <th>Signal</th>
                    <th class="num">Observed</th>
                    <th class="num">Its baseline</th>
                    <th class="num">Peer median</th>
                    <th class="weight-col">Weight</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="signal in detail.signals" :key="signal.key">
                    <td>
                      <div>{{ signal.label }}</div>
                      <code class="feature-key">{{ signal.key }}</code>
                    </td>
                    <td class="num observed" :style="{ color: BAND_COLORS[detail.band] }">
                      {{ signal.format(signal.observed) }}
                    </td>
                    <td class="num">{{ signal.format(signal.baseline) }}</td>
                    <td class="num" :class="{ muted: signal.peer == null }">
                      {{ signal.peer == null ? 'not collected' : signal.format(signal.peer) }}
                    </td>
                    <td>
                      <span class="weight">
                        <svg viewBox="0 0 100 12" width="100" height="12" aria-hidden="true">
                          <rect x="0" y="3" width="100" height="6" rx="3" fill="var(--preview-line)" />
                          <rect x="0" y="3" :width="Math.min(100, signal.contribution * 100)" height="6" rx="3"
                                :fill="BAND_COLORS[detail.band]" />
                        </svg>
                        <small>{{ Math.round(signal.contribution * 100) }}%</small>
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="entity-section">
            <h4>Evidence{{ detail.windowLabel ? `, flagged window ${detail.windowLabel}` : '' }}</h4>
            <p class="section-hint">
              The actual queries behind the score. This is the answer to "is it really dangerous", and it is
              the one thing the current page cannot show you.
            </p>

            <div class="evidence-state" v-if="mode === 'live' && evidenceState === 'loading'">
              Loading the traffic for this window...
            </div>
            <div class="evidence-state error" v-else-if="mode === 'live' && evidenceState === 'error'">
              {{ evidenceError }}
            </div>
            <div class="evidence-state" v-else-if="mode === 'live' && store.clientEvidence && !store.clientEvidence.window_within_retention && !detail.evidence.length">
              This window is older than the {{ store.clientEvidence.retention_days }} day analytics retention,
              so the queries behind it have been pruned. The score survives for 30 days, the traffic does not.
            </div>
            <div class="evidence-state" v-else-if="!detail.evidence.length">
              No queries recorded for this window.
            </div>
            <template v-else>
              <div class="evidence-summary" v-if="detail.evidenceSummary">
                <span><b>{{ detail.evidenceSummary.total_queries.toLocaleString() }}</b> queries</span>
                <span><b>{{ detail.evidenceSummary.distinct_domains.toLocaleString() }}</b> distinct domains</span>
                <span><b>{{ detail.evidenceSummary.nxdomain_count.toLocaleString() }}</b> NXDOMAIN</span>
                <span><b>{{ detail.evidenceSummary.blocked_count.toLocaleString() }}</b> blocked</span>
              </div>
              <div class="table-scroll">
                <table class="evidence-table">
                  <thead>
                    <tr>
                      <th>Domain</th>
                      <th class="type-col">Type</th>
                      <th class="resp-col">Response</th>
                      <th class="num count-col">Queries</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, index) in detail.evidence" :key="`${row.domain}-${row.type}-${index}`">
                      <td class="domain">{{ row.domain }}</td>
                      <td class="qtype">{{ row.type }}</td>
                      <td>
                        <span class="rcode" :class="rcodeClass(row.response)">{{ row.response }}</span>
                      </td>
                      <td class="num">{{ row.count.toLocaleString() }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="section-hint truncated" v-if="detail.evidenceTruncated">
                Showing the top {{ detail.evidence.length }} groups. Raise the limit to see the tail.
              </p>
            </template>
          </div>

          <div class="entity-actions">
            <button type="button" class="action primary" data-track="anomaly-preview-action"
                    @click="notify('Open in DNS log')">Open in DNS log</button>
            <button type="button" class="action" data-track="anomaly-preview-action"
                    v-if="detail.signals.length"
                    @click="notify(`Mute ${detail.signals[0].key} for this device`)">
              Mute {{ detail.signals[0].key }} for this device
            </button>
            <button type="button" class="action" data-track="anomaly-preview-action"
                    @click="notify('Mark benign, keep scoring')">Mark benign, keep scoring</button>
            <button type="button" class="action" data-track="anomaly-preview-action"
                    @click="notify('Whitelist device')">Whitelist device</button>
            <button type="button" class="action" data-track="anomaly-preview-action"
                    @click="notify('Retrain baseline')">Retrain baseline</button>
          </div>
        </template>
        </div>
      </section>
    </div>

    <section class="panel backend-notes" aria-label="What this needs from the backend">
      <div v-for="note in BACKEND_NOTES" :key="note.title">
        <h5>{{ note.title }}</h5>
        <p>{{ note.body }}</p>
        <code>{{ note.ref }}</code>
      </div>
    </section>

    <div class="preview-toast" :class="{ visible: !!notice }" role="status">{{ notice }}</div>
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import {
  ALL_DEVICES,
  BACKEND_NOTES,
  BAND_COLORS,
  DETECTOR_STATUS as SAMPLE_STATUS,
  FLAG_THRESHOLD,
  REVIEW_DEVICES,
  SCORE_CEILING,
  SCORE_FLOOR,
  formatSignalValue,
  scoreSeries,
} from './anomalies-workspace-data.js';
import { useAnomalyStore } from '../stores/anomalies.js';
import { classifyClients, PATTERNS } from '../utils/anomaly-pattern.js';
import { formatFeatureValue } from '../utils/anomaly-features.js';
import { apiError, EMPTY_CELL } from '../utils/format.js';
import { formatDateTime, formatRelativeTime as timeAgo } from '../utils/dateFormat.js';

const store = useAnomalyStore();

const LEGEND = [
  { band: 'critical', title: 'Investigate', body: 'Off its own baseline and the traffic looks like tunneling, DGA or scanning.' },
  { band: 'suspicious', title: 'Suspicious shape, steady', body: 'Always does this. Either it is compromised and patient, or the shape is normal for it.' },
  { band: 'unusual', title: 'Just unusual', body: 'Changed its habits, but the traffic is ordinary. New app, new owner, firmware update.' },
  { band: 'quiet', title: 'Quiet', body: 'Within baseline. Shown so the map is a network view, not an alert list.' },
];

// Filters run over normalized rows so the same chips work against sample data
// and against whatever the detector actually found.
const FILTERS = [
  { id: 'review', label: 'Needs review', match: row => row.reviewable },
  { id: 'escalating', label: 'Escalating', match: row => row.pattern === 'escalating' },
  { id: 'recurring', label: 'Recurring', match: row => row.pattern === 'recurring' },
  { id: 'one-off', label: 'One-off', match: row => row.pattern === 'one-off' },
  { id: 'all', label: 'All devices', match: () => true },
];

const MAP = { w: 760, h: 430, pad: { l: 56, r: 16, t: 18, b: 46 } };
const MAP_TICKS = [0, 25, 50, 75, 100];
const CHART = { w: 720, h: 210, pad: { l: 42, r: 14, t: 12, b: 26 } };
const CHART_ROWS = [0, -0.2, -0.4, -0.6, -0.8];

const mode = ref('sample');
const activeFilter = ref('review');
const selectedId = ref(REVIEW_DEVICES[0].id);
const notice = ref('');
const liveState = ref('idle');
const liveError = ref('');
const evidenceState = ref('idle');
const evidenceError = ref('');
let noticeTimer;

// ── sample rows ──────────────────────────────────────────────────────
const sampleRows = computed(() => ALL_DEVICES.map(device => ({
  id: device.id,
  name: device.name,
  ip: device.ip,
  band: device.band,
  pattern: device.pattern,
  scoreLabel: String(device.urgency),
  why: device.why || (device.pattern === 'learning'
    ? `Learning, ${device.trainingWindows} of 48 training windows collected.`
    : 'Within baseline for the last 24 windows.'),
  tags: device.tags || [],
  spark: scoreSeries(device),
  reviewable: !!device.signals,
  sortKey: device.urgency,
})));

// ── live rows ────────────────────────────────────────────────────────
// classifyClients already groups /anomalies/events by identity and names the
// shape of each client's history, so the queue reuses it rather than inventing
// a second classifier.
const liveClients = computed(() => classifyClients(store.events, store.learning));

// The classifier's vocabulary and the sample data's overlap but are not
// identical: it calls a spike that went quiet "resolved", the sample calls the
// same shape "one-off". Normalize so one set of filter chips serves both.
function normalizePattern(pattern) {
  if (pattern === 'resolved') return 'one-off';
  return pattern;
}

function bandFor(client) {
  if (client.pattern === 'learning') return 'quiet';
  if (client.latestSeverity === 'high') return 'critical';
  if (client.latestSeverity === 'medium') return 'unusual';
  return 'quiet';
}

const liveRows = computed(() => liveClients.value.map(client => ({
  id: client.identity,
  name: client.hostname || client.client_ip,
  ip: client.client_ip,
  band: bandFor(client),
  pattern: normalizePattern(client.pattern),
  scoreLabel: client.latestScore != null ? client.latestScore.toFixed(2) : EMPTY_CELL,
  why: client.note,
  tags: (client.latestTopFeatures || []).slice(0, 3).map(entry => entry.feature),
  spark: client.sparkline.map(point => point.score),
  reviewable: client.pattern !== 'learning',
  // More anomalous is a lower (more negative) score, so sort ascending by it.
  sortKey: client.latestScore != null ? -client.latestScore : -1,
})));

const allRows = computed(() => (mode.value === 'sample' ? sampleRows.value : liveRows.value));

const queueRows = computed(() => {
  const filter = FILTERS.find(entry => entry.id === activeFilter.value) || FILTERS[0];
  return allRows.value.filter(filter.match).slice().sort((a, b) => b.sortKey - a.sortKey);
});

const queueNote = computed(() => {
  if (mode.value === 'live' && liveState.value !== 'ready') return 'live data';
  const unit = mode.value === 'sample' ? 'ranked by urgency' : 'ranked by score';
  return `${queueRows.value.length} devices, ${unit}`;
});

// ── status rail ──────────────────────────────────────────────────────
const rail = computed(() => {
  if (mode.value === 'sample') {
    return {
      needsReview: SAMPLE_STATUS.needsReview,
      flaggedWindows: SAMPLE_STATUS.flaggedWindows,
      monitored: SAMPLE_STATUS.monitored,
      learning: SAMPLE_STATUS.learning,
      lastScored: SAMPLE_STATUS.lastScored,
      lastTrained: SAMPLE_STATUS.lastTrained,
      sidecar: 'Healthy',
      sidecarNote: `heartbeat ${SAMPLE_STATUS.heartbeat}`,
      sidecarOk: true,
    };
  }
  const summary = store.summary;
  const daemon = summary?.daemon;
  return {
    needsReview: liveRows.value.filter(row => row.reviewable).length,
    flaggedWindows: store.events.length,
    monitored: summary?.clients_monitored ?? EMPTY_CELL,
    learning: summary?.clients_learning ?? EMPTY_CELL,
    lastScored: daemon?.last_score ? timeAgo(daemon.last_score) : EMPTY_CELL,
    lastTrained: daemon?.last_train ? timeAgo(daemon.last_train) : EMPTY_CELL,
    sidecar: !summary?.enabled ? 'Disabled' : (daemon?.stale ? 'Stale' : 'Healthy'),
    sidecarNote: daemon?.heartbeat_age_sec != null ? `heartbeat ${daemon.heartbeat_age_sec}s` : null,
    sidecarOk: !!summary?.enabled && !daemon?.stale,
  };
});

// ── triage map, sample only ──────────────────────────────────────────
function mapX(value) {
  return MAP.pad.l + (value / 100) * (MAP.w - MAP.pad.l - MAP.pad.r);
}
function mapY(value) {
  return MAP.h - MAP.pad.b - (value / 100) * (MAP.h - MAP.pad.t - MAP.pad.b);
}

const mapPoints = computed(() => ALL_DEVICES.map(device => ({
  id: device.id,
  cx: mapX(device.deviation),
  cy: mapY(device.threatShape),
  r: Number((5 + Math.sqrt(device.queries) / 11).toFixed(1)),
  color: BAND_COLORS[device.band],
  actionable: !!device.signals,
  ringed: device.flaggedWindows >= 3,
  selected: device.id === selectedId.value,
  title: `${device.name} · ${device.ip} · ${device.queries.toLocaleString()} queries`,
})));

const leadLabel = computed(() => {
  const lead = REVIEW_DEVICES[0];
  return { x: mapX(lead.deviation) - 12, y: mapY(lead.threatShape) - 16, text: lead.name };
});

// ── entity detail ────────────────────────────────────────────────────
const sampleDetail = computed(() => {
  const device = REVIEW_DEVICES.find(entry => entry.id === selectedId.value);
  if (!device) return null;
  return {
    name: device.name,
    ip: device.ip,
    mac: device.mac,
    role: `${device.role}, ${device.owner}`,
    band: device.band,
    severity: device.severity,
    patternLabel: `${device.pattern}, ${device.flaggedWindows} of last 24 windows`,
    modelNote: `model trained on ${device.trainingWindows} windows`,
    verdictLede: device.verdictLede,
    verdict: device.verdict,
    rawScore: device.rawScore,
    scores: scoreSeries(device),
    signals: device.signals.map(signal => ({
      key: signal.feature.key,
      label: signal.feature.label,
      observed: signal.observed,
      baseline: signal.baseline,
      peer: signal.peer,
      contribution: signal.contribution,
      format: value => formatSignalValue(signal.feature, value),
    })),
    windowLabel: '03:00 to 04:00',
    evidence: device.evidence.map(row => ({
      domain: row.domain, type: row.type, response: row.response, count: row.count,
    })),
    evidenceSummary: null,
    evidenceTruncated: false,
  };
});

const liveDetail = computed(() => {
  const client = liveClients.value.find(entry => entry.identity === selectedId.value);
  if (!client) return null;

  // clientHistory arrives newest first; the chart reads left to right.
  const history = [...store.clientHistory]
    .sort((a, b) => String(a.window_start).localeCompare(String(b.window_start)));
  const evidence = store.clientEvidence;
  const isMac = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(client.identity);

  return {
    name: client.hostname || client.client_ip,
    ip: client.client_ip,
    mac: isMac ? client.identity : null,
    role: null,
    band: bandFor(client),
    severity: client.latestSeverity,
    patternLabel: `${PATTERNS[client.pattern]?.label || client.pattern}, ${client.eventCount} flagged windows`,
    modelNote: store.clientModel?.training_rows != null
      ? `model trained on ${store.clientModel.training_rows} windows`
      : null,
    verdictLede: PATTERNS[client.pattern]?.label || 'Flagged',
    verdict: client.note,
    rawScore: client.latestScore,
    scores: history.map(row => row.anomaly_score),
    signals: (client.latestTopFeatures || []).map(entry => ({
      key: entry.feature,
      label: entry.label,
      observed: entry.observed,
      baseline: entry.baseline,
      peer: null,
      contribution: entry.contribution,
      format: value => formatFeatureValue(entry.feature, value),
    })),
    windowLabel: evidence
      ? `${formatDateTime(isoish(evidence.window_start))} to ${formatDateTime(isoish(evidence.window_end))}`
      : null,
    evidence: (evidence?.rows || []).map(row => ({
      domain: row.domain,
      type: row.query_type,
      response: row.action && row.action.startsWith('blocked') ? 'BLOCKED' : (row.response_code || 'NOERROR'),
      count: row.count,
    })),
    evidenceSummary: evidence?.summary || null,
    evidenceTruncated: !!evidence?.truncated,
  };
});

const detail = computed(() => (mode.value === 'sample' ? sampleDetail.value : liveDetail.value));

// Window bounds arrive in whichever shape wrote the row: the scoring sidecar
// writes Python isoformat ('2026-09-07T02:00:00+00:00'), SQLite's own
// datetime() writes '2026-09-07 02:00:00'. The second carries no zone marker
// and would be read as local time, so mark it UTC. The first already says so,
// and appending a second marker would produce an Invalid Date.
function isoish(value) {
  if (!value) return value;
  const withT = String(value).replace(' ', 'T');
  return /([zZ]|[+-]\d{2}:?\d{2})$/.test(withT) ? withT : `${withT}Z`;
}

// ── charts ───────────────────────────────────────────────────────────
function chartX(index, length) {
  if (length < 2) return CHART.pad.l;
  return CHART.pad.l + (index / (length - 1)) * (CHART.w - CHART.pad.l - CHART.pad.r);
}
function chartY(value) {
  return CHART.pad.t + (value / SCORE_FLOOR) * (CHART.h - CHART.pad.t - CHART.pad.b);
}

const chart = computed(() => {
  const values = detail.value?.scores || [];
  if (values.length < 2) return null;
  const points = values.map((value, index) => ({ x: chartX(index, values.length), y: chartY(value), value }));
  const bandTop = chartY(-0.14);
  const marks = [{ x: chartX(0, values.length), label: `${values.length} windows ago`, anchor: 'start' }];
  if (values.length > 4) {
    marks.push({ x: chartX(Math.floor(values.length / 2), values.length), label: 'midpoint', anchor: 'middle' });
  }
  marks.push({ x: chartX(values.length - 1, values.length), label: 'latest', anchor: 'end' });

  return {
    bandTop,
    bandHeight: chartY(-0.34) - bandTop,
    thresholdY: chartY(FLAG_THRESHOLD),
    rows: CHART_ROWS.map(value => ({ value, y: chartY(value), label: value.toFixed(1) })),
    line: points.map((point, index) =>
      `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' '),
    flagged: points.filter(point => point.value <= FLAG_THRESHOLD),
    last: points[points.length - 1],
    marks,
  };
});

function sparkPath(values) {
  const span = SCORE_CEILING - SCORE_FLOOR;
  return values.map((value, index) => {
    const x = (index / (values.length - 1)) * 76;
    const y = 18 - ((value - SCORE_FLOOR) / span) * 18;
    return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function rcodeClass(response) {
  if (response === 'NXDOMAIN') return 'nx';
  if (response === 'BLOCKED') return 'blocked';
  return '';
}

// ── data loading ─────────────────────────────────────────────────────
async function setMode(next) {
  if (mode.value === next) return;
  detailOpen.value = false;
  mode.value = next;
  selectedId.value = next === 'sample' ? REVIEW_DEVICES[0].id : null;
  store.clearClient();
  if (next === 'live') await loadLive();
}

async function loadLive() {
  liveState.value = 'loading';
  liveError.value = '';
  try {
    await Promise.all([store.fetchSummary(), store.fetchEvents(7)]);
    liveState.value = 'ready';
    const first = liveRows.value.find(row => row.reviewable);
    if (first) await selectLive(first.id);
  } catch (err) {
    liveState.value = 'error';
    liveError.value = apiError(err);
  }
}

async function selectLive(identity) {
  selectedId.value = identity;
  store.clearClient();
  evidenceState.value = 'loading';
  evidenceError.value = '';
  // The history and model calls are independent of the evidence call, so one
  // failing (a client with no trained model, say) must not blank the other.
  store.fetchClientHistory(identity).catch(() => {});
  store.fetchClientModel(identity).catch(() => {});
  try {
    await store.fetchClientEvidence(identity);
    evidenceState.value = 'ready';
  } catch (err) {
    evidenceState.value = 'error';
    evidenceError.value = apiError(err);
  }
}

// Returns whether the device was actually selected. Callers that open the
// detail dialog need to know: a refused selection leaves the previous device
// in place, and opening on that would show the wrong device's evidence.
function selectDevice(id) {
  if (mode.value === 'live') {
    const row = liveRows.value.find(entry => entry.id === id);
    if (!row?.reviewable) {
      notify('That device is still learning its baseline, there is nothing scored to review.');
      return false;
    }
    selectLive(id);
    return true;
  }
  if (!REVIEW_DEVICES.some(device => device.id === id)) {
    notify('That device is within baseline, nothing to review.');
    return false;
  }
  selectedId.value = id;
  return true;
}

// The detail card doubles as a dialog. Next and previous walk the queue as it
// is currently filtered, which is the list the user is looking at, so a filter
// change re-bounds them rather than stepping through hidden devices.
const detailOpen = ref(false);
const detailIndex = computed(() => queueRows.value.findIndex(row => row.id === selectedId.value));
const hasPrev = computed(() => detailIndex.value > 0);
const hasNext = computed(() => detailIndex.value >= 0 && detailIndex.value < queueRows.value.length - 1);

function openDetail(id) {
  if (selectDevice(id)) detailOpen.value = true;
}

function closeDetail() {
  detailOpen.value = false;
}

function stepDetail(delta) {
  const next = queueRows.value[detailIndex.value + delta];
  if (next) selectDevice(next.id);
}

function onDialogKeydown(event) {
  if (!detailOpen.value) return;
  if (event.key === 'Escape') { closeDetail(); return; }
  if (event.key === 'ArrowLeft') stepDetail(-1);
  if (event.key === 'ArrowRight') stepDetail(1);
}
window.addEventListener('keydown', onDialogKeydown);
onUnmounted(() => window.removeEventListener('keydown', onDialogKeydown));

function notify(message) {
  notice.value = message.endsWith('.') ? message : `${message}: concept only, nothing was changed.`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = ''; }, 2600);
}

// A filter change can strip the selected row out of the queue. Follow it to
// the top of whatever is still showing rather than leaving a detail panel
// that no longer matches anything in the list.
watch(queueRows, rows => {
  if (!rows.length || rows.some(row => row.id === selectedId.value)) return;
  const next = rows.find(row => row.reviewable);
  if (!next) return;
  if (mode.value === 'live') selectLive(next.id);
  else selectedId.value = next.id;
});

onUnmounted(() => clearTimeout(noticeTimer));
</script>

<style scoped>
.anomaly-preview {
  --preview-accent: var(--p-primary-color);
  --preview-accent-soft: color-mix(in srgb, var(--preview-accent) 12%, transparent);
  --preview-line: color-mix(in srgb, var(--p-surface-border) 82%, transparent);
  --preview-muted: var(--p-text-muted-color);
  --triage-row-min: 22rem;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 100%;
  padding: 1.1rem;
  box-sizing: border-box;
  color: var(--p-text-color);
  background:
    radial-gradient(circle at 80% 0%, color-mix(in srgb, var(--preview-accent) 7%, transparent), transparent 27rem),
    var(--p-surface-ground);
}
button { font: inherit; color: inherit; }

.preview-banner { display: flex; align-items: flex-end; justify-content: space-between; gap: 2rem; margin-bottom: 1rem; }
.preview-banner h1 { margin: 0.12rem 0 0.25rem; font-size: clamp(1.35rem, 2vw, 2rem); letter-spacing: -0.035em; }
.preview-banner p { margin: 0; max-width: 68ch; color: var(--preview-muted); font-size: var(--app-fs-base); }
.preview-banner b { color: var(--p-text-color); font-weight: 700; }
.preview-kicker { color: var(--preview-accent); font-size: 0.65rem; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
.preview-banner-actions { display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0; }
.quiet-link { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.15rem; border-radius: 999px; color: var(--preview-accent); font-size: var(--app-fs-sm); font-weight: 700; text-decoration: none; }

.mode-switch { display: inline-flex; padding: 0.15rem; border: 1px solid var(--preview-line); border-radius: 999px; background: var(--p-surface-card); }
.mode-switch button { padding: 0.3rem 0.8rem; border: 0; border-radius: 999px; background: transparent; color: var(--preview-muted); font-size: var(--app-fs-sm); cursor: pointer; }
.mode-switch button[aria-pressed="true"] { background: var(--preview-accent-soft); color: var(--p-text-color); font-weight: 700; }

.status-rail {
  display: flex; flex-wrap: wrap; margin-bottom: 1rem;
  background: var(--p-surface-card); border: 1px solid var(--preview-line); border-radius: 10px; overflow: hidden;
}
.status-rail > div { flex: 1 1 9rem; min-width: 0; padding: 0.65rem 1rem; border-right: 1px solid var(--preview-line); }
.status-rail > div:last-child { border-right: 0; }
.status-rail .k { display: block; color: var(--preview-muted); font-size: 0.62rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.status-rail .v { display: block; margin-top: 0.1rem; font-size: 1.2rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.status-rail .v small { color: var(--preview-muted); font-size: 0.75rem; font-weight: 400; }
.status-rail .v.lead { color: var(--p-red-400); }
.status-rail .v.ok { color: var(--p-green-400); }
.status-rail .v.warn { color: var(--p-orange-400); }

.panel { background: var(--p-surface-card); border: 1px solid var(--preview-line); border-radius: 12px; }
.panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; padding: 0.8rem 1rem; border-bottom: 1px solid var(--preview-line); }
.panel-head h2 { margin: 0; font-size: var(--app-fs-base); font-weight: 700; }
.panel-note { color: var(--preview-muted); font-size: var(--app-fs-sm); }

.map-panel, .missing-axis { margin-bottom: 0; }
.missing-axis { display: flex; gap: 0.7rem; align-items: flex-start; padding: 0.8rem 1rem; }
.missing-axis i { margin-top: 0.15rem; color: var(--preview-accent); }
.missing-axis p { margin: 0; max-width: 90ch; color: var(--preview-muted); font-size: var(--app-fs-sm); }
.map-body { display: grid; grid-template-columns: minmax(0, 1fr) 16rem; }
.map-svg { display: block; box-sizing: border-box; width: 100%; height: 100%; padding: 0.5rem 0.6rem 0; }
.map-legend { padding: 0.9rem 1rem; border-left: 1px solid var(--preview-line); }
.legend-row { display: flex; gap: 0.55rem; align-items: flex-start; margin-bottom: 0.75rem; }
.legend-swatch { width: 0.62rem; height: 0.62rem; margin-top: 0.25rem; border-radius: 2px; flex: none; }
.legend-row b { display: block; font-size: var(--app-fs-sm); }
.legend-row small { color: var(--preview-muted); font-size: 0.72rem; line-height: 1.35; }
.legend-foot { margin: 0; padding-top: 0.7rem; border-top: 1px solid var(--preview-line); color: var(--preview-muted); font-size: 0.72rem; }
.axis-num { fill: var(--preview-muted); font-size: 10px; font-family: var(--font-mono, monospace); }
.axis-label { fill: var(--preview-muted); font-size: 11.5px; }
.quad-label { fill: var(--preview-muted); font-size: 11px; }
.quad-label.hot { fill: var(--p-red-400); font-weight: 700; }
.lead-label { fill: var(--preview-muted); font-size: 11px; font-family: var(--font-mono, monospace); }
.map-dot.actionable { cursor: pointer; }
.map-dot.selected { stroke: var(--p-text-color); stroke-width: 2.5; stroke-opacity: 1; }

/* One height shared by the queue and the map, taken from whatever the window
   leaves over. Both panels are flex columns that fill it, and the queue list
   scrolls inside its own panel rather than stretching the row. */
.triage-row { display: grid; grid-template-columns: 27rem minmax(0, 1fr); gap: 1rem; align-items: stretch; flex: 1; min-height: var(--triage-row-min); margin-bottom: 1rem; }
.triage-row > .panel { display: flex; min-height: 0; flex-direction: column; overflow: hidden; }
.map-body { flex: 1; min-height: 0; }
.map-legend { overflow-y: auto; }
/* Live mode swaps the map for a short note. Stretching that to the full row
   height would just be a tall empty box, so let it keep its own size. */
.triage-row > .missing-axis { align-self: start; }
.board { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; align-items: start; margin-bottom: 1rem; }

/* The detail card is the same element whether it is sitting at the bottom of
   the page or opened as a dialog, so there is one copy of its markup. Opening
   it just lifts it out with position: fixed. */
.detail-backdrop {
  position: fixed; inset: 0; z-index: 40;
  background: color-mix(in srgb, #000 55%, transparent);
}
.board.as-modal {
  position: fixed; z-index: 41; top: 5vh; left: 10vw; width: 80vw; height: 90vh; margin: 0;
}
.board.as-modal .entity-panel {
  display: flex; min-height: 0; height: 100%; flex-direction: column; overflow: hidden;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
}
/* Only the card body scrolls, so the nav stays put while reading a long one. */
.board.as-modal .entity-body { flex: 1; min-height: 0; overflow-y: auto; }
.detail-nav {
  display: flex; align-items: center; gap: 0.5rem; padding: 0.55rem 0.7rem;
  border-bottom: 1px solid var(--preview-line); background: var(--p-surface-ground);
}
.nav-button {
  display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.3rem 0.6rem;
  border: 1px solid var(--preview-line); border-radius: 7px; background: var(--p-surface-card);
  font-size: var(--app-fs-sm); font-weight: 700; cursor: pointer;
}
.nav-button:hover:not(:disabled) { border-color: var(--preview-accent); color: var(--preview-accent); }
.nav-button:disabled { opacity: 0.45; cursor: default; }
.detail-pos { color: var(--preview-muted); font-size: 0.7rem; font-variant-numeric: tabular-nums; }
.nav-close {
  display: inline-flex; align-items: center; justify-content: center; width: 1.9rem; height: 1.9rem;
  margin-left: auto; border: 1px solid var(--preview-line); border-radius: 7px;
  background: var(--p-surface-card); color: var(--preview-muted); cursor: pointer;
}
.nav-close:hover { border-color: var(--preview-accent); color: var(--preview-accent); }

.queue-filters { display: flex; flex-wrap: wrap; gap: 0.35rem; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--preview-line); }
.chip { padding: 0.15rem 0.6rem; border: 1px solid var(--preview-line); border-radius: 999px; background: transparent; color: var(--preview-muted); font-size: 0.72rem; cursor: pointer; }
.chip:hover { border-color: var(--preview-accent); color: var(--p-text-color); }
.chip[aria-pressed="true"] { background: var(--preview-accent-soft); border-color: var(--preview-accent); color: var(--p-text-color); font-weight: 700; }

.queue-state, .evidence-state { padding: 1.2rem 1.1rem; color: var(--preview-muted); font-size: var(--app-fs-sm); }
.queue-state.error, .evidence-state.error { color: var(--p-red-400); }
.evidence-state { padding: 0.6rem 0; }

.queue { flex: 1; min-height: 0; overflow-y: auto; }
.queue-item { display: flex; align-items: stretch; border-bottom: 1px solid var(--preview-line); }
.queue-item:hover { background: color-mix(in srgb, var(--p-surface-ground) 60%, transparent); }
.queue-item.current { background: var(--preview-accent-soft); }
.queue-row {
  display: grid; grid-template-columns: 4px 1fr auto; gap: 0.6rem; min-width: 0; flex: 1;
  padding: 0.65rem 0.85rem 0.65rem 0; border: 0;
  background: transparent; text-align: left; cursor: pointer;
}
.row-detail {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.22rem;
  width: 4rem; flex: none; padding: 0 0.3rem; border: 0; border-left: 1px solid var(--preview-line);
  background: transparent; color: var(--preview-muted); font-size: 0.6rem; font-weight: 700;
  letter-spacing: 0.04em; cursor: pointer;
}
.row-detail i { font-size: 0.78rem; }
.row-detail:hover { color: var(--preview-accent); background: var(--preview-accent-soft); }
.row-stripe { border-radius: 0 2px 2px 0; }
.row-who { display: flex; align-items: baseline; gap: 0.4rem; min-width: 0; }
.row-who b { overflow: hidden; font-size: var(--app-fs-sm); font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.row-who code { color: var(--preview-muted); font-size: 0.68rem; }
.row-why { display: block; margin-top: 0.1rem; color: var(--preview-muted); font-size: 0.72rem; }
.row-tags { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.35rem; }
.row-tag { padding: 0 0.3rem; border: 1px solid var(--preview-line); border-radius: 3px; color: var(--preview-muted); font-family: var(--font-mono, monospace); font-size: 0.62rem; }
.row-tag.hot { border-color: var(--p-red-400); color: var(--p-red-400); }
.row-right { display: flex; flex-direction: column; align-items: flex-end; gap: 0.2rem; }
.row-urgency { font-size: 1.05rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.row-spark { display: block; }

.entity-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.9rem; padding: 0.9rem 1.1rem; border-bottom: 1px solid var(--preview-line); }
.entity-head h3 { margin: 0; font-size: 1.15rem; font-weight: 700; letter-spacing: -0.01em; }
.entity-ids { display: flex; flex-wrap: wrap; gap: 0.65rem; margin-top: 0.15rem; color: var(--preview-muted); font-family: var(--font-mono, monospace); font-size: 0.72rem; }
.entity-badges { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.badge { padding: 0.15rem 0.5rem; border: 1px solid var(--preview-line); border-radius: 4px; color: var(--preview-muted); font-size: 0.7rem; white-space: nowrap; }
.badge.strong { font-weight: 700; }

.verdict { display: flex; gap: 0.75rem; padding: 0.85rem 1.1rem; border-bottom: 1px solid var(--preview-line); }
.verdict-bar { width: 3px; border-radius: 2px; flex: none; }
.verdict-lede { margin: 0 0 0.2rem; font-size: var(--app-fs-base); font-weight: 700; }
.verdict-body { margin: 0; max-width: 78ch; font-size: var(--app-fs-sm); }

.entity-section { padding: 0.9rem 1.1rem; border-bottom: 1px solid var(--preview-line); }
.entity-section h4 { margin: 0 0 0.15rem; color: var(--preview-muted); font-size: 0.64rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
.section-hint { margin: 0 0 0.7rem; max-width: 78ch; color: var(--preview-muted); font-size: 0.75rem; }
.section-hint.truncated { margin: 0.5rem 0 0; }
.score-chart { display: block; width: 100%; height: auto; }
.threshold-label { fill: var(--p-orange-400); font-size: 10px; }

.evidence-summary { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 0.7rem; color: var(--preview-muted); font-size: 0.75rem; }
.evidence-summary b { color: var(--p-text-color); font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }

.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: var(--app-fs-sm); }
th { padding: 0 0.5rem 0.35rem 0; border-bottom: 1px solid var(--preview-line); color: var(--preview-muted); font-size: 0.62rem; font-weight: 700; letter-spacing: 0.08em; text-align: left; text-transform: uppercase; }
td { padding: 0.45rem 0.5rem 0.45rem 0; border-bottom: 1px solid var(--preview-line); vertical-align: middle; }
tr:last-child td { border-bottom: 0; }
th.num, td.num { text-align: right; font-family: var(--font-mono, monospace); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
td.observed { font-weight: 700; }
td.muted { color: var(--preview-muted); font-size: 0.68rem; }
.feature-key { color: var(--preview-muted); font-family: var(--font-mono, monospace); font-size: 0.66rem; }
.weight-col { width: 7rem; }
.weight { display: inline-flex; align-items: center; gap: 0.35rem; }
.weight small { color: var(--preview-muted); font-family: var(--font-mono, monospace); font-size: 0.66rem; }
.type-col { width: 4rem; }
.resp-col { width: 7rem; }
.count-col { width: 5rem; }
td.domain { font-family: var(--font-mono, monospace); font-size: 0.74rem; word-break: break-all; }
td.qtype { color: var(--preview-muted); font-family: var(--font-mono, monospace); font-size: 0.72rem; }
.rcode { padding: 0 0.3rem; border: 1px solid var(--preview-line); border-radius: 3px; color: var(--preview-muted); font-family: var(--font-mono, monospace); font-size: 0.66rem; }
.rcode.nx { border-color: var(--p-orange-400); color: var(--p-orange-400); }
.rcode.blocked { border-color: var(--p-purple-400); color: var(--p-purple-400); }

.entity-actions { display: flex; flex-wrap: wrap; gap: 0.45rem; padding: 0.85rem 1.1rem; }
.action { padding: 0.35rem 0.7rem; border: 1px solid var(--preview-line); border-radius: 6px; background: var(--p-surface-ground); font-size: 0.75rem; cursor: pointer; }
.action:hover { border-color: var(--preview-accent); }
.action.primary { border-color: var(--preview-accent); background: var(--preview-accent); color: var(--p-primary-contrast-color); font-weight: 700; }

.backend-notes { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.backend-notes > div { padding: 0.85rem 1rem; border-right: 1px solid var(--preview-line); }
.backend-notes > div:last-child { border-right: 0; }
.backend-notes h5 { margin: 0 0 0.25rem; font-size: var(--app-fs-sm); font-weight: 700; }
.backend-notes p { margin: 0 0 0.3rem; color: var(--preview-muted); font-size: 0.75rem; }
.backend-notes code { color: var(--preview-muted); font-family: var(--font-mono, monospace); font-size: 0.66rem; }

.preview-toast {
  position: fixed; left: 50%; bottom: 1.4rem; transform: translateX(-50%);
  padding: 0.5rem 1rem; border-radius: 7px; background: var(--p-text-color); color: var(--p-surface-ground);
  font-size: var(--app-fs-sm); opacity: 0; pointer-events: none; transition: opacity 0.18s ease;
}
.preview-toast.visible { opacity: 1; }

@media (max-width: 1180px) {
  .anomaly-preview { height: auto; }
  .board.as-modal { top: 2vh; left: 2vw; width: 96vw; height: 96vh; }
  .triage-row { grid-template-columns: 1fr; flex: none; }
  .triage-row > .panel { max-height: 34rem; }
  .board { grid-template-columns: 1fr; }
  .map-body { grid-template-columns: 1fr; }
  .map-legend { border-left: 0; border-top: 1px solid var(--preview-line); }
  .queue { max-height: 26rem; }
}
@media (prefers-reduced-motion: reduce) {
  .preview-toast { transition: none; }
}
</style>
