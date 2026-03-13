<template>
  <div class="folder-table">
    <!-- Header -->
    <div class="folder-header">
      <i class="pi pi-folder" style="font-size: 0.9rem"></i>
      <span class="folder-name">{{ folder.name }}</span>
      <span v-if="folder.description" class="folder-desc">{{ folder.description }}</span>
      <span style="flex:1"></span>
      <span class="folder-count">{{ totalCount }} networks</span>
    </div>

    <!-- Table -->
    <div class="table-area">
      <div class="table-hdr">
        <span class="col col-cidr">Network</span>
        <span class="col col-name">Name</span>
        <span class="col col-vlan">VLAN</span>
        <span class="col col-desc">Description</span>
        <span class="col col-scan">Scan</span>
        <span class="col col-status">Status</span>
        <span class="col col-actions"></span>
      </div>
      <div v-for="item in flatRows" :key="item.node.key"
           class="table-row"
           :class="{
             'row-allocated': item.node.data.status === 'allocated',
             'row-unallocated': item.node.data.status !== 'allocated',
             'row-merge-selected': props.mergeSelectedIds.includes(item.node.data.id),
           }"
           :draggable="isDraggable(item.node)"
           @dragstart="onDragStart($event, item.node)"
           @click="onRowClick($event, item.node)"
           @contextmenu.prevent="$emit('context-menu', $event, item.node)">
        <span class="col col-cidr">
          <span :style="{ paddingLeft: (item.depth * 1.2) + 'rem' }" class="cidr-cell">
            <i v-if="item.hasChildren"
               class="pi expand-icon"
               :class="expanded[item.node.key] ? 'pi-chevron-down' : 'pi-chevron-right'"
               @click.stop="toggleExpand(item.node.key)"></i>
            <span v-else class="expand-spacer"></span>
            <span class="cidr-text">{{ item.node.data.cidr }}</span>
          </span>
        </span>
        <span class="col col-name">{{ item.node.data.name || '—' }}</span>
        <span class="col col-vlan">{{ item.node.data.vlan_id || '—' }}</span>
        <span class="col col-desc">{{ item.node.data.description || '—' }}</span>
        <span class="col col-scan">
          <span v-if="item.node.data.status === 'allocated'" class="scan-badge" :class="scanClass(item.node)">{{ scanLabel(item.node) }}</span>
          <span v-else>—</span>
        </span>
        <span class="col col-status">
          <span class="status-badge" :class="statusClass(item.node)">{{ statusLabel(item.node) }}</span>
        </span>
        <span class="col col-actions" v-if="item.node.data.status === 'allocated'">
          <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                  @click.stop="$emit('edit-subnet', item.node)" data-track="folder-net-edit" />
          <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                  @click.stop="$emit('delete-subnet', item.node)" data-track="folder-net-delete" />
        </span>
        <span class="col col-actions" v-else></span>
      </div>
      <div v-if="flatRows.length === 0" class="empty-state">
        No networks in this folder.
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import Button from 'primevue/button';
import { useSubnetStore } from '../stores/subnets.js';

const props = defineProps({
  folder: { type: Object, required: true },
  mergeSelectedIds: { type: Array, default: () => [] },
});

const emit = defineEmits(['select-subnet', 'context-menu', 'merge-toggle', 'edit-subnet', 'delete-subnet']);
const store = useSubnetStore();

const expanded = ref({});

// Auto-expand all root nodes on folder change
watch(() => props.folder.id, () => {
  const nodes = getNodes();
  const autoExpand = {};
  for (const n of nodes) {
    if (n.children && n.children.length > 0) {
      autoExpand[n.key] = true;
    }
  }
  expanded.value = autoExpand;
}, { immediate: true });

function getNodes() {
  if (!props.folder.subnets || props.folder.subnets.length === 0) return [];
  return store.toSubnetNodes(props.folder.subnets);
}

const flatRows = computed(() => {
  const nodes = getNodes();
  const flat = [];
  function walk(list, depth) {
    for (const n of list) {
      const hasChildren = n.children && n.children.length > 0;
      flat.push({ node: n, depth, hasChildren });
      if (hasChildren && expanded.value[n.key]) {
        walk(n.children, depth + 1);
      }
    }
  }
  walk(nodes, 0);
  return flat;
});

const totalCount = computed(() => {
  let count = 0;
  function walk(nodes) {
    for (const n of nodes) {
      count++;
      if (n.children && n.children.length > 0) walk(n.children);
    }
  }
  if (props.folder.subnets) walk(props.folder.subnets);
  return count;
});

