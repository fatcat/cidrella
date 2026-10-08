<!-- A ranked list: label, a thin bar proportional to the largest count, and
     the count. Rows with a `to` are links. This is what a top-10 is; a
     doughnut of ten slices needs a legend to say the same thing. -->
<template>
  <table class="top-list">
    <thead>
      <tr>
        <th>{{ title }}</th>
        <th class="r">{{ countHeader }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in ranked" :key="row.key">
        <td>
          <RouterLink v-if="row.to" :to="row.to" :data-track="track">{{ row.label }}</RouterLink>
          <span v-else>{{ row.label }}</span>
          <small v-if="row.sub" class="muted">{{ row.sub }}</small>
          <div class="bar" :style="{ width: `${row.pct}%` }"></div>
        </td>
        <td class="r mono">{{ formatNumber(row.count) }}</td>
      </tr>
      <tr v-if="!ranked.length">
        <td colspan="2" class="unavailable">{{ emptyText }}</td>
      </tr>
    </tbody>
  </table>
</template>

<script setup>
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { formatNumber } from '../utils/format.js';

const props = defineProps({
  title: { type: String, required: true },
  rows: { type: Array, required: true }, // [{ key, label, count, to?, sub? }]
  countHeader: { type: String, default: 'Queries' },
  emptyText: { type: String, default: 'Nothing in this range.' },
  limit: { type: Number, default: 10 },
  track: { type: String, default: undefined }, // data-track on each link
});

const ranked = computed(() => {
  const list = (props.rows || []).slice(0, props.limit);
  const max = Math.max(1, ...list.map((r) => Number(r.count) || 0));
  return list.map((r) => ({
    ...r,
    count: Number(r.count) || 0,
    pct: ((Number(r.count) || 0) / max) * 100,
  }));
});
</script>

<style scoped>
.top-list {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
th {
  text-align: left;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cid-text-muted-color);
  font-weight: 600;
  padding: 0 0 6px;
  border-bottom: 1px solid var(--cid-surface-border);
}
th.r,
td.r {
  text-align: right;
  white-space: nowrap;
  vertical-align: top;
  padding-left: 12px;
}
td {
  padding: 5px 0;
  border-bottom: 1px solid var(--cid-surface-border);
  overflow-wrap: anywhere;
}
tr:last-child td {
  border-bottom: 0;
}
td a {
  color: inherit;
  text-decoration: none;
}
td a:hover {
  color: var(--cid-primary-color);
}
td small {
  margin-left: 6px;
  font-size: 0.75rem;
}
.bar {
  height: 3px;
  background: var(--cid-primary-color);
  border-radius: 2px;
  margin-top: 3px;
  opacity: 0.7;
}
</style>
