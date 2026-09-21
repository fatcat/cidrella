<!-- The "Needs attention" rows of the health board. Each row is a link to
     the page where the condition is acted on. Rows come pre-sorted from
     utils/health-attention.js. -->
<template>
  <ul class="attn" role="list">
    <li v-for="row in rows" :key="row.id" :class="row.tone">
      <RouterLink :to="row.to" class="attn-row" :data-track="`dashboard-attention-${row.id}`">
        <StatusDot :kind="row.tone" :label="row.title" decorative class="mark" />
        <span class="text">
          <span class="title">{{ row.title }}</span>
          <span class="detail">{{ row.detail }}</span>
        </span>
        <span v-if="row.count !== null" class="count mono">{{ row.count }}</span>
        <span v-else class="go">Open</span>
      </RouterLink>
    </li>
    <li v-if="!rows.length" class="empty">Nothing needs a decision.</li>
  </ul>
</template>

<script setup>
import { RouterLink } from 'vue-router';
import StatusDot from '../StatusDot.vue';

defineProps({
  rows: { type: Array, required: true },
});
</script>

<style scoped>
.attn {
  list-style: none;
  margin: 0;
  padding: 0;
}
.attn li {
  border-top: 1px solid var(--cid-surface-border);
}
.attn-row {
  display: grid;
  grid-template-columns: 10px 1fr auto;
  gap: 10px;
  align-items: start;
  padding: 10px 14px;
  color: inherit;
  text-decoration: none;
}
.attn-row:hover {
  background: var(--cid-surface-ground);
}
.attn-row:focus-visible {
  outline: 2px solid var(--cid-primary-color);
  outline-offset: -2px;
}
.mark {
  margin-top: 6px;
}
.text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.title {
  font-weight: 500;
}
.detail {
  font-size: 0.78rem;
  color: var(--cid-text-muted-color);
  margin-top: 1px;
}
.count {
  font-weight: 600;
  font-size: 0.98rem;
}
.go,
.empty {
  font-size: 0.78rem;
  color: var(--cid-text-muted-color);
}
.go {
  align-self: center;
}
li.muted .title,
li.muted .count {
  color: var(--cid-text-muted-color);
  font-weight: 400;
}
.empty {
  padding: 20px 14px;
}
</style>
