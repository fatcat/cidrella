<template>
  <div v-if="density === 'spacious'" class="address-grid-view">
    <div class="grid-ruler">
      <span>.0</span><span>.16</span><span>.32</span><span>.48</span><span>.64</span><span>.80</span
      ><span>.96</span><span>.112</span>
    </div>
    <div class="address-grid">
      <button
        v-for="(cell, index) in cells"
        :key="cell.ip"
        :ref="(element) => setCellRef(element, index)"
        :class="[cell.kind, { selected: selectedRows.includes(cell.row.id) }]"
        :title="`${cell.ip} · ${cell.label}`"
        :aria-label="`${cell.ip}, ${cell.label}`"
        :aria-pressed="selectedRows.includes(cell.row.id)"
        :tabindex="index === focusedIndex ? 0 : -1"
        @focus="focusedIndex = index"
        @pointerdown="beginDrag($event, index)"
        @pointerenter="extendDrag($event, index)"
        @click="activateCell($event, cell)"
        @keydown="handleKeydown($event, cell, index)"
        @contextmenu.prevent="emit('row-menu', cell.row)"
      >
        <span>{{ cell.last }}</span>
      </button>
    </div>
    <div class="grid-key">
      <span><i class="system" />System</span><span><i class="gateway" />Gateway</span
      ><span><i class="dhcp" />DHCP</span> <span><i class="dns" />Static DNS</span
      ><span><i class="reserved" />Reserved</span><span><i class="rogue" />Rogue</span
      ><span><i class="available" />Available</span>
    </div>
  </div>
  <div v-else class="compact-grid-view">
    <div class="compact-address-grid" aria-label="Compact address grid">
      <button
        v-for="(cell, index) in cells"
        :key="cell.ip"
        :ref="(element) => setCellRef(element, index)"
        :class="[
          cell.kind,
          { section: (index + 1) % 16 === 0, selected: selectedRows.includes(cell.row.id) },
        ]"
        :title="`${cell.ip} · ${cell.label}`"
        :aria-label="`${cell.ip}, ${cell.label}`"
        :aria-pressed="selectedRows.includes(cell.row.id)"
        :tabindex="index === focusedIndex ? 0 : -1"
        @focus="focusedIndex = index"
        @pointerdown="beginDrag($event, index)"
        @pointerenter="extendDrag($event, index)"
        @click="activateCell($event, cell)"
        @keydown="handleKeydown($event, cell, index)"
        @contextmenu.prevent="emit('row-menu', cell.row)"
      />
    </div>
    <div class="grid-key">
      <span><i class="system" />System</span><span><i class="gateway" />Gateway</span
      ><span><i class="dhcp" />DHCP</span> <span><i class="dns" />Static DNS</span
      ><span><i class="reserved" />Reserved</span><span><i class="rogue" />Rogue</span
      ><span><i class="available" />Available</span>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

// One grid, two densities. Cells arrive already classified by the parent
// (gridKind over canonical rows); this component never derives status itself.
const props = defineProps({
  cells: { type: Array, required: true },
  density: {
    type: String,
    default: 'spacious',
    validator: (value) => ['spacious', 'compact'].includes(value),
  },
  selectedRows: { type: Array, default: () => [] },
});
const emit = defineEmits(['open', 'toggle', 'range-toggle', 'drag-select', 'row-menu']);
const focusedIndex = ref(0);
const cellRefs = [];
let dragStart = null;
let dragEnd = null;
let dragAdditive = false;
let dragged = false;

function setCellRef(element, index) {
  if (element) cellRefs[index] = element;
}

function activateCell(event, cell) {
  if (dragged) {
    dragged = false;
    return;
  }
  if (event.shiftKey) emit('range-toggle', cell.row);
  else if (event.ctrlKey || event.metaKey) emit('toggle', cell.row.id);
  else emit('open', cell);
}

function beginDrag(event, index) {
  if (event.button !== 0) return;
  dragStart = index;
  dragEnd = index;
  dragAdditive = event.ctrlKey || event.metaKey;
  dragged = false;
}

function extendDrag(event, index) {
  if (dragStart == null || event.buttons !== 1) return;
  dragEnd = index;
  dragged ||= dragEnd !== dragStart;
}

function finishDrag() {
  if (dragStart == null) return;
  if (dragged) {
    const start = Math.min(dragStart, dragEnd);
    const end = Math.max(dragStart, dragEnd);
    emit('drag-select', {
      ids: props.cells.slice(start, end + 1).map((cell) => cell.row.id),
      additive: dragAdditive,
    });
  }
  dragStart = null;
  dragEnd = null;
  dragAdditive = false;
}

function handleKeydown(event, cell, index) {
  if (event.key === 'Enter') {
    event.preventDefault();
    emit('open', cell);
    return;
  }
  if (event.key === ' ') {
    event.preventDefault();
    emit(event.shiftKey ? 'range-toggle' : 'toggle', event.shiftKey ? cell.row : cell.row.id);
    return;
  }
  const columns = props.density === 'compact' ? 64 : 16;
  const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
  let next = offsets[event.key] == null ? null : index + offsets[event.key];
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = props.cells.length - 1;
  if (next == null) return;
  event.preventDefault();
  focusedIndex.value = Math.max(0, Math.min(props.cells.length - 1, next));
  cellRefs[focusedIndex.value]?.focus();
}

