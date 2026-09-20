<!-- Everything known about one device, in the order a triage reads it: the
     verdict, when it happens (timeline), how it has moved (score history),
     which signals are building, why the latest window tripped, the queries
     behind that window, and where it sits among its peers. Content swaps in
     place when another device is picked; the page animates open and close. -->
<template>
  <aside
    class="evidence-drawer"
    role="dialog"
    :aria-label="detail ? `Evidence for ${detail.name}` : 'Evidence'"
    tabindex="-1"
  >
    <div class="drawer-nav">
      <span class="eyebrow">Evidence</span>
      <span class="spacer"></span>
      <button
        type="button"
        class="nav-button"
        :disabled="!hasPrev"
        data-track="evidence-prev"
        @click="emit('prev')"
      >
        <i class="pi pi-chevron-left" aria-hidden="true" /> Previous
      </button>
      <button
        type="button"
        class="nav-button"
        :disabled="!hasNext"
        data-track="evidence-next"
        @click="emit('next')"
      >
        Next <i class="pi pi-chevron-right" aria-hidden="true" />
      </button>
      <span class="position" v-if="position">{{ position }}</span>
      <button
        type="button"
        class="nav-close"
        aria-label="Close evidence"
        data-track="evidence-close"
        @click="emit('close')"
      >
        <i class="pi pi-times" aria-hidden="true" />
      </button>
    </div>

    <div class="drawer-state" v-if="!detail">Select a device to see its evidence.</div>
    <template v-else>
      <div class="dhead">
        <div>
          <h3>{{ detail.name }}</h3>
          <div class="sub mono">
            {{ detail.ip }}<template v-if="detail.mac"> · {{ detail.mac }}</template>
          </div>
          <div class="sub" v-if="detail.modelNote">{{ detail.modelNote }}</div>
        </div>
        <div class="actions">
          <Button
            label="Acknowledge"
            severity="secondary"
            outlined
            size="small"
            data-track="evidence-acknowledge"
            @click="emit('acknowledge')"
          />
          <Button
            label="Whitelist"
            icon="pi pi-shield"
            severity="secondary"
            outlined
            size="small"
            data-track="evidence-whitelist"
            @click="emit('whitelist')"
          />
        </div>
      </div>

      <div class="fingerprint-warning" v-if="detail.fingerprint">
        <i class="pi pi-exclamation-triangle"></i>
        <div>
          <strong>Device fingerprint changed</strong>
          {{ timeAgo(detail.fingerprint.changed_at) }}, previously identified as
          <b>{{ detail.fingerprint.previous_value }}</b
          >, now <b>{{ detail.fingerprint.new_value }}</b
          >. The physical device behind this address may have changed, including MAC spoofing.
        </div>
      </div>

      <div class="verdict">
        <AnomalyGauge
          v-if="typeof detail.score === 'number'"
          :score="detail.score"
          :severity="detail.severity"
        />
        <div class="verdict-text" :class="detail.pattern">
          <div class="pattern">
            {{ detail.patternIcon }} {{ detail.patternLabel }}
            <span class="sev" v-if="detail.severity">· {{ detail.severity }}</span>
          </div>
          <p>{{ detail.note }}</p>
        </div>
      </div>

      <div class="drawer-state" v-if="state === 'loading'">Loading this device's history...</div>
      <div class="drawer-state error" v-else-if="state === 'error'">{{ error }}</div>
      <template v-else>
        <div class="section" v-if="detail.history.length">
          <h4>
            <span>Behavior timeline</span>
            <span class="range">hour of day by day, darker is more anomalous</span>
          </h4>
          <div class="card"><AnomalyHeatmap :history="detail.history" /></div>
        </div>

        <div class="section" v-if="detail.history.length">
          <h4>
            <span>Score history</span>
            <span class="range">{{ detail.history.length }} windows, flagged points in red</span>
          </h4>
          <div class="card"><AnomalyScoreHistory :history="detail.history" /></div>
        </div>

        <div class="section" v-if="detail.trends.length">
          <h4>
            <span>Contributing signals, trended</span>
            <span class="range">each point is a window where this signal was a top factor</span>
          </h4>
          <div class="features-grid">
            <AnomalyFeatureTrend
              v-for="f in detail.trends"
              :key="f.feature"
              :feature="f.feature"
              :label="f.label"
              :points="f.points"
            />
          </div>
        </div>

        <div class="section" v-if="detail.factors.length">
          <h4><span>Why the latest window was flagged</span></h4>
          <div class="card">
            <div v-for="(f, i) in detail.factors" :key="f.feature" class="factor">
              <div class="factor-top">
                <span class="factor-rank">{{ i + 1 }}.</span>
                <span class="factor-name">{{ f.label }}</span>
                <span class="factor-dir" :class="f.observed > f.baseline ? 'up' : 'down'">
                  {{ f.observed > f.baseline ? '▲' : '▼' }}
                </span>
                <span class="factor-pct mono">{{ Math.round(f.contribution * 100) }}%</span>
              </div>
              <div class="factor-bar">
                <div
                  class="factor-bar-fill"
                  :style="{
                    width: Math.min(f.contribution * 100, 100) + '%',
                    background: contribColor(f.contribution),
                  }"
                ></div>
              </div>
              <div class="factor-vals">
                observed <b>{{ formatFeatureValue(f.feature, f.observed) }}</b> &middot; baseline
                {{ formatFeatureValue(f.feature, f.baseline) }}
              </div>
              <div class="factor-desc">{{ FACTOR_DESCRIPTIONS[f.label] || '' }}</div>
              <div class="factor-evidence" v-if="f.evidence && f.evidence.items.length">
                <div class="factor-evidence-head">
                  The names behind it{{
                    f.evidence.total > f.evidence.items.length
                      ? `, top ${f.evidence.items.length} of ${f.evidence.total.toLocaleString()}`
                      : ''
                  }}
                </div>
                <ul class="factor-names">
                  <li v-for="item in f.evidence.items" :key="item.domain">
                    <span class="mono name">{{ item.domain }}</span>
                    <span class="measure">{{
                      formatSignalValue(f.evidence.metric, item.value)
                    }}</span>
                    <span class="count mono" v-if="f.evidence.metric !== 'count'"
                      >{{ item.count.toLocaleString() }}×</span
                    >
                  </li>
                </ul>
              </div>
              <div class="factor-evidence-none" v-else-if="f.evidence && !f.evidence.items.length">
                No names in this window carry that signal.
              </div>
            </div>
          </div>
        </div>

        <div class="section">
          <h4>
            <span>Queries behind that window</span>
            <span class="range" v-if="detail.evidence.windowLabel">{{
              detail.evidence.windowLabel
            }}</span>
          </h4>
          <div class="drawer-state" v-if="evidenceState === 'loading'">
            Loading the traffic for this window...
          </div>
          <div class="drawer-state error" v-else-if="evidenceState === 'error'">
            {{ evidenceError }}
          </div>
          <div class="drawer-state" v-else-if="evidenceState === 'none'">
            No flagged window for this device, so there is no traffic to show.
          </div>
          <div
            class="drawer-state"
            v-else-if="!detail.evidence.withinRetention && !detail.evidence.rows.length"
          >
            This window is older than the {{ detail.evidence.retentionDays }} day analytics
            retention, so the queries behind it have been pruned. The score survives for 30 days,
            the traffic does not.
          </div>
          <div class="drawer-state" v-else-if="!detail.evidence.rows.length">
            No queries recorded for this window.
          </div>
          <div class="card" v-else>
            <div class="evidence-summary" v-if="detail.evidence.summary">
              <span
                ><b>{{ detail.evidence.summary.total_queries.toLocaleString() }}</b> queries</span
              >
              <span
                ><b>{{ detail.evidence.summary.distinct_domains.toLocaleString() }}</b> distinct
                domains</span
              >
              <span
                ><b>{{ detail.evidence.summary.nxdomain_count.toLocaleString() }}</b> NXDOMAIN</span
              >
              <span
                ><b>{{ detail.evidence.summary.blocked_count.toLocaleString() }}</b> blocked</span
              >
            </div>
            <div class="table-scroll">
              <table class="evidence-table">
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Type</th>
                    <th>Response</th>
                    <th class="num">Queries</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(row, index) in detail.evidence.rows"
                    :key="`${row.domain}-${row.type}-${index}`"
                  >
                    <td class="domain mono">{{ row.domain }}</td>
                    <td>{{ row.type }}</td>
                    <td>
                      <span class="rcode" :class="rcodeClass(row.response)">{{
                        row.response
                      }}</span>
                    </td>
                    <td class="num mono">{{ row.count.toLocaleString() }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="hint" v-if="detail.evidence.truncated">
              Showing the top {{ detail.evidence.rows.length }} groups.
            </p>
          </div>
        </div>

        <div class="section" v-if="peerScores.length > 1 && typeof detail.score === 'number'">
          <h4><span>Network context</span></h4>
          <div class="card"><AnomalyPeerStrip :scores="peerScores" :mine="detail.score" /></div>
        </div>
      </template>
    </template>
  </aside>
</template>

<script setup>
import Button from '../../ui/Button.js';
import AnomalyGauge from '../anomaly/AnomalyGauge.vue';
import AnomalyHeatmap from '../anomaly/AnomalyHeatmap.vue';
import AnomalyScoreHistory from '../anomaly/AnomalyScoreHistory.vue';
import AnomalyFeatureTrend from '../anomaly/AnomalyFeatureTrend.vue';
import AnomalyPeerStrip from '../anomaly/AnomalyPeerStrip.vue';
import {
  formatFeatureValue,
  formatSignalValue,
  FACTOR_DESCRIPTIONS,
} from '../../utils/anomaly-features.js';
import { chartColor } from '../../utils/chart-config.js';
import { formatRelativeTime as timeAgo } from '../../utils/dateFormat.js';

defineProps({
  detail: { type: Object, default: null },
  state: { type: String, default: 'ready' }, // loading | error | ready
  error: { type: String, default: '' },
  evidenceState: { type: String, default: 'ready' }, // loading | error | none | ready
  evidenceError: { type: String, default: '' },
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false },
  position: { type: String, default: '' },
  peerScores: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'prev', 'next', 'whitelist', 'acknowledge']);

