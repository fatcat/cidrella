<template>
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th v-if="showCheckboxes" class="check-cell">
            <input
              type="checkbox"
              aria-label="Select all visible rows"
              @change="emit('toggle-all', $event)"
            />
          </th>
          <th v-for="column in columns" :key="column.key" :class="column.className">
            <button @click="emit('sort', column.key)">
              {{ column.label }}
              <i
                v-if="sortKey === column.key"
                :class="sortOrder === 1 ? 'pi pi-sort-amount-up-alt' : 'pi pi-sort-amount-down'"
              />
            </button>
          </th>
          <th class="action-cell"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id"
          :class="{ selected: selectedRowId === row.id }"
          tabindex="0"
          :aria-selected="selectedRowId === row.id"
          :draggable="draggableRows ? 'true' : undefined"
          @click="emit('select', row)"
          @keydown="handleRowKeydown($event, row)"
          @dragstart="emit('row-dragstart', row, $event)"
        >
          <td v-if="showCheckboxes" class="check-cell" @click.stop>
            <input
              type="checkbox"
              :checked="selectedRows.includes(row.id)"
              :aria-label="`Select ${row.address}`"
              @change="emit('toggle-row', row.id)"
            />
          </td>
          <td v-for="column in columns" :key="column.key" :class="column.className">
            <template v-if="column.key === 'online' || column.key === 'is_online'">
              <span class="online-value" :class="row.online"><i />{{ row.online }}</span>
            </template>
            <template v-else-if="column.key === 'status' || column.key === 'lease'">
              <span class="table-pill" :class="pillClass(cellValue(row, column))">{{
                cellValue(row, column)
              }}</span>
            </template>
            <template v-else-if="column.key === 'type'">
              <span v-if="row.type" class="type-value"
                ><i :class="typeIcon(row.type)" />{{ row.type }}</span
              >
              <span v-else class="muted">{{ EMPTY_CELL }}</span>
            </template>
            <template v-else-if="column.key === 'enabled'">
              <span class="enabled-value" :class="{ off: !row.enabled }"
                ><i />{{ row.enabled ? 'Enabled' : 'Disabled' }}</span
              >
            </template>
            <template v-else>{{ cellValue(row, column) || EMPTY_CELL }}</template>
          </td>
          <td class="action-cell" @click.stop>
            <button aria-label="Row actions" @click="emit('row-menu', row, $event.currentTarget)">
              <i class="pi pi-ellipsis-h" />
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="!rows.length" class="no-results">
      <i class="pi pi-search" /><strong>No matching rows</strong
      ><span>Try clearing the search or filters.</span>
    </div>
  </div>
</template>

<script setup>
import { EMPTY_CELL } from '../../utils/format.js';

// Row rendering, sort headers and selection checkboxes. The pager stays in
// NetworksWorkspace.vue because it drives the grid presentations too. Rows are
// the parent's display adapters (mapAddressRows and friends); this component
// reads their fields and never classifies an address itself.
const props = defineProps({
  columns: { type: Array, required: true },
  rows: { type: Array, required: true },
  showCheckboxes: { type: Boolean, default: false },
  selectedRowId: { type: [String, Number], default: null },
  selectedRows: { type: Array, default: () => [] },
  sortKey: { type: String, default: null },
  sortOrder: { type: Number, default: 1 },
  // The parent decides what a drag carries (N-08 network moves); the table
  // only marks rows draggable and forwards the event.
  draggableRows: { type: Boolean, default: false },
});
const emit = defineEmits([
  'sort',
  'select',
  'toggle-row',
  'toggle-all',
  'row-menu',
  'row-dragstart',
]);

// Rows are focusable so the table works without a pointer (T-38): Enter
// opens details, Space toggles selection where the view has checkboxes,
// ArrowUp/ArrowDown move between rows, Shift+F10 or the ContextMenu key
// opens the row menu on the row itself.
function handleRowKeydown(event, row) {
  if (event.target !== event.currentTarget) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    emit('select', row);
  } else if (event.key === ' ' && props.showCheckboxes) {
    event.preventDefault();
    emit('toggle-row', row.id);
  } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    emit('row-menu', row, event.currentTarget);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const sibling =
      event.key === 'ArrowDown'
        ? event.currentTarget.nextElementSibling
        : event.currentTarget.previousElementSibling;
    if (sibling) {
      event.preventDefault();
      sibling.focus();
    }
  }
}

