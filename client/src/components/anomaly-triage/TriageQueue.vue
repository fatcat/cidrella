<!-- The flagged devices, most anomalous first, with pattern filter chips.
     Hover and click are mirrored on the triage map: the page owns the
     selection, this only reports it. -->
<template>
  <section class="panel queue-panel" aria-label="Triage queue">
    <div class="panel-head">
      <h2>Queue</h2>
      <span class="panel-note">{{ note }}</span>
    </div>
    <div class="queue-filters" role="group" aria-label="Pattern filter">
      <button
        v-for="f in QUEUE_FILTERS"
        :key="f.id"
        type="button"
        class="filter-chip"
        :aria-pressed="filter === f.id"
        :data-track="`triage-filter-${f.id}`"
        @click="emit('update:filter', f.id)"
      >
        {{ f.label }} <span class="chip-count">{{ counts[f.id] ?? 0 }}</span>
      </button>
    </div>

    <div class="queue-state" v-if="state === 'loading'">Loading your detector data...</div>
    <div class="queue-state error" v-else-if="state === 'error'">{{ error }}</div>
    <div class="queue-state" v-else-if="!rows.length">
      {{
        filter === 'all' ? 'Nothing flagged in the last 7 days.' : 'No devices match this filter.'
      }}
    </div>
    <div class="queue" v-else role="list">
      <button
        v-for="row in rows"
        :key="row.id"
        type="button"
        class="queue-row"
        role="listitem"
        :class="{ open: row.id === openId, hover: row.id === hoverId }"
        :aria-current="row.id === openId ? 'true' : undefined"
        data-track="triage-row"
        data-triage-target
        @click="emit('select', row.id)"
        @mouseenter="emit('hover', row.id)"
        @mouseleave="emit('hover', null)"
        @focus="emit('hover', row.id)"
        @blur="emit('hover', null)"
      >
        <span class="row-main">
          <b class="row-name" :title="row.name">{{ row.name }}</b>
          <code class="row-ip">{{ row.ip }}</code>
          <span class="row-tag">{{ row.patternLabel }}</span>
        </span>
        <span class="row-right">
          <span class="row-score" :style="{ color: row.color }">{{ row.scoreLabel }}</span>
          <AnomalySparkline v-if="row.spark.length > 1" :scores="row.spark" :color="row.color" />
        </span>
      </button>
    </div>
  </section>
</template>

<script setup>
import AnomalySparkline from '../anomaly/AnomalySparkline.vue';
import { QUEUE_FILTERS } from './triage-filters.js';

defineProps({
  rows: { type: Array, required: true }, // { id, name, ip, patternLabel, scoreLabel, color, spark }
  counts: { type: Object, required: true }, // per filter id
  filter: { type: String, required: true },
  openId: { type: String, default: null },
  hoverId: { type: String, default: null },
  state: { type: String, default: 'ready' }, // loading | error | ready
  error: { type: String, default: '' },
  note: { type: String, default: '' },
});
const emit = defineEmits(['select', 'hover', 'update:filter']);
</script>

<style scoped>
.queue-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.queue-filters {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 0 14px 10px;
}
.filter-chip {
  font: inherit;
  font-size: 0.78rem;
  background: var(--cid-surface-ground);
  color: var(--cid-text-color);
  border: 1px solid var(--cid-surface-border);
  border-radius: 999px;
  padding: 3px 10px;
  cursor: pointer;
}
.filter-chip[aria-pressed='true'] {
  background: var(--cid-primary-color);
  border-color: var(--cid-primary-color);
  color: var(--cid-primary-contrast-color, #fff);
}
.chip-count {
  opacity: 0.75;
  margin-left: 2px;
}
.queue {
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.queue-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  width: 100%;
  text-align: left;
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  border-top: 1px solid var(--cid-surface-border);
  padding: 9px 14px;
  cursor: pointer;
}
.queue-row:hover,
.queue-row.hover {
  background: var(--cid-surface-ground);
}
.queue-row.open {
  box-shadow: inset 3px 0 0 var(--cid-primary-color);
  background: color-mix(in srgb, var(--cid-primary-color) 12%, transparent);
}
.queue-row:focus-visible {
  outline: 2px solid var(--cid-primary-color);
  outline-offset: -2px;
}
.row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-ip {
  font-size: 0.78rem;
  color: var(--cid-text-muted-color);
}
.row-tag {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--cid-text-muted-color);
}
.row-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.row-score {
  font-family: var(--mono, ui-monospace, monospace);
  font-weight: 600;
}
.queue-state {
  padding: 14px;
  color: var(--cid-text-muted-color);
  font-size: 0.85rem;
}
.queue-state.error {
  color: var(--cid-red-500, #bf616a);
}
</style>
