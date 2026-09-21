<!-- The address plan as one StackedBar: how the managed addresses split by
     allocation state, unassigned drawn as the empty track. -->
<template>
  <StackedBar :segments="segments" noun="addresses" />
</template>

<script setup>
import { computed } from 'vue';
import StackedBar from '../StackedBar.vue';

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

const segments = computed(() => {
  const rows = STATES.map(([key, label, color]) => ({
    key,
    label,
    color,
    count: Number(props.allocations?.[key]) || 0,
  })).filter((row) => row.count > 0);
  rows.push({
    key: 'unassigned',
    label: 'Unassigned',
    count: Number(props.allocations?.unassigned) || 0,
    hollow: true,
  });
  return rows;
});
</script>