function cellValue(row, column) {
  const aliases = {
    ip_address: 'address',
    mac_address: 'mac',
    last_seen_at: 'lastSeen',
    dns_hostname: 'name',
    record_type: 'recordType',
    lease: 'leaseStatus',
    expires: 'expires',
    is_online: 'online',
  };
  if (column.key === 'dns_hostname' && row.raw?.record_fqdn) return row.raw.record_fqdn;
  const mappedKey = aliases[column.key] || column.key;
  if (row[mappedKey] != null) return row[mappedKey];
  const field = column.field || column.key;
  return row.raw?.[field];
}
function pillClass(value) {
  return String(value || '')
    .toLowerCase()
    .replaceAll(' ', '-');
}
function typeIcon(type) {
  if (type === 'gateway') return 'pi pi-directions';
  if (type?.includes('DHCP')) return 'pi pi-server';
  if (type === 'static DNS') return 'pi pi-globe';
  if (type === 'rogue') return 'pi pi-exclamation-triangle';
  return 'pi pi-shield';
}
</script>

<style scoped>
button,
input {
  font: inherit;
}
button {
  color: inherit;
}
.table-scroll {
  min-height: 0;
  flex: 1;
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.67rem;
}
thead {
  position: sticky;
  top: 0;
  z-index: 1;
  background: color-mix(in srgb, var(--cid-surface-ground) 78%, var(--cid-surface-card));
}
th {
  height: 2rem;
  padding: 0 0.6rem;
  border-bottom: 1px solid var(--preview-line);
  color: var(--preview-muted);
  text-align: left;
  white-space: nowrap;
}
th button {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font-size: 0.59rem;
  font-weight: 800;
  letter-spacing: 0.055em;
  text-transform: uppercase;
  cursor: pointer;
}
td {
  height: 2.35rem;
  padding: 0 0.6rem;
  border-bottom: 1px solid color-mix(in srgb, var(--preview-line) 65%, transparent);
  white-space: nowrap;
}
tbody tr {
  cursor: pointer;
}
tbody tr:hover,
tbody tr.selected {
  background: var(--preview-accent-soft);
}
tbody tr:focus-visible {
  outline: 2px solid var(--cid-primary-color);
  outline-offset: -2px;
}
.check-cell {
  width: 1.5rem;
  padding-right: 0;
}
.check-cell input {
  accent-color: var(--preview-accent);
}
.action-cell {
  width: 2rem;
  padding-left: 0;
  text-align: right;
}
.action-cell button {
  width: 1.65rem;
  height: 1.65rem;
  border: 0;
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
}
.action-cell button:hover {
  color: var(--preview-accent);
  background: var(--cid-surface-card);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
  color: var(--preview-muted);
}
.table-pill {
  display: inline-flex;
  padding: 0.17rem 0.38rem;
  border-radius: 999px;
  font-size: 0.6rem;
  font-weight: 750;
}
.table-pill.in-use,
.table-pill.active {
  color: var(--cid-red-600);
  background: color-mix(in srgb, var(--cid-red-500) 10%, transparent);
}
.table-pill.dhcp-scope,
.table-pill.available {
  color: var(--preview-accent);
  background: color-mix(in srgb, var(--preview-accent) 10%, transparent);
}
.table-pill.offline,
.table-pill.expired {
  color: var(--preview-muted);
  background: var(--cid-surface-ground);
}
.table-pill.unavailable {
  color: var(--preview-dns);
  background: color-mix(in srgb, var(--preview-dns) 12%, transparent);
}
.online-value,
.enabled-value {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  text-transform: capitalize;
}
.online-value i,
.enabled-value i {
  width: 0.38rem;
  height: 0.38rem;
  border-radius: 50%;
  background: var(--cid-green-500);
}
.online-value.offline i,
.enabled-value.off i {
  background: var(--cid-surface-400);
}
.online-value.unknown {
  color: var(--preview-muted);
}
.online-value.unknown i {
  border: 1px solid var(--cid-surface-400);
  background: transparent;
}
.type-value {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.type-value i {
  color: var(--preview-accent);
  font-size: 0.7rem;
}
.no-results {
  display: flex;
  min-height: 180px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 0.4rem;
  color: var(--preview-muted);
}
.no-results i {
  font-size: 1.4rem;
}
.no-results strong {
  color: var(--cid-text-color);
}
.table-pill {
  font-size: var(--workspace-font-small);
}
table,
th button {
  font-size: var(--workspace-font-body);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
