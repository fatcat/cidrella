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
      <span class="info-bar-pair"><span class="info-bar-label">VLAN</span> <span class="info-bar-val">{{ subnet.vlan_id ?? EMPTY_CELL }}</span></span>
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
        <div class="info-value">{{ subnet.vlan_id ?? EMPTY_CELL }}</div>
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
    <Tabs v-model:value="activeTab" class="subnet-tabs">
      <TabList>
        <Tab value="ips" data-track="subnet-tab-ip-addresses">IP Addresses</Tab>
        <Tab value="grid" data-track="subnet-tab-grid-view">Grid View</Tab>
      </TabList>
      <TabPanels>
      <TabPanel value="ips">
        <div class="ip-search-bar">
          <IconField>
            <InputIcon class="pi pi-search" />
            <InputText v-model="ipSearch" placeholder="Search by IP, hostname, MAC, vendor, status…" size="small" class="ip-search-input" />
          </IconField>
          <Button v-if="ipSearch" icon="pi pi-times" severity="secondary" text rounded size="small" @click="ipSearch = ''" />
          <label class="available-toggle">
            <ToggleSwitch v-model="showAvailableIps" />
            <span>show available</span>
          </label>
          <ColumnChooserButton
            tableName="Network IPs"
            :allColumns="networkTableColumns"
            :visibleColumns="visibleNetworkColumns"
            @update:visibleColumns="setVisibleNetworkColumns"
            @reset="resetNetworkColumns"
          />
        </div>
        <DataTable :value="displayIps" stripedRows size="small"
                   class="ip-address-table"
                   :loading="loadingPage"
                  
                   scrollable scrollHeight="flex"
                   dataKey="ip_address"
                   @row-click="onTableRowClick"
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
          <template #empty>
            <EmptyState icon="pi-table" title="No IP addresses" description="Scan the subnet or add addresses to populate this view." />
          </template>
          <Column
            v-for="col in visibleNetworkColumns"
            :key="col.key"
            :field="col.field"
            :sortable="col.sortable"
            :sortField="col.sortField || col.field"
            :style="col.style"
          >
            <template #header>
              <ColumnHeaderTooltip :column="col" />
            </template>
            <template #body="{ data }">
              <span v-if="col.key === 'ip_address'" class="ip-mono">{{ displayCell(data.ip_address) }}</span>
              <StatusText
                v-else-if="col.key === 'status'"
                :label="data._ipState.status"
                :className="data._ipState.statusSeverity === 'danger' ? 'state-err' : 'state-muted'"
              />
              <AddressTypePill v-else-if="col.key === 'type'" :display="data._ipState.addressType" :tooltip="data._ipState.tooltip" />
              <template v-else-if="col.key === 'hostname'">{{ displayHost(data.hostname) }}</template>
              <template v-else-if="col.key === 'mac_address'">
                <code v-if="data.mac_address || data.last_seen_mac">{{ displayMac(data.mac_address || data.last_seen_mac) }}</code>
                <span v-else class="cell-muted">—</span>
              </template>
              <template v-else-if="col.key === 'vendor'">{{ displayCell(data.vendor) }}</template>
              <template v-else-if="col.key === 'device'">{{ deviceCell(data) }}</template>
              <OnlineStatusCell v-else-if="col.key === 'is_online'" :value="data.is_online" />
              <template v-else-if="col.key === 'last_seen_at'">{{ data.last_seen_at ? formatDate(data.last_seen_at) : EMPTY_CELL }}</template>
              <template v-else-if="col.key === 'dhcp_expires_at'">{{ displayExpiry(data.dhcp_expires_at, formatDate) }}</template>
            </template>
          </Column>
        </DataTable>
      </TabPanel>

      <TabPanel value="grid">
        <div class="grid-view-scroll">
        <!-- Ranges Table -->
        <div class="section">
          <h4 style="margin:0 0 0.5rem 0">Ranges</h4>
          <DataTable :value="visibleRanges" stripedRows size="small"
                     :paginator="ranges.length > 256" :rows="256"
                     :rowsPerPageOptions="[64, 128, 256, 512]"
                     @row-contextmenu="onRangeRightClick" contextMenu
                     scrollable scrollHeight="flex">
            <template #empty>
              <EmptyState icon="pi-sitemap" title="No ranges defined" />
            </template>
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
              <template #body="{ data }">{{ data.description ?? EMPTY_CELL }}</template>
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
              <span class="legend-swatch" style="background: var(--p-blue-700)"></span>
              DHCP Reservation
            </span>
            <span class="legend-item">
              <span class="legend-swatch" style="background: var(--p-green-300)"></span>
              DNS Configured
            </span>
            <span class="legend-item">
              <span class="legend-swatch" style="background: var(--p-violet-500)"></span>
              IP Reservation
            </span>
            <span class="legend-item">
              <!-- Rogue is already rendered on the grid as a red outline +
                   conflict dot; the swatch mirrors that with a red ring. -->
              <span class="legend-swatch legend-swatch-rogue"></span>
              Rogue
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
                 :class="{
                   'ip-cell-selected': gridSelection.has(idx),
                   'ip-cell-conflict': ip.isConflict,
                   'ip-cell-section-right': ip.isSectionRight
                 }">
              <span v-if="ip.isConflict" class="conflict-dot"></span>
            </div>
          </div>
          <div v-else class="grid-too-large">
            Network too large for grid view ({{ subnet.total_addresses }} addresses, max 1024). Use the IP Addresses tab.
          </div>
        </div>
        </div>
      </TabPanel>
      </TabPanels>
    </Tabs>

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

    <!-- IP Reservation Dialog -->
    <Dialog v-model:visible="showReserveDialog" header="Create IP Reservation" modal :style="{ width: '26rem' }" data-track="dialog-reserve-ip">
      <p style="margin: 0 0 0.75rem 0; font-size: 0.85rem; color: var(--p-text-muted-color)">
        An IP Reservation holds the selected address or range. While it exists, the address is unavailable for DHCP or DNS assignment.
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
        <ScanToggle v-model="reserveScanEnabled" :resolved-enabled="resolvedSubnetScanEnabled" />
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showReserveDialog = false" />
        <Button label="Create IP Reservation" icon="pi pi-lock" data-track="btn-confirm-reserve" @click="confirmReserve" :disabled="!reserveNote.trim()" />
      </template>
    </Dialog>

    <!-- Convert to DHCP Reservation Dialog -->
    <Dialog v-model:visible="showStaticDhcpDialog" header="Create DHCP Reservation" modal :style="{ width: '28rem' }" data-track="dialog-static-dhcp">
      <p style="margin: 0 0 0.75rem 0; font-size: 0.85rem; color: var(--p-text-muted-color)">
        Convert this dynamic DHCP assignment to a DHCP Reservation.
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
        <ScanToggle v-model="staticDhcpScanEnabled" :resolved-enabled="resolvedSubnetScanEnabled" />
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showStaticDhcpDialog = false" />
        <Button label="Create DHCP Reservation" icon="pi pi-check" data-track="btn-create-static-dhcp" @click="confirmStaticDhcp" :disabled="!staticDhcpForm.mac_address" />
      </template>
    </Dialog>

    <!-- IP details drawer -->
    <IpDetailsDrawer v-model:visible="showIpDetails" :host="ipDetailsRow"
                     :subnet-id="subnet?.id" :domain-name="subnet?.domain_name" />

    <Toast />
  </div>
  <div v-else-if="loading" class="loading">Loading network...</div>
  <div v-else class="empty-state">Select a network to view details.</div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { formatDateTime } from '../utils/dateFormat.js';
