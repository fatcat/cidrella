<!-- A stacked area of counts per time bucket, one dataset per series, with
     the totals as legend chips underneath instead of Chart.js's own legend.
     The minute rows from /api/metrics/timeseries are re-bucketed here so a
     week does not draw ten thousand points. -->
<template>
  <div class="traffic">
    <div class="chart-box">
      <Line v-if="hasData" :data="chartData" :options="options" />
      <div v-else class="empty">No {{ noun }} in this range.</div>
    </div>
    <div class="legend">
      <span v-for="s in seriesWithTotals" :key="s.key" class="chip">
        <i class="sw" :style="{ background: s.color }" aria-hidden="true"></i>
        {{ s.label }} <b class="mono">{{ formatNumber(s.total) }}</b>
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import '../../assets/analytics-workspace.css';
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
import { chartColor, chartThemeVersion, makeLineOptions } from '../../utils/chart-config.js';
import { formatEpoch } from '../../utils/dateFormat.js';
import { formatNumber } from '../../utils/format.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

const props = defineProps({
  rows: { type: Array, required: true }, // [{ ts, ...counts }] minute buckets, ascending
  series: { type: Array, required: true }, // [{ key, label, color }] drawn bottom to top
  range: { type: String, default: '24h' },
  noun: { type: String, default: 'traffic' },
  buckets: { type: Number, default: 96 }, // target points across the range
  // Stacked when the series are parts of one total (answered + blocked).
  // Overlaid when they are two views of one conversation (requests, replies).
  stacked: { type: Boolean, default: true },
});

// Sum minute rows into at most `buckets` evenly sized bins so the chart stays
// readable at any range. The last bin is partial and still drawn.
const bucketed = computed(() => {
  const rows = props.rows || [];
  if (!rows.length) return [];
  const span = Math.max(1, Math.ceil(rows.length / props.buckets));
  const out = [];
  for (let i = 0; i < rows.length; i += span) {
    const slice = rows.slice(i, i + span);
    const bin = { ts: slice[0].ts };
    for (const s of props.series) {
      bin[s.key] = slice.reduce((sum, r) => sum + (Number(r[s.key]) || 0), 0);
    }
    out.push(bin);
  }
  return out;
});

const seriesWithTotals = computed(() => {
  chartThemeVersion.value;
  return props.series.map((s) => ({
    ...s,
    color: chartColor(s.color),
    total: (props.rows || []).reduce((sum, r) => sum + (Number(r[s.key]) || 0), 0),
  }));
});

const hasData = computed(() => seriesWithTotals.value.some((s) => s.total > 0));

const chartData = computed(() => ({
  labels: bucketed.value.map((r) => formatEpoch(r.ts, props.range)),
  // Built by hand rather than through lineDataset(), which takes a palette
  // NAME and would resolve the hex the legend already holds to its default.
  datasets: seriesWithTotals.value.map((s) => ({
    label: s.label,
    data: bucketed.value.map((r) => r[s.key]),
    borderColor: s.color,
    backgroundColor: withAlpha(s.color, props.stacked ? 0.35 : 0.18),
    borderWidth: 1.5,
    fill: true,
    tension: 0.2,
    pointRadius: 0,
    pointHitRadius: 8,
  })),
}));

function withAlpha(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const options = computed(() => {
  chartThemeVersion.value;
  const base = makeLineOptions({ stacked: props.stacked });
  base.plugins.legend = { display: false };
  // Smoothing a series through zero can dip the fill below the axis.
  base.scales.y.min = 0;
  return base;
});
</script>

<style scoped>
.chart-box {
  height: 180px;
  position: relative;
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
</style>