function contribColor(contribution) {
  if (contribution > 0.3) return chartColor('err');
  if (contribution > 0.15) return chartColor('warn');
  return chartColor('info');
}
function rcodeClass(response) {
  if (response === 'BLOCKED') return 'blocked';
  if (response === 'NXDOMAIN') return 'nx';
  return '';
}
</script>

<style scoped>
.evidence-drawer {
  background: var(--cid-surface-card);
  border: 1px solid var(--cid-surface-border);
  border-radius: 10px;
  padding: 14px 18px 24px;
  min-width: 0;
}
.mono {
  font-family: var(--mono, ui-monospace, monospace);
}
.drawer-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.eyebrow {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--cid-text-muted-color);
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.nav-button,
.nav-close {
  font: inherit;
  font-size: 0.8rem;
  background: var(--cid-surface-ground);
  color: var(--cid-text-color);
  border: 1px solid var(--cid-surface-border);
  border-radius: 7px;
  padding: 4px 9px;
  cursor: pointer;
}
.nav-button:disabled {
  opacity: 0.45;
  cursor: default;
}
.nav-button:focus-visible,
.nav-close:focus-visible {
  outline: 2px solid var(--cid-primary-color);
  outline-offset: 2px;
}
.position {
  font-size: 0.75rem;
  color: var(--cid-text-muted-color);
}
.dhead {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}
.dhead h3 {
  margin: 0;
  font-size: 1.15rem;
}
.sub {
  font-size: 0.8rem;
  color: var(--cid-text-muted-color);
}
.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.fingerprint-warning {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 0.85rem;
  background: color-mix(in srgb, var(--cid-orange-500, #d08770) 14%, transparent);
}
.verdict {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 14px;
  align-items: center;
  margin-top: 12px;
}
@media (max-width: 560px) {
  .verdict {
    grid-template-columns: 1fr;
  }
}
.verdict-text .pattern {
  font-weight: 600;
}
.verdict-text .sev {
  font-weight: 500;
  color: var(--cid-text-muted-color);
  text-transform: capitalize;
}
.verdict-text p {
  margin: 4px 0 0;
  color: var(--cid-text-muted-color);
  font-size: 0.85rem;
}
.section {
  margin-top: 18px;
}
.section h4 {
  margin: 0 0 8px;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--cid-text-muted-color);
  font-weight: 700;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.section h4 .range {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
  font-size: 0.7rem;
}
.card {
  background: var(--cid-surface-ground);
  border: 1px solid var(--cid-surface-border);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
}
.features-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}
.factor {
  margin-bottom: 10px;
}
.factor-top {
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-size: 0.85rem;
}
.factor-name {
  flex: 1;
}
.factor-dir.up {
  color: var(--cid-red-500, #bf616a);
}
.factor-dir.down {
  color: var(--cid-blue-500, #5e81ac);
}
.factor-bar {
  height: 6px;
  background: var(--cid-surface-border);
  border-radius: 3px;
  margin: 4px 0;
  overflow: hidden;
}
.factor-bar-fill {
  height: 100%;
}
.factor-evidence {
  margin: 6px 0 2px;
  padding: 6px 8px 4px;
  border-left: 2px solid var(--cid-surface-border);
}
.factor-evidence-head,
.factor-evidence-none {
  font-size: 0.72rem;
  color: var(--cid-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.factor-evidence-none {
  text-transform: none;
  letter-spacing: 0;
  margin-top: 4px;
}
.factor-names {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  font-size: 0.8rem;
}
.factor-names li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 10px;
  padding: 2px 0;
  align-items: baseline;
}
.factor-names .name {
  word-break: break-all;
}
.factor-names .measure {
  color: var(--cid-text-color);
  white-space: nowrap;
  font-size: 0.75rem;
}
.factor-names .count {
  color: var(--cid-text-muted-color);
  font-size: 0.72rem;
}
.factor-vals,
.factor-desc,
.hint {
  font-size: 0.78rem;
  color: var(--cid-text-muted-color);
}
.hint {
  margin: 8px 0 0;
}
.drawer-state {
  padding: 10px 0;
  color: var(--cid-text-muted-color);
  font-size: 0.85rem;
}
.drawer-state.error {
  color: var(--cid-red-500, #bf616a);
}
.evidence-summary {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 0.8rem;
  color: var(--cid-text-muted-color);
  margin-bottom: 8px;
}
.evidence-summary b {
  color: var(--cid-text-color);
}
.table-scroll {
  overflow-x: auto;
}
.evidence-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
.evidence-table th {
  text-align: left;
  font-weight: 600;
  color: var(--cid-text-muted-color);
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 4px 6px;
  border-bottom: 1px solid var(--cid-surface-border);
}
.evidence-table td {
  padding: 5px 6px;
  border-bottom: 1px solid var(--cid-surface-border);
  vertical-align: top;
}
.evidence-table .num {
  text-align: right;
}
.evidence-table .domain {
  word-break: break-all;
}
.rcode {
  font-size: 0.7rem;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--cid-surface-border);
  color: var(--cid-text-muted-color);
}
.rcode.blocked {
  background: color-mix(in srgb, var(--cid-red-500, #bf616a) 20%, transparent);
  color: var(--cid-red-500, #bf616a);
}
.rcode.nx {
  background: color-mix(in srgb, var(--cid-orange-500, #d08770) 22%, transparent);
  color: var(--cid-orange-500, #d08770);
}
</style>
