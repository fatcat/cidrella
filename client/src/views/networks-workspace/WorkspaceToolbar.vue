<template>
  <div class="table-toolbar">
    <label class="table-search">
      <i class="pi pi-search" />
      <input
        v-model="tableQuery"
        type="search"
        :placeholder="viewMeta.search"
        aria-label="Search current table"
      />
    </label>
    <FilterMenu
      v-model="filters"
      :columns="filterColumns"
      :facets="facets"
      :loading="facetsLoading"
      :value-label="filterValueLabel"
      @open="emit('filter-open')"
    />
    <label v-if="activeView === 'addresses' || activeView === 'dhcp'" class="available-switch">
      <input v-model="showAvailable" type="checkbox" />
      <span /> Show available
    </label>
    <span class="toolbar-space" />
    <div
      v-if="activeView === 'addresses' && allowGrid"
      class="view-switcher"
      aria-label="Address presentation"
    >
      <button
        :class="{ active: presentation === 'table' }"
        aria-label="Table view"
        @click="presentation = 'table'"
      >
        <i class="pi pi-list" />
      </button>
      <button
        :class="{ active: presentation === 'grid' }"
        aria-label="Grid view"
        @click="presentation = 'grid'"
      >
        <i class="pi pi-th-large" />
      </button>
      <button
        :class="{ active: presentation === 'compact-grid' }"
        aria-label="Compact grid view"
        data-track="workspace-compact-grid"
        @click="presentation = 'compact-grid'"
      >
        <i class="pi pi-th-large compact-grid-icon" />
      </button>
    </div>
    <ColumnChooserButton
      :table-name="columnTableName"
      :all-columns="columnCatalog"
      :visible-columns="columns"
      :locked-keys="columnCatalog.filter((column) => column.locked).map((column) => column.key)"
      @update:visible-columns="emit('update:visible-columns', $event)"
      @reset="emit('reset-columns')"
    />
    <button v-if="canCreate" class="button primary compact" @click="emit('add')">
      <i class="pi pi-plus" /> {{ viewMeta.addLabel }}
    </button>
  </div>
  <div v-if="filterChips.length" class="filter-chips" aria-label="Active filters">
    <button v-for="chip in filterChips" :key="chip.key" @click="emit('clear-filter', chip.key)">
      {{ chip.label }} <i class="pi pi-times" />
    </button>
    <button @click="emit('clear-filters')">Clear all</button>
  </div>

  <div v-if="selectedRows.length" class="selection-bar">
    <strong>{{ selectedRows.length }} selected</strong>
    <button
      v-for="action in selectionActions"
      :key="action.id"
      :disabled="!action.available"
      :title="action.available ? action.note : action.reason"
      @click="emit('selection-action', action.id)"
    >
      {{ action.label }}
    </button>
    <button @click="selectedRows = []">Clear</button>
  </div>
</template>

<script setup>
import ColumnChooserButton from '../../components/table/ColumnChooserButton.vue';
import FilterMenu from '../../components/table/FilterMenu.vue';
import { filterValueLabel } from './workspace-columns.js';

// Search, filters, presentation switch, column chooser, filter chips and the
// bulk-selection bar. All state is owned by NetworksWorkspace.vue.
defineProps({
  // An IPv6 network has no grid: its address space cannot be enumerated, so
  // the switcher is withheld and the table is the one presentation.
  allowGrid: { type: Boolean, default: true },
  activeView: { type: String, required: true },
  contextKind: { type: String, required: true },
  viewMeta: { type: Object, required: true },
  // [{ key, header, kind }]: the columns the Filter menu offers, and the
  // counts of each one's values over the whole result (null until asked).
  filterColumns: { type: Array, default: () => [] },
  facets: { type: Object, default: null },
  facetsLoading: { type: Boolean, default: false },
  columnTableName: { type: String, required: true },
  columnCatalog: { type: Array, required: true },
  columns: { type: Array, required: true },
  canCreate: { type: Boolean, default: false },
  // Registry items for the selection bar (`menuActions({ menu: 'selection' })`
  // with unavailable entries kept so their reason can be shown).
  selectionActions: { type: Array, default: () => [] },
  filterChips: { type: Array, default: () => [] },
});
const emit = defineEmits([
  'update:visible-columns',
  'reset-columns',
  'clear-filter',
  'clear-filters',
  'filter-open',
  'add',
  'selection-action',
]);
const tableQuery = defineModel('tableQuery', { type: String, default: '' });
const filters = defineModel('filters', { type: Object, required: true });
const showAvailable = defineModel('showAvailable', { type: Boolean, default: true });
const presentation = defineModel('presentation', { type: String, default: 'table' });
const selectedRows = defineModel('selectedRows', { type: Array, default: () => [] });
</script>

