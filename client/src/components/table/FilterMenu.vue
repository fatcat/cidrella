<!-- The Add filter control of the workspace tables. One button opens a list of
     every column that can be filtered; picking one shows its values with how
     many rows carry each, counted over the whole result rather than the page
     on screen, or a text box for a column of free text. Values toggle as they
     are clicked; the active filters show as chips beside the table. The same
     control on every table, so every table filters the same way. -->
<template>
  <Button
    icon="pi pi-filter"
    :label="activeCount ? `Filter · ${activeCount}` : 'Filter'"
    size="small"
    text
    class="filter-menu-trigger"
    data-track="workspace-filter-menu"
    :aria-expanded="open"
    @click="toggle"
  />
  <Popover ref="panel" class="filter-menu-panel" @show="onShow" @hide="onHide">
    <div class="filter-menu" role="dialog" aria-label="Filter the table">
      <template v-if="!column">
        <InputText
          v-model="columnQuery"
          size="small"
          placeholder="Find a column"
          aria-label="Find a column to filter"
          class="w-full"
        />
        <ul class="filter-list" role="list">
          <li v-for="item in listedColumns" :key="item.key">
            <button
              type="button"
              class="filter-row"
              :data-track="`workspace-filter-column-${item.key}`"
              @click="pickColumn(item)"
            >
              <span>{{ item.header }}</span>
              <span v-if="modelValue[item.key]" class="filter-active">{{
                modelValue[item.key].length
              }}</span>
              <i class="pi pi-chevron-right" aria-hidden="true" />
            </button>
          </li>
          <li v-if="!listedColumns.length" class="filter-empty muted">
            {{ loading ? 'Loading columns…' : 'No column matches.' }}
          </li>
        </ul>
      </template>

      <template v-else>
        <button type="button" class="filter-back" @click="column = null">
          <i class="pi pi-chevron-left" aria-hidden="true" /> {{ column.header }}
        </button>
        <form v-if="column.kind === 'text'" class="filter-text" @submit.prevent="applyText">
          <InputText
            v-model="text"
            size="small"
            :placeholder="`${column.header} contains`"
            :aria-label="`${column.header} contains`"
            class="w-full"
          />
          <div class="dialog-actions">
            <Button
              v-if="modelValue[column.key]"
              label="Clear"
              size="small"
              severity="secondary"
              text
              @click="setValues(column.key, [])"
            />
            <Button type="submit" label="Apply" size="small" :disabled="!text.trim()" />
          </div>
        </form>
        <template v-else>
          <p v-if="loading" class="filter-empty muted">Counting…</p>
          <p v-else-if="!values.length" class="filter-empty muted">No values in this table.</p>
          <ul v-else class="filter-list" role="list">
            <li v-for="item in values" :key="String(item.value)">
              <label class="filter-row filter-value">
                <Checkbox
                  :model-value="isSelected(item.value)"
                  binary
                  :data-track="`workspace-filter-value-${column.key}`"
                  @update:model-value="toggleValue(item.value)"
                />
                <span>{{ valueLabel(column.key, item.value) }}</span>
                <span class="filter-count mono">{{ formatNumber(item.count) }}</span>
              </label>
            </li>
          </ul>
        </template>
      </template>
    </div>
  </Popover>
</template>

<script setup>
import { computed, ref } from 'vue';
import Button from '../../ui/Button.js';
import Checkbox from '../../ui/Checkbox.js';
import InputText from '../../ui/InputText.js';
import Popover from '../../ui/Popover.js';
import { formatNumber } from '../../utils/format.js';

const props = defineProps({
  // [{ key, header, kind: 'enum' | 'text' }], the columns that can be filtered.
  columns: { type: Array, required: true },
  // { column: [{ value, count }] } for the enum columns, or null until loaded.
  facets: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  // { column: [value, ...] }
  modelValue: { type: Object, required: true },
  valueLabel: { type: Function, required: true },
});
const emit = defineEmits(['update:modelValue', 'open']);

const panel = ref(null);
const open = ref(false);
const column = ref(null);
const columnQuery = ref('');
const text = ref('');

const activeCount = computed(() => Object.keys(props.modelValue).length);
const listedColumns = computed(() => {
  const query = columnQuery.value.trim().toLocaleLowerCase();
  return props.columns
    .filter((item) => !query || item.header.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.header.localeCompare(b.header, undefined, { sensitivity: 'base' }));
});
// A value picked earlier stays listed even when the other filters leave no
// row carrying it, so it can be unticked.
const values = computed(() => {
  if (!column.value) return [];
  const counted = props.facets?.[column.value.key] || [];
  const picked = (props.modelValue[column.value.key] || [])
    .filter((value) => !counted.some((item) => item.value === value))
    .map((value) => ({ value, count: 0 }));
  return [...counted, ...picked];
});

function toggle(event) {
  panel.value?.toggle(event);
}
function onShow() {
  open.value = true;
  column.value = null;
  columnQuery.value = '';
  emit('open');
}
function onHide() {
  open.value = false;
}
function pickColumn(item) {
  column.value = item;
  text.value = props.modelValue[item.key]?.[0] || '';
}
function isSelected(value) {
  return (props.modelValue[column.value.key] || []).includes(value);
}
function setValues(key, list) {
  const next = { ...props.modelValue };
  if (list.length) next[key] = list;
  else delete next[key];
  emit('update:modelValue', next);
}
function toggleValue(value) {
  const current = props.modelValue[column.value.key] || [];
  setValues(
    column.value.key,
    current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
  );
}
function applyText() {
  setValues(column.value.key, [text.value.trim()]);
  panel.value?.hide();
}
</script>

<style scoped>
.filter-menu {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: min(18rem, calc(100vw - 2rem));
}
.filter-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 20rem;
  overflow-y: auto;
}
.filter-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.4rem 0.5rem;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--app-fs-sm);
  text-align: left;
  cursor: pointer;
}
.filter-row:hover,
.filter-row:focus-visible {
  background: var(--cid-surface-ground);
}
.filter-value {
  grid-template-columns: auto 1fr auto;
}
.filter-active {
  min-width: 1.2rem;
  padding: 0 0.3rem;
  border-radius: 999px;
  background: var(--cid-primary-color);
  color: var(--cid-primary-contrast-color);
  font-size: 0.7rem;
  text-align: center;
}
.filter-count {
  color: var(--cid-text-muted-color);
  font-size: 0.75rem;
}
.filter-back {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.filter-text {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.filter-empty {
  margin: 0;
  padding: 0.4rem 0.5rem;
  font-size: var(--app-fs-sm);
}
</style>
