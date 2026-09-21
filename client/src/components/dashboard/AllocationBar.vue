<!-- One stacked bar of the address plan: how the managed addresses split by
     allocation state, with the counts as a legend. Unassigned is drawn as
     the empty track so the bar reads as "how full". -->
<template>
  <div class="allocation">
    <div class="bar" role="img" :aria-label="ariaLabel">
      <span
        v-for="seg in segments"
        :key="seg.key"
        :style="{ width: `${seg.pct}%`, background: seg.color }"
        :title="`${seg.label}: ${seg.count}`"
      ></span>
    </div>
    <div class="legend">
      <div v-for="seg in legend" :key="seg.key">
        <span
          ><i :style="{ background: seg.color }" :class="{ hollow: seg.hollow }"></i
          >{{ seg.label }}</span
        >
        <b class="mono">{{ seg.count }}</b>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { chartColor, chartThemeVersion } from '../../utils/chart-config.js';

const props = defineProps({
  allocations: { type: Object, required: true }, // from /api/metrics/ip-lifecycle
});

// Order is the order a person reads the plan in: what is pinned, what moves,
// what the network itself takes, what is free.
const STATES = [
  ['static_dns', 'Static DNS', 1],
  ['static_dhcp', 'Static DHCP', 2],
  ['dynamic_dhcp', 'Dynamic DHCP', 3],
  ['reserved', 'Reserved', 4],
  ['slaac', 'SLAAC', 5],
  ['quarantined', 'Quarantined', 'warn'],
  ['system', 'System', 6],
  ['gateway', 'Gateway', 'muted'],
];

const total = computed(() =>
  Object.values(props.allocations || {}).reduce((sum, n) => sum + (Number(n) || 0), 0),
);

const legend = computed(() => {
  chartThemeVersion.value;
  const rows = STATES.map(([key, label, color]) => ({
    key,
    label,
    color: chartColor(color),
    count: Number(props.allocations?.[key]) || 0,
    hollow: false,
  }));
  rows.push({
    key: 'unassigned',
    label: 'Unassigned',
    color: 'transparent',
    count: Number(props.allocations?.unassigned) || 0,
    hollow: true,
  });
  return rows.filter((row) => row.count > 0 || row.key === 'unassigned');
});

const segments = computed(() =>
  legend.value
    .filter((row) => !row.hollow && row.count > 0)
    .map((row) => ({ ...row, pct: total.value ? (row.count / total.value) * 100 : 0 })),
);

const ariaLabel = computed(
  () => `${total.value} addresses: ` + legend.value.map((r) => `${r.label} ${r.count}`).join(', '),
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 14px;
  margin-top: 10px;
  font-size: 0.78rem;
  color: var(--cid-text-muted-color);
}
.legend div {
  display: flex;
  justify-content: space-between;
  gap: 8px;
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
