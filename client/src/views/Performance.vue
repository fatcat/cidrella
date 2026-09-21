<!-- Analytics "Performance": how fast the resolver answers and what it costs
     the box. Everything comes from the proxy's minute rows
     (/api/metrics/proxy-perf) over the shared range: the figures the
     Dashboard leads with plus the ones only this page shows, then the
     series behind them. Same grammar as the health board. -->
<template>
  <div class="workspace performance" data-track="analytics-performance">
    <WorkspaceHead
      title="Resolver performance"
      lede="How fast the resolver answers, how often the cache saves a trip upstream, and what the process costs the box."
      track="performance"
      :range="selectedRange"
      :loading="store.loading"
      @update:range="onRange"
      @refresh="refreshAll"
    />

    <section class="status-rail" aria-label="Services">
      <span v-for="chip in chips" :key="chip.key" class="chip" :title="chip.title">
        <StatusDot :kind="chip.tone" :label="chip.label" decorative /> {{ chip.label }}
        <b>{{ chip.value }}</b>
      </span>
    </section>

    <section class="panel" aria-label="Resolution">
      <div class="panel-head">
        <h2>Resolution</h2>
        <span class="panel-note">{{ note }}</span>
      </div>
      <div class="figures five">
        <FigureCard v-bind="figures.perMinute" />
        <FigureCard v-bind="figures.p95" />
        <FigureCard v-bind="figures.hitRate" />
        <FigureCard v-bind="figures.timeouts" />
        <FigureCard v-bind="figures.peakPending" />
      </div>
    </section>

    <div class="board three">
      <section class="panel" aria-label="Latency">
        <div class="panel-head">
          <h2>Latency</h2>
          <span class="panel-note">per minute, averaged into buckets</span>
        </div>
        <div class="panel-body">
          <SeriesChart
            :rows="latencyRows"
            :series="LATENCY_SERIES"
            :range="selectedRange"
            :stacked="false"
            unit="ms"
            noun="latency samples"
          />
        </div>
      </section>

      <section class="panel" aria-label="Queries">
        <div class="panel-head">
          <h2>Queries</h2>
          <span class="panel-note">{{ rangeLabel }}</span>
        </div>
        <div class="panel-body">
          <SeriesChart
            :rows="rows"
            :series="QUERY_SERIES"
            :range="selectedRange"
            :stacked="false"
            noun="queries"
          />
        </div>
      </section>

      <section class="panel" aria-label="Cache">
        <div class="panel-head">
          <h2>Cache</h2>
          <span class="panel-note">hits over misses, the stack is every lookup</span>
        </div>
        <div class="panel-body">
          <SeriesChart :rows="rows" :series="CACHE_SERIES" :range="selectedRange" noun="lookups" />
        </div>
      </section>
    </div>

    <section class="panel" aria-label="Process">
      <div class="panel-head">
        <h2>Process</h2>
        <span class="panel-note">{{ processNote }}</span>
      </div>
      <div class="panel-body process">
        <div>
          <FigureCard v-bind="figures.cpu" :series="[]" />
          <SeriesChart
            :rows="cpuRows"
            :series="CPU_SERIES"
            :range="selectedRange"
            :stacked="false"
            unit="%"
            noun="CPU samples"
          />
        </div>
        <div>
          <FigureCard v-bind="figures.memory" :series="[]" />
          <SeriesChart
            :rows="rows"
            :series="MEMORY_SERIES"
            :range="selectedRange"
            :stacked="false"
            unit=" MB"
            noun="memory samples"
          />
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { useDashboardStore } from '../stores/dashboard.js';
import { rangeLabel as rangeLabelOf } from '../utils/chart-config.js';
import { formatNumber } from '../utils/format.js';
import { proxyPerfFigures, summarizeProxyPerf } from '../utils/proxy-perf.js';
import { serviceChips } from '../utils/service-chips.js';
import { useAutoRefresh } from '../composables/useAutoRefresh.js';
import '../assets/analytics-workspace.css';
import StatusDot from '../components/StatusDot.vue';
import WorkspaceHead from '../components/WorkspaceHead.vue';
import SeriesChart from '../components/SeriesChart.vue';
import FigureCard from '../components/dashboard/FigureCard.vue';

