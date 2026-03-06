<template>
  <div class="subnet-detail" v-if="subnet" style="position: relative;">
    <!-- Loading overlay for large subnets -->
    <Transition name="fade">
      <div v-if="showLoadingOverlay" class="loading-overlay">
        <div class="loading-card">
          <i class="pi pi-spin pi-spinner" style="font-size: 1.5rem"></i>
          <span>Loading Data</span>
        </div>
      </div>
    </Transition>
    <div class="detail-header">
      <div>
        <h3 style="margin: 0; display: inline;">{{ subnet.name }}</h3>
        <span class="cidr-badge">{{ subnet.cidr }}</span>
      </div>
      <div class="header-actions">
        <Button label="Add Range" icon="pi pi-plus" severity="secondary" size="small" @click="openAddRange" />
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

    <!-- Tabs: IP Addresses + Grid View -->
    <TabView>
      <TabPanel header="IP Addresses">
        <div class="ip-table-controls">
          <div class="page-size-control">
            <label>Per page:</label>
            <Select v-model="currentPageSize" :options="pageSizeOptions"
                    optionLabel="label" optionValue="value" size="small"
                    @change="onPageSizeChange" style="width: 7rem" />
          </div>
          <div class="page-nav" v-if="totalPages > 1">
            <Button icon="pi pi-angle-double-left" severity="secondary" text size="small"
                    :disabled="currentPage <= 1 || loadingPage" @click="goToPage(1)" title="First page" />
            <Button icon="pi pi-angle-left" severity="secondary" text size="small"
                    :disabled="currentPage <= 1 || loadingPage" @click="goToPage(currentPage - 1)" title="Previous page" />
            <span class="page-info">Page {{ currentPage }} of {{ totalPages }}</span>
            <Button icon="pi pi-angle-right" severity="secondary" text size="small"
                    :disabled="currentPage >= totalPages || loadingPage" @click="goToPage(currentPage + 1)" title="Next page" />
            <Button icon="pi pi-angle-double-right" severity="secondary" text size="small"
                    :disabled="currentPage >= totalPages || loadingPage" @click="goToPage(totalPages)" title="Last page" />
          </div>
          <span class="ip-count">{{ totalIps }} total IPs</span>
        </div>
        <DataTable :value="ips" stripedRows size="small"
                   :loading="loadingPage"
                   emptyMessage="No IP addresses."
                   scrollable scrollHeight="flex"
                   dataKey="ip_address">
          <Column header="Address" style="width: 10rem">
            <template #body="{ data }">
              <span class="ip-mono">{{ data.ip_address }}</span>
            </template>
          </Column>
          <Column header="Status" style="width: 7rem">
            <template #body="{ data }">
              <Tag :severity="statusSeverity(data.status)" :value="data.status" />
            </template>
          </Column>
          <Column header="Type" style="width: 7rem">
            <template #body="{ data }">
              <span v-if="data.range_type_name" class="range-type-badge" :style="{ background: data.range_type_color }">
                {{ data.range_type_name }}
              </span>
              <span v-else>—</span>
            </template>
          </Column>
          <Column field="hostname" header="Hostname" style="width: 10rem">
            <template #body="{ data }">{{ data.hostname || '—' }}</template>
          </Column>
          <Column header="MAC Address" style="width: 10rem">
            <template #body="{ data }">{{ data.mac_address || data.last_seen_mac || data.scan_mac || '—' }}</template>
          </Column>
          <Column header="Online" style="width: 5rem">
            <template #body="{ data }">
              <span v-if="data.is_online" class="online-dot online">●</span>
              <span v-else class="online-dot offline">●</span>
            </template>
          </Column>
          <Column header="Last Seen" style="width: 10rem">
            <template #body="{ data }">{{ data.last_seen_at ? formatDate(data.last_seen_at) : '—' }}</template>
          </Column>
        </DataTable>
      </TabPanel>

      <TabPanel header="Grid View">
        <!-- Ranges Table -->
        <div class="section">
          <h4 style="margin:0 0 0.5rem 0">Ranges</h4>
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

        <!-- IP Grid (smaller) -->
        <div class="section">
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
          <div class="ip-grid" v-if="subnet.total_addresses <= 512"
               @mousedown="onGridMouseDown"
               @mousemove="onGridMouseMove"
               @mouseup="onGridMouseUp"
               @contextmenu.prevent="onGridContextMenu">
            <div v-for="(ip, idx) in ipGrid" :key="ip.address"
                 class="ip-cell"
                 v-tooltip.top="gridTooltip(ip)"
                 :style="{ background: gridSelection.has(idx) ? 'var(--p-primary-200)' : ip.color }"
                 :data-idx="idx"
                 :class="{ 'ip-cell-selected': gridSelection.has(idx), 'ip-cell-conflict': ip.isConflict }">
              <span v-if="ip.isConflict" class="conflict-dot"></span>
            </div>
          </div>
          <div v-else class="grid-too-large">
            Subnet too large for grid view ({{ subnet.total_addresses }} addresses, max 512). Use the IP Addresses tab.
          </div>
        </div>
      </TabPanel>
    </TabView>

    <!-- Scan Progress -->
    <div class="section" v-if="activeScan">
      <h4 style="margin:0 0 0.5rem 0">Network Scan</h4>
      <div class="scan-progress">
        <div class="scan-info">
          <span class="scan-status" :class="'scan-' + activeScan.status">{{ activeScan.status }}</span>
          <span v-if="activeScan.status === 'running'">
            {{ activeScan.scanned_ips }} / {{ activeScan.total_ips }} IPs scanned
          </span>
          <span v-if="activeScan.status === 'completed'">
            {{ activeScan.conflicts_found }} conflict{{ activeScan.conflicts_found !== 1 ? 's' : '' }} found
          </span>
        </div>
        <div class="scan-bar-container" v-if="activeScan.status === 'running'">
          <div class="scan-bar" :style="{ width: scanProgress + '%' }"></div>
        </div>
      </div>
    </div>

    <!-- Scan Confirm Dialog -->
    <Dialog v-model:visible="showScanConfirm" header="Scan Network" modal :style="{ width: '26rem' }">
      <p>This will send ARP probes to all usable IPs in <strong>{{ subnet?.cidr }}</strong>.</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showScanConfirm = false" />
        <Button label="Start Scan" icon="pi pi-search" @click="doStartScan" :loading="startingScan" />
      </template>
    </Dialog>

    <!-- Grid Context Menu -->
    <ContextMenu ref="gridContextMenuRef" :model="gridContextMenuItems" />

    <!-- Range Create/Edit Dialog -->
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

    <!-- DHCP Scope Auto-Create Dialog -->
    <Dialog v-model:visible="showDhcpScopeDialog" header="Configure DHCP Scope" modal :style="{ width: '28rem' }">
      <div class="form-grid">
        <div class="field">
          <label>Lease Time</label>
          <InputText v-model="dhcpScopeForm.lease_time" class="w-full" placeholder="e.g. 24h, 3600, 1d" />
          <small class="field-help">Duration: number with optional suffix (s/m/h/d)</small>
        </div>
        <div class="field">
          <label>Description</label>
          <InputText v-model="dhcpScopeForm.description" class="w-full" />
        </div>
        <div class="options-summary" v-if="dhcpScopeForm.selectedOptions.length > 0">
          <label>Options ({{ dhcpScopeForm.selectedOptions.length }})</label>
          <div class="option-tags">
            <span v-for="code in dhcpScopeForm.selectedOptions" :key="code" class="option-tag">
              {{ scopeOptionLabel(code) }}
            </span>
          </div>
        </div>
      </div>
      <template #footer>
        <Button label="Skip" severity="secondary" @click="showDhcpScopeDialog = false" />
        <Button label="Options..." icon="pi pi-list" severity="secondary" @click="openScopeOptionSelector" />
        <Button label="Create Scope" @click="saveDhcpScope" :loading="savingDhcpScope" />
      </template>
    </Dialog>

    <!-- Scope Option Selector Dialog -->
    <Dialog v-model:visible="showScopeOptionSelector" header="Select DHCP Options" modal :style="{ width: '36rem' }">
      <DataTable :value="scopeOptionCatalog" v-model:selection="scopeSelectedOptionRows" dataKey="code"
                 stripedRows size="small" scrollable scrollHeight="20rem">
        <Column selectionMode="multiple" headerStyle="width: 3rem" />
        <Column field="code" header="Code" style="width: 4rem" />
        <Column field="label" header="Option" />
        <Column field="type" header="Type" style="width: 6rem">
          <template #body="{ data }">
            <span class="text-sm muted">{{ data.type }}</span>
          </template>
        </Column>
        <Column header="Default" style="width: 8rem">
          <template #body="{ data }">
            <span class="text-sm muted">{{ scopeOptionDefaults[data.code] || '—' }}</span>
          </template>
        </Column>
      </DataTable>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showScopeOptionSelector = false" />
        <Button label="Next →" @click="openScopeOptionValues" :disabled="scopeSelectedOptionRows.length === 0" />
      </template>
    </Dialog>

    <!-- Scope Option Values Dialog -->
    <Dialog v-model:visible="showScopeOptionValues" header="Configure Option Values" modal :style="{ width: '32rem' }">
      <div class="form-grid">
        <div class="field" v-for="opt in scopeSelectedOptionRows" :key="opt.code">
          <label>{{ opt.label }} <span class="text-sm muted">({{ opt.code }})</span></label>
          <Select v-if="opt.type === 'select'" v-model="scopeOptionValues[opt.code]"
                  :options="opt.choices" class="w-full" size="small" placeholder="—" />
          <InputNumber v-else-if="opt.type === 'number'" v-model="scopeOptionValues[opt.code]"
                       class="w-full" size="small" :useGrouping="false" />
          <InputText v-else v-model="scopeOptionValues[opt.code]" class="w-full" size="small"
                     :placeholder="scopePlaceholderForType(opt.type)" />
        </div>
      </div>
      <template #footer>
        <Button label="← Back" severity="secondary" @click="showScopeOptionValues = false; showScopeOptionSelector = true" />
        <Button label="Done" @click="applyScopeOptionSelections" />
      </template>
    </Dialog>

    <Toast />
  </div>
  <div v-else-if="loading" class="loading">Loading subnet...</div>
  <div v-else class="empty-state">Select a subnet to view details.</div>