function toggleExpand(key) {
  expanded.value = { ...expanded.value, [key]: !expanded.value[key] };
}

function onRowClick(event, node) {
  if ((event.ctrlKey || event.metaKey) && node.data.id) {
    emit('merge-toggle', node.data.id);
    return;
  }
  if (node.data.status === 'allocated') {
    emit('select-subnet', node);
  }
}

function isDraggable(node) {
  if (node.data.status === 'allocated') return false;
  if (node.children && node.children.length > 0) return false;
  return true;
}

function onDragStart(event, node) {
  if (!isDraggable(node)) return;
  event.dataTransfer.setData('application/x-subnet-id', String(node.data.id));
  event.dataTransfer.setData('text/plain', node.data.cidr);
  event.dataTransfer.effectAllowed = 'move';
}

function scanLabel(node) {
  const v = node.data.scan_enabled;
  if (v === 1) return 'enabled';
  if (v === 0) return 'disabled';
  return 'inherit';
}

function scanClass(node) {
  const v = node.data.scan_enabled;
  if (v === 1) return 'scan-on';
  if (v === 0) return 'scan-off';
  return 'scan-inherit';
}

function statusClass(node) {
  const d = node.data;
  if (d.status === 'allocated') return 'st-allocated';
  if (node.children && node.children.length > 0) return 'st-divided';
  return 'st-unallocated';
}

function statusLabel(node) {
  const d = node.data;
  if (d.status === 'allocated') return 'allocated';
  if (node.children && node.children.length > 0) return 'divided';
  return 'unallocated';
}
</script>

<style scoped>
.folder-table {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.folder-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.75rem;
  height: 2.4rem;
  box-sizing: border-box;
  border-bottom: 1px solid var(--p-surface-border);
  flex-shrink: 0;
}
.folder-name {
  font-weight: 700;
  font-size: 0.9rem;
}
.folder-desc {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
.folder-count {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.table-area {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  font-size: 0.8rem;
}

.table-hdr {
  display: flex;
  padding: 0.4rem 0.75rem;
  font-weight: 600;
  font-size: 0.7rem;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
  border-bottom: 1px solid var(--p-surface-border);
  position: sticky;
  top: 0;
  background: var(--p-surface-card);
  z-index: 1;
}

.table-row {
  display: flex;
  padding: 0.4rem 0.75rem;
  align-items: center;
  border-bottom: 1px solid color-mix(in srgb, var(--p-surface-border) 50%, transparent);
  cursor: default;
  transition: background 0.1s;
}
.table-row.row-allocated {
  cursor: pointer;
}
.table-row.row-allocated:hover {
  background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
}
.table-row.row-unallocated {
  opacity: 0.7;
}
.table-row.row-unallocated[draggable="true"] {
  cursor: grab;
}
.table-row.row-merge-selected {
  background: color-mix(in srgb, var(--p-orange-500) 15%, transparent);
  border-left: 3px solid var(--p-orange-500);
}

.col {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-cidr { width: 14rem; }
.col-name { flex: 1; }
.col-vlan { width: 5rem; }
.col-desc { flex: 1; }
.col-scan { width: 5rem; }
.col-status { width: 6rem; }
.col-actions { width: 4.5rem; display: flex; gap: 0.15rem; flex-shrink: 0; justify-content: flex-end; overflow: visible; white-space: normal; }

.cidr-cell {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.cidr-text {
  font-family: monospace;
  font-weight: 500;
}
.expand-icon {
  font-size: 0.55rem;
  cursor: pointer;
  width: 0.8rem;
  text-align: center;
  flex-shrink: 0;
}
.expand-spacer {
  width: 0.8rem;
  flex-shrink: 0;
}

.status-badge {
  display: inline-block;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 500;
}
.st-allocated {
  background: color-mix(in srgb, var(--p-green-500) 20%, transparent);
  color: var(--p-green-500);
}
.st-unallocated {
  color: var(--p-text-muted-color);
}
.st-divided {
  background: color-mix(in srgb, var(--p-blue-500) 15%, transparent);
  color: var(--p-blue-500);
}

.scan-badge {
  display: inline-block;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 500;
}
.scan-on {
  background: color-mix(in srgb, var(--p-green-500) 20%, transparent);
  color: var(--p-green-500);
}
.scan-off {
  background: color-mix(in srgb, var(--p-red-500) 15%, transparent);
  color: var(--p-red-500);
}
.scan-inherit {
  color: var(--p-text-muted-color);
}

.empty-state {
  padding: 2rem;
  text-align: center;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
</style>
