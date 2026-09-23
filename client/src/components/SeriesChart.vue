<!-- One area chart of minute rows, one dataset per series, with a legend of
     chips underneath instead of Chart.js's own legend; clicking a chip hides
     its series, so a small one can be read against the axis on its own. The rows are
     re-bucketed here so a week does not draw ten thousand points; how a
     bucket combines its minutes (sum for counts, avg for a gauge like
     latency, max for a peak) and what the legend chip shows (the total, the
     average, the max, the latest) are per series so one component serves
     traffic counts and process gauges alike. -->
<template>
  <div class="series-chart">
    <div class="chart-box" :style="{ height: `${height}px` }">
      <Line v-if="hasData" :data="chartData" :options="options" />
      <div v-else class="empty">No {{ noun }} in this range.</div>
    </div>
    <div class="legend">
      <button
        v-for="(s, i) in legend"
        :key="`${s.key}-${i}`"
        type="button"
        class="chip"
        :class="{ off: hidden.has(s.key) }"
        :aria-pressed="!hidden.has(s.key)"
        :title="hidden.has(s.key) ? `Show ${s.label}` : `Hide ${s.label}`"
        @click="toggle(s.key)"
      >
        <i class="sw" :style="{ background: s.color }" aria-hidden="true"></i>
        {{ s.label }} <b class="mono">{{ s.text }}</b>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import '../assets/analytics-workspace.css';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
} from 'chart.js';
import { Line } from 'vue-chartjs';
import {
  chartColor,
  chartThemeVersion,
  makeLineOptions,
  withAlpha,
} from '../utils/chart-config.js';
import { formatEpoch } from '../utils/dateFormat.js';
import { EMPTY_CELL, formatNumber } from '../utils/format.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

const props = defineProps({
  rows: { type: Array, required: true }, // [{ ts, ...values }] minute rows, ascending
  // [{ key, label, color, aggregate?, summary?, outline? }] drawn bottom to top.
  // aggregate: how a bucket combines its minutes, sum (default) | avg | max.
  // summary: what the legend chip shows, total (default) | avg | max | latest.
  // outline: a line with no fill, for an envelope like a max whose fill
  // would otherwise tint everything under it.
  series: { type: Array, required: true },
  range: { type: String, default: '24h' },
  noun: { type: String, default: 'traffic' },
  unit: { type: String, default: '' }, // appended to legend and tooltip values
  buckets: { type: Number, default: 96 }, // target points across the range
  height: { type: Number, default: 180 },
  // Stacked when the series are parts of one total (answered + blocked).
  // Overlaid when they are views of one thing (requests and replies, RSS and heap).
  stacked: { type: Boolean, default: true },
});

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const hidden = ref(new Set());
function toggle(key) {
  const next = new Set(hidden.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hidden.value = next;
}

function combine(values, how) {
  const present = values.map(num).filter((v) => v !== null);
  if (how === 'sum') return present.reduce((s, v) => s + v, 0);
  if (!present.length) return null;
  if (how === 'max') return Math.max(...present);
  return present.reduce((s, v) => s + v, 0) / present.length;
}

// Combine minute rows into at most `buckets` evenly sized bins so the chart
// stays readable at any range. The last bin is partial and still drawn.
const bucketed = computed(() => {
  const rows = props.rows || [];
  if (!rows.length) return [];
  const span = Math.max(1, Math.ceil(rows.length / props.buckets));
  const out = [];
  for (let i = 0; i < rows.length; i += span) {
    const slice = rows.slice(i, i + span);
    const bin = {
      ts: slice[0].ts,
      values: props.series.map((s) =>
        combine(
          slice.map((r) => r[s.key]),
          s.aggregate || 'sum',
        ),
      ),
    };
    out.push(bin);
  }
  return out;
});

function summarize(s) {
  const values = (props.rows || []).map((r) => r[s.key]);
  const how = s.summary || 'total';
  if (how === 'latest') {
    const present = values.map(num).filter((v) => v !== null);
    return present.length ? present[present.length - 1] : null;
  }
  return combine(values, how === 'total' ? 'sum' : how);
}

const fmt = (v) =>
  v === null
    ? EMPTY_CELL
    : `${formatNumber(v >= 10 ? Math.round(v) : Math.round(v * 10) / 10)}${props.unit}`;

const legend = computed(() => {
  chartThemeVersion.value;
  return props.series.map((s) => {
    const value = summarize(s);
    return { ...s, color: chartColor(s.color), value, text: fmt(value) };
  });
});

// A series with a summary of null has no samples; one that sums to zero has
// nothing to draw either. A gauge (avg, max, latest) at zero is still data.
const hasData = computed(() =>
  legend.value.some((s) => s.value !== null && ((s.summary || 'total') !== 'total' || s.value > 0)),
);

const chartData = computed(() => ({
  labels: bucketed.value.map((r) => formatEpoch(r.ts, props.range)),
  // Built by hand rather than through lineDataset(), which takes a palette
  // NAME and would resolve the hex the legend already holds to its default.
  datasets: legend.value.map((s, i) => ({
    label: s.label,
    data: bucketed.value.map((r) => r.values[i]),
    borderColor: s.color,
    backgroundColor: withAlpha(s.color, props.stacked ? 0.35 : 0.18),
    borderWidth: 1.5,
    fill: !s.outline,
    tension: 0.2,
    pointRadius: 0,
    pointHitRadius: 8,
    spanGaps: false,
    hidden: hidden.value.has(s.key),
  })),
}));

const options = computed(() => {
  chartThemeVersion.value;
  const base = makeLineOptions({
    stacked: props.stacked,
    tooltipCallback: (ctx) => `${ctx.dataset.label}: ${fmt(num(ctx.parsed.y))}`,
  });
  base.plugins.legend = { display: false };
  // Chart.js's twelve fits a full-width chart; a panel a third as wide gets
  // its labels colliding at more than eight.
  base.scales.x.ticks.maxTicksLimit = 8;
  // Smoothing a series through zero can dip the fill below the axis.
  base.scales.y.min = 0;
  return base;
});
</script>

<style scoped>
/* Chart.js redraws only when this box resizes, and a canvas at its drawn
   pixel width would otherwise set the box's minimum in any grid or flex
   parent: the chart could grow with the window but never shrink back. */
.chart-box {
  position: relative;
  contain: inline-size;
}
.empty {
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--cid-text-muted-color);
  font-size: 0.85rem;
}
.legend {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.legend .chip {
  cursor: pointer;
  font: inherit;
  font-size: 0.78rem;
}
.legend .chip:hover {
  border-color: var(--cid-primary-color);
}
.legend .chip:focus-visible {
  outline: 2px solid var(--cid-primary-color);
  outline-offset: 1px;
}
.legend .chip.off {
  opacity: 0.5;
}
.legend .chip.off .sw {
  background: transparent !important;
  box-shadow: inset 0 0 0 1px var(--cid-text-muted-color);
}
.legend .chip.off b {
  text-decoration: line-through;
}
</style>
