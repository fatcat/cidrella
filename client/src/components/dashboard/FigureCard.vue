<!-- One figure of the Resolution panel: a label, a big number with its unit,
     an inline sparkline of the series behind it, and a line of context. -->
<template>
  <div class="fig" :class="tone">
    <div class="label">{{ label }}</div>
    <div class="value mono">
      {{ display }}<small v-if="unit && display !== EMPTY_CELL">{{ unit }}</small>
    </div>
    <svg
      v-if="series.length > 1"
      class="spark"
      viewBox="0 0 100 34"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path :d="area" :fill="stroke" opacity="0.12" />
      <path
        :d="line"
        fill="none"
        :stroke="stroke"
        stroke-width="1.5"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <!-- A series too short to draw keeps the height so a row of figures lines up;
         no series at all means the figure is a number only. -->
    <div v-else-if="series.length" class="spark spark-empty"></div>
    <div class="sub">{{ sub }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { chartColor, chartThemeVersion } from '../../utils/chart-config.js';
import { EMPTY_CELL } from '../../utils/format.js';

const props = defineProps({
  label: { type: String, required: true },
  value: { type: [Number, String], default: null },
  unit: { type: String, default: '' },
  sub: { type: String, default: '' },
  tone: { type: String, default: 'ok' }, // ok | warn | err
  series: { type: Array, default: () => [] }, // chronological numbers, nulls skipped
});

const display = computed(() =>
  props.value === null || props.value === undefined ? EMPTY_CELL : String(props.value),
);

const stroke = computed(() => {
  chartThemeVersion.value;
  return chartColor(props.tone === 'ok' ? 'info' : props.tone);
});

// Minute rows are too many for a 100-unit wide line and read as noise, so
// the series is averaged into at most SPARK_POINTS bins first.
const SPARK_POINTS = 48;
const points = computed(() => {
  const raw = props.series.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const binSize = Math.max(1, Math.ceil(raw.length / SPARK_POINTS));
  const values = [];
  for (let i = 0; i < raw.length; i += binSize) {
    const slice = raw.slice(i, i + binSize);
    values.push(slice.reduce((s, v) => s + v, 0) / slice.length);
  }
  if (values.length < 2) return [];
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  return values.map((v, i) => [(i / (values.length - 1)) * 100, 32 - ((v - min) / span) * 28]);
});
const line = computed(() =>
  points.value.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' '),
);
const area = computed(() => (points.value.length ? `${line.value} L100 34 L0 34 Z` : ''));
</script>

<style scoped>
.fig {
  border: 1px solid var(--cid-surface-border);
  border-radius: 8px;
  padding: 10px 12px;
  display: grid;
  gap: 4px;
  min-width: 0;
}
.label {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cid-text-muted-color);
}
.value {
  font-size: 1.6rem;
  font-weight: 600;
  line-height: 1.1;
}
.value small {
  font-size: 0.8rem;
  color: var(--cid-text-muted-color);
  font-weight: 400;
  margin-left: 2px;
}
.fig.warn .value {
  color: var(--cid-status-warn);
}
.fig.err .value {
  color: var(--cid-status-err);
}
.spark {
  width: 100%;
  height: 34px;
  display: block;
  overflow: visible;
}
.sub {
  font-size: 0.75rem;
  color: var(--cid-text-muted-color);
}
</style>