import { useToast } from '../ui/useToast.js';
import Button from '../ui/Button.js';
import EmptyState from '../components/EmptyState.vue';
import DataTable from '../ui/DataTable.js';
import Column from '../ui/Column.js';
import Dialog from '../ui/Dialog.js';
import InputText from '../ui/InputText.js';
import IconField from '../ui/IconField.js';
import InputIcon from '../ui/InputIcon.js';
import Select from '../ui/Select.js';
import ContextMenu from '../ui/ContextMenu.js';
import Toast from '../ui/Toast.js';
import Tabs from '../ui/Tabs.js';
import TabList from '../ui/TabList.js';
import Tab from '../ui/Tab.js';
import TabPanels from '../ui/TabPanels.js';
import TabPanel from '../ui/TabPanel.js';
import ToggleSwitch from '../ui/ToggleSwitch.js';
import ScopeDialog from '../components/ScopeDialog.vue';
import IpDetailsDrawer from '../components/IpDetailsDrawer.vue';
import ScanToggle from '../components/ScanToggle.vue';
import AddressTypePill from '../components/table/AddressTypePill.vue';
import ColumnChooserButton from '../components/table/ColumnChooserButton.vue';
import ColumnHeaderTooltip from '../components/table/ColumnHeaderTooltip.vue';
import OnlineStatusCell from '../components/table/OnlineStatusCell.vue';
import StatusText from '../components/table/StatusText.vue';
import { useSubnetStore } from '../stores/subnets.js';
import { loadJson, saveJson } from '../utils/storage.js';
import { useDhcpStore } from '../stores/dhcp.js';
import { useColumnPreferences } from '../composables/useColumnPreferences.js';
import api from '../api/client.js';
import { ipToLong, longToIp } from '../utils/ip.js';
import { ipLifecycleDisplay } from '../utils/ipLifecycleDisplay.js';
import { isImmutableNetworkAddress, probeNowMenuItem } from '../utils/rowContextMenu.js';
import {
  EMPTY_CELL,
  apiError,
  displayCell,
  displayExpiry,
  displayHostnameCell,
  displayMacAddress
} from '../utils/format.js';

const props = defineProps({
  subnetId: { type: [Number, String], default: null },
  compact: { type: Boolean, default: false }
});

defineEmits(['refresh']);

const toast = useToast();
const store = useSubnetStore();
const dhcpStore = useDhcpStore();

