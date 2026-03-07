<template>
  <div class="subnet-detail" :class="{ 'compact-mode': compact }" v-if="subnet" style="position: relative;">
    <!-- Loading overlay for large subnets -->
    <Transition name="fade">
      <div v-if="showLoadingOverlay" class="loading-overlay">
        <div class="loading-card">
          <span>Loading Data</span>
        </div>
      </div>
    </Transition>
    <div v-if="!compact" class="detail-header">
      <div>
        <h3 style="margin: 0; display: inline;">{{ subnet.name }}</h3>
        <span class="cidr-badge">{{ subnet.cidr }}</span>
      </div>
      <div class="header-actions">
        <Button label="Add Network" icon="pi pi-plus" size="small" @click="openAddRange" />
      </div>
    </div>

    <!-- Compact info bar (used when embedded in Layout B) -->
    <div v-if="compact" class="info-bar">
      <span class="info-bar-name">{{ subnet.name }}</span>
      <span class="info-bar-cidr">{{ subnet.cidr }}</span>
      <span class="info-bar-sep"></span>
      <span class="info-bar-pair"><span class="info-bar-label">Network</span> <span class="info-bar-val">{{ subnet.network_address }}</span></span>
      <span class="info-bar-sep"></span>
      <span class="info-bar-pair"><span class="info-bar-label">Broadcast</span> <span class="info-bar-val">{{ subnet.broadcast_address }}</span></span>
      <span class="info-bar-sep"></span>
      <span class="info-bar-pair"><span class="info-bar-label">Gateway</span> <span class="info-bar-val">{{ subnet.gateway_address }}</span></span>
      <span class="info-bar-sep"></span>
      <span class="info-bar-pair"><span class="info-bar-label">VLAN</span> <span class="info-bar-val">{{ subnet.vlan_id ?? '—' }}</span></span>
      <span class="info-bar-sep"></span>
      <span class="info-bar-pair"><span class="info-bar-label">Total IPs</span> <span class="info-bar-val">{{ subnet.total_addresses }}</span></span>
      <span class="info-bar-sep"></span>
      <span class="info-bar-pair"><span class="info-bar-label">Prefix</span> <span class="info-bar-val">/{{ subnet.prefix_length }}</span></span>
      <span style="flex:1"></span>
      <Button label="Add DHCP Scope" size="small" text @click="openAddRange" />
    </div>

    <!-- Subnet Info Cards (non-compact) -->
    <div v-if="!compact" class="info-cards">
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
        <DataTable :value="ips" stripedRows size="small"
                   :loading="loadingPage"
                   emptyMessage="No IP addresses."
                   scrollable scrollHeight="flex"
                   dataKey="ip_address"
                   @row-contextmenu="onTableRowContextMenu"
                   contextMenu
                   lazy paginator paginatorPosition="bottom"
                   :rows="currentPageSize"
                   :totalRecords="totalIps"
                   :first="(currentPage - 1) * currentPageSize"
                   :rowsPerPageOptions="rowsPerPageOptions"
                   @page="onLazyPage">
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
          <Column header="Type" style="width: 9rem">
            <template #body="{ data }">
              <span v-if="data.status === 'reserved' && data.reservation_note" class="range-type-badge reservation-badge">
                {{ data.reservation_note }}
              </span>
              <span v-else-if="data.range_type_name" class="range-type-badge" :style="{ background: data.range_type_color }">
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
        <div class="grid-view-scroll">
        <!-- Ranges Table -->
        <div class="section">
          <h4 style="margin:0 0 0.5rem 0">Ranges</h4>
          <DataTable :value="ranges" stripedRows size="small" emptyMessage="No ranges defined."
                     :paginator="ranges.length > 256" :rows="256"
                     :rowsPerPageOptions="[64, 128, 256, 512]"
                     scrollable scrollHeight="flex">
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
            Network too large for grid view ({{ subnet.total_addresses }} addresses, max 512). Use the IP Addresses tab.
          </div>
        </div>
        </div>
      </TabPanel>
    </TabView>

    <!-- Scan Progress -->
    <div class="section" style="flex-shrink: 0;" v-if="activeScan">
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

    <!-- Table Context Menu -->
    <ContextMenu ref="tableContextMenuRef" :model="tableContextMenuItems" />

    <!-- Range Create/Edit Dialog -->
    <Dialog v-model:visible="showRangeDialog" :header="editingRange ? 'Edit Range' : 'Add DHCP Scope'"
            modal :style="{ width: '28rem' }">
      <div class="form-grid">
        <div class="field" v-if="editingRange">
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
    <Dialog v-model:visible="showDhcpScopeDialog" header="Configure DHCP Scope" modal :style="{ width: '36rem' }">
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
      </div>

      <!-- Inline Options Section -->
      <div class="scope-options-section">
        <div class="scope-options-header" @click="scopeOptionsExpanded = !scopeOptionsExpanded">
          <i class="pi" :class="scopeOptionsExpanded ? 'pi-chevron-down' : 'pi-chevron-right'" style="font-size: 0.7rem"></i>
          <span class="scope-options-title">DHCP Options</span>
          <span class="scope-options-count" v-if="dhcpScopeForm.selectedOptions.length > 0">{{ dhcpScopeForm.selectedOptions.length }} selected</span>
        </div>
        <div v-if="scopeOptionsExpanded" class="scope-options-list">
          <template v-for="group in scopeOptionGroups" :key="group.name">
            <div class="scope-option-group-header">{{ group.label }}</div>
            <div v-for="opt in group.options" :key="opt.code" class="scope-option-row">
              <div class="scope-option-check">
                <input type="checkbox"
                       :checked="dhcpScopeForm.selectedOptions.includes(opt.code)"
                       @change="toggleScopeOption(opt.code, $event.target.checked)" />
              </div>
              <div class="scope-option-info">
                <span class="scope-option-label">{{ opt.label }}</span>
                <span class="scope-option-code">({{ opt.code }})</span>
                <i class="pi pi-question-circle scope-option-help" @click="showOptionHelp($event, opt)" />
              </div>
              <div class="scope-option-value">
                <template v-if="dhcpScopeForm.selectedOptions.includes(opt.code)">
                  <Select v-if="opt.type === 'select'" v-model="dhcpScopeForm.optionValues[opt.code]"
                          :options="opt.choices" size="small" :placeholder="scopeOptionDefaults[opt.code] || '—'" showClear />
                  <InputNumber v-else-if="opt.type === 'number'" v-model="dhcpScopeForm.optionValues[opt.code]"
                               size="small" :useGrouping="false" :placeholder="scopeOptionDefaults[opt.code] || '0'" />
                  <InputText v-else v-model="dhcpScopeForm.optionValues[opt.code]" size="small"
                             :placeholder="scopeOptionDefaults[opt.code] || scopePlaceholderForType(opt.type)" />
                </template>
                <span v-else-if="scopeOptionDefaults[opt.code]" class="scope-option-default">
                  default: {{ scopeOptionDefaults[opt.code] }}
                </span>
              </div>
            </div>
          </template>
        </div>
      </div>

      <template #footer>
        <Button label="Skip" severity="secondary" @click="showDhcpScopeDialog = false" />
        <Button label="Create Scope" @click="saveDhcpScope" :loading="savingDhcpScope" />
      </template>
    </Dialog>

    <!-- Reserve IP Note Dialog -->
    <Dialog v-model:visible="showReserveDialog" header="Reserve IP Address(es)" modal :style="{ width: '26rem' }">
      <p style="margin: 0 0 0.75rem 0; font-size: 0.85rem; color: var(--p-text-muted-color)">
        Reserved IPs cannot be used for DHCP or static assignment.
      </p>
      <div class="form-grid">
        <div class="field">
          <label style="display:block; margin-bottom: 0.35rem; font-size: 0.85rem; font-weight: 600">Start IP</label>
          <InputText v-model="reserveStartIp" class="w-full" />
        </div>
        <div class="field">
          <label style="display:block; margin-bottom: 0.35rem; font-size: 0.85rem; font-weight: 600">End IP</label>
          <InputText v-model="reserveEndIp" class="w-full" />
        </div>
        <div class="field">
          <label style="display:block; margin-bottom: 0.35rem; font-size: 0.85rem; font-weight: 600">Reason (max 16 characters)</label>
          <InputText v-model="reserveNote" class="w-full" :maxlength="16" placeholder="e.g. MGMT, PRINTER" @keyup.enter="confirmReserve" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showReserveDialog = false" />
        <Button label="Reserve" icon="pi pi-lock" @click="confirmReserve" :disabled="!reserveNote.trim()" />
      </template>
    </Dialog>

    <!-- Help Popover (shared) -->
    <Popover ref="helpPopoverRef">
      <div class="option-help-popover">
        <strong>{{ helpPopoverData.label }}</strong>
        <p>{{ helpPopoverData.description }}</p>
        <a v-if="helpPopoverData.rfcUrl" :href="helpPopoverData.rfcUrl" target="_blank" rel="noopener" class="rfc-link">
          {{ helpPopoverData.rfc }}
        </a>
      </div>
    </Popover>

    <Toast />
  </div>
  <div v-else-if="loading" class="loading">Loading network...</div>
  <div v-else class="empty-state">Select a network to view details.</div>
