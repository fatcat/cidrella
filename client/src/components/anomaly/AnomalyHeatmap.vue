<template>
  <div class="anomaly-heatmap">
    <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`">
      <defs>
        <pattern id="anomaly-heatmap-nodata" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2="5" :stroke="gridColor" stroke-width="1.5" />
        </pattern>
      </defs>
      <text v-for="h in [0, 6, 12, 18]" :key="'h'+h" :x="originX + h * (cell + gap) + cell / 2" y="10"
            font-size="9" text-anchor="middle" :fill="mutedColor">{{ h }}h</text>
      <text v-for="(label, i) in dayLabels" :key="'d'+i" :x="originX - 6" :y="originY + i * (cell + gap) + cell - 2"
            font-size="9" text-anchor="end" :fill="mutedColor">{{ label }}</text>
      <rect v-for="c in cells" :key="c.key" :x="c.x" :y="c.y" :width="cell" :height="cell" rx="2.5" :fill="c.fill" />
    </svg>
    <div class="anomaly-heatmap-legend">
      <span>low</span>
      <span class="grad" :style="{ background: `linear-gradient(90deg, ${lowColor}, ${highColor})` }"></span>
      <span>high</span>
      <span class="nodata-key"><svg width="10" height="10"><rect width="10" height="10" fill="url(#anomaly-heatmap-nodata)" /></svg> no data</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { chartColor, chartThemeVersion, parseColor } from '../../utils/chart-config.js';
import { dayKey } from '../../utils/anomaly-pattern.js';

const props = defineProps({
  history: { type: Array, required: true }, // rows: { window_start, anomaly_score }
});

const cell = 13, gap = 2, originX = 34, originY = 14;

const days = computed(() => {
  if (!props.history.length) return [];
  const times = props.history.map(r => new Date(r.window_start).getTime());
  const minDay = new Date(Math.min(...times));
  const maxDay = new Date(Math.max(...times));
  minDay.setHours(0, 0, 0, 0);
  maxDay.setHours(0, 0, 0, 0);
  const list = [];
  for (let d = new Date(minDay); d <= maxDay; d.setDate(d.getDate() + 1)) {
    list.push(new Date(d));
  }
  return list.slice(-30); // cap at 30 rows even if retention is longer
});

const grid = computed(() => {
  const byBucket = new Map();
  for (const row of props.history) {
    const dt = new Date(row.window_start);
    const key = `${dayKey(row.window_start)}|${dt.getHours()}`;
    const existing = byBucket.get(key);
    if (existing === undefined || row.anomaly_score > existing) byBucket.set(key, row.anomaly_score);
  }
  return days.value.map(day => {
    const dk = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
    return Array.from({ length: 24 }, (_, h) => {
      const v = byBucket.get(`${dk}|${h}`);
      return v === undefined ? null : v;
    });
  });
});

const width = computed(() => originX + 24 * (cell + gap) + 8);
const height = computed(() => originY + Math.max(days.value.length, 1) * (cell + gap) + 6);

const dayLabels = computed(() => days.value.map((d, i) => {
  if (i === days.value.length - 1) return 'today';
  const diff = days.value.length - 1 - i;
  return `${diff}d ago`;
}));

const lowColor = computed(() => { chartThemeVersion.value; return chartColor('track'); });
const highColor = computed(() => { chartThemeVersion.value; return chartColor('err'); });
const gridColor = computed(() => { chartThemeVersion.value; return chartColor('grid'); });
const mutedColor = computed(() => { chartThemeVersion.value; return chartColor('text'); });

function mixColor(v) {
  const t = Math.pow(Math.max(0, Math.min(1, v)), 1.8);
  const lo = parseColor(lowColor.value) || [200, 200, 200];
  const hi = parseColor(highColor.value) || [191, 97, 106];
  const r = Math.round(lo[0] + (hi[0] - lo[0]) * t);
  const g = Math.round(lo[1] + (hi[1] - lo[1]) * t);
  const b = Math.round(lo[2] + (hi[2] - lo[2]) * t);
  return `rgb(${r},${g},${b})`;
}

const cells = computed(() => {
  const out = [];
  grid.value.forEach((row, d) => {
    row.forEach((v, h) => {
      out.push({
        key: `${d}-${h}`,
        x: originX + h * (cell + gap),
        y: originY + d * (cell + gap),
        fill: v === null ? 'url(#anomaly-heatmap-nodata)' : mixColor(v),
      });
    });
  });
  return out;
});
</script>

<style scoped>
.anomaly-heatmap { overflow-x: auto; }
.anomaly-heatmap-legend { display: flex; align-items: center; gap: .4rem; font-size: .66rem; color: var(--p-text-muted-color); margin-top: .4rem; }
.anomaly-heatmap-legend .grad { width: 60px; height: 8px; border-radius: 4px; }
.nodata-key { display: inline-flex; align-items: center; gap: .25rem; margin-left: .75rem; }
</style>
