<template>
  <div class="subnet-detail" v-if="subnet">
    <div class="page-header">
      <div>
        <Button icon="pi pi-arrow-left" severity="secondary" text @click="router.push('/subnets')" />
        <h2 style="display:inline; margin-left: 0.5rem;">{{ subnet.name }}</h2>
        <span class="cidr-badge">{{ subnet.cidr }}</span>
      </div>
      <div class="header-actions">
        <Button label="Add Range" icon="pi pi-plus" severity="secondary" @click="openAddRange" />
      </div>
    </div>

    <!-- Subnet Info Cards -->
    <div class="info-cards">
      <div class="info-card">
        <div class="info-label">Network</div>
        <div class="info-value">{{ subnet.network_address }}</div>
      </div>
      <div class="info-card">
        <div class="info-label">Broadcast</div>
        <div class="info-value">{{ subnet.broadcast_address }}</div>
      </div>
      <div class="info-card">
        <div class="info-label">Gateway</div>
        <div class="info-value">{{ subnet.gateway_address }}</div>
      </div>
      <div class="info-card">
        <div class="info-label">VLAN</div>
        <div class="info-value">{{ subnet.vlan_id ?? '—' }}</div>
      </div>
      <div class="info-card">
        <div class="info-label">Total IPs</div>
        <div class="info-value">{{ subnet.total_addresses }}</div>
      </div>
      <div class="info-card">
        <div class="info-label">Prefix</div>
        <div class="info-value">/{{ subnet.prefix_length }}</div>
      </div>
    </div>

    <!-- Ranges Table -->
    <div class="section">
      <h3>Ranges</h3>
      <DataTable :value="ranges" stripedRows size="small" emptyMessage="No ranges defined.">
        <Column header="Type">
          <template #body="{ data }">
            <span class="range-type-badge" :style="{ background: data.range_type_color }">
              {{ data.range_type_name }}
            </span>
          </template>
        </Column>
        <Column field="start_ip" header="Start IP" />
        <Column field="end_ip" header="End IP" />
        <Column field="description" header="Description">
          <template #body="{ data }">{{ data.description ?? '—' }}</template>
        </Column>
        <Column header="" style="width: 5rem">
          <template #body="{ data }">
            <div class="action-buttons" v-if="isEditableRange(data)">
              <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                      @click="editRange(data)" />
              <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                      @click="confirmDeleteRange(data)" />
            </div>
          </template>
        </Column>
      </DataTable>
    </div>

    <!-- IP Grid -->
    <div class="section">
      <h3>IP Address Map</h3>
      <div class="legend">
        <span v-for="rt in rangeTypeLegend" :key="rt.name" class="legend-item">
          <span class="legend-swatch" :style="{ background: rt.color }"></span>
          {{ rt.name }}
        </span>
        <span class="legend-item">
          <span class="legend-swatch" style="background: #e5e7eb"></span>
          Unassigned
        </span>
      </div>
      <div class="ip-grid" v-if="subnet.total_addresses <= 1024"
           @mousedown="onGridMouseDown"
           @mousemove="onGridMouseMove"
           @mouseup="onGridMouseUp"
           @contextmenu.prevent="onGridContextMenu">
        <div v-for="(ip, idx) in ipGrid" :key="ip.address"
             class="ip-cell"
             :class="{ 'ip-cell-selected': gridSelection.has(idx) }"
             :style="{ background: gridSelection.has(idx) ? 'var(--p-primary-200)' : ip.color }"
             :data-idx="idx"
             :title="`${ip.address}\n${ip.rangeType || 'Unassigned'}${ip.hostname ? '\n' + ip.hostname : ''}`">
          <span class="ip-octet">{{ ip.lastOctet }}</span>
        </div>
      </div>
      <div v-else class="grid-too-large">
        Subnet too large for grid view ({{ subnet.total_addresses }} addresses). Use ranges to manage allocations.
      </div>
    </div>

    <!-- Grid Context Menu -->
    <ContextMenu ref="gridContextMenuRef" :model="gridContextMenuItems" />

    <!-- Range Create/Edit Dialog (for ranges with start/end) -->
    <Dialog v-model:visible="showRangeDialog" :header="editingRange ? 'Edit Range' : 'Add Range'"
            modal :style="{ width: '28rem' }">
      <div class="form-grid">
        <div class="field">
          <label>Range Type *</label>
          <Select v-model="rangeForm.range_type_id" :options="editableRangeTypes"
                    optionLabel="name" optionValue="id" placeholder="Select type" class="w-full" />
        </div>
        <template v-if="isGatewayType(rangeForm.range_type_id)">
          <div class="field">
            <label>IP Address *</label>
            <InputText v-model="rangeForm.start_ip" class="w-full" />
          </div>
        </template>
        <template v-else>
          <div class="field">
            <label>Start IP *</label>
            <InputText v-model="rangeForm.start_ip" class="w-full" />
          </div>
          <div class="field">
            <label>End IP *</label>
            <InputText v-model="rangeForm.end_ip" class="w-full" />
          </div>
        </template>
        <div class="field">
          <label>Description</label>
          <InputText v-model="rangeForm.description" class="w-full" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="closeRangeDialog" />
        <Button :label="editingRange ? 'Save' : 'Create'" @click="saveRange" :loading="saving" />
      </template>
    </Dialog>

    <!-- Overlap Warning Dialog -->
    <Dialog v-model:visible="showOverlapDialog" header="Range Overlap Warning" modal :style="{ width: '30rem' }">
      <p>This range overlaps with existing ranges:</p>
      <ul>
        <li v-for="o in overlapDetails" :key="o.id">
          <strong>{{ o.type }}</strong>: {{ o.start_ip }} – {{ o.end_ip }}
        </li>
      </ul>
      <p>Do you want to create it anyway?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showOverlapDialog = false" />
        <Button label="Force Create" severity="warn" @click="forceCreateRange" :loading="saving" />
      </template>
    </Dialog>

    <!-- Delete Range Confirmation -->
    <Dialog v-model:visible="showDeleteRangeDialog" header="Delete Range" modal :style="{ width: '24rem' }">
      <p>Delete this range ({{ deletingRange?.start_ip }} – {{ deletingRange?.end_ip }})?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteRangeDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteRange" :loading="saving" />
      </template>
    </Dialog>

    <Toast />
  </div>
  <div v-else-if="loading" class="loading">Loading subnet...</div>
  <div v-else class="not-found">Subnet not found.</div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import ContextMenu from 'primevue/contextmenu';