const store = useDashboardStore();
const selectedRange = computed(() => store.selectedRange);
const rows = computed(() => store.proxyPerf || []);
const cores = computed(() => store.systemHealth?.cpu?.cores || 1);

const LATENCY_SERIES = [
  { key: 'latency_avg_ms', label: 'Avg', color: 'info', aggregate: 'avg', summary: 'avg' },
  { key: 'latency_p95_ms', label: 'p95', color: 'warn', aggregate: 'avg', summary: 'avg' },
  {
    key: 'latency_max_ms',
    label: 'Max',
    color: 'err',
    aggregate: 'max',
    summary: 'max',
    outline: true,
  },
];
const QUERY_SERIES = [
  { key: 'query_count', label: 'Queries', color: 'info' },
  { key: 'timeouts', label: 'Timeouts', color: 'err' },
];
const CACHE_SERIES = [
  { key: 'cache_hits', label: 'Hits', color: 'ok' },
  { key: 'cache_misses', label: 'Misses', color: 'warn' },
];
const MEMORY_SERIES = [
  { key: 'rss_mb', label: 'RSS', color: 'info', aggregate: 'avg', summary: 'latest' },
  { key: 'heap_mb', label: 'Heap', color: 'ok', aggregate: 'avg', summary: 'latest' },
];
const CPU_SERIES = [{ key: 'cpu', label: 'CPU', color: 'info', aggregate: 'avg', summary: 'avg' }];

const summary = computed(() => summarizeProxyPerf(rows.value));
const figures = computed(() => proxyPerfFigures(summary.value));
const chips = computed(() => serviceChips(store.services));

// The latency series are stored in microseconds; the chart wants the same
// milliseconds the figures show. Rows without queries carry null latency,
// which the chart draws as a gap rather than a zero.
const ms = (v) => (typeof v === 'number' ? v / 1000 : null);
const latencyRows = computed(() =>
  rows.value.map((r) => ({
    ...r,
    latency_avg_ms: ms(r.latency_avg),
    latency_p95_ms: ms(r.latency_p95),
    latency_max_ms: ms(r.latency_max),
  })),
);
const cpuRows = computed(() =>
  rows.value.map((r, i) => ({ ts: r.ts, cpu: summary.value.series.cpu[i] })),
);

const rangeLabel = computed(() => rangeLabelOf(selectedRange.value));
const note = computed(
  () =>
    `${rangeLabel.value} · ${formatNumber(summary.value.queries)} queries in ${formatNumber(
      summary.value.minutes,
    )} samples`,
);
const processNote = computed(() =>
  cores.value > 1
    ? `CIDRella itself · CPU is of one core, the host has ${cores.value} · heap sits inside RSS`
    : 'CIDRella itself · heap sits inside RSS',
);

async function refreshAll() {
  store.loading = true;
  try {
    await Promise.all([
      store.fetchProxyPerf(selectedRange.value),
      store.fetchSystemHealth(),
      store.fetchServices(),
    ]);
  } finally {
    store.loading = false;
  }
}
async function onRange(value) {
  store.setRange(value);
  await refreshAll();
}

onMounted(refreshAll);
useAutoRefresh(refreshAll);
</script>

<style scoped>
.process {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.process > div {
  display: grid;
  gap: 12px;
}
.figures.five {
  --figures: 5;
}
.board.three {
  --board-columns: repeat(3, minmax(0, 1fr));
}
@media (max-width: 1100px) {
  .figures.five {
    --figures: 3;
  }
  .board.three {
    --board-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 860px) {
  .process {
    grid-template-columns: 1fr;
  }
}
</style>