watch(
  () => props.cells.length,
  (length) => {
    focusedIndex.value = Math.max(0, Math.min(focusedIndex.value, length - 1));
    cellRefs.length = length;
  },
);

onMounted(() => globalThis.window?.addEventListener('pointerup', finishDrag));
onBeforeUnmount(() => globalThis.window?.removeEventListener('pointerup', finishDrag));
</script>

<style scoped>
button,
input {
  font: inherit;
}
button {
  color: inherit;
}
.grid-key {
  display: flex;
  flex-wrap: wrap;
  gap: 0.7rem;
  color: var(--preview-muted);
  font-size: 0.61rem;
}
.grid-key span {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.grid-key i {
  width: 0.48rem;
  height: 0.48rem;
  border-radius: 2px;
}
.grid-key i.dhcp {
  background: var(--preview-accent);
}
.grid-key i.infra {
  background: #22d3ee;
}
.grid-key i.reserved {
  background: var(--preview-dhcp);
}
.grid-key i.system {
  background: var(--cid-surface-500);
}
.address-grid-view {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0.7rem;
}
.grid-ruler {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  margin: 0 0 0.28rem;
  color: var(--preview-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.56rem;
}
.address-grid {
  display: grid;
  grid-template-columns: repeat(16, minmax(24px, 1fr));
  gap: 3px;
}
.address-grid button {
  aspect-ratio: 1.35;
  min-height: 23px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: var(--cid-surface-100);
  color: var(--preview-muted);
  font-size: 0.54rem;
  cursor: pointer;
}
.address-grid button:hover {
  border-color: var(--cid-text-color);
  transform: translateY(-1px);
}
.address-grid button.selected,
.compact-address-grid button.selected {
  outline: 2px solid var(--cid-text-color);
  outline-offset: -2px;
}
.address-grid button.system {
  background: var(--cid-surface-400);
  color: white;
}
.address-grid button.gateway {
  background: var(--preview-dns);
  color: #111;
}
.address-grid button.infra {
  background: color-mix(in srgb, #22d3ee 35%, var(--cid-surface-card));
}
.address-grid button.dhcp {
  background: color-mix(in srgb, var(--preview-accent) 22%, var(--cid-surface-card));
}
.address-grid button.dhcp-active {
  background: var(--preview-accent);
  color: white;
}
.address-grid button.dns {
  background: color-mix(in srgb, var(--preview-dns) 70%, #fde68a);
  color: #111;
}
.address-grid button.reserved {
  background: color-mix(in srgb, var(--preview-dhcp) 64%, var(--cid-surface-card));
  color: white;
}
.address-grid button.rogue {
  border: 2px solid var(--cid-red-500);
  background: color-mix(in srgb, var(--cid-red-500) 12%, var(--cid-surface-card));
  color: var(--cid-red-600);
  font-weight: 800;
}
.grid-key {
  margin-top: 0.65rem;
}
.grid-key i.gateway {
  background: var(--preview-dns);
}
.grid-key i.dns {
  background: color-mix(in srgb, var(--preview-dns) 70%, #fde68a);
}
.grid-key i.rogue {
  border: 2px solid var(--cid-red-500);
}
.grid-key i.available {
  border: 1px solid var(--preview-line);
  background: var(--cid-surface-100);
}
.compact-grid-view {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 0.7rem;
}
.compact-address-grid {
  display: grid;
  grid-template-columns: repeat(64, minmax(5px, 1fr));
  overflow: hidden;
  border-top: 1px solid var(--preview-line);
  border-left: 1px solid var(--preview-line);
  user-select: none;
}
.compact-address-grid button {
  position: relative;
  min-width: 0;
  min-height: 7px;
  aspect-ratio: 1;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: var(--cid-surface-100);
  box-shadow:
    inset -1px 0 var(--preview-line),
    inset 0 -1px var(--preview-line);
  cursor: pointer;
}
.compact-address-grid button.section {
  box-shadow:
    inset -2px 0 color-mix(in srgb, var(--preview-line) 75%, var(--cid-text-color)),
    inset 0 -1px var(--preview-line);
}
.compact-address-grid button:hover {
  z-index: 1;
  outline: 2px solid var(--cid-text-color);
  outline-offset: -1px;
}
.compact-address-grid button.system {
  background: var(--cid-surface-400);
}
.compact-address-grid button.gateway {
  background: var(--preview-dns);
}
.compact-address-grid button.dhcp {
  background: color-mix(in srgb, var(--preview-accent) 22%, var(--cid-surface-card));
}
.compact-address-grid button.dhcp-active {
  background: var(--preview-accent);
}
.compact-address-grid button.dns {
  background: color-mix(in srgb, var(--preview-dns) 70%, #fde68a);
}
.compact-address-grid button.reserved {
  background: color-mix(in srgb, var(--preview-dhcp) 64%, var(--cid-surface-card));
}
.compact-address-grid button.rogue {
  z-index: 1;
  outline: 2px solid var(--cid-red-500);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--cid-red-500) 12%, var(--cid-surface-card));
}
.grid-key,
.grid-ruler,
.address-grid button {
  font-size: var(--workspace-font-small);
}
</style>
