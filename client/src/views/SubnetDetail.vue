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
        <Button label="Add Network" icon="pi pi-plus" size="small" data-track="subnet-add-network" @click="openAddRange" />
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
      <span v-if="subnet.domain_name" class="info-bar-pair"><span class="info-bar-label">Domain</span> <span class="info-bar-val">{{ subnet.domain_name }}</span></span>
      <span v-if="subnet.domain_name" class="info-bar-sep"></span>
      <span class="info-bar-pair"><span class="info-bar-label">Total IPs</span> <span class="info-bar-val">{{ subnet.total_addresses }}</span></span>
      <span class="info-bar-sep"></span>
      <span class="info-bar-pair"><span class="info-bar-label">Prefix</span> <span class="info-bar-val">/{{ subnet.prefix_length }}</span></span>
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
      <div v-if="subnet.domain_name" class="info-card">
        <div class="info-label">Domain</div>
        <div class="info-value">{{ subnet.domain_name }}</div>
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
    <TabView v-model:activeIndex="activeTabIndex">
      <TabPanel header="IP Addresses" :pt="{ headerAction: { 'data-track': 'subnet-tab-ip-addresses' } }">
        <div class="ip-search-bar">
          <IconField>
            <InputIcon class="pi pi-search" />
            <InputText v-model="ipSearch" placeholder="Search by IP, hostname, MAC, vendor, status…" size="small" class="ip-search-input" />
          </IconField>
          <Button v-if="ipSearch" icon="pi pi-times" severity="secondary" text rounded size="small" @click="ipSearch = ''" />
        </div>
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
                   :sortField="sortField"
                   :sortOrder="sortOrder"
                   removableSort
                   @page="onLazyPage"
                   @sort="onLazySort">
          <Column field="ip_address" header="Address" sortable style="width: 10rem">
            <template #body="{ data }">
              <span class="ip-mono">{{ data.ip_address }}</span>
            </template>
          </Column>
          <Column field="status" header="Status" sortable style="width: 7rem">
            <template #body="{ data }">
              <Tag :severity="computeIpState(data).statusSeverity" :value="computeIpState(data).status" />
            </template>
          </Column>
          <Column header="Type" sortable :sortField="'computed_type'" style="width: 9rem">
            <template #body="{ data }">
              <Tag v-if="computeIpState(data).type" :severity="computeIpState(data).typeSeverity"
                   :value="computeIpState(data).type"
                   v-tooltip.top="computeIpState(data).tooltip || null" />
              <span v-else>—</span>
            </template>
          </Column>
          <Column field="hostname" header="Hostname" sortable style="width: 10rem">
            <template #body="{ data }">{{ displayHostname(data.hostname) }}</template>
          </Column>
          <Column header="MAC Address" sortable style="width: 10rem" :sortField="'mac_address'">
            <template #body="{ data }">{{ data.mac_address || data.last_seen_mac || '—' }}</template>
          </Column>
          <Column field="vendor" header="Vendor" sortable style="width: 10rem">
            <template #body="{ data }">{{ data.vendor || '—' }}</template>
          </Column>
          <Column field="is_online" header="Online" sortable style="width: 5rem">
            <template #body="{ data }">
              <span :class="['type-badge', data.is_online ? 'badge-green-light' : 'badge-muted']">{{ data.is_online ? 'Online' : 'Offline' }}</span>
            </template>
          </Column>
          <Column field="last_seen_at" header="Last Seen" sortable style="width: 10rem">
            <template #body="{ data }">{{ data.last_seen_at ? formatDate(data.last_seen_at) : '—' }}</template>
          </Column>
          <Column field="dhcp_expires_at" header="Expires" sortable style="width: 9rem">
            <template #body="{ data }">
              <template v-if="!data.dhcp_expires_at">—</template>
              <template v-else-if="data.dhcp_expires_at === 'infinite'">Never</template>
              <template v-else>{{ formatDate(data.dhcp_expires_at) }}</template>
            </template>
          </Column>
        </DataTable>
      </TabPanel>

      <TabPanel header="Grid View" :pt="{ headerAction: { 'data-track': 'subnet-tab-grid-view' } }">
        <div class="grid-view-scroll">
        <!-- Ranges Table -->
        <div class="section">
          <h4 style="margin:0 0 0.5rem 0">Ranges</h4>
          <DataTable :value="ranges" stripedRows size="small" emptyMessage="No ranges defined."
                     :paginator="ranges.length > 256" :rows="256"
                     :rowsPerPageOptions="[64, 128, 256, 512]"
                     @row-contextmenu="onRangeRightClick" contextMenu
                     scrollable scrollHeight="flex">
            <Column header="Type">
              <template #body="{ data }">
                <span class="range-type-badge" :style="{ background: data.range_type_color }">
                  {{ data.range_type_name }}
                </span>
              </template>
            </Column>
            <Column header="Address / Range">
              <template #body="{ data }">
                <template v-if="data.start_ip === data.end_ip">{{ data.start_ip }}</template>
                <template v-else>{{ data.start_ip }} – {{ data.end_ip }}</template>
              </template>
            </Column>
            <Column field="description" header="Description">
              <template #body="{ data }">{{ data.description ?? '—' }}</template>
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
              <span class="legend-swatch" style="background: var(--p-surface-200)"></span>
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
                 v-tooltip.top="gridTooltip(ip)"
                 :style="{ background: gridSelection.has(idx) ? 'var(--p-primary-200)' : ip.color }"
                 :data-idx="idx"
                 :class="{ 'ip-cell-selected': gridSelection.has(idx), 'ip-cell-conflict': ip.isConflict }">
              <span v-if="ip.isConflict" class="conflict-dot"></span>
            </div>
          </div>
          <div v-else class="grid-too-large">
            Network too large for grid view ({{ subnet.total_addresses }} addresses, max 1024). Use the IP Addresses tab.
          </div>
        </div>
        </div>
      </TabPanel>
    </TabView>

    <!-- Scan Confirm Dialog -->
    <Dialog v-model:visible="showScanConfirm" header="Scan Network" modal :style="{ width: '26rem' }" data-track="dialog-scan-network">
      <p>This will send ARP probes to all usable IPs in <strong>{{ subnet?.cidr }}</strong>.</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showScanConfirm = false" />
        <Button label="Start Scan" icon="pi pi-search" data-track="btn-start-scan" @click="doStartScan" :loading="startingScan" />
      </template>
    </Dialog>

    <!-- Grid Context Menu -->
    <ContextMenu ref="gridContextMenuRef" :model="gridContextMenuItems" />

    <!-- Table Context Menu -->
    <ContextMenu ref="tableContextMenuRef" :model="tableContextMenuItems" />

    <!-- Range Context Menu -->
    <ContextMenu ref="rangeContextMenuRef" :model="rangeContextMenuItems" />

    <!-- Range Create/Edit Dialog -->
    <Dialog v-model:visible="showRangeDialog" :header="rangeDialogHeader"
            modal :style="{ width: '28rem' }" data-track="dialog-range-edit">
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
    <Dialog v-model:visible="showOverlapDialog" header="Range Overlap Warning" modal :style="{ width: '30rem' }" data-track="dialog-overlap-warning">
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

    <!-- Delete Range/Address Confirmation -->
    <Dialog v-model:visible="showDeleteRangeDialog"
            :header="deletingRange?.start_ip === deletingRange?.end_ip ? 'Delete Address' : 'Delete Range'"
            modal :style="{ width: '24rem' }" data-track="dialog-delete-range">
      <p v-if="deletingRange?.start_ip === deletingRange?.end_ip">Delete this address ({{ deletingRange?.start_ip }})?</p>
      <p v-else>Delete this range ({{ deletingRange?.start_ip }} – {{ deletingRange?.end_ip }})?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteRangeDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteRange" :loading="saving" />
      </template>
    </Dialog>

    <!-- Scope Dialog (shared component) -->
    <ScopeDialog ref="scopeDialogRef" @saved="reloadData" />

    <!-- Lock IP Dialog -->
    <Dialog v-model:visible="showReserveDialog" header="Lock IP Address(es)" modal :style="{ width: '26rem' }" data-track="dialog-reserve-ip">
      <p style="margin: 0 0 0.75rem 0; font-size: 0.85rem; color: var(--p-text-muted-color)">
        Locked IPs are held and cannot be used for DHCP or static assignment.
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
        <div class="field">
          <label style="display:block; margin-bottom: 0.35rem; font-size: 0.85rem; font-weight: 600">Liveness Scanning</label>
          <div class="scan-toggle-group">
            <button type="button" :class="['scan-toggle-btn', 'scan-inherit', { active: reserveScanEnabled === null }]"
                    @click="reserveScanEnabled = null">Inherit</button>
            <button type="button" :class="['scan-toggle-btn', 'scan-enabled', { active: reserveScanEnabled === true, resolved: reserveScanEnabled === null && resolvedSubnetScanEnabled }]"
                    @click="reserveScanEnabled = true">Enabled</button>
            <button type="button" :class="['scan-toggle-btn', 'scan-disabled', { active: reserveScanEnabled === false, resolved: reserveScanEnabled === null && !resolvedSubnetScanEnabled }]"
                    @click="reserveScanEnabled = false">Disabled</button>
          </div>
          <small v-if="reserveScanEnabled === null" style="font-size: 0.75rem; color: var(--p-text-muted-color)">
            Inherits from subnet — scanning is {{ resolvedSubnetScanEnabled ? 'enabled' : 'disabled' }} for this network
          </small>
          <small v-else-if="reserveScanEnabled === true" style="font-size: 0.75rem; color: var(--p-text-muted-color)">Scanning is enabled for this network</small>
          <small v-else style="font-size: 0.75rem; color: var(--p-text-muted-color)">Scanning is disabled for this network</small>
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showReserveDialog = false" />
        <Button label="Lock" icon="pi pi-lock" data-track="btn-confirm-reserve" @click="confirmReserve" :disabled="!reserveNote.trim()" />
      </template>
    </Dialog>

    <!-- Convert to Static DHCP Reservation Dialog -->
    <Dialog v-model:visible="showStaticDhcpDialog" header="Create Static DHCP Reservation" modal :style="{ width: '28rem' }" data-track="dialog-static-dhcp">
      <p style="margin: 0 0 0.75rem 0; font-size: 0.85rem; color: var(--p-text-muted-color)">
        Convert this dynamic DHCP assignment to a static reservation.
      </p>
      <div class="form-grid">
        <div class="field">
          <label style="display:block; margin-bottom: 0.35rem; font-size: 0.85rem; font-weight: 600">IP Address</label>
          <InputText v-model="staticDhcpForm.ip_address" class="w-full" readonly />
        </div>
        <div class="field">
          <label style="display:block; margin-bottom: 0.35rem; font-size: 0.85rem; font-weight: 600">MAC Address</label>
          <InputText v-model="staticDhcpForm.mac_address" class="w-full" placeholder="XX:XX:XX:XX:XX:XX" />
        </div>
        <div class="field">
          <label style="display:block; margin-bottom: 0.35rem; font-size: 0.85rem; font-weight: 600">Hostname</label>
          <InputText v-model="staticDhcpForm.hostname" class="w-full" placeholder="Optional" />
        </div>
        <div class="field">
          <label style="display:block; margin-bottom: 0.35rem; font-size: 0.85rem; font-weight: 600">Description</label>
          <InputText v-model="staticDhcpForm.description" class="w-full" placeholder="Optional" />
        </div>
        <div class="field">
          <label style="display:block; margin-bottom: 0.35rem; font-size: 0.85rem; font-weight: 600">Liveness Scanning</label>
          <div class="scan-toggle-group">
            <button type="button" :class="['scan-toggle-btn', 'scan-inherit', { active: staticDhcpScanEnabled === null }]"
                    @click="staticDhcpScanEnabled = null">Inherit</button>
            <button type="button" :class="['scan-toggle-btn', 'scan-enabled', { active: staticDhcpScanEnabled === true, resolved: staticDhcpScanEnabled === null && resolvedSubnetScanEnabled }]"
                    @click="staticDhcpScanEnabled = true">Enabled</button>
            <button type="button" :class="['scan-toggle-btn', 'scan-disabled', { active: staticDhcpScanEnabled === false, resolved: staticDhcpScanEnabled === null && !resolvedSubnetScanEnabled }]"
                    @click="staticDhcpScanEnabled = false">Disabled</button>
          </div>
          <small v-if="staticDhcpScanEnabled === null" style="font-size: 0.75rem; color: var(--p-text-muted-color)">
            Inherits from subnet — scanning is {{ resolvedSubnetScanEnabled ? 'enabled' : 'disabled' }} for this network
          </small>
          <small v-else-if="staticDhcpScanEnabled === true" style="font-size: 0.75rem; color: var(--p-text-muted-color)">Scanning is enabled for this network</small>
          <small v-else style="font-size: 0.75rem; color: var(--p-text-muted-color)">Scanning is disabled for this network</small>
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showStaticDhcpDialog = false" />
        <Button label="Create Reservation" icon="pi pi-check" data-track="btn-create-static-dhcp" @click="confirmStaticDhcp" :disabled="!staticDhcpForm.mac_address" />
      </template>
    </Dialog>

    <!-- IP Lifecycle Events Dialog -->
    <Dialog v-model:visible="showEventsDialog" :header="`Lifecycle — ${eventsIp}`" modal :style="{ width: '38rem' }" data-track="dialog-ip-events">
      <div v-if="eventsLoading" class="events-loading">Loading events...</div>
      <div v-else-if="eventsData.length === 0" class="events-empty">No events recorded for this IP.</div>
      <div v-else class="events-list">
        <div v-for="evt in eventsData" :key="evt.id" class="event-row">
          <span class="event-time">{{ formatDate(evt.created_at) }}</span>
          <Tag :severity="eventSeverity(evt.event_type)" :value="eventLabel(evt.event_type)" class="event-tag" />
          <span class="event-detail">{{ eventDetail(evt) }}</span>
        </div>
      </div>
    </Dialog>

    <Toast />
  </div>
  <div v-else-if="loading" class="loading">Loading network...</div>
  <div v-else class="empty-state">Select a network to view details.</div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { formatDateTime } from '../utils/dateFormat.js';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import IconField from 'primevue/iconfield';
