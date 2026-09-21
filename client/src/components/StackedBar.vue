<!-- One horizontal stacked bar of how a total splits, with the counts as a
     legend. A hollow segment (the free part of an address plan) is drawn as
     the empty track so the bar reads as "how full". Clicking a legend row
     hides that segment and the bar re-proportions over what is left. -->
<template>
  <div class="stacked">
    <div class="bar" role="img" :aria-label="ariaLabel">
      <span
        v-for="seg in drawn"
        :key="seg.key"
        :style="{ width: `${seg.pct}%`, background: seg.color }"
        :title="`${seg.label}: ${formatNumber(seg.count)}`"
      ></span>
    </div>
    <div class="legend" :style="{ '--legend-cols': columns }">
      <button
        v-for="seg in legend"
        :key="seg.key"
        type="button"
        :class="{ off: hidden.has(seg.key) }"
        :aria-pressed="!hidden.has(seg.key)"
        :title="hidden.has(seg.key) ? `Show ${seg.label}` : `Hide ${seg.label}`"
        @click="toggle(seg.key)"
      >
        <span
          ><i :style="{ background: seg.color }" :class="{ hollow: seg.hollow }"></i
          >{{ seg.label }}</span
        >
        <b class="mono">{{ formatNumber(seg.count) }}</b>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { chartColor, chartThemeVersion } from '../utils/chart-config.js';
import { formatNumber } from '../utils/format.js';

const props = defineProps({
  // [{ key, label, count, color, hollow? }] in reading order. color is a
  // chart-config name or palette index; hollow draws as the track.
  segments: { type: Array, required: true },
  noun: { type: String, default: 'items' },
  columns: { type: Number, default: 2 }, // legend columns
});

const hidden = ref(new Set());
function toggle(key) {
  const next = new Set(hidden.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hidden.value = next;
}

const legend = computed(() => {
  chartThemeVersion.value;
  return props.segments.map((s) => ({
    ...s,
    count: Number(s.count) || 0,
    color: s.hollow ? 'transparent' : chartColor(s.color),
  }));
});

const shown = computed(() => legend.value.filter((s) => !hidden.value.has(s.key)));
const total = computed(() => shown.value.reduce((sum, s) => sum + s.count, 0));
const drawn = computed(() =>
  shown.value
    .filter((s) => !s.hollow && s.count > 0)
    .map((s) => ({ ...s, pct: total.value ? (s.count / total.value) * 100 : 0 })),
);

const ariaLabel = computed(
  () =>
    `${formatNumber(total.value)} ${props.noun}: ` +
    shown.value.map((s) => `${s.label} ${formatNumber(s.count)}`).join(', '),
);
</script>

<style scoped>
.bar {
  display: flex;
  height: 16px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--cid-gauge-track, var(--cid-surface-ground));
}
.bar span {
  height: 100%;
}
.legend {
  display: grid;
  grid-template-columns: repeat(var(--legend-cols, 2), minmax(0, 1fr));
  gap: 4px 14px;
  margin-top: 10px;
  font-size: 0.78rem;
  color: var(--cid-text-muted-color);
}
.legend button {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.legend button:hover {
  color: var(--cid-text-color);
}
.legend button:focus-visible {
  outline: 2px solid var(--cid-primary-color);
  outline-offset: 2px;
  border-radius: 3px;
}
.legend button.off {
  opacity: 0.45;
  text-decoration: line-through;
}
.legend b {
  color: var(--cid-text-color);
  font-weight: 500;
}
.legend i {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  display: inline-block;
  margin-right: 6px;
  vertical-align: -1px;
}
.legend i.hollow {
  border: 1px solid var(--cid-surface-border);
  background: var(--cid-gauge-track, var(--cid-surface-ground)) !important;
}
@media (max-width: 480px) {
  .legend {
    grid-template-columns: 1fr;
  }
}
</style>