const networkTableColumns = [
  { key: 'ip_address', header: 'IP Address', description: 'Address within the selected network.', field: 'ip_address', sortable: true, style: 'width: 10rem' },
  { key: 'status', header: 'Status', description: 'Whether the address is currently in use or available according to CIDRella lifecycle data.', field: 'ip_display_status', sortable: true, style: 'width: 7rem' },
  { key: 'type', header: 'Type', description: 'How the address is allocated, such as static DNS, dynamic DHCP, DHCP Reservation, IP Reservation, rogue, gateway, or system.', field: 'computed_type', sortField: 'computed_type', sortable: true, style: 'width: 9.5rem' },
  { key: 'hostname', header: 'Hostname', description: 'Best known hostname from DNS, DHCP, or passive observations.', field: 'hostname', sortable: true, style: 'width: 10rem' },
  { key: 'mac_address', header: 'MAC Address', description: 'Best known hardware address from DHCP or last-seen lifecycle data.', field: 'mac_address', sortField: 'mac_address', sortable: true, style: 'width: 10rem' },
  { key: 'vendor', header: 'Vendor', description: 'Hardware vendor inferred from the MAC address OUI.', field: 'vendor', sortable: true, style: 'width: 10rem' },
  { key: 'device', header: 'Device', description: 'Device type / OS family inferred passively from the DHCP fingerprint (options 55/60 + hostname) and MAC OUI. Click the row for full detail.', field: 'os_family', sortable: true, style: 'width: 9rem' },
  { key: 'is_online', header: 'Online', description: 'Current liveness state from active probes and passive DHCP/DNS observations.', field: 'is_online', sortable: true, style: 'width: 5rem' },
  { key: 'last_seen_at', header: 'Last Seen', description: 'Most recent time CIDRella observed this address through DHCP, DNS logs, or active scans.', field: 'last_seen_at', sortable: true, style: 'width: 10rem' },
  { key: 'dhcp_expires_at', header: 'Expires', description: 'DHCP lease expiration time when the address has a dynamic lease.', field: 'dhcp_expires_at', sortable: true, style: 'width: 9rem' },
];

const {
  visibleColumns: visibleNetworkColumns,
  setVisibleColumns: setVisibleNetworkColumns,
  resetColumns: resetNetworkColumns
} = useColumnPreferences('cidrella_columns_networks', networkTableColumns);

const subnet = ref(null);
const ips = ref([]);
const displayIps = computed(() => ips.value.map(ip => ({ ...ip, _ipState: ipLifecycleDisplay(ip) })));
const ranges = ref([]);
const rangeTypes = ref([]);
const loading = ref(false);
const saving = ref(false);

// IP Reservation dialog
const showReserveDialog = ref(false);
const reserveStartIp = ref('');
const reserveEndIp = ref('');
const reserveNote = ref('');
const reserveScanEnabled = ref(null);

// Convert to DHCP Reservation dialog
const showStaticDhcpDialog = ref(false);
const staticDhcpForm = ref({ ip_address: '', mac_address: '', hostname: '', description: '' });
const staticDhcpScanEnabled = ref(null);

// IP details drawer (full per-host metadata, device fingerprint, and lifecycle)
const showIpDetails = ref(false);
const ipDetailsRow = ref(null);
function openIpDetails(row) {
  ipDetailsRow.value = row;
  showIpDetails.value = true;
}
function onTableRowClick(event) {
  openIpDetails(event.data);
}
// Compact "Device" column: OS family preferred, else device type. Full detail
// (manufacturer, confidence, raw fingerprint) lives in the details drawer.
function deviceCell(row) {
  return row.os_family || row.device_type || EMPTY_CELL;
}

// Resolve the effective scan_enabled for this subnet (subnet → folder → default true)
const resolvedSubnetScanEnabled = computed(() => {
  if (!subnet.value) return true;
  if (subnet.value.scan_enabled !== null && subnet.value.scan_enabled !== undefined) return !!subnet.value.scan_enabled;
  // Inherit from folder
  const folder = store.folders?.find(f => f.id === subnet.value.folder_id);
  return folder ? !!folder.scan_enabled : true;
});

// Server-side pagination state, persisted per-subnet
function loadTableState() {
  const saved = loadJson('cidrella_ip_table_state', {});
  return saved;
}
function saveTableState() {
  try {
    const key = `${props.subnetId}`;
    const all = loadJson('cidrella_ip_table_state', {});
    all[key] = {
      page: currentPage.value,
      pageSize: currentPageSize.value,
      sortField: sortField.value,
      sortOrder: sortOrder.value,
    };
    saveJson('cidrella_ip_table_state', all);
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
const showAvailableIps = ref(loadJson('cidrella_network_show_available', true));

// Active tab, persisted as a string key. Older builds stored the numeric
// TabView index (0/1) under the same localStorage key, map those over.
const TAB_KEYS = ['ips', 'grid'];
function loadSubnetTab() {
  const stored = loadJson('cidrella_subnet_detail_tab', 'ips');
  if (typeof stored === 'number') return TAB_KEYS[stored] || 'ips';
  return TAB_KEYS.includes(stored) ? stored : 'ips';
}
const activeTab = ref(loadSubnetTab());
watch(activeTab, (val) => {
  saveJson('cidrella_subnet_detail_tab', val)
});

// Search / filter
const ipSearch = ref('');
let _searchTimer = null;
watch(ipSearch, (_val) => {
  if (_searchTimer) clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    _searchTimer = null;
    currentPage.value = 1;
    loadIpPage(1, currentPageSize.value);
  }, 300);
});