</template>

<script setup>
import { ref, reactive, computed, watch, onUnmounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Select from 'primevue/select';
import ContextMenu from 'primevue/contextmenu';
import Toast from 'primevue/toast';
import TabView from 'primevue/tabview';
import TabPanel from 'primevue/tabpanel';
import Tag from 'primevue/tag';
import { useSubnetStore } from '../stores/subnets.js';
import api from '../api/client.js';

const props = defineProps({
  subnetId: { type: [Number, String], default: null }
});

const emit = defineEmits(['refresh']);

const toast = useToast();
const store = useSubnetStore();

const subnet = ref(null);
const ips = ref([]);
const ranges = ref([]);
const rangeTypes = ref([]);
const loading = ref(false);
const saving = ref(false);

// Server-side pagination state
const currentPage = ref(1);
const currentPageSize = ref(256);
const totalIps = ref(0);
const totalPages = ref(0);
const loadingPage = ref(false);

// Loading overlay for large subnets (>256 IPs)
const showLoadingOverlay = ref(false);

const pageSizeOptions = computed(() => {
  if (!subnet.value) return [{ value: 256, label: '256' }];
  // Use full subnet size (including network/broadcast) so page sizes align with power-of-2 boundaries
  const prefix = subnet.value.prefix_length || 24;
  const subnetSize = Math.pow(2, 32 - prefix);
  const opts = [];
  for (const s of [16, 32, 64, 128, 256, 512]) {
    if (subnetSize >= s) opts.push({ value: s, label: String(s) });
  }
  if (opts.length === 0) opts.push({ value: total, label: String(total) });
  return opts;
});

const showRangeDialog = ref(false);
const showOverlapDialog = ref(false);
const showDeleteRangeDialog = ref(false);
const editingRange = ref(null);
const deletingRange = ref(null);
const overlapDetails = ref([]);
const pendingRangeForm = ref(null);

const rangeForm = ref({ range_type_id: null, start_ip: '', end_ip: '', description: '' });

// DHCP scope auto-creation state
const showDhcpScopeDialog = ref(false);
const savingDhcpScope = ref(false);
const dhcpScopeForm = ref({
  range_id: null, subnet_id: null,
  lease_time: '24h', description: '',
  selectedOptions: [], optionValues: {}
});

// Scope option selector state
const scopeOptionCatalog = ref([]);
const scopeOptionDefaults = reactive({});
const showScopeOptionSelector = ref(false);
const showScopeOptionValues = ref(false);
const scopeSelectedOptionRows = ref([]);
const scopeOptionValues = reactive({});

// Scan state
const showScanConfirm = ref(false);
const startingScan = ref(false);
const activeScan = ref(null);
const scanResults = ref([]);
let scanPollTimer = null;

// Grid context menu
const gridContextMenuRef = ref(null);

function ipToLong(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function longToIp(long) {
  return [(long >>> 24) & 255, (long >>> 16) & 255, (long >>> 8) & 255, long & 255].join('.');
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleString();
}

function statusSeverity(status) {
  switch (status) {
    case 'assigned': return 'info';
    case 'reserved': return 'warn';
    case 'dhcp': return 'success';
    case 'available': return 'secondary';
    default: return 'danger';
  }
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

const editableRangeTypes = computed(() => {
  return rangeTypes.value.filter(rt => !rt.is_system || !['Network', 'Broadcast'].includes(rt.name));
});

function isGatewayType(typeId) {
  if (!typeId) return false;
  const rt = rangeTypes.value.find(t => t.id === typeId);
  return rt?.is_system && rt.name === 'Gateway';
}

function gridTooltip(ip) {
  const lines = [ip.address];
  if (ip.rangeType) lines.push(`Type: ${ip.rangeType}`);
  lines.push(`Status: ${ip.status}`);
  if (ip.hostname) lines.push(`Host: ${ip.hostname}`);
  if (ip.mac) lines.push(`MAC: ${ip.mac}`);
  lines.push(ip.isOnline ? 'Online' : 'Offline');
  if (ip.lastSeen) lines.push(`Last seen: ${formatDate(ip.lastSeen)}`);
  if (ip.conflictReason) lines.push(`Warning: ${ip.conflictReason}`);
  return lines.join('\n');
}

const ipGrid = computed(() => {
  if (!subnet.value || subnet.value.total_addresses > 512) return [];

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

  const conflictMap = new Map();
  for (const r of scanResults.value) {
    if (r.is_conflict) {
      conflictMap.set(r.ip_address, r.conflict_reason);
    }
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
      mac: assignInfo?.mac_address || assignInfo?.last_seen_mac || assignInfo?.scan_mac || null,
      status: assignInfo?.status || 'available',
      isOnline: assignInfo?.is_online === 1,
      lastSeen: assignInfo?.last_seen_at || null,
      isConflict: conflictMap.has(addr),
      conflictReason: conflictMap.get(addr) || null
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
  if (event.button !== 0) return;
  const idx = getCellIdx(event);
  if (idx === null) return;

  if (event.shiftKey && lastClickedIdx.value !== null) {
    const start = Math.min(lastClickedIdx.value, idx);
    const end = Math.max(lastClickedIdx.value, idx);
    const newSet = new Set(gridSelection.value);
    for (let i = start; i <= end; i++) newSet.add(i);
    gridSelection.value = newSet;
  } else if (event.ctrlKey || event.metaKey) {
    const newSet = new Set(gridSelection.value);
    if (newSet.has(idx)) newSet.delete(idx);
    else newSet.add(idx);
    gridSelection.value = newSet;
    lastClickedIdx.value = idx;
  } else {
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
  if (idx !== null && isImmutableCell(idx)) return;
  if (idx !== null && gridSelection.value.size === 0) {
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
    if (ip.rangeId) {
      const range = ranges.value.find(r => r.id === ip.rangeId);
      if (range && isEditableRange(range)) {
        items.push({ label: `Edit ${range.range_type_name} Range`, icon: 'pi pi-pencil', command: () => editRange(range) });
      }
    }
  }

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

async function loadIpPage(page, pageSize, { skipCache = false } = {}) {
  loadingPage.value = true;
  try {
    const detail = await store.getSubnetDetail(props.subnetId, page, pageSize, { skipCache });
    // Guard: if subnetId changed while we were loading, discard stale result
    if (detail.subnet.id !== Number(props.subnetId)) return;
    subnet.value = detail.subnet;
    ips.value = detail.ips;
    ranges.value = detail.ranges;
    totalIps.value = detail.totalIps;
    totalPages.value = detail.totalPages;
    currentPage.value = detail.page;
    currentPageSize.value = detail.pageSize;
  } catch (err) {
    console.error('Failed to load IP page:', err);
  } finally {
    loadingPage.value = false;
  }
}

async function loadData({ skipCache = false } = {}) {
  if (!props.subnetId) {
    subnet.value = null;
    return;
  }
  loading.value = true;

  // Show overlay for large subnets (>256 IPs) with minimum 1s display
  const isLarge = subnet.value ? subnet.value.total_addresses > 256 : false;
  let overlayMinTimer = null;
  if (isLarge) {
    showLoadingOverlay.value = true;
    overlayMinTimer = new Promise(r => setTimeout(r, 1000));
  }

  try {
    currentPage.value = 1;
    // Load IPs and range types in parallel
    const [, rt] = await Promise.all([
      loadIpPage(1, currentPageSize.value, { skipCache }),
      store.getRangeTypes()
    ]);
    rangeTypes.value = rt;

    // Reset scan state
    activeScan.value = null;
    scanResults.value = [];
    if (scanPollTimer) { clearInterval(scanPollTimer); scanPollTimer = null; }
    await loadLatestScan();
  } catch (err) {
    console.error('Failed to load subnet detail:', err);
    subnet.value = null;
  } finally {
    loading.value = false;
    if (overlayMinTimer) {
      overlayMinTimer.then(() => { showLoadingOverlay.value = false; });
    }
  }
}

/** Force-reload current subnet data (e.g. after a mutation) */
async function reloadData() {
  store.invalidateDetailCache(props.subnetId);
  await loadData({ skipCache: true });
}

function goToPage(page) {
  loadIpPage(page, currentPageSize.value);
}

function onPageSizeChange() {
  currentPage.value = 1;
  loadIpPage(1, currentPageSize.value);
}

// Watch for subnetId changes — debounce rapid clicks
let _loadTimer = null;
watch(() => props.subnetId, (newId, oldId) => {
  gridSelection.value = new Set();
  if (_loadTimer) clearTimeout(_loadTimer);
  if (!newId) {
    subnet.value = null;
    return;
  }
  // Debounce: wait 80ms before loading so rapid clicks only trigger once
  _loadTimer = setTimeout(() => {
    _loadTimer = null;
    loadData();
  }, 80);
}, { immediate: true });

function isEditableRange(range) {
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
    if (isGatewayType(payload.range_type_id)) {
      payload.end_ip = payload.start_ip;
    }
    if (editingRange.value) {
      await store.updateRange(subnet.value.id, editingRange.value.id, payload);
      closeRangeDialog();
      showOverlapDialog.value = false;
      toast.add({ severity: 'success', summary: 'Range updated', life: 3000 });
    } else {
      const created = await store.createRange(subnet.value.id, payload);
      closeRangeDialog();
      showOverlapDialog.value = false;
      toast.add({ severity: 'success', summary: 'Range created', life: 3000 });

      // Auto-open DHCP scope dialog for DHCP Pool ranges
      if (created.range_type_name === 'DHCP Pool') {
        dhcpScopeForm.value = {
          range_id: created.id,
          subnet_id: subnet.value.id,
          lease_time: '24h',
          description: '',
          selectedOptions: [],
          optionValues: {}
        };
        // Load options catalog if not already loaded
        if (scopeOptionCatalog.value.length === 0) {
          await loadScopeOptions();
        }
        showDhcpScopeDialog.value = true;
      }
    }
    await reloadData();
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
    await reloadData();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

// DHCP scope options helpers
async function loadScopeOptions() {
  try {
    const res = await api.get('/dhcp/options');
    scopeOptionCatalog.value = res.data.catalog;
    Object.keys(scopeOptionDefaults).forEach(k => delete scopeOptionDefaults[k]);
    for (const [code, value] of Object.entries(res.data.defaults || {})) {
      scopeOptionDefaults[code] = value;
    }
  } catch (err) {
    console.error('Failed to load DHCP options:', err);
  }
}

function scopeOptionLabel(code) {
  const opt = scopeOptionCatalog.value.find(o => o.code === code);
  return opt ? opt.label : `Option ${code}`;
}

function scopePlaceholderForType(type) {
  switch (type) {
    case 'ip': return 'e.g. 192.168.1.1';
    case 'ip-list': return 'e.g. 8.8.8.8, 1.1.1.1';
    case 'text': return 'Value';
    case 'text-list': return 'e.g. domain1.com, domain2.com';
    case 'number': return '0';
    default: return '';
  }
}

function openScopeOptionSelector() {
  scopeSelectedOptionRows.value = scopeOptionCatalog.value.filter(o =>
    dhcpScopeForm.value.selectedOptions.includes(o.code)
  );
  Object.keys(scopeOptionValues).forEach(k => delete scopeOptionValues[k]);
  Object.assign(scopeOptionValues, dhcpScopeForm.value.optionValues);
  showScopeOptionSelector.value = true;
}

function openScopeOptionValues() {
  for (const opt of scopeSelectedOptionRows.value) {
    if (scopeOptionValues[opt.code] == null || scopeOptionValues[opt.code] === '') {
      const def = scopeOptionDefaults[opt.code];
      if (def != null) scopeOptionValues[opt.code] = def;
    }
  }
  showScopeOptionSelector.value = false;
  showScopeOptionValues.value = true;
}

function applyScopeOptionSelections() {
  dhcpScopeForm.value.selectedOptions = scopeSelectedOptionRows.value.map(o => o.code);
  dhcpScopeForm.value.optionValues = {};
  for (const opt of scopeSelectedOptionRows.value) {
    const val = scopeOptionValues[opt.code];
    if (val != null && val !== '') {
      dhcpScopeForm.value.optionValues[opt.code] = String(val);
    }
  }
  showScopeOptionValues.value = false;
}

// DHCP scope auto-creation
async function saveDhcpScope() {
  savingDhcpScope.value = true;
  try {
    const f = dhcpScopeForm.value;
    const options = f.selectedOptions
      .filter(code => f.optionValues[code] != null && f.optionValues[code] !== '')
      .map(code => ({ code, value: String(f.optionValues[code]) }));

    await api.post('/dhcp/scopes', {
      range_id: f.range_id,
      subnet_id: f.subnet_id,
      lease_time: f.lease_time || '24h',
      description: f.description || null,
      options
    });
    showDhcpScopeDialog.value = false;
    toast.add({ severity: 'success', summary: 'DHCP scope created', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingDhcpScope.value = false;
  }
}

// Scan functions
async function doStartScan() {
  startingScan.value = true;
  try {
    const result = await store.startScan(subnet.value.id);
    activeScan.value = { id: result.scan_id, status: 'pending', total_ips: 0, scanned_ips: 0, conflicts_found: 0 };
    showScanConfirm.value = false;
    startPollingScan(result.scan_id);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Scan Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    startingScan.value = false;
  }
}

const scanProgress = computed(() => {
  if (!activeScan.value || activeScan.value.total_ips === 0) return 0;
  return Math.round((activeScan.value.scanned_ips / activeScan.value.total_ips) * 100);
});

function startPollingScan(scanId) {
  if (scanPollTimer) clearInterval(scanPollTimer);
  scanPollTimer = setInterval(async () => {
    try {
      const data = await store.getScan(scanId);
      activeScan.value = data.scan;
      if (data.results) scanResults.value = data.results;
      if (data.scan.status === 'completed' || data.scan.status === 'failed') {
        clearInterval(scanPollTimer);
        scanPollTimer = null;
        if (data.scan.status === 'completed') {
          await reloadData(); // Reload IPs to get updated online status
        }
        if (data.scan.status === 'failed') {
          toast.add({ severity: 'error', summary: 'Scan Failed', detail: data.scan.error, life: 5000 });
        }
      }
    } catch {
      clearInterval(scanPollTimer);
      scanPollTimer = null;
    }
  }, 2000);
}

async function loadLatestScan() {
  if (!subnet.value) return;
  try {
    const scans = await store.getScans(subnet.value.id);
    if (scans.length > 0) {
      const latest = scans[0];
      if (latest.status === 'running' || latest.status === 'pending') {
        activeScan.value = latest;
        startPollingScan(latest.id);
      } else if (latest.status === 'completed') {
        const data = await store.getScan(latest.id);
        activeScan.value = data.scan;
        scanResults.value = data.results || [];
      }
    }
  } catch { /* no scans yet */ }
}

onUnmounted(() => {
  if (scanPollTimer) clearInterval(scanPollTimer);
});
</script>

<style scoped>
.subnet-detail {
  height: 100%;
  overflow-y: auto;
  padding: 1rem;
}
.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.header-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.cidr-badge {
  font-size: 0.85rem;
  background: var(--p-surface-200);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  margin-left: 0.5rem;
  font-family: monospace;
}
.info-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.info-card {
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}
.info-label {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
}
.info-value {
  font-size: 0.9rem;
  font-weight: 600;
  font-family: monospace;
}
.ip-mono {
  font-family: monospace;
  font-size: 0.85rem;
}
.online-dot {
  font-size: 1.1rem;
}
.online-dot.online { color: #22c55e; }
.online-dot.offline { color: #d1d5db; }
.section {
  margin-bottom: 1rem;
}
.range-type-badge {
  display: inline-block;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  color: white;
  font-size: 0.75rem;
  font-weight: 600;
}
.action-buttons {
  display: flex;
  gap: 0.25rem;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
}
.legend-swatch {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  display: inline-block;
}
.ip-grid {
  display: grid;
  grid-template-columns: repeat(32, 1fr);
  gap: 1px;
  user-select: none;
}
.ip-cell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
  cursor: pointer;
  min-height: 12px;
  min-width: 0;
  position: relative;
  transition: outline 0.1s;
}
.ip-cell-selected {
  outline: 2px solid var(--p-primary-500);
  outline-offset: -1px;
  z-index: 1;
}
.ip-cell-conflict {
  outline: 2px solid #ef4444 !important;
  outline-offset: -1px;
}
.conflict-dot {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 4px;
  height: 4px;
  background: #ef4444;
  border-radius: 50%;
}
.ip-table-controls {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.5rem;
  flex-wrap: wrap;
}
.page-size-control {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
}
.page-nav {
  display: flex;
  align-items: center;
  gap: 0.15rem;
}
.page-info {
  font-size: 0.8rem;
  padding: 0 0.5rem;
  white-space: nowrap;
}
.ip-count {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  margin-left: auto;
}
.grid-too-large {
  padding: 1.5rem;
  text-align: center;
  color: var(--p-text-muted-color);
  background: var(--p-surface-card);
  border-radius: 6px;
  border: 1px dashed var(--p-surface-border);
  font-size: 0.9rem;
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
.loading, .empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--p-text-muted-color);
  font-size: 0.95rem;
}
.scan-progress {
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  padding: 0.75rem;
}
.scan-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
}
.scan-status {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-weight: 600;
  text-transform: uppercase;
}
.scan-pending { background: #fef3c7; color: #92400e; }
.scan-running { background: #dbeafe; color: #1e40af; }
.scan-completed { background: #dcfce7; color: #166534; }
.scan-failed { background: #fee2e2; color: #991b1b; }
.scan-bar-container {
  height: 4px;
  background: var(--p-surface-200);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 0.5rem;
}
.scan-bar {
  height: 100%;
  background: var(--p-primary-color);
  border-radius: 2px;
  transition: width 0.3s;
}
.loading-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.loading-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 12px;
  padding: 1.25rem 2rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  font-size: 0.95rem;
  font-weight: 500;
  pointer-events: auto;
}
.fade-enter-active { transition: opacity 0.15s ease; }
.fade-leave-active { transition: opacity 0.3s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.text-sm { font-size: 0.8rem; }
.muted { color: var(--p-text-muted-color); }
.field-help {
  display: block;
  margin-top: 0.2rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.options-summary label {
  display: block;
  margin-bottom: 0.35rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.option-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.option-tag {
  background: var(--p-primary-50);
  color: var(--p-primary-700);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
}
</style>