import Toast from 'primevue/toast';
import { useSubnetStore } from '../stores/subnets.js';

const route = useRoute();
const router = useRouter();
const toast = useToast();
const store = useSubnetStore();

const subnet = ref(null);
const ips = ref([]);
const ranges = ref([]);
const rangeTypes = ref([]);
const loading = ref(true);
const saving = ref(false);

const showRangeDialog = ref(false);
const showOverlapDialog = ref(false);
const showDeleteRangeDialog = ref(false);
const editingRange = ref(null);
const deletingRange = ref(null);
const overlapDetails = ref([]);
const pendingRangeForm = ref(null);

const rangeForm = ref({ range_type_id: null, start_ip: '', end_ip: '', description: '' });

// Grid context menu
const gridContextMenuRef = ref(null);

function ipToLong(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function longToIp(long) {
  return [(long >>> 24) & 255, (long >>> 16) & 255, (long >>> 8) & 255, long & 255].join('.');
}

const rangeTypeLegend = computed(() => {
  const seen = new Map();
  for (const r of ranges.value) {
    if (!seen.has(r.range_type_name)) {
      seen.set(r.range_type_name, { name: r.range_type_name, color: r.range_type_color });
    }
  }
  return Array.from(seen.values());
});

// Range types that can be used for editing (exclude Network and Broadcast)
const editableRangeTypes = computed(() => {
  return rangeTypes.value.filter(rt => !rt.is_system || !['Network', 'Broadcast'].includes(rt.name));
});

function isGatewayType(typeId) {
  if (!typeId) return false;
  const rt = rangeTypes.value.find(t => t.id === typeId);
  return rt?.is_system && rt.name === 'Gateway';
}

const ipGrid = computed(() => {
  if (!subnet.value || subnet.value.total_addresses > 1024) return [];

  const net = ipToLong(subnet.value.network_address);
  const bcast = ipToLong(subnet.value.broadcast_address);
  const grid = [];

  const ipRangeMap = new Map();
  for (const r of ranges.value) {
    const start = ipToLong(r.start_ip);
    const end = ipToLong(r.end_ip);
    for (let i = start; i <= end; i++) {
      ipRangeMap.set(i, { color: r.range_type_color, rangeType: r.range_type_name, rangeId: r.id });
    }
  }

  const ipAssignMap = new Map();
  for (const ip of ips.value) {
    ipAssignMap.set(ipToLong(ip.ip_address), ip);
  }

  for (let i = net; i <= bcast; i++) {
    const addr = longToIp(i);
    const rangeInfo = ipRangeMap.get(i);
    const assignInfo = ipAssignMap.get(i);

    grid.push({
      address: addr,
      ipLong: i,
      lastOctet: i & 255,
      color: rangeInfo?.color || '#e5e7eb',
      rangeType: rangeInfo?.rangeType || null,
      rangeId: rangeInfo?.rangeId || null,
      hostname: assignInfo?.hostname || null,
      status: assignInfo?.status || 'available'
    });
  }

  return grid;
});

// Grid selection state
const gridSelection = ref(new Set());
const isDragging = ref(false);
const dragStartIdx = ref(null);
const lastClickedIdx = ref(null);

function getCellIdx(event) {
  const cell = event.target.closest('.ip-cell');
  if (!cell) return null;
  return parseInt(cell.dataset.idx, 10);
}

function onGridMouseDown(event) {
  if (event.button !== 0) return; // left click only
  const idx = getCellIdx(event);
  if (idx === null) return;

  if (event.shiftKey && lastClickedIdx.value !== null) {
    // Shift-click: select range from last clicked to current
    const start = Math.min(lastClickedIdx.value, idx);
    const end = Math.max(lastClickedIdx.value, idx);
    const newSet = new Set(gridSelection.value);
    for (let i = start; i <= end; i++) newSet.add(i);
    gridSelection.value = newSet;
  } else if (event.ctrlKey || event.metaKey) {
    // Ctrl-click toggles individual cells
    const newSet = new Set(gridSelection.value);
    if (newSet.has(idx)) newSet.delete(idx);
    else newSet.add(idx);
    gridSelection.value = newSet;
    lastClickedIdx.value = idx;
  } else {
    // Start drag selection
    isDragging.value = true;
    dragStartIdx.value = idx;
    gridSelection.value = new Set([idx]);
    lastClickedIdx.value = idx;
  }
}

function onGridMouseMove(event) {
  if (!isDragging.value || dragStartIdx.value === null) return;
  const idx = getCellIdx(event);
  if (idx === null) return;

  const start = Math.min(dragStartIdx.value, idx);
  const end = Math.max(dragStartIdx.value, idx);
  const newSet = new Set();
  for (let i = start; i <= end; i++) newSet.add(i);
  gridSelection.value = newSet;
}

function onGridMouseUp() {
  isDragging.value = false;
}

function isImmutableCell(idx) {
  if (idx === null || !ipGrid.value[idx]) return false;
  const rt = ipGrid.value[idx].rangeType;
  return rt === 'Network' || rt === 'Broadcast';
}

function onGridContextMenu(event) {
  const idx = getCellIdx(event);
  // Don't show context menu for Network or Broadcast cells
  if (idx !== null && isImmutableCell(idx)) return;
  if (idx !== null && gridSelection.value.size === 0) {
    // Single right-click on a cell with no selection — select it
    gridSelection.value = new Set([idx]);
  }
  if (gridSelection.value.size > 0) {
    gridContextMenuRef.value.show(event);
  }
}

const gridContextMenuItems = computed(() => {
  const sel = gridSelection.value;
  if (sel.size === 0) return [];

  const items = [];
  const selectedIps = Array.from(sel).sort((a, b) => a - b).map(i => ipGrid.value[i]);

  if (sel.size === 1) {
    const ip = selectedIps[0];
    // Single IP right-click: show edit for its range if it has one
    if (ip.rangeId) {
      const range = ranges.value.find(r => r.id === ip.rangeId);
      if (range && isEditableRange(range)) {
        const editLabel = range.range_type_name === 'Gateway' ? 'Edit Gateway' : `Edit ${range.range_type_name} Range`;
        items.push({ label: editLabel, icon: 'pi pi-pencil', command: () => editRange(range) });
      }
    }
  }

  // Create DHCP range from selection
  if (sel.size >= 1) {
    const firstIp = selectedIps[0].address;
    const lastIp = selectedIps[selectedIps.length - 1].address;
    items.push({
      label: sel.size === 1 ? `Create range at ${firstIp}` : `Create range ${firstIp} – ${lastIp}`,
      icon: 'pi pi-plus',
      command: () => openRangeFromSelection(firstIp, lastIp)
    });
  }

  return items;
});

function openRangeFromSelection(startIp, endIp) {
  // Find DHCP Pool type as default
  const dhcpType = rangeTypes.value.find(rt => rt.name === 'DHCP Pool' && rt.is_system);
  rangeForm.value = {
    range_type_id: dhcpType?.id || null,
    start_ip: startIp,
    end_ip: endIp,
    description: ''
  };
  editingRange.value = null;
  showRangeDialog.value = true;
  gridSelection.value = new Set();
}

async function loadData() {
  loading.value = true;
  try {
    const detail = await store.getSubnetDetail(route.params.id);
    subnet.value = detail.subnet;
    ips.value = detail.ips;
    ranges.value = detail.ranges;
    rangeTypes.value = await store.getRangeTypes();
  } catch {
    subnet.value = null;
  } finally {
    loading.value = false;
  }
}

function isEditableRange(range) {
  // Network and Broadcast are immutable
  return !(range.range_type_is_system && ['Network', 'Broadcast'].includes(range.range_type_name));
}

function openAddRange() {
  editingRange.value = null;
  rangeForm.value = { range_type_id: null, start_ip: '', end_ip: '', description: '' };
  showRangeDialog.value = true;
}

function editRange(range) {
  editingRange.value = range;
  rangeForm.value = {
    range_type_id: range.range_type_id,
    start_ip: range.start_ip,
    end_ip: range.end_ip,
    description: range.description || ''
  };
  showRangeDialog.value = true;
}

function closeRangeDialog() {
  showRangeDialog.value = false;
  editingRange.value = null;
  rangeForm.value = { range_type_id: null, start_ip: '', end_ip: '', description: '' };
}

async function saveRange(force = false) {
  saving.value = true;
  try {
    const payload = { ...rangeForm.value };
    if (force) payload.force = true;

    // For Gateway type, end_ip = start_ip (single IP)
    if (isGatewayType(payload.range_type_id)) {
      payload.end_ip = payload.start_ip;
    }

    if (editingRange.value) {
      await store.updateRange(subnet.value.id, editingRange.value.id, payload);
    } else {
      await store.createRange(subnet.value.id, payload);
    }
    closeRangeDialog();
    showOverlapDialog.value = false;
    toast.add({ severity: 'success', summary: editingRange.value ? 'Range updated' : 'Range created', life: 3000 });
    await loadData();
  } catch (err) {
    if (err.response?.status === 409 && err.response?.data?.can_force) {
      overlapDetails.value = err.response.data.overlaps;
      pendingRangeForm.value = { ...rangeForm.value };
      showOverlapDialog.value = true;
    } else {
      toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
    }
  } finally {
    saving.value = false;
  }
}

async function forceCreateRange() {
  rangeForm.value = pendingRangeForm.value;
  await saveRange(true);
}

function confirmDeleteRange(range) {
  deletingRange.value = range;
  showDeleteRangeDialog.value = true;
}

async function doDeleteRange() {
  saving.value = true;
  try {
    await store.deleteRange(subnet.value.id, deletingRange.value.id);
    showDeleteRangeDialog.value = false;
    toast.add({ severity: 'success', summary: 'Range deleted', life: 3000 });
    await loadData();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

onMounted(loadData);
</script>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}
.cidr-badge {
  font-size: 0.9rem;
  background: var(--p-surface-200);
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  margin-left: 0.75rem;
  font-family: monospace;
}
.info-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.75rem;
  margin-bottom: 2rem;
}
.info-card {
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  padding: 0.75rem 1rem;
}
.info-label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
}
.info-value {
  font-size: 1rem;
  font-weight: 600;
  font-family: monospace;
}
.section {
  margin-bottom: 2rem;
}
.section h3 {
  margin: 0 0 0.75rem 0;
}
.range-type-badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  color: white;
  font-size: 0.8rem;
  font-weight: 600;
}
.action-buttons {
  display: flex;
  gap: 0.25rem;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-bottom: 0.75rem;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
}
.legend-swatch {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  display: inline-block;
}
.ip-grid {
  display: grid;
  grid-template-columns: repeat(16, 1fr);
  gap: 2px;
  user-select: none;
}
.ip-cell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  cursor: pointer;
  min-width: 0;
  transition: outline 0.1s;
}
.ip-cell-selected {
  outline: 2px solid var(--p-primary-500);
  outline-offset: -1px;
  z-index: 1;
}
.ip-octet {
  font-size: 0.65rem;
  font-family: monospace;
  color: rgba(0,0,0,0.6);
}
.grid-too-large {
  padding: 2rem;
  text-align: center;
  color: var(--p-text-muted-color);
  background: var(--p-surface-card);
  border-radius: 8px;
  border: 1px dashed var(--p-surface-border);
}
.form-grid {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.field label {
  display: block;
  margin-bottom: 0.35rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.loading, .not-found {
  padding: 3rem;
  text-align: center;
  color: var(--p-text-muted-color);
}
</style>
