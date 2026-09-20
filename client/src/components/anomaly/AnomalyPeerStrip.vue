<template>
  <div class="anomaly-peer-strip">
    <div class="peer-caption">
      More anomalous than <b>{{ Math.round(percentile * 100) }}%</b> of the
      {{ scores.length }} monitored clients this week.
    </div>
    <!-- No viewBox on purpose: the strip stretches to the panel width while the
         dots and labels keep their CSS pixel size, so a narrow drawer does not
         shrink the text with the graph. -->
    <svg class="peer-svg" width="100%" height="40" role="img" aria-label="Peer percentile strip">
      <line x1="2%" y1="16" x2="98%" y2="16" :stroke="gridColor" stroke-width="1" />
      <circle
        v-for="(x, i) in peerDots"
        :key="i"
        :cx="x"
        cy="16"
        r="2.5"
        :fill="mutedColor"
        opacity=".45"
      />
      <circle
        :cx="myX"
        cy="16"
        r="6"
        :fill="chartColor('err')"
        :stroke="surfaceColor"
        stroke-width="2"
      />
      <text x="2%" y="36" class="peer-label" :fill="mutedColor">0th pct</text>
      <text x="98%" y="36" class="peer-label" text-anchor="end" :fill="mutedColor">100th pct</text>
    </svg>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { chartColor, chartThemeVersion } from '../../utils/chart-config.js';
import { moreAnomalousThan } from '../../utils/anomaly-score.js';

const props = defineProps({
  scores: { type: Array, required: true }, // latest score per monitored client
  mine: { type: Number, required: true },
});

// Negative is anomalous, so "more anomalous than" counts the peers scoring
// HIGHER than this one.
function percentileOf(score, all) {
  return moreAnomalousThan(score, all);
}

const percentile = computed(() => percentileOf(props.mine, props.scores));

// Percent of the strip width, 2% in from each edge so the end dots are not clipped.
const toX = (pct) => `${2 + pct * 96}%`;
const peerDots = computed(() => props.scores.map((s) => toX(percentileOf(s, props.scores))));
const myX = computed(() => toX(percentile.value));

const mutedColor = computed(() => {
  chartThemeVersion.value;
  return chartColor('text');
});
const gridColor = computed(() => {
  chartThemeVersion.value;
  return chartColor('grid');
});
const surfaceColor = computed(() => {
  chartThemeVersion.value;
  return chartColor('track');
});
</script>

<style scoped>
.peer-caption {
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
}
.peer-caption b {
  font-family: monospace;
}
.peer-svg {
  display: block;
  overflow: visible;
}
.peer-label {
  font-size: 0.72rem;
}
</style>