<style scoped>
button,
input {
  font: inherit;
}
button {
  color: inherit;
}
.table-search {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--preview-line);
  background: var(--cid-surface-card);
}
.table-search i {
  color: var(--preview-muted);
  font-size: 0.78rem;
}
.table-search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--cid-text-color);
  font-size: var(--app-fs-sm);
}
.button {
  display: inline-flex;
  min-height: 2rem;
  align-items: center;
  justify-content: center;
  gap: 0.38rem;
  padding: 0 0.68rem;
  border: 1px solid var(--preview-line);
  border-radius: 7px;
  background: var(--cid-surface-card);
  font-size: var(--app-fs-sm);
  font-weight: 700;
  cursor: pointer;
}
.button:hover {
  border-color: color-mix(in srgb, var(--preview-accent) 55%, var(--preview-line));
}
.button.primary {
  border-color: var(--preview-accent);
  color: var(--cid-primary-contrast-color, white);
  background: var(--preview-accent);
}
.button.compact {
  min-height: 1.9rem;
  white-space: nowrap;
}
.table-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  padding: 0.48rem;
  border-bottom: 1px solid var(--preview-line);
}
.table-search {
  width: min(300px, 31%);
  min-height: 1.9rem;
  padding: 0 0.5rem;
  border-radius: 7px;
}
.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding: 0 1rem 0.65rem;
}
.filter-chips button {
  border: 1px solid color-mix(in srgb, var(--preview-accent) 35%, var(--cid-surface-border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--preview-accent) 9%, var(--cid-surface-card));
  color: var(--cid-text-color);
  padding: 0.25rem 0.55rem;
}
.available-switch {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--preview-muted);
  font-size: 0.66rem;
  cursor: pointer;
}
.available-switch input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.available-switch span {
  position: relative;
  width: 1.65rem;
  height: 0.92rem;
  border-radius: 99px;
  background: var(--cid-surface-300);
  transition: background 0.15s;
}
.available-switch span::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: calc(0.92rem - 4px);
  height: calc(0.92rem - 4px);
  border-radius: 50%;
  background: white;
  transition: transform 0.15s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}
.available-switch input:checked + span {
  background: var(--preview-accent);
}
.available-switch input:checked + span::after {
  transform: translateX(0.72rem);
}
.toolbar-space {
  flex: 1;
}
.view-switcher {
  display: flex;
  padding: 0.12rem;
  border-radius: 7px;
  background: var(--cid-surface-ground);
}
.view-switcher button {
  display: inline-flex;
  width: 1.7rem;
  height: 1.55rem;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--preview-muted);
  cursor: pointer;
}
.view-switcher button.active {
  background: var(--cid-surface-card);
  color: var(--preview-accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}
.compact-grid-icon {
  font-size: 0.66rem;
  transform: scale(0.82);
}
.selection-bar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.42rem 0.65rem;
  color: var(--cid-primary-contrast-color, white);
  background: var(--preview-accent);
  font-size: 0.67rem;
}
.selection-bar button {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.selection-bar button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
  text-decoration: none;
}
.selection-bar button:last-child {
  margin-left: auto;
}
.available-switch,
.selection-bar {
  font-size: var(--workspace-font-small);
}
.table-search input,
.button {
  font-size: var(--workspace-font-body);
}
@media (max-width: 820px) {
  .table-toolbar {
    flex-wrap: wrap;
  }
  .table-search {
    width: 100%;
  }
  .toolbar-space {
    display: none;
  }
}
</style>