import InputIcon from 'primevue/inputicon';
import Select from 'primevue/select';
import ContextMenu from 'primevue/contextmenu';
import Toast from 'primevue/toast';
import TabView from 'primevue/tabview';
import TabPanel from 'primevue/tabpanel';
import Tag from 'primevue/tag';
import ScopeDialog from '../components/ScopeDialog.vue';
import { useSubnetStore } from '../stores/subnets.js';
import { useDhcpStore } from '../stores/dhcp.js';
import api from '../api/client.js';

const props = defineProps({
  subnetId: { type: [Number, String], default: null },
  compact: { type: Boolean, default: false }
});

const emit = defineEmits(['refresh']);

const toast = useToast();
const store = useSubnetStore();
const dhcpStore = useDhcpStore();

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
const reserveScanEnabled = ref(null);

// Convert to Static DHCP Reservation dialog
const showStaticDhcpDialog = ref(false);
const staticDhcpForm = ref({ ip_address: '', mac_address: '', hostname: '', description: '' });
const staticDhcpScanEnabled = ref(null);

// IP Lifecycle Events dialog
const showEventsDialog = ref(false);
const eventsIp = ref('');
const eventsData = ref([]);
const eventsLoading = ref(false);

async function openEventsDialog(ipAddress) {
  eventsIp.value = ipAddress;
  eventsData.value = [];
  eventsLoading.value = true;
  showEventsDialog.value = true;
  try {
    const { data } = await api.get(`/subnets/${subnet.value.id}/ips/${ipAddress}/events`);
    eventsData.value = data.events || [];
  } catch {
    eventsData.value = [];
  } finally {
    eventsLoading.value = false;
  }
}