</template>

<script setup>
import { ref, reactive, computed, watch, onUnmounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import Popover from 'primevue/popover';
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
  subnetId: { type: [Number, String], default: null },
  compact: { type: Boolean, default: false }
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

// Reserve IP dialog
const showReserveDialog = ref(false);
const reserveStartIp = ref('');
const reserveEndIp = ref('');
const reserveNote = ref('');

// Server-side pagination state
const currentPage = ref(1);
const currentPageSize = ref(256);
const totalIps = ref(0);
const totalPages = ref(0);
const loadingPage = ref(false);

// Loading overlay for large subnets (>256 IPs)
const showLoadingOverlay = ref(false);

const rowsPerPageOptions = [64, 128, 256, 512];

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

// Scope option state
const scopeOptionCatalog = ref([]);
const scopeOptionDefaults = reactive({});
const scopeOptionsExpanded = ref(false);
const scopeOptionGroupOrder = ref([]);

const scopeOptionGroups = computed(() => {
  const order = scopeOptionGroupOrder.value.map(g => g.name);
  const groups = {};
  for (const opt of scopeOptionCatalog.value) {
    const g = opt.group || 'Common';
    if (!groups[g]) groups[g] = [];
    groups[g].push(opt);
  }
  const result = [];
  for (const name of order) {
    if (groups[name]?.length) {
      const meta = scopeOptionGroupOrder.value.find(g => g.name === name);
      result.push({ name, label: meta?.label || name, options: groups[name] });
    }
  }
  for (const [name, opts] of Object.entries(groups)) {
    if (!order.includes(name) && opts.length) {
      result.push({ name, label: name, options: opts });
    }
  }
  return result;
});

// Help popover
const helpPopoverRef = ref(null);
const helpPopoverData = ref({ label: '', description: '', rfc: '', rfcUrl: '' });

function showOptionHelp(event, opt) {
  helpPopoverData.value = { label: opt.label, description: opt.description || '', rfc: opt.rfc || '', rfcUrl: opt.rfcUrl || '' };
  helpPopoverRef.value.toggle(event);
}

// Scan state
const showScanConfirm = ref(false);
const startingScan = ref(false);
const activeScan = ref(null);
const scanResults = ref([]);
let scanPollTimer = null;

// Context menus
const gridContextMenuRef = ref(null);
const tableContextMenuRef = ref(null);
const tableContextIp = ref(null);

function onTableRowContextMenu(event) {
  const row = event.data;
  // Skip Network/Broadcast
  if (row.range_type_name === 'Network' || row.range_type_name === 'Broadcast') return;
  tableContextIp.value = row;
  tableContextMenuRef.value.show(event.originalEvent);
}

const tableContextMenuItems = computed(() => {
  const row = tableContextIp.value;
  if (!row) return [];

  const range = findRangeForIp(row.ip_address);
  const ip = {
    address: row.ip_address,
    rangeId: range?.id || null,
    rangeType: row.range_type_name || null,
    status: row.status || 'available'
  };

  return buildContextMenuItems([ip]);
});

function findRangeForIp(ipAddress) {
  const long = ipToLong(ipAddress);
  return ranges.value.find(r => long >= ipToLong(r.start_ip) && long <= ipToLong(r.end_ip));
}

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
  if (ip.status === 'reserved' && ip.reservationNote) lines.push(`Reserved: ${ip.reservationNote}`);
  else if (ip.rangeType) lines.push(`Type: ${ip.rangeType}`);
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
      reservationNote: assignInfo?.reservation_note || null,
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

function isSystemReserved(ip) {
  const rangeType = ip.rangeType || ip.range_type_name;
  return rangeType === 'Network' || rangeType === 'Broadcast' || rangeType === 'Gateway';
}

function buildContextMenuItems(selectedIps) {
  if (selectedIps.length === 0) return [];

  const items = [];
  const firstIp = selectedIps[0];
  const lastIp = selectedIps[selectedIps.length - 1];

  if (selectedIps.length === 1) {
    const ip = firstIp;
    const range = ip.rangeId ? ranges.value.find(r => r.id === ip.rangeId) : null;
    const isDhcpScope = range && range.range_type_name === 'DHCP Scope';
    const isGateway = range && range.range_type_name === 'Gateway';
    const ipStatus = ip.status || 'available';

    if (isGateway) {
      // Gateway IP: Edit, Delete, and create pool
      items.push({ label: 'Edit Gateway', icon: 'pi pi-pencil', command: () => editRange(range) });
      items.push({ label: 'Delete Gateway', icon: 'pi pi-trash', command: () => confirmDeleteRange(range) });
      items.push({ separator: true });
      items.push({
        label: 'Create DHCP Scope',
        icon: 'pi pi-plus',
        command: () => openRangeFromSelection(ip.address, ip.address)
      });
    } else if (isDhcpScope) {
      // IP inside a DHCP Scope
      items.push({
        label: `Edit Scope ${range.start_ip} – ${range.end_ip}`,
        icon: 'pi pi-pencil',
        command: () => editRange(range)
      });
      items.push({
        label: 'Remove this IP from Scope',
        icon: 'pi pi-minus',
        command: () => removeIpFromPool(range, ip.address)
      });
      items.push({
        label: `Delete Scope ${range.start_ip} – ${range.end_ip}`,
        icon: 'pi pi-trash',
        command: () => confirmDeleteRange(range)
      });
    } else if (range && isEditableRange(range)) {
      // Other editable range
      items.push({ label: `Edit ${range.range_type_name} Range`, icon: 'pi pi-pencil', command: () => editRange(range) });
      items.push({
        label: 'Create DHCP Scope',
        icon: 'pi pi-plus',
        command: () => openRangeFromSelection(ip.address, ip.address)
      });
    } else {
      // No range or non-editable
      items.push({
        label: 'Create DHCP Scope',
        icon: 'pi pi-plus',
        command: () => openRangeFromSelection(ip.address, ip.address)
      });
    }

    // Reserve / Unreserve (not for system ranges)
    if (!isSystemReserved(ip)) {
      items.push({ separator: true });
      if (ipStatus === 'reserved') {
        items.push({
          label: 'Remove Reservation',
          icon: 'pi pi-unlock',
          command: () => setIpReservation(ip.address, 'available')
        });
      } else {
        items.push({
          label: `Reserve ${ip.address}`,
          icon: 'pi pi-lock',
          command: () => openReserveDialog(ip.address)
        });
      }
    }
  } else {
    // Multi-select
    items.push({
      label: `Add DHCP Scope ${firstIp.address} – ${lastIp.address}`,
      icon: 'pi pi-plus',
      command: () => openRangeFromSelection(firstIp.address, lastIp.address)
    });
    items.push({
      label: `Reserve ${firstIp.address} – ${lastIp.address}`,
      icon: 'pi pi-lock',
      command: () => openReserveDialog(firstIp.address, lastIp.address)
    });
  }

  return items;
}

function openReserveDialog(ipAddress, endIpAddress) {
  reserveStartIp.value = ipAddress;
  reserveEndIp.value = endIpAddress || ipAddress;
  reserveNote.value = '';
  showReserveDialog.value = true;
}

async function confirmReserve() {
  if (!reserveNote.value.trim()) return;
  const note = reserveNote.value.trim();
  showReserveDialog.value = false;
  if (reserveStartIp.value === reserveEndIp.value) {
    await setIpReservation(reserveStartIp.value, 'reserved', note);
  } else {
    try {
      const result = await store.bulkSetIpStatus(subnet.value.id, reserveStartIp.value, reserveEndIp.value, 'reserved', note);
      toast.add({ severity: 'success', summary: `${result.count} IPs reserved`, life: 3000 });
      await reloadData();
    } catch (err) {
      toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
    }
  }
}

async function setIpReservation(ipAddress, status, note) {
  try {
    await store.setIpStatus(subnet.value.id, ipAddress, status, note);
    toast.add({ severity: 'success', summary: status === 'reserved' ? 'IP reserved' : 'Reservation removed', life: 3000 });
    await reloadData();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  }
}

const gridContextMenuItems = computed(() => {
  const sel = gridSelection.value;
  if (sel.size === 0) return [];
  const selectedIps = Array.from(sel).sort((a, b) => a - b).map(i => ipGrid.value[i]);
  return buildContextMenuItems(selectedIps);
});

function openRangeFromSelection(startIp, endIp) {
  const dhcpType = rangeTypes.value.find(rt => rt.name === 'DHCP Scope' && rt.is_system);
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
    // Load IPs and address types in parallel
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
    console.error('Failed to load network detail:', err);
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

function onLazyPage(event) {
  const newPage = Math.floor(event.first / event.rows) + 1;
  currentPageSize.value = event.rows;
  loadIpPage(newPage, event.rows);
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
  const dhcpType = rangeTypes.value.find(rt => rt.name === 'DHCP Scope' && rt.is_system);
  rangeForm.value = { range_type_id: dhcpType?.id || null, start_ip: '', end_ip: '', description: '' };
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

      // Auto-open DHCP scope dialog for DHCP Scope ranges
      if (created.range_type_name === 'DHCP Scope') {
        // Load options catalog if not already loaded
        if (scopeOptionCatalog.value.length === 0) {
          await loadScopeOptions();
        }
        // Auto-select all options that have defaults
        const defaultOptions = [];
        const defaultOptionValues = {};
        for (const code of Object.keys(scopeOptionDefaults)) {
          const c = Number(code);
          defaultOptions.push(c);
          defaultOptionValues[c] = scopeOptionDefaults[code];
        }
        // Override Router (option 3) with subnet gateway if available
        if (subnet.value.gateway_address) {
          if (!defaultOptions.includes(3)) defaultOptions.push(3);
          defaultOptionValues[3] = subnet.value.gateway_address;
        }
        dhcpScopeForm.value = {
          range_id: created.id,
          subnet_id: subnet.value.id,
          lease_time: '24h',
          description: '',
          selectedOptions: defaultOptions,
          optionValues: defaultOptionValues
        };
        scopeOptionsExpanded.value = defaultOptions.length > 0;
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

async function removeIpFromPool(range, ipAddress) {
  saving.value = true;
  try {
    const startLong = ipToLong(range.start_ip);
    const endLong = ipToLong(range.end_ip);
    const ipLong = ipToLong(ipAddress);

    if (startLong === endLong) {
      // Single-IP pool — just delete it
      await store.deleteRange(subnet.value.id, range.id);
      toast.add({ severity: 'success', summary: 'Pool deleted', life: 3000 });
    } else if (ipLong === startLong) {
      // Remove from start
      await store.updateRange(subnet.value.id, range.id, {
        ...range, start_ip: longToIp(startLong + 1)
      });
      toast.add({ severity: 'success', summary: 'IP removed from pool', life: 3000 });
    } else if (ipLong === endLong) {
      // Remove from end
      await store.updateRange(subnet.value.id, range.id, {
        ...range, end_ip: longToIp(endLong - 1)
      });
      toast.add({ severity: 'success', summary: 'IP removed from pool', life: 3000 });
    } else {
      // Middle — shrink original to before the IP, create new range after
      await store.updateRange(subnet.value.id, range.id, {
        ...range, end_ip: longToIp(ipLong - 1)
      });
      await store.createRange(subnet.value.id, {
        range_type_id: range.range_type_id,
        start_ip: longToIp(ipLong + 1),
        end_ip: range.end_ip,
        description: range.description || '',
        force: true
      });
      toast.add({ severity: 'success', summary: 'IP removed from pool (pool split)', life: 3000 });
    }
    await reloadData();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
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
    if (res.data.groups) scopeOptionGroupOrder.value = res.data.groups;
    Object.keys(scopeOptionDefaults).forEach(k => delete scopeOptionDefaults[k]);
    for (const [code, value] of Object.entries(res.data.defaults || {})) {
      scopeOptionDefaults[code] = value;
    }
  } catch (err) {
    console.error('Failed to load DHCP options:', err);
  }
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

function toggleScopeOption(code, checked) {
  if (checked) {
    if (!dhcpScopeForm.value.selectedOptions.includes(code)) {
      dhcpScopeForm.value.selectedOptions.push(code);
    }
    if (dhcpScopeForm.value.optionValues[code] == null || dhcpScopeForm.value.optionValues[code] === '') {
      const def = scopeOptionDefaults[code];
      if (def != null) dhcpScopeForm.value.optionValues[code] = def;
    }
  } else {
    dhcpScopeForm.value.selectedOptions = dhcpScopeForm.value.selectedOptions.filter(c => c !== code);
    delete dhcpScopeForm.value.optionValues[code];
  }
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
    window.dispatchEvent(new Event('ipam:stats-changed'));
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
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 1rem;
}
.subnet-detail.compact-mode {
  padding: 0;
}

/* ── Compact info bar ── */
.info-bar {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  border-bottom: 1px solid var(--p-surface-border);
  padding: 0 0.75rem;
  gap: 0.6rem;
  height: 2.4rem;
  box-sizing: border-box;
}
.info-bar-name {
  font-weight: 700;
  font-size: 0.85rem;
  white-space: nowrap;
}
.info-bar-cidr {
  font-size: 0.75rem;
  font-family: monospace;
  background: var(--p-surface-ground);
  color: var(--p-text-muted-color);
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
}
.info-bar-sep {
  width: 1px;
  height: 1rem;
  background: var(--p-surface-border);
  flex-shrink: 0;
}
.info-bar-pair {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
  white-space: nowrap;
}
.info-bar-label {
  font-size: 0.65rem;
  text-transform: uppercase;
  color: var(--p-text-muted-color);
  letter-spacing: 0.04em;
}
.info-bar-val {
  font-size: 0.8rem;
  font-weight: 600;
}

:deep(.p-tabview) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
:deep(.p-tabview-panels) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
:deep(.p-tabview-panel) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
:deep(.p-tabview-panel > .p-datatable) {
  flex: 1;
  min-height: 0;
}
.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  flex-wrap: wrap;
  flex-shrink: 0;
  gap: 0.5rem;
}
.header-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.cidr-badge {
  font-size: 0.85rem;
  background: var(--p-surface-ground);
  color: var(--p-text-muted-color);
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
  flex-shrink: 0;
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
.grid-view-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.section {
  margin-bottom: 1rem;
}
.range-type-badge {
  display: inline-block;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  color: #1a1a1a;
  font-size: 0.75rem;
  font-weight: 600;
}
.reservation-badge {
  background: color-mix(in srgb, var(--p-orange-500) 25%, transparent) !important;
  color: var(--p-orange-500);
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
.scan-pending { background: color-mix(in srgb, var(--p-yellow-500) 20%, transparent); color: var(--p-yellow-500); }
.scan-running { background: color-mix(in srgb, var(--p-blue-500) 20%, transparent); color: var(--p-blue-500); }
.scan-completed { background: color-mix(in srgb, var(--p-green-500) 20%, transparent); color: var(--p-green-500); }
.scan-failed { background: color-mix(in srgb, var(--p-red-500) 20%, transparent); color: var(--p-red-500); }
.scan-bar-container {
  height: 4px;
  background: var(--p-surface-border);
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
/* Scope dialog inline options */
.scope-options-section {
  margin-top: 1rem;
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  overflow: hidden;
}
.scope-options-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  user-select: none;
  background: var(--p-surface-ground);
  transition: background 0.1s;
}
.scope-options-header:hover {
  background: color-mix(in srgb, var(--p-primary-color) 5%, var(--p-surface-ground));
}
.scope-options-title {
  font-size: 0.85rem;
  font-weight: 600;
}
.scope-options-count {
  font-size: 0.75rem;
  color: var(--p-primary-color);
  margin-left: auto;
}
.scope-options-list {
  max-height: 18rem;
  overflow-y: auto;
}
.scope-option-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.75rem;
  border-top: 1px solid color-mix(in srgb, var(--p-surface-border) 50%, transparent);
  font-size: 0.8rem;
}
.scope-option-row:first-child {
  border-top: 1px solid var(--p-surface-border);
}
.scope-option-check {
  flex-shrink: 0;
}
.scope-option-info {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 10rem;
  flex-shrink: 0;
}
.scope-option-label {
  font-weight: 500;
}
.scope-option-code {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
}
.scope-option-help {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
  cursor: pointer;
  margin-left: 0.15rem;
}
.scope-option-help:hover {
  color: var(--p-primary-color);
}
.scope-option-group-header {
  padding: 0.3rem 0.75rem;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--p-text-muted-color);
  background: var(--p-surface-ground);
  border-top: 1px solid var(--p-surface-border);
}
.option-help-popover {
  max-width: 20rem;
  font-size: 0.8rem;
  line-height: 1.4;
}
.option-help-popover strong {
  display: block;
  margin-bottom: 0.3rem;
}
.option-help-popover p {
  margin: 0 0 0.4rem 0;
  color: var(--p-text-muted-color);
}
.rfc-link {
  font-size: 0.75rem;
  color: var(--p-primary-color);
  text-decoration: none;
}
.rfc-link:hover { text-decoration: underline; }
.scope-option-value {
  flex: 1;
  min-width: 0;
}
.scope-option-value :deep(.p-inputtext),
.scope-option-value :deep(.p-select),
.scope-option-value :deep(.p-inputnumber) {
  width: 100%;
  font-size: 0.8rem;
}
.scope-option-default {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
  font-style: italic;
}
</style>
