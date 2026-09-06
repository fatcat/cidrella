<template>
  <div class="anomaly-feature-trend">
    <div class="flabel">{{ label }}</div>
    <svg width="100%" height="64" viewBox="0 0 280 64" preserveAspectRatio="none">
      <line x1="8" y1="56" x2="272" y2="56" :stroke="gridColor" stroke-width="1" />
      <path v-if="path" :d="path" fill="none" :stroke="lineColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" />
      <circle v-for="(p, i) in dots" :key="i" :cx="p[0]" :cy="p[1]" :r="i === dots.length - 1 ? 4 : 2.5" :fill="lineColor" />
    </svg>
    <div class="fvals">
      <span v-if="points.length > 1">first seen {{ formatFeatureValue(feature, points[0].value) }}</span>
      <span v-else>&nbsp;</span>
      <span class="now">now {{ formatFeatureValue(feature, points[points.length - 1].value) }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { chartColor, chartThemeVersion } from '../../utils/chart-config.js';
import { formatFeatureValue } from '../../utils/anomaly-features.js';

const props = defineProps({
  feature: { type: String, required: true },
  label: { type: String, required: true },
  points: { type: Array, required: true }, // chronological [{ t, value }], length >= 1
});

const range = computed(() => {
  const values = props.points.map(p => p.value);
  const lo = Math.min(...values), hi = Math.max(...values);
  return hi - lo || Math.max(Math.abs(hi), 1) || 1;
});

const coords = computed(() => {
  const n = props.points.length;
  const lo = Math.min(...props.points.map(p => p.value));
  return props.points.map((p, i) => {
    const x = n === 1 ? 140 : 8 + (i / (n - 1)) * 264;
    const norm = (p.value - lo) / range.value;
    const y = 56 - norm * 44;
    return [x, y];
  });
});

const path = computed(() => coords.value.length > 1
  ? coords.value.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  : '');
const dots = computed(() => coords.value);

const lineColor = computed(() => { chartThemeVersion.value; return chartColor(1); });
const gridColor = computed(() => { chartThemeVersion.value; return chartColor('grid'); });
</script>

<style scoped>
.anomaly-feature-trend { background: var(--p-surface-ground); border: 1px solid var(--p-surface-border); border-radius: 8px; padding: .6rem .7rem; }
.flabel { font-size: .72rem; font-weight: 600; margin-bottom: .15rem; }
.fvals { display: flex; justify-content: space-between; font-size: .68rem; color: var(--p-text-muted-color); font-family: monospace; margin-top: .2rem; }
.fvals .now { color: var(--p-text-color); font-weight: 700; }
</style>