function eventLabel(type) {
  const labels = {
    online: 'Online', offline: 'Offline', scanned: 'Scanned',
    rogue_detected: 'Rogue', rogue_cleared: 'Rogue Cleared',
    dns_added: 'DNS Added', dns_removed: 'DNS Removed',
    lease_obtained: 'Lease', hostname_changed: 'Hostname',
    mac_changed: 'MAC Changed', status_changed: 'Status',
    scan_enabled_changed: 'Scan Toggle',
  };
  return labels[type] || type;
}

function eventSeverity(type) {
  if (type === 'online' || type === 'dns_added' || type === 'lease_obtained') return 'success';
  if (type === 'offline' || type === 'dns_removed') return 'secondary';
  if (type === 'rogue_detected') return 'danger';
  if (type === 'rogue_cleared') return 'warn';
  return 'info';
}

function sourceLabel(source) {
  const labels = {
    scanner: 'active scan', passive: 'passive (DNS log)', stale: 'staleness timeout',
    dns: 'DNS', dhcp_reservation: 'DHCP reservation', dhcp_lease: 'DHCP lease',
    manual: 'manual', offline: 'went offline',
  };
  return labels[source] || source || '';
}

function eventDetail(evt) {
  const parts = [];
  if (evt.old_value && evt.new_value) parts.push(`${evt.old_value} → ${evt.new_value}`);
  else if (evt.new_value) parts.push(evt.new_value);
  else if (evt.old_value) parts.push(evt.old_value);
  if (evt.source) parts.push(`(${sourceLabel(evt.source)})`);
  return parts.join(' ');
}

