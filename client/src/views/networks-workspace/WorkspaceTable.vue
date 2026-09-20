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
          @contextmenu.prevent="emit('row-menu', row, $event.currentTarget, $event)"
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
              <span
                v-if="cellValue(row, column)"
                class="address-type-pill status-pill"
                :class="statusClass(cellValue(row, column))"
                >{{ cellValue(row, column) }}</span
              >
              <span v-else class="muted">{{ EMPTY_CELL }}</span>
            </template>
            <template v-else-if="column.key === 'type'">
              <AddressTypePill
                :display="typeDisplay(row)"
                :tooltip="row.raw?.address_type_tooltip || null"
              />
            </template>
            <template v-else-if="column.key === 'assignment'">
              <span v-if="row.assignment" class="assignment-cell">
                <span
                  class="address-type-pill"
                  :class="
                    row.assignment === 'Reserved' ? 'type-reserved-dhcp' : 'type-dynamic-dhcp'
                  "
                  >{{ row.assignment }}</span
                >
                <span
                  v-if="row.pool"
                  class="address-type-pill pool-pill"
                  :class="`pool-${row.pool.tone}`"
                  >{{ row.pool.label }}</span
                >
              </span>
              <span v-else class="muted">{{ EMPTY_CELL }}</span>
            </template>
            <template v-else-if="column.key === 'enabled'">
              <span class="enabled-value" :class="{ off: !row.enabled }"
                ><i />{{ row.enabled ? 'Enabled' : 'Disabled' }}</span
              >
            </template>
            <template v-else>{{ cellValue(row, column) || EMPTY_CELL }}</template>
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
import AddressTypePill from '../../components/table/AddressTypePill.vue';
import { EMPTY_CELL } from '../../utils/format.js';
import { ipLifecycleDisplay } from '../../utils/ipLifecycleDisplay.js';

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
// Tags are the current interface's: AddressTypePill for the Type column
// (same classes and semantic colors as the current tables) and a status pill
// where "in use" is neutral, since it is neither good nor bad.
function statusClass(value) {
  return `status-${String(value || '')
    .toLowerCase()
    .replaceAll(' ', '-')}`;
}
function typeDisplay(row) {
  return ipLifecycleDisplay({ address_type: row.type || null }).addressType;
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
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
  color: var(--preview-muted);
}
/* Status pills share the current interface's capsule shape (.address-type-pill,
   App.vue). "in use" is neutral: text on a gray capsule. */
.status-pill.status-in-use {
  background: color-mix(in srgb, var(--cid-status-muted) 28%, transparent);
  color: var(--cid-text-color);
}
.status-pill.status-available,
.status-pill.status-inactive,
.status-pill.status-offline,
.status-pill.status-expired {
  background: transparent;
  border-color: color-mix(in srgb, var(--cid-status-muted) 45%, transparent);
  color: var(--cid-status-muted);
}
.status-pill.status-dhcp-scope {
  background: color-mix(in srgb, var(--cid-status-info) 16%, transparent);
  color: var(--cid-status-info);
}
.status-pill.status-active {
  background: color-mix(in srgb, var(--cid-status-ok) 16%, transparent);
  color: var(--cid-status-ok);
}
.status-pill.status-unavailable {
  background: color-mix(in srgb, var(--cid-status-warn) 16%, transparent);
  color: var(--cid-status-warn);
}
.assignment-cell {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
/* Pool membership qualifies the assignment pill beside it: outlined, so it
   reads as a note rather than a second status. */
.pool-pill {
  font-weight: 500;
  background: transparent;
}
.pool-pill.pool-muted {
  border-color: color-mix(in srgb, var(--cid-status-muted) 45%, transparent);
  color: var(--cid-status-muted);
}
.pool-pill.pool-warn {
  border-color: color-mix(in srgb, var(--cid-status-warn) 55%, transparent);
  color: var(--cid-status-warn);
}
.online-value,
.enabled-value {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  text-transform: capitalize;
}
/* Online and Enabled are green as a word, not only as a dot, so the state
   reads at a glance the way it does in the classic tables (.state-ok). */
.online-value.online,
.enabled-value:not(.off) {
  color: var(--cid-status-ok);
}
.online-value i,
.enabled-value i {
  width: 0.38rem;
  height: 0.38rem;
  border-radius: 50%;
  background: var(--cid-status-ok);
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
.address-type-pill {
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
