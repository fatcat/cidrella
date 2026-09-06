<template>
  <svg width="200" height="118" viewBox="0 0 200 118" class="anomaly-gauge">
    <path :d="trackPath" fill="none" :stroke="trackColor" stroke-width="12" stroke-linecap="round" />
    <line v-for="t in [0.4, 0.7]" :key="t" x1="100" y1="98" :x2="tickPoint(t)[0]" :y2="tickPoint(t)[1]"
          :stroke="gridColor" stroke-width="1" opacity=".6" />
    <path :d="progressPath" fill="none" :stroke="color" stroke-width="12" stroke-linecap="round" />
    <text x="100" y="88" text-anchor="middle" font-size="28" font-weight="700"
          font-family="var(--mono, ui-monospace, monospace)" :fill="textColor">{{ score.toFixed(2) }}</text>
    <text x="100" y="106" text-anchor="middle" font-size="10" :fill="mutedColor" letter-spacing="1">ANOMALY SCORE</text>
  </svg>
</template>

<script setup>
import { computed } from 'vue';
import { chartColor, chartThemeVersion } from '../../utils/chart-config.js';

const props = defineProps({
  score: { type: Number, required: true }, // 0..1
  severity: { type: String, default: null }, // 'high' | 'medium' | 'low'
});

const cx = 100, cy = 98, r = 78;
function angleFor(v) { return Math.PI - v * Math.PI; }
function pt(v) {
  const a = angleFor(v);
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}
function tickPoint(v) { return pt(v); }
function arcPath(v0, v1) {
  const p0 = pt(v0), p1 = pt(v1);
  const large = (v1 - v0) > 0.5 ? 1 : 0;
  return `M ${p0[0].toFixed(1)} ${p0[1].toFixed(1)} A ${r} ${r} 0 ${large} 1 ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
}

const trackPath = computed(() => arcPath(0, 1));
const progressPath = computed(() => arcPath(0, Math.max(props.score, 0.012)));

const color = computed(() => {
  chartThemeVersion.value;
  const key = props.severity === 'high' ? 'err' : props.severity === 'medium' ? 'warn' : 'info';
  return chartColor(key);
});
const trackColor = computed(() => { chartThemeVersion.value; return chartColor('track'); });
const gridColor = computed(() => { chartThemeVersion.value; return chartColor('grid'); });
const textColor = computed(() => { chartThemeVersion.value; return chartColor('text'); });
const mutedColor = computed(() => { chartThemeVersion.value; return chartColor('muted'); });
</script>