// Resolve the effective scan_enabled for this subnet (subnet → folder → default true)
const resolvedSubnetScanEnabled = computed(() => {
  if (!subnet.value) return true;
  if (subnet.value.scan_enabled !== null && subnet.value.scan_enabled !== undefined) return !!subnet.value.scan_enabled;
  // Inherit from folder
  const folder = store.folders?.find(f => f.id === subnet.value.folder_id);
  return folder ? !!folder.scan_enabled : true;
});

// Server-side pagination state — persisted per-subnet
function loadTableState() {
  const saved = loadJson('ipam_ip_table_state', {});
  return saved;
}
function saveTableState() {
  try {
    const key = `${props.subnetId}`;
    const all = loadJson('ipam_ip_table_state', {});
    all[key] = {
      page: currentPage.value,
      pageSize: currentPageSize.value,
      sortField: sortField.value,
      sortOrder: sortOrder.value,
    };
    localStorage.setItem('ipam_ip_table_state', JSON.stringify(all));
  } catch {}
}
function restoreTableState() {
  const all = loadTableState();
  const saved = all[`${props.subnetId}`];
  if (saved) {
    currentPage.value = saved.page || 1;
    currentPageSize.value = saved.pageSize || 256;
    sortField.value = saved.sortField || null;
    sortOrder.value = saved.sortOrder ?? 1;
  } else {
    currentPage.value = 1;
    currentPageSize.value = 256;
    sortField.value = null;
    sortOrder.value = 1;
  }
}

