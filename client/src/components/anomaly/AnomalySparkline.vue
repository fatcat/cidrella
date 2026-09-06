<template>
  <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" class="anomaly-sparkline">
    <path v-if="path" :d="path" fill="none" :stroke="color" stroke-width="1.6"
          stroke-linecap="round" stroke-linejoin="round" />
    <circle v-if="lastPoint" :cx="lastPoint[0]" :cy="lastPoint[1]" r="2" :fill="color" />
  </svg>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  scores: { type: Array, required: true }, // chronological, each in [0, 1]
  color: { type: String, required: true },
  width: { type: Number, default: 64 },
  height: { type: Number, default: 22 },
});

const points = computed(() => {
  const n = props.scores.length;
  if (n === 0) return [];
  return props.scores.map((v, i) => [
    n === 1 ? props.width / 2 : (i / (n - 1)) * (props.width - 4) + 2,
    props.height - 2 - Math.max(0, Math.min(1, v)) * (props.height - 4),
  ]);
});

const path = computed(() => points.value.length
  ? points.value.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  : '');

const lastPoint = computed(() => points.value.length ? points.value[points.value.length - 1] : null);
</script>
