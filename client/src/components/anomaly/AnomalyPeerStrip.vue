<template>
  <div class="anomaly-peer-strip">
    <div class="peer-caption">
      More anomalous than <b>{{ Math.round(percentile * 100) }}%</b> of the {{ scores.length }} monitored clients this week.
    </div>
    <svg width="100%" height="34" viewBox="0 0 620 34">
      <line x1="10" y1="18" x2="610" y2="18" :stroke="gridColor" stroke-width="1" />
      <circle v-for="(x, i) in peerDots" :key="i" :cx="x" cy="18" r="2.2" :fill="mutedColor" opacity=".45" />
      <circle :cx="myX" cy="18" r="6" :fill="chartColor('err')" :stroke="surfaceColor" stroke-width="2" />
      <text x="10" y="32" font-size="9" :fill="mutedColor">0th pct</text>
      <text x="610" y="32" font-size="9" text-anchor="end" :fill="mutedColor">100th pct</text>
    </svg>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { chartColor, chartThemeVersion } from '../../utils/chart-config.js';

const props = defineProps({
  scores: { type: Array, required: true }, // latest score per monitored client
  mine: { type: Number, required: true },
});

function percentileOf(score, all) {
  if (!all.length) return 0;
  return all.filter(s => s <= score).length / all.length;
}

const percentile = computed(() => percentileOf(props.mine, props.scores));

const peerDots = computed(() => props.scores.map(s => 10 + percentileOf(s, props.scores) * 600));
const myX = computed(() => 10 + percentile.value * 600);

const mutedColor = computed(() => { chartThemeVersion.value; return chartColor('text'); });
const gridColor = computed(() => { chartThemeVersion.value; return chartColor('grid'); });
const surfaceColor = computed(() => { chartThemeVersion.value; return chartColor('track'); });
</script>

<style scoped>
.peer-caption { font-size: .78rem; margin-bottom: .5rem; }
.peer-caption b { font-family: monospace; }
</style>