const currentPage = ref(1);
const currentPageSize = ref(256);
const totalIps = ref(0);
const totalPages = ref(0);
const sortField = ref(null);
const sortOrder = ref(1);
const loadingPage = ref(false);

// Persistence helper
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

// Active tab (IP Addresses = 0, Grid View = 1)
const activeTabIndex = ref(loadJson('ipam_subnet_detail_tab', 0));
watch(activeTabIndex, (val) => {
  try { localStorage.setItem('ipam_subnet_detail_tab', JSON.stringify(val)); } catch {}
});

// Search / filter
const ipSearch = ref('');
let _searchTimer = null;
watch(ipSearch, (val) => {
  if (_searchTimer) clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    _searchTimer = null;
    currentPage.value = 1;
    loadIpPage(1, currentPageSize.value);
  }, 300);
});

// Loading overlay for large subnets (>256 IPs)
const showLoadingOverlay = ref(false);

const rowsPerPageOptions = [64, 128, 256, 512];

/** Pick the largest page size that fits totalIps, or 512 if totalIps >= 512 */
function bestPageSize(total) {
  for (let i = rowsPerPageOptions.length - 1; i >= 0; i--) {
    if (total >= rowsPerPageOptions[i]) return rowsPerPageOptions[i];
  }
  return rowsPerPageOptions[0];
}

const showRangeDialog = ref(false);
const showOverlapDialog = ref(false);
const showDeleteRangeDialog = ref(false);
const editingRange = ref(null);
const deletingRange = ref(null);
const overlapDetails = ref([]);
const pendingRangeForm = ref(null);

const rangeForm = ref({ range_type_id: null, start_ip: '', end_ip: '', description: '' });

// Scope dialog (shared component)
const scopeDialogRef = ref(null);

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
  if (tableContextMenuItems.value.length) {
    tableContextMenuRef.value.show(event.originalEvent);
  }
}

const tableContextMenuItems = computed(() => {
  const row = tableContextIp.value;
  if (!row) return [];

  const range = findRangeForIp(row.ip_address);
  const ip = {
    address: row.ip_address,
    rangeId: range?.id || null,
    rangeType: row.range_type_name || null,
    status: row.status || 'available',
    mac: row.mac_address || row.last_seen_mac || null,
    hostname: row.hostname || null
  };

  return buildContextMenuItems([ip]);
});

// Range context menu
const rangeContextMenuRef = ref(null);
const selectedRange = ref(null);
const rangeContextMenuItems = computed(() => {
  const r = selectedRange.value;
  if (!r || !isEditableRange(r)) return [];
  return [
    { label: r.range_type_name === 'DHCP Scope' ? 'Edit DHCP Scope' : 'Edit Range', icon: 'pi pi-pencil', command: () => r.range_type_name === 'DHCP Scope' ? editDhcpScope(r) : editRange(r) },
    { label: 'Delete Range', icon: 'pi pi-trash', command: () => confirmDeleteRange(r) }
  ];
});
function onRangeRightClick(event) {
  selectedRange.value = event.data;
  if (rangeContextMenuItems.value.length) {
    rangeContextMenuRef.value.show(event.originalEvent);
  }
}

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

const formatDate = formatDateTime;

function displayHostname(hostname) {
  if (!hostname) return '—';
  const domain = subnet.value?.domain_name;
  if (domain && hostname.endsWith('.' + domain)) {
    return hostname.slice(0, -(domain.length + 1));
  }
  return hostname;
}

/**
 * Compute unified status + type for an IP row.
 * Returns { status, statusSeverity, type, typeSeverity, tooltip? }
 */
