<!-- Analytics "Performance": how fast the resolver answers, how often it
     fails and why, and what it costs the box. The proxy's minute rows
     (/api/metrics/proxy-perf) carry the speed and the failed answers by
     cause; the forwarder's (/api/metrics/forwarder) what each upstream
     did; /api/metrics/dns-failures the names that failed. Same
     grammar as the health board. -->
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

    <section class="panel" aria-label="Failed answers" data-track="performance-resolver">
      <div class="panel-head">
        <h2>Failed answers</h2>
        <span class="panel-note">{{ failedNote }}</span>
      </div>
      <div class="figures" style="--figures: 4">
        <FigureCard v-bind="figures.failedRate" />
        <FigureCard v-bind="figures.dnssecFailed" />
        <FigureCard v-bind="figures.upstreamFailed" />
        <FigureCard v-bind="failoverFigure" />
      </div>
    </section>

    <div class="board three">
      <section class="panel" aria-label="Failures by cause">
        <div class="panel-head">
          <h2>Failures by cause</h2>
          <span class="panel-note">by the error code it carried</span>
        </div>
        <div class="panel-body" data-track="performance-resolver-causes">
          <SeriesChart
            :rows="rows"
            :series="FAILURE_SERIES"
            :range="selectedRange"
            noun="failed answers"
          />
        </div>
      </section>

      <section class="panel" aria-label="Upstreams">
        <div class="panel-head">
          <h2>Upstreams</h2>
          <span class="panel-note">{{ upstreamNote }}</span>
        </div>
        <div class="panel-body" data-track="performance-resolver-upstreams">
          <SeriesChart
            :rows="forwarder.rows"
            :series="UPSTREAM_SERIES"
            :range="selectedRange"
            :stacked="false"
            noun="upstream queries"
          />
        </div>
      </section>

      <section class="panel" aria-label="Upstream latency">
        <div class="panel-head">
          <h2>Upstream latency</h2>
          <span class="panel-note">p95 of each provider's slowest address</span>
        </div>
        <div class="panel-body" data-track="performance-resolver-latency">
          <SeriesChart
            :rows="forwarder.rows"
            :series="upstreamLatencySeries"
            :range="selectedRange"
            :stacked="false"
            unit="ms"
            noun="latency samples"
          />
        </div>
      </section>
    </div>

    <section class="panel" aria-label="Failed names and upstreams">
      <div class="panel-body lists">
        <TopList
          title="Names that failed"
          :rows="failedNames"
          count-header="Failed"
          empty-text="No failed answers in this range"
          track="performance-resolver-failed-name"
        />
        <TopList
          title="Upstreams"
          :rows="providerRows"
          count-header="Answers"
          empty-text="Nothing was forwarded in this range"
          track="performance-resolver-provider"
        />
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
import TopList from '../components/TopList.vue';
import { FAILURE_COLUMNS, failedNameRows } from '../utils/proxy-perf.js';
import {
  failoverFigureOf,
  providerLatencySeries,
  providerListRows,
  summarizeForwarder,
} from '../utils/forwarder-perf.js';
import { FAILURE_CAUSES, FAILURE_LABELS } from '@shared/dns-ede.js';

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
const FAILURE_COLORS = {
  dnssec: 'err',
  upstream: 'warn',
  timeout: 'info',
  refused: 3,
  other: 'muted',
};
const FAILURE_SERIES = FAILURE_CAUSES.map((cause) => ({
  key: FAILURE_COLUMNS[cause],
  label: FAILURE_LABELS[cause],
  color: FAILURE_COLORS[cause],
}));
const UPSTREAM_SERIES = [
  { key: 'timeouts', label: 'Timeouts', color: 'err' },
  { key: 'drops', label: 'Dropped, resent', color: 'warn' },
  { key: 'connect_failures', label: 'Refused connections', color: 3 },
  { key: 'failovers', label: 'Failovers', color: 'info' },
];
const MEMORY_SERIES = [
  { key: 'rss_mb', label: 'RSS', color: 'info', aggregate: 'avg', summary: 'latest' },
  { key: 'heap_mb', label: 'Heap', color: 'ok', aggregate: 'avg', summary: 'latest' },
];
const CPU_SERIES = [{ key: 'cpu', label: 'CPU', color: 'info', aggregate: 'avg', summary: 'avg' }];

const summary = computed(() => summarizeProxyPerf(rows.value));
const forwarder = computed(() => summarizeForwarder(store.forwarder || []));
const upstreamLatencySeries = computed(() => providerLatencySeries(forwarder.value.providers));
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
const failedNote = computed(
  () =>
    `${rangeLabel.value} · DNSSEC failures are answers that did not validate; upstream failures are queries no upstream answered`,
);
const upstreamNote = computed(() =>
  forwarder.value.providers.length
    ? `forwarding · ${formatNumber(
        forwarder.value.providers.reduce((t, p) => t + p.answers, 0),
      )} answers in the range`
    : 'nothing was forwarded',
);
const failoverFigure = computed(() => failoverFigureOf(forwarder.value));
const failedNames = computed(() => failedNameRows(store.dnsFailures));
const providerRows = computed(() => providerListRows(forwarder.value));
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

function refreshAll() {
  return store.track(() =>
    Promise.all([
      store.fetchProxyPerf(selectedRange.value),
      store.fetchForwarder(selectedRange.value),
      store.fetchDnsFailures(selectedRange.value),
      store.fetchSystemHealth(),
      store.fetchServices(),
    ]),
  );
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
@media (max-width: 1100px) {
  .figures.five {
    --figures: 3;
  }
}
@media (max-width: 860px) {
  .process {
    grid-template-columns: 1fr;
  }
}
</style>