watch(showAvailableIps, (val) => {
  saveJson('cidrella_network_show_available', val)
  currentPage.value = 1;
  store.invalidateDetailCache(props.subnetId);
  loadIpPage(1, currentPageSize.value);
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
  tableContextIp.value = row;
  if (tableContextMenuItems.value.length) {
    tableContextMenuRef.value.show(event.originalEvent);
  }
}

const tableContextMenuItems = computed(() => {
  const row = tableContextIp.value;
  if (!row) return [];

  if (isImmutableNetworkAddress(row)) {
    return [
      {
        label: `Protected ${row.range_type_name.toLowerCase()} address`,
        icon: 'pi pi-lock',
        disabled: true
      },
      { separator: true },
      probeNowMenuItem(() => probeIpNow(row.ip_address))
    ];
  }

  const range = findRangeForIp(row.ip_address);
  const ip = {
    address: row.ip_address,
    rangeId: range?.id || null,
    rangeType: row.range_type_name || null,
    allocationState: row.allocation_state || 'unassigned',
    mac: row.mac_address || row.last_seen_mac || null,
    hostname: row.hostname || null
  };

  return buildContextMenuItems([ip], { allowCreateDhcpScope: false });
});

// Range context menu
const rangeContextMenuRef = ref(null);
const selectedRange = ref(null);
const rangeContextMenuItems = computed(() => {
  const r = selectedRange.value;
  if (!r) return [];
  if (r._synthetic) {
    const plural = r.start_ip === r.end_ip ? '' : 's';
    return [{
      label: `Release IP Reservation${plural}`,
      icon: 'pi pi-unlock',
      command: () => bulkRelease(r.start_ip, r.end_ip)
    }];
  }
  if (!isEditableRange(r)) return [];
  return [
    { label: r.range_type_name === 'DHCP Scope' ? 'Edit DHCP Scope' : 'Edit Range', icon: 'pi pi-pencil', command: () => r.range_type_name === 'DHCP Scope' ? editDhcpScope(r) : editRange(r) },
    { label: r.range_type_name === 'DHCP Scope' ? 'Delete DHCP Scope' : 'Delete Range', icon: 'pi pi-trash', command: () => confirmDeleteRange(r) }
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

const formatDate = formatDateTime;

const displayHost = (hostname) => displayHostnameCell(hostname, subnet.value?.domain_name);
const displayMac = displayMacAddress;

// The legend always shows every possible color so users can learn it
// without needing a subnet that happens to have one of each. User-defined
// range types (non-system) still appear dynamically, those are specific
// to a deployment and only meaningful when they exist.
const rangeTypeLegend = computed(() => {
  // Static baseline, always shown, in a deliberate order.
  const baseline = [
    { name: 'System',      color: '#6b7280' },          // network + broadcast
    { name: 'Gateway',     color: '#f59e0b' },
    { name: 'DHCP Scope',  color: '#3b82f6' },
  ];

  // Dynamic user-defined types pulled from range_types store (loaded on
  // mount). Filter out the system types we already cover in baseline.
  const dynamic = [];
  const seen = new Set(['System', 'Gateway', 'DHCP Scope', 'Network', 'Broadcast']);
  for (const rt of (rangeTypes.value || [])) {
    if (rt.is_system) continue;
    if (seen.has(rt.name)) continue;
    seen.add(rt.name);
    dynamic.push({ name: rt.name, color: rt.color });
  }
  return [...baseline, ...dynamic];
});

// Entries displayed in the Ranges table on the Grid View. System-range rows
// (Network / Broadcast / Gateway) are hidden, they're implicit for every
// allocated subnet and add noise. IP Reservations from `ip_addresses` are injected
// as synthetic rows so users can see which addresses are manually held. We
// collapse consecutive IP Reservations into a single range (e.g. .5–.7 instead
// of three separate rows) to keep the table tidy.
const visibleRanges = computed(() => {
  const filtered = ranges.value.filter(r => {
    if (!r.range_type_is_system) return true;
    return !['Network', 'Broadcast', 'Gateway'].includes(r.range_type_name);
  });

  // An IP Reservation that overlaps a system range (Network / Broadcast / Gateway)
  // is topology-owned, createSystemRanges writes those rows automatically.
  // The grid-cell coloring already applies this same filter; we mirror it
  // here so the Ranges table doesn't list .0, .255, or the gateway IP as
  // as an IP Reservation. Build a set of system-range IPs for quick lookup.
  const systemIpLongs = new Set();
  for (const r of ranges.value) {
    if (!r.range_type_is_system) continue;
    if (!['Network', 'Broadcast', 'Gateway'].includes(r.range_type_name)) continue;
    const s = ipToLong(r.start_ip);
    const e = ipToLong(r.end_ip);
    for (let l = s; l <= e; l++) systemIpLongs.add(l);
  }

  // Group IP Reservations into contiguous ranges.
  const reservedIps = (ips.value || [])
    .filter(ip => ip.allocation_state === 'reserved')
    .map(ip => ({ ip, long: ipToLong(ip.ip_address) }))
    .filter(({ long }) => !systemIpLongs.has(long))
    .sort((a, b) => a.long - b.long);

  const reservedRows = [];
  let run = null;  // { startIp, endIp, startLong, endLong, hostnames:[], notes:[] }
  const flushRun = () => {
    if (!run) return;
    // Build the description from all hostnames + notes within the run.
    const parts = [];
    const noteSet = [...new Set(run.notes.filter(Boolean))];
    const hostSet = [...new Set(run.hostnames.filter(Boolean))];
    if (hostSet.length) parts.push(`Host${hostSet.length > 1 ? 's' : ''}: ${hostSet.join(', ')}`);
    if (noteSet.length) parts.push(noteSet.join('; '));
    reservedRows.push({
      id: `reserved-${run.startLong}`,
      range_type_name: 'IP Reservation',
      range_type_color: 'var(--p-violet-500)',
      range_type_is_system: 0,
      start_ip: run.startIp,
      end_ip: run.endIp,
      description: parts.join(' · ') || null,
      _synthetic: true
    });
  };
  for (const { ip, long } of reservedIps) {
    if (run && long === run.endLong + 1) {
      run.endIp = ip.ip_address;
      run.endLong = long;
      if (ip.hostname) run.hostnames.push(ip.hostname);
      if (ip.reservation_note) run.notes.push(ip.reservation_note);
    } else {
      flushRun();
      run = {
        startIp: ip.ip_address,
        endIp: ip.ip_address,
        startLong: long,
        endLong: long,
        hostnames: ip.hostname ? [ip.hostname] : [],
        notes: ip.reservation_note ? [ip.reservation_note] : [],
      };
    }
  }
  flushRun();

  return [...filtered, ...reservedRows];
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
  // Reuse the classification the cell was painted from. Re-deriving it here is
  // how the tooltip and the fill came to disagree. See audit #41.
  const state = ip.state;
  lines.push(`Status: ${state.status}`);
  if (state.addressType?.label) {
    lines.push(`Type: ${state.addressType.label}${state.tooltip ? ` (${state.tooltip})` : ''}`);
  }
  // Network and Broadcast both resolve to Type = "system"; the Role line
  // tells them apart for quick identification.
  if (ip.rangeType === 'Network')   lines.push('Role: network');
  if (ip.rangeType === 'Broadcast') lines.push('Role: broadcast');
  if (ip.hostname) lines.push(`Host: ${displayHost(ip.hostname)}`);
  if (ip.mac) lines.push(`MAC: ${ip.mac}`);
  if (ip.vendor) lines.push(`Vendor: ${ip.vendor}`);
  if (ip.os_family || ip.device_type) lines.push(`Device: ${ip.os_family || ip.device_type}`);
  lines.push(ip.isOnline ? 'Online' : 'Offline');
  if (ip.lastSeen) lines.push(`Last seen: ${formatDate(ip.lastSeen)}`);
  if (ip.conflictReason) lines.push(`Warning: ${ip.conflictReason}`);
  return lines.join('\n');
}

// The row shape the shared classifier expects, built from what the grid knows
// about one address. Extracted so the cell fill and the tooltip classify from
// exactly the same input rather than each assembling their own.
function gridPseudoData({ addr, assignInfo, rangeInfo }) {
  return {
    ip_address: addr,
    ip_display_status: assignInfo?.ip_display_status || null,
    ip_status_severity: assignInfo?.ip_status_severity || null,
    address_type: assignInfo?.address_type || null,
    address_type_tooltip: assignInfo?.address_type_tooltip || null,
    allocation_state: assignInfo?.allocation_state || 'unassigned',
    range_type_name: rangeInfo?.rangeType || null,
    reservation_note: assignInfo?.reservation_note || null,
    hostname: assignInfo?.hostname || null,
    mac_address: assignInfo?.mac_address || assignInfo?.last_seen_mac || null,
    last_seen_mac: null,
    is_online: assignInfo?.is_online === 1 ? 1 : 0,
    is_rogue: assignInfo?.is_rogue === 1 ? 1 : 0,
    rogue_reason: assignInfo?.rogue_reason || null,
    dhcp_expires_at: assignInfo?.dhcp_expires_at || null,
  };
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
      ipRangeMap.set(i, {
        color: r.range_type_color,
        rangeType: r.range_type_name,
        rangeId: r.id,
        isSystem: !!r.range_type_is_system
      });
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

    const isSystemRange = !!rangeInfo?.isSystem;

    // Classify ONCE, here, and hand the result to both the fill below and the
    // tooltip (see gridTooltip). The tooltip used to re-derive it from this
    // cell, so the two could describe the same square differently: the ladder
    // had no branch for rogue or for one of our own interface addresses, so a
    // rogue address was painted in the ordinary pool tint, indistinguishable
    // from free space unless you happened to hover it. The grid is the
    // at-a-glance view of a subnet, so the one classification an operator most
    // needs to spot was the one the colour could not express.
    // See REVIEW.md, duplicate-logic audit #41.
    const cellState = ipLifecycleDisplay(gridPseudoData({
      addr, assignInfo, rangeInfo,
    }));
    const cellTypeClass = cellState.addressType?.className || null;

    let cellColor;
    if (isSystemRange) cellColor = rangeInfo.color;
    else if (cellTypeClass === 'type-rogue')  cellColor = 'var(--cid-rogue)';
    else if (cellTypeClass === 'type-system') cellColor = 'var(--cid-system)';
    else if (cellTypeClass === 'type-reserved-dhcp') cellColor = 'var(--p-blue-700)';
    else if (cellTypeClass === 'type-static-dns') cellColor = 'var(--p-green-300)';
    else if (cellTypeClass === 'type-reserved') cellColor = 'var(--p-violet-500)';
    else                        cellColor = rangeInfo?.color || 'var(--p-surface-200)';

    // Column position within the 64-wide grid. Mark every 16th column's
    // RIGHT edge with a thicker line so users can visually count IPs by
    // octets of 16. Skip col 63 (that's the outer frame) and any cell
    // that's the last rendered cell (subnet smaller than 64-wide).
    const col = (i - net) % 64;
    const isSectionRight = (col % 16) === 15 && col !== 63 && i !== bcast;

    grid.push({
      address: addr,
      ipLong: i,
      lastOctet: i & 255,
      color: cellColor,
      isSectionRight,
      rangeType: rangeInfo?.rangeType || null,
      rangeId: rangeInfo?.rangeId || null,
      hostname: assignInfo?.hostname || null,
      mac: assignInfo?.mac_address || assignInfo?.last_seen_mac || null,
      allocationState: assignInfo?.allocation_state || 'unassigned',
      ipDisplayStatus: assignInfo?.ip_display_status || null,
      ipStatusSeverity: assignInfo?.ip_status_severity || null,
      addressType: assignInfo?.address_type || null,
      addressTypeTooltip: assignInfo?.address_type_tooltip || null,
      reservationNote: assignInfo?.reservation_note || null,
      dhcpExpiresAt: assignInfo?.dhcp_expires_at || null,
      vendor: assignInfo?.vendor || null,
      isOnline: assignInfo?.is_online === 1,
      lastSeen: assignInfo?.last_seen_at || null,
      isConflict: assignInfo?.is_rogue === 1,
      conflictReason: assignInfo?.rogue_reason || null,
      state: cellState
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

function buildContextMenuItems(selectedIps, { allowCreateDhcpScope = true } = {}) {
  if (selectedIps.length === 0) return [];

  const items = [];
  const firstIp = selectedIps[0];
  const lastIp = selectedIps[selectedIps.length - 1];

  if (selectedIps.length === 1) {
    const ip = firstIp;
    const range = ip.rangeId ? ranges.value.find(r => r.id === ip.rangeId) : null;
    const isDhcpScope = range && range.range_type_name === 'DHCP Scope';
    const isGateway = range && range.range_type_name === 'Gateway';
    const allocationState = ip.allocationState || ip.allocation_state || 'unassigned';

    if (isGateway) {
      // Gateway IP: Edit and Delete. Grid view can also create a scope.
      items.push({ label: 'Edit Gateway', icon: 'pi pi-pencil', command: () => editRange(range) });
      items.push({ label: 'Delete Gateway', icon: 'pi pi-trash', command: () => confirmDeleteRange(range) });
      if (allowCreateDhcpScope) {
        items.push({ separator: true });
        items.push({
          label: 'Create DHCP Scope',
          icon: 'pi pi-plus',
          command: () => scopeDialogRef.value.openNewWithPicker(subnet.value)
        });
      }
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
      if (allowCreateDhcpScope) {
        items.push({
          label: 'Create DHCP Scope',
          icon: 'pi pi-plus',
          command: () => scopeDialogRef.value.openNewWithPicker(subnet.value)
        });
      }
    } else if (allowCreateDhcpScope) {
      // No range or non-editable
      items.push({
        label: 'Create DHCP Scope',
        icon: 'pi pi-plus',
        command: () => scopeDialogRef.value.openNewWithPicker(subnet.value)
      });
    }

    // Create / Release IP Reservation (not for system ranges)
    if (!isSystemReserved(ip)) {
      if (items.length) items.push({ separator: true });
      if (allocationState === 'reserved') {
        items.push({
          label: 'Release IP Reservation',
          icon: 'pi pi-unlock',
          command: () => setIpReservation(ip.address, false)
        });
      } else {
        items.push({
          label: `Create IP Reservation for ${ip.address}`,
          icon: 'pi pi-lock',
          command: () => openReserveDialog(ip.address)
        });
      }
    }

    // Convert dynamic DHCP to a DHCP Reservation
    if (ip.mac && (allocationState === 'dynamic_dhcp' || isDhcpScope)) {
      items.push({ separator: true });
      items.push({
        label: 'Create DHCP Reservation',
        icon: 'pi pi-arrow-right-arrow-left',
        command: () => openStaticDhcpDialog(ip)
      });
    }

    // Liveness scan toggle, resolve effective state (IP override → subnet default)
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

    // Probe
    items.push({ separator: true });
    items.push(probeNowMenuItem(() => probeIpNow(ip.address)));
  } else {
    // Multi-select. Skip system-owned IPs (network/broadcast/gateway),
    // their allocations cannot be changed here. The bulk-allocation
    // endpoint also silently skips them, so this is just UX symmetry.
    const reservable = selectedIps.filter(ip => !isSystemReserved(ip));
    const anyReserved = reservable.some(ip => (ip.allocationState || 'unassigned') === 'reserved');
    const anyUnreserved = reservable.some(ip => (ip.allocationState || 'unassigned') !== 'reserved');

    // If the contiguous selection is entirely inside ONE DHCP Scope range,
    // offer a bulk "Remove from Scope" that shrinks/splits that scope. When
    // the selection straddles two scopes or leaks outside any scope, we
    // don't offer it, the user should remove per-scope.
    const firstLong = ipToLong(firstIp.address);
    const lastLong = ipToLong(lastIp.address);
    const coveringScope = ranges.value.find(r =>
      r.range_type_name === 'DHCP Scope'
      && firstLong >= ipToLong(r.start_ip)
      && lastLong <= ipToLong(r.end_ip)
    );

    items.push({
      label: `Add DHCP Scope ${firstIp.address} – ${lastIp.address}`,
      icon: 'pi pi-plus',
      command: () => scopeDialogRef.value.openNewWithPicker(subnet.value)
    });
    if (coveringScope) {
      items.push({
        label: `Remove ${firstIp.address} – ${lastIp.address} from Scope`,
        icon: 'pi pi-minus',
        command: () => removeRangeFromPool(coveringScope, firstIp.address, lastIp.address)
      });
    }
    if (anyUnreserved) {
      items.push({
        label: `Create IP Reservations for ${firstIp.address} – ${lastIp.address}`,
        icon: 'pi pi-lock',
        command: () => openReserveDialog(firstIp.address, lastIp.address)
      });
    }
    if (anyReserved) {
      items.push({
        label: `Release IP Reservations for ${firstIp.address} – ${lastIp.address}`,
        icon: 'pi pi-unlock',
        command: () => bulkRelease(firstIp.address, lastIp.address)
      });
    }
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

async function probeIpNow(ipAddress) {
  toast.add({ severity: 'info', summary: 'Probing...', detail: `Sending probe to ${ipAddress}`, life: 2000 });
  try {
    const res = await api.post('/scans/probe', { ip: ipAddress, subnet_id: subnet.value.id });
    const r = res.data;
    if (r.responded) {
      toast.add({
        severity: 'success',
        summary: `${ipAddress} is Online`,
        detail: `Method: ${r.method.toUpperCase()}${r.mac ? ` · MAC: ${r.mac}` : ''}`,
        life: 5000
      });
    } else {
      toast.add({
        severity: 'warn',
        summary: `${ipAddress} is Offline`,
        detail: `No response via ${r.method.toUpperCase()}`,
        life: 5000
      });
    }
    // Refetch IPs so the Online badge updates
    await loadIpPage(currentPage.value, currentPageSize.value, { skipCache: true });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Probe Failed', detail: apiError(err), life: 5000 });
  }
}

async function confirmReserve() {
  if (!reserveNote.value.trim()) return;
  const note = reserveNote.value.trim();
  const scanEn = reserveScanEnabled.value;
  showReserveDialog.value = false;
  if (reserveStartIp.value === reserveEndIp.value) {
    await setIpReservation(reserveStartIp.value, true, note);
    if (scanEn !== null) {
      await api.put(`/subnets/${subnet.value.id}/ips/${reserveStartIp.value}/scan-enabled`, { scan_enabled: scanEn });
    }
  } else {
    try {
      const result = await store.bulkSetIpAllocation(subnet.value.id, reserveStartIp.value, reserveEndIp.value, 'reserved', note);
      toast.add({ severity: 'success', summary: `${result.count} IP Reservation${result.count === 1 ? '' : 's'} created`, life: 3000 });
      await reloadData();
    } catch (err) {
      toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
    }
  }
}

async function setIpReservation(ipAddress, reserved, note) {
  try {
    await store.setIpAllocation(subnet.value.id, ipAddress, reserved ? 'reserved' : 'unassigned', note);
    toast.add({ severity: 'success', summary: reserved ? 'IP Reservation created' : 'IP Reservation released', life: 3000 });
    await reloadData();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  }
}

// Release a contiguous IP Reservation range. Topology-owned addresses are
// silently skipped by the server.
async function bulkRelease(startIp, endIp) {
  try {
    const result = await store.bulkSetIpAllocation(subnet.value.id, startIp, endIp, 'unassigned');
    const skipped = result?.skipped ? ` (${result.skipped} skipped)` : '';
    toast.add({
      severity: 'success',
      summary: `${result.count} IP Reservation${result.count === 1 ? '' : 's'} released${skipped}`,
      life: 3000
    });
    await reloadData();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'success', summary: 'DHCP Reservation created', life: 3000 });
    await reloadData();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
      sortOrder: sortOrder.value,
      showAvailable: showAvailableIps.value
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

// Watch for subnetId changes, debounce rapid clicks
let _loadTimer = null;
watch(() => props.subnetId, (newId, _oldId) => {
  gridSelection.value = new Set();
  ipSearch.value = '';
  showIpDetails.value = false;
  ipDetailsRow.value = null;
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
      await store.createRange(subnet.value.id, payload);
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
      toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
    }
  } finally {
    saving.value = false;
  }
}

async function forceCreateRange() {
  rangeForm.value = pendingRangeForm.value;
  await saveRange(true);
}

// Shrink a DHCP scope range to exclude a contiguous sub-range [startIp,
// endIp]. Caller guarantees [startIp, endIp] is fully inside `range`.
// Three shapes are supported: whole pool, start trim, end trim. Middle-
// split (two pools per subnet) is NOT supported today, dnsmasq can handle
// multiple scopes per interface but CIDRella's data model and UI assume
// one DHCP scope per subnet. Rather than throw a generic server-side
// "ranges must be contiguous" error, refuse client-side with guidance.
async function removeRangeFromPool(range, startIp, endIp) {
  const poolStart = ipToLong(range.start_ip);
  const poolEnd = ipToLong(range.end_ip);
  const cutStart = ipToLong(startIp);
  const cutEnd = ipToLong(endIp);

  // Middle cut, would split the pool into two. Reject with guidance.
  if (cutStart > poolStart && cutEnd < poolEnd) {
    toast.add({
      severity: 'warn',
      summary: "Can't split a DHCP pool",
      detail: `Removing ${startIp} – ${endIp} would leave two separate pools (${range.start_ip} – ${longToIp(cutStart - 1)} and ${longToIp(cutEnd + 1)} – ${range.end_ip}). A subnet can only have one DHCP scope. To carve out this range, resize the pool from the start or end, or delete the pool and recreate smaller ones by hand.`,
      life: 9000
    });
    return;
  }

  saving.value = true;
  try {
    if (cutStart <= poolStart && cutEnd >= poolEnd) {
      // Whole pool carved out, drop it.
      await store.deleteRange(subnet.value.id, range.id);
      toast.add({ severity: 'success', summary: 'Pool deleted', life: 3000 });
    } else if (cutStart <= poolStart) {
      // Trim the start.
      await store.updateRange(subnet.value.id, range.id, {
        ...range, start_ip: longToIp(cutEnd + 1)
      });
      toast.add({ severity: 'success', summary: 'Pool start trimmed', life: 3000 });
    } else {
      // Trim the end.
      await store.updateRange(subnet.value.id, range.id, {
        ...range, end_ip: longToIp(cutStart - 1)
      });
      toast.add({ severity: 'success', summary: 'Pool end trimmed', life: 3000 });
    }
    await reloadData();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    saving.value = false;
  }
}

async function removeIpFromPool(range, ipAddress) {
  const startLong = ipToLong(range.start_ip);
  const endLong = ipToLong(range.end_ip);
  const ipLong = ipToLong(ipAddress);

  // Middle cut would require two separate pools (one below, one above),
  // not supported today. Explain up front instead of hitting the generic
  // contiguous-range error from the ranges POST endpoint.
  if (startLong !== endLong && ipLong !== startLong && ipLong !== endLong) {
    toast.add({
      severity: 'warn',
      summary: "Can't split a DHCP pool",
      detail: `Removing ${ipAddress} would leave two separate pools (${range.start_ip} – ${longToIp(ipLong - 1)} and ${longToIp(ipLong + 1)} – ${range.end_ip}). A subnet can only have one DHCP scope. To free this IP, shrink the pool's start or end instead, or delete the pool and recreate it.`,
      life: 9000
    });
    return;
  }

  saving.value = true;
  try {
    if (startLong === endLong) {
      // Single-IP pool, just delete it
      await store.deleteRange(subnet.value.id, range.id);
      toast.add({ severity: 'success', summary: 'Pool deleted', life: 3000 });
    } else if (ipLong === startLong) {
      // Remove from start
      await store.updateRange(subnet.value.id, range.id, {
        ...range, start_ip: longToIp(startLong + 1)
      });
      toast.add({ severity: 'success', summary: 'IP removed from pool', life: 3000 });
    } else {
      // Remove from end
      await store.updateRange(subnet.value.id, range.id, {
        ...range, end_ip: longToIp(endLong - 1)
      });
      toast.add({ severity: 'success', summary: 'IP removed from pool', life: 3000 });
    }
    await reloadData();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    const range = deletingRange.value;
    // DHCP Scope ranges aren't deletable directly, the server refuses to
    // avoid orphaning the attached `dhcp_scopes` row (range_id → SET NULL).
    // The DHCP scope DELETE endpoint wipes scope + options + range together,
    // which is what the user actually wants. Look up the scope by range_id
    // and route through it.
    if (range.range_type_name === 'DHCP Scope') {
      const scopes = await dhcpStore.fetchScopes();
      const scope = (scopes || dhcpStore.scopes || []).find(s => s.range_id === range.id);
      if (!scope) throw new Error('DHCP scope metadata missing. Refresh and retry.');
      await dhcpStore.deleteScope(scope.id);
      showDeleteRangeDialog.value = false;
      toast.add({ severity: 'success', summary: 'DHCP scope deleted', life: 3000 });
    } else {
      await store.deleteRange(subnet.value.id, range.id);
      showDeleteRangeDialog.value = false;
      toast.add({ severity: 'success', summary: 'Range deleted', life: 3000 });
    }
    await reloadData();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Scan Error', detail: apiError(err), life: 5000 });
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
.ip-search-bar {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.4rem 0;
}
.ip-search-input {
  width: 22rem;
}
.ip-address-table :deep(.p-datatable-tbody > tr) {
  cursor: pointer;
}
.available-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin-left: 0.5rem;
  color: var(--p-text-muted-color);
  font-size: var(--app-fs-sm);
  white-space: nowrap;
  text-transform: lowercase;
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

:deep(.p-tabs) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
:deep(.p-tabpanels) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
:deep(.p-tabpanel) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
:deep(.p-tabpanel > .p-datatable) {
  flex: 1;
  min-height: 0;
  padding-right: 0.5rem;
  box-sizing: border-box;
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
/* Rogue cells are drawn as a red outline + dot on the grid rather than a
   solid fill; the legend swatch mirrors that so users can match what they
   see. */
.legend-swatch-rogue {
  background: transparent;
  outline: 2px solid var(--p-red-500);
  outline-offset: -2px;
}
.ip-grid {
  display: grid;
  grid-template-columns: repeat(64, 1fr);
  /* No gap. `gap: 1px` combined with `1fr` columns produces fractional
     cell widths (e.g. 14.859–14.875 px) whose 1px gaps then get eaten by
     sub-pixel rasterization, so grid lines randomly disappear. We draw
     each cell's right + bottom edges with an inset box-shadow instead;
     shadows snap to device pixels regardless of cell width. The grid
     container frames its own top + left edges so the outer border is
     complete. */
  gap: 0;
  user-select: none;
  border-top: 1px solid var(--p-surface-border);
  border-left: 1px solid var(--p-surface-border);
}
.ip-cell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0;
  cursor: pointer;
  min-height: 6px;
  min-width: 0;
  position: relative;
  transition: outline 0.1s;
  box-shadow:
    inset -1px 0 0 var(--p-surface-border),
    inset 0 -1px 0 var(--p-surface-border);
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
/* Every 16th column gets a thicker, slightly darker right edge so users
   can count IPs by groups of 16 at a glance. Overrides the default
   box-shadow (right + bottom), we keep the bottom thin but widen and
   darken the right edge. */
.ip-cell-section-right {
  box-shadow:
    inset -2px 0 0 var(--p-surface-content),
    inset 0 -1px 0 var(--p-surface-border);
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
  font-size: var(--app-fs-sm);
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