function computeIpState(data) {
  const mac = data.mac_address || data.last_seen_mac;
  const isDhcpScope = data.range_type_name === 'DHCP Scope';
  const isLeaseExpired = data.dhcp_expires_at && data.dhcp_expires_at !== 'infinite'
    && new Date(data.dhcp_expires_at) < new Date();

  // Network / Broadcast
  if (data.range_type_name === 'Network' || data.range_type_name === 'Broadcast') {
    return { status: 'in use', statusSeverity: 'danger', type: 'system', typeSeverity: 'secondary' };
  }

  // Gateway
  if (data.range_type_name === 'Gateway') {
    return { status: 'in use', statusSeverity: 'danger', type: 'gateway', typeSeverity: 'warn' };
  }

  // Rogue: model flagged as rogue, OR online but has no assignment/reservation/lease/DNS
  const hasActiveLease = data.dhcp_expires_at && !isLeaseExpired;
  if (data.is_rogue) {
    return {
      status: 'in use', statusSeverity: 'danger', type: 'rogue', typeSeverity: 'danger',
      tooltip: data.rogue_reason || null
    };
  }
  if (data.is_online
      && data.status === 'available' && !data.has_dhcp_reservation && !data.hostname && !hasActiveLease) {
    return { status: 'in use', statusSeverity: 'danger', type: 'rogue', typeSeverity: 'danger' };
  }

  // DHCP reservation (static IP assignment via DHCP — inside or outside a scope)
  if (data.has_dhcp_reservation) {
    return { status: 'in use', statusSeverity: 'danger', type: 'reservation', typeSeverity: 'info' };
  }

  // Inside DHCP scope
  if (isDhcpScope) {
    // Dynamic lease — active
    if (data.dhcp_expires_at && !isLeaseExpired) {
      return { status: 'in use', statusSeverity: 'danger', type: 'dynamic', typeSeverity: 'success' };
    }
    // Unassigned or expired lease in DHCP range
    return { status: 'available', statusSeverity: 'secondary', type: 'dhcp', typeSeverity: 'secondary' };
  }

  // Locked (manually held — cannot be used until unlocked)
  if (data.status === 'locked') {
    return {
      status: 'in use', statusSeverity: 'danger',
      type: 'locked', typeSeverity: 'warn',
      tooltip: data.reservation_note || null
    };
  }

  // DNS assigned (has hostname, outside DHCP range)
  if ((data.status === 'assigned' || data.hostname) && !isDhcpScope) {
    return { status: 'in use', statusSeverity: 'danger', type: 'dns assigned', typeSeverity: 'info' };
  }

  // Completely undefined
  return { status: 'available', statusSeverity: 'secondary', type: null, typeSeverity: null };
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

const rangeDialogHeader = computed(() => {
  if (editingRange.value) {
    return isGatewayType(rangeForm.value.range_type_id) ? 'Edit Address' : 'Edit Range';
  }
  return 'Add DHCP Scope';
});

function gridTooltip(ip) {
  const lines = [ip.address];
  const pseudoData = {
    status: ip.status, range_type_name: ip.rangeType, reservation_note: ip.reservationNote,
    has_dhcp_reservation: ip.hasDhcpReservation, hostname: ip.hostname,
    mac_address: ip.mac, last_seen_mac: null,
    is_online: ip.isOnline ? 1 : 0, is_rogue: ip.isConflict ? 1 : 0, rogue_reason: ip.conflictReason,
    dhcp_expires_at: ip.dhcpExpiresAt || null
  };
  const state = computeIpState(pseudoData);
  lines.push(`Status: ${state.status}`);
  if (state.type) {
    lines.push(`Type: ${state.type}${state.tooltip ? ` (${state.tooltip})` : ''}`);
  }
  if (ip.hostname) lines.push(`Host: ${displayHostname(ip.hostname)}`);
  if (ip.mac) lines.push(`MAC: ${ip.mac}`);
  if (ip.vendor) lines.push(`Vendor: ${ip.vendor}`);
  lines.push(ip.isOnline ? 'Online' : 'Offline');
  if (ip.lastSeen) lines.push(`Last seen: ${formatDate(ip.lastSeen)}`);
  if (ip.conflictReason) lines.push(`Warning: ${ip.conflictReason}`);
  return lines.join('\n');
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
      color: rangeInfo?.color || 'var(--p-surface-200)',
      rangeType: rangeInfo?.rangeType || null,
      rangeId: rangeInfo?.rangeId || null,
      hostname: assignInfo?.hostname || null,
      mac: assignInfo?.mac_address || assignInfo?.last_seen_mac || null,
      status: assignInfo?.status || 'available',
      reservationNote: assignInfo?.reservation_note || null,
      hasDhcpReservation: assignInfo?.has_dhcp_reservation || 0,
      dhcpExpiresAt: assignInfo?.dhcp_expires_at || null,
      vendor: assignInfo?.vendor || null,
      isOnline: assignInfo?.is_online === 1,
      lastSeen: assignInfo?.last_seen_at || null,
      isConflict: assignInfo?.is_rogue === 1,
      conflictReason: assignInfo?.rogue_reason || null
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
  if (gridSelection.value.size > 0 && gridContextMenuItems.value.length) {
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
        command: () => scopeDialogRef.value.openNewWithPicker(subnet.value)
      });
    } else if (isDhcpScope) {
      // IP inside a DHCP Scope
      items.push({
        label: `Edit Scope ${range.start_ip} – ${range.end_ip}`,
        icon: 'pi pi-pencil',
        command: () => editDhcpScope(range)
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
        command: () => scopeDialogRef.value.openNewWithPicker(subnet.value)
      });
    } else {
      // No range or non-editable
      items.push({
        label: 'Create DHCP Scope',
        icon: 'pi pi-plus',
        command: () => scopeDialogRef.value.openNewWithPicker(subnet.value)
      });
    }

    // Lock / Unlock (not for system ranges)
    if (!isSystemReserved(ip)) {
      items.push({ separator: true });
      if (ipStatus === 'locked') {
        items.push({
          label: 'Unlock',
          icon: 'pi pi-unlock',
          command: () => setIpReservation(ip.address, 'available')
        });
      } else {
        items.push({
          label: `Lock ${ip.address}`,
          icon: 'pi pi-lock',
          command: () => openReserveDialog(ip.address)
        });
      }
    }

    // Convert dynamic DHCP to static reservation
    if (ip.mac && (ipStatus === 'dhcp' || isDhcpScope)) {
      items.push({ separator: true });
      items.push({
        label: 'Make Static DHCP Reservation',
        icon: 'pi pi-arrow-right-arrow-left',
        command: () => openStaticDhcpDialog(ip)
      });
    }

    // Liveness scan toggle — resolve effective state (IP override → subnet default)
    items.push({ separator: true });
    const ipData = ips.value.find(a => a.ip_address === ip.address);
    const ipOverride = ipData?.scan_enabled ?? null;
    const effectivelyEnabled = ipOverride !== null ? !!ipOverride : resolvedSubnetScanEnabled.value;
    const hasOverride = ipOverride !== null;

    if (effectivelyEnabled) {
      items.push({ label: `Disable Scanning of ${ip.address}`, icon: 'pi pi-eye-slash', command: () => toggleIpScan(ip.address, false) });
    } else {
      items.push({ label: `Enable Scanning of ${ip.address}`, icon: 'pi pi-eye', command: () => toggleIpScan(ip.address, true) });
    }
    if (hasOverride) {
      items.push({ label: 'Reset to Inherit', icon: 'pi pi-replay', command: () => toggleIpScan(ip.address, null) });
    }

    // IP lifecycle history
    items.push({ separator: true });
    items.push({ label: `Lifecycle of ${ip.address}`, icon: 'pi pi-history', command: () => openEventsDialog(ip.address) });
  } else {
    // Multi-select
    items.push({
      label: `Add DHCP Scope ${firstIp.address} – ${lastIp.address}`,
      icon: 'pi pi-plus',
      command: () => scopeDialogRef.value.openNewWithPicker(subnet.value)
    });
    items.push({
      label: `Lock ${firstIp.address} – ${lastIp.address}`,
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
  reserveScanEnabled.value = null;
  showReserveDialog.value = true;
}

async function toggleIpScan(ipAddress, enabled) {
  try {
    await api.put(`/subnets/${subnet.value.id}/ips/${ipAddress}/scan-enabled`, { scan_enabled: enabled });
    toast.add({ severity: 'success', summary: enabled === null ? 'Scan reset to inherit' : enabled ? 'Scanning enabled' : 'Scanning disabled', life: 3000 });
    await reloadData();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  }
}

async function confirmReserve() {
  if (!reserveNote.value.trim()) return;
  const note = reserveNote.value.trim();
  const scanEn = reserveScanEnabled.value;
  showReserveDialog.value = false;
  if (reserveStartIp.value === reserveEndIp.value) {
    await setIpReservation(reserveStartIp.value, 'locked', note);
    if (scanEn !== null) {
      await api.put(`/subnets/${subnet.value.id}/ips/${reserveStartIp.value}/scan-enabled`, { scan_enabled: scanEn });
    }
  } else {
    try {
      const result = await store.bulkSetIpStatus(subnet.value.id, reserveStartIp.value, reserveEndIp.value, 'locked', note);
      toast.add({ severity: 'success', summary: `${result.count} IPs locked`, life: 3000 });
      await reloadData();
    } catch (err) {
      toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
    }
  }
}

async function setIpReservation(ipAddress, status, note) {
  try {
    await store.setIpStatus(subnet.value.id, ipAddress, status, note);
    toast.add({ severity: 'success', summary: status === 'locked' ? 'IP locked' : 'IP unlocked', life: 3000 });
    await reloadData();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  }
}

function openStaticDhcpDialog(ip) {
  staticDhcpForm.value = {
    ip_address: ip.address,
    mac_address: ip.mac || '',
    hostname: ip.hostname || '',
    description: ''
  };
  staticDhcpScanEnabled.value = null;
  showStaticDhcpDialog.value = true;
}

async function confirmStaticDhcp() {
  try {
    await dhcpStore.createReservation({
      subnet_id: Number(subnet.value.id),
      ip_address: staticDhcpForm.value.ip_address,
      mac_address: staticDhcpForm.value.mac_address,
      hostname: staticDhcpForm.value.hostname || null,
      description: staticDhcpForm.value.description || null
    });
    if (staticDhcpScanEnabled.value !== null) {
      await api.put(`/subnets/${subnet.value.id}/ips/${staticDhcpForm.value.ip_address}/scan-enabled`, { scan_enabled: staticDhcpScanEnabled.value });
    }
    showStaticDhcpDialog.value = false;
    toast.add({ severity: 'success', summary: 'Static DHCP reservation created', life: 3000 });
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


async function loadIpPage(page, pageSize, { skipCache = false } = {}) {
  loadingPage.value = true;
  try {
    const detail = await store.getSubnetDetail(props.subnetId, page, pageSize, {
      skipCache,
      search: ipSearch.value,
      sortField: sortField.value,
      sortOrder: sortOrder.value
    });
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
    restoreTableState();
    // Load IPs and address types in parallel
    const [, rt] = await Promise.all([
      loadIpPage(currentPage.value, currentPageSize.value, { skipCache }),
      store.getRangeTypes()
    ]);
    rangeTypes.value = rt;

    // Auto-select best page size if no saved state
    const all = loadTableState();
    if (!all[`${props.subnetId}`]) {
      const ideal = bestPageSize(totalIps.value);
      if (ideal !== currentPageSize.value) {
        currentPageSize.value = ideal;
        await loadIpPage(1, ideal, { skipCache });
      }
    }

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
  saveTableState();
}

function onLazySort(event) {
  sortField.value = event.sortField || null;
  sortOrder.value = event.sortOrder ?? 1;
  currentPage.value = 1;
  loadIpPage(1, currentPageSize.value);
  saveTableState();
}

// Watch for subnetId changes — debounce rapid clicks
let _loadTimer = null;
watch(() => props.subnetId, (newId, oldId) => {
  gridSelection.value = new Set();
  ipSearch.value = '';
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
  scopeDialogRef.value.openNewWithPicker(subnet.value);
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

// Open DHCP scope edit dialog for an existing scope
async function editDhcpScope(range) {
  try {
    const res = await api.get('/dhcp/scopes');
    const scope = res.data.find(s => s.range_id === range.id);
    if (!scope) {
      toast.add({ severity: 'error', summary: 'No DHCP scope found for this range', life: 5000 });
      return;
    }
    scopeDialogRef.value.openEdit(scope);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
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
    window.dispatchEvent(new Event('ipam:scan-started'));
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Scan Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    startingScan.value = false;
  }
}

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
/* ── IP Lifecycle Events Dialog ── */
.events-loading, .events-empty {
  padding: 1.5rem;
  text-align: center;
  color: var(--p-text-muted-color);
  font-size: 0.85rem;
}
.events-list {
  max-height: 24rem;
  overflow-y: auto;
}
.event-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0;
  border-bottom: 1px solid color-mix(in srgb, var(--p-surface-border) 50%, transparent);
  font-size: 0.8rem;
}
.event-time {
  width: 9rem;
  flex-shrink: 0;
  color: var(--p-text-muted-color);
  font-family: monospace;
  font-size: 0.75rem;
}
.event-tag {
  flex-shrink: 0;
}
.event-detail {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--p-text-color);
}

.ip-search-bar {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.4rem 0;
}
.ip-search-input {
  width: 22rem;
}

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
.type-badge { font-size: 0.75rem; font-weight: 600; padding: 0.15rem 0.4rem; border-radius: 3px; font-family: monospace; }
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
  color: var(--p-surface-900);
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
  grid-template-columns: repeat(64, 1fr);
  gap: 1px;
  user-select: none;
}
.ip-cell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 1px;
  cursor: pointer;
  min-height: 6px;
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
  outline: 2px solid var(--p-red-500) !important;
  outline-offset: -1px;
}
.conflict-dot {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 4px;
  height: 4px;
  background: var(--p-red-500);
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

/* Scan toggle button group */
.scan-toggle-group {
  display: inline-flex;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--p-surface-border);
}
.scan-toggle-btn {
  padding: 0.3rem 0.75rem;
  font-size: 0.8rem;
  font-weight: 500;
  border: none;
  cursor: pointer;
  background: var(--p-surface-ground);
  color: var(--p-text-muted-color);
  transition: background 0.15s, color 0.15s;
}
.scan-toggle-btn + .scan-toggle-btn {
  border-left: 1px solid var(--p-surface-border);
}
.scan-toggle-btn:hover {
  background: var(--p-surface-200);
}
.p-dark .scan-toggle-btn:hover {
  background: var(--p-surface-700);
}
.scan-inherit.active {
  background: var(--p-surface-300);
  color: var(--p-text-color);
}
.p-dark .scan-inherit.active {
  background: var(--p-surface-600);
}
.scan-enabled.active {
  background: color-mix(in srgb, var(--p-green-500) 25%, transparent);
  color: var(--p-green-500);
}
.scan-disabled.active {
  background: color-mix(in srgb, var(--p-blue-500) 25%, transparent);
  color: var(--p-blue-500);
}
.scan-enabled.resolved {
  background: color-mix(in srgb, var(--p-green-500) 10%, transparent);
  color: var(--p-green-500);
  opacity: 0.7;
}
.scan-disabled.resolved {
  background: color-mix(in srgb, var(--p-blue-500) 10%, transparent);
  color: var(--p-blue-500);
  opacity: 0.7;
}

</style>
