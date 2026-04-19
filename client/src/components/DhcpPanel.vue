<template>
  <div class="dhcp-panel" style="display: flex; flex-direction: column; height: 100%;">
    <div class="dhcp-layout">
      <!-- Scopes Sidebar -->
      <div class="scope-panel">
        <Tabs v-model:value="scopeTab">
          <TabList>
            <Tab value="scopes" data-track="dhcp-tab-scopes"><i class="pi pi-server" style="margin-right: 0.3rem" />Scopes</Tab>
          </TabList>
          <TabPanels>
            <TabPanel value="scopes">
              <div class="sidebar-search">
                <i class="pi pi-search search-icon"></i>
                <input type="text" v-model="scopeFilterText" placeholder="Filter scopes..." class="sidebar-filter" data-track="dhcp-sidebar-filter" />
              </div>
              <div class="scope-list" v-if="!store.loading">
                <div v-for="scope in filteredScopes" :key="scope.id"
                     class="scope-item"
                     :class="{ active: selectedScope?.id === scope.id }"
                     @click="selectScope(scope)">
                  <div class="scope-info">
                    <div class="scope-name">
                      <i class="pi pi-server" />
                      {{ scope.subnet_name || scope.subnet_cidr }}
                    </div>
                    <div class="scope-meta">
                      <span class="scope-range">{{ scope.start_ip }} — {{ scope.end_ip }}</span>
                      <span v-if="!scope.enabled" class="badge-sm badge-red-light">disabled</span>
                    </div>
                  </div>
                  <div class="scope-actions">
                    <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                            @click.stop="openScopeDialog(scope)" />
                    <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                            @click.stop="confirmDeleteScope(scope)" />
                  </div>
                </div>
                <div v-if="filteredScopes.length === 0" class="empty-state">
                  No DHCP scopes configured.
                </div>
              </div>
              <div v-else class="loading-state">
                <i class="pi pi-spin pi-spinner" /> Loading scopes...
              </div>
            </TabPanel>
          </TabPanels>
        </Tabs>
      </div>

      <!-- Leases Panel -->
      <div class="leases-panel">
        <div class="dhcp-toolbar">
          <Button label="Add Scope" icon="pi pi-plus" size="small" text data-track="dhcp-add-scope" @click="openScopeDialog()" />
          <span class="toolbar-divider"></span>
          <Button label="Add Reservation" icon="pi pi-plus" size="small" text data-track="dhcp-add-reservation" @click="openReservationDialog()" />
          <span class="toolbar-divider"></span>
          <Button label="Sync Now" icon="pi pi-sync" size="small" text data-track="dhcp-sync-leases" @click="doSyncLeases" :loading="syncing" />
        </div>

        <!-- Scope info bar — only shown when a scope is selected -->
        <template v-if="selectedScope">
          <div class="info-bar">
            <span class="info-bar-name">{{ selectedScope.subnet_name || selectedScope.subnet_cidr }}</span>
            <span class="info-bar-sep"></span>
            <span class="info-bar-pair"><span class="info-bar-label">Range</span> <span class="info-bar-val">{{ selectedScope.start_ip }} — {{ selectedScope.end_ip }}</span></span>
            <span class="info-bar-sep"></span>
            <span class="info-bar-pair"><span class="info-bar-label">Lease</span> <span class="info-bar-val">{{ scopeLeaseTime }}</span></span>
            <span class="info-bar-sep"></span>
            <span v-if="scopeGateway" class="info-bar-pair"><span class="info-bar-label">Gateway</span> <span class="info-bar-val">{{ scopeGateway }}</span></span>
            <span v-if="scopeGateway" class="info-bar-sep"></span>
            <span v-if="selectedScope.domain_name || selectedScope.subnet_domain_name" class="info-bar-pair"><span class="info-bar-label">Domain</span> <span class="info-bar-val">{{ selectedScope.domain_name || selectedScope.subnet_domain_name }}</span></span>
            <span v-if="selectedScope.domain_name || selectedScope.subnet_domain_name" class="info-bar-sep"></span>
            <span class="info-bar-pair"><span class="info-bar-label">Status</span> <span class="info-bar-val">{{ selectedScope.enabled ? 'enabled' : 'disabled' }}</span></span>
          </div>
        </template>

        <!-- All-leases header — only shown when no scope is selected and leases exist -->
        <template v-else-if="filteredLeases.length > 0">
          <div class="panel-header">
            <h3>All Leases</h3>
          </div>
        </template>

        <!-- Search bar and shared leases table (scope-filtered or all-leases) -->
        <template v-if="selectedScope || filteredLeases.length > 0">
          <div v-if="selectedScope" class="search-bar">
            <IconField>
              <InputIcon class="pi pi-search" />
              <InputText v-model="dhcpSearch" placeholder="Search by IP, MAC, hostname…" size="small" class="search-input" />
            </IconField>
            <Button v-if="dhcpSearch" icon="pi pi-times" severity="secondary" text rounded size="small" @click="dhcpSearch = ''" />
          </div>
          <div v-else class="search-bar">
            <IconField>
              <InputIcon class="pi pi-search" />
              <InputText v-model="dhcpAllSearch" placeholder="Search by IP, MAC, hostname…" size="small" class="search-input" />
            </IconField>
            <Button v-if="dhcpAllSearch" icon="pi pi-times" severity="secondary" text rounded size="small" @click="dhcpAllSearch = ''" />
          </div>

          <DataTable :value="selectedScope ? searchedScopeLeases : searchedAllLeases"
                     :loading="loadingLeases" stripedRows
                     :emptyMessage="selectedScope ? 'No leases or reservations for this scope.' : 'No DHCP leases or reservations.'"
                     size="small" scrollable scrollHeight="flex"
                     paginator :rows="100" paginatorPosition="bottom"
                     :rowsPerPageOptions="[50, 100, 250, 500]"
                     removableSort :nullSortOrder="0"
                     @row-contextmenu="onLeaseRightClick" contextMenu>
            <Column field="ip_address" header="IP Address" sortable style="min-width: 8rem" />
            <Column field="is_online" header="Online" sortable style="width: 5rem">
              <template #body="{ data }">
                <span v-if="data.is_online != null" class="status-text" :class="data.is_online ? 'state-ok' : 'state-muted'">{{ data.is_online ? 'Online' : 'Offline' }}</span>
                <span v-else class="cell-muted">—</span>
              </template>
            </Column>
            <Column header="Lease" sortable field="status" style="width: 6rem">
              <template #body="{ data }">
                <span class="status-text" :class="data.status === 'active' ? 'state-ok' : 'state-muted'">{{ data.status === 'active' ? 'Active' : 'Inactive' }}</span>
              </template>
            </Column>
            <Column header="Type" sortable field="type" style="width: 7rem">
              <template #body="{ data }">
                <span v-if="data.type === 'reserved'" class="taxonomy-tag">Reservation</span>
                <span v-else class="cell-muted">Dynamic</span>
              </template>
            </Column>
            <Column field="hostname" header="Hostname" sortable style="min-width: 8rem">
              <template #body="{ data }">{{ displayHostname(data.hostname, selectedScope ? selectedScope.subnet_domain_name : data.subnet_domain_name) }}</template>
            </Column>
            <Column field="mac_address" header="MAC Address" sortable style="min-width: 10rem">
              <template #body="{ data }"><code>{{ data.mac_address }}</code></template>
            </Column>
            <Column field="vendor" header="Vendor" sortable style="min-width: 8rem">
              <template #body="{ data }">{{ data.vendor || '—' }}</template>
            </Column>
            <Column v-if="!selectedScope" header="Network" style="min-width: 8rem">
              <template #body="{ data }">{{ data.subnet_name || data.subnet_cidr || '—' }}</template>
            </Column>
            <Column header="Expires" sortable field="expires_at" style="min-width: 9rem">
              <template #body="{ data }">
                <template v-if="data.type === 'reserved'">never</template>
                <template v-else>{{ data.expires_at === 'infinite' ? 'Never' : formatDate(data.expires_at) }}</template>
              </template>
            </Column>
          </DataTable>
        </template>

        <EmptyState v-else-if="store.scopes.length === 0"
          icon="pi-server"
          title="No DHCP scopes yet"
          description="Add a scope to start handing out leases on a subnet."
          :actions="[
            { label: 'Add Scope', icon: 'pi-plus', severity: 'primary', dataTrack: 'empty-add-scope', onClick: () => openScopeDialog() }
          ]" />
        <div v-else class="empty-state centered">
          <i class="pi pi-server" style="font-size: 2rem; opacity: 0.3"></i>
          <span>Select a scope to view leases</span>
        </div>
      </div>
    </div>

    <!-- Scope Dialog (shared component) -->
    <ScopeDialog ref="scopeDialogRef" @saved="onScopeSaved" />

    <!-- Reservation Dialog -->
    <Dialog v-model:visible="showReservationDialog" :header="editingReservation ? 'Edit Reservation' : 'Add Reservation'" data-track="dialog-dhcp-reservation"
            modal :style="{ width: '28rem' }">
      <div class="form-grid">
        <div class="field" v-if="!editingReservation">
          <label>Network *</label>
          <Select v-model="reservationForm.subnet_id" :options="allocatedSubnets" optionLabel="_label" optionValue="id"
                  class="w-full" placeholder="Select network" />
        </div>
        <div class="field">
          <label>MAC Address *</label>
          <InputText :modelValue="reservationForm.mac_address"
                     @keydown="onMacKeydown"
                     @paste="onMacPaste"
                     @input="onMacInput"
                     class="w-full" placeholder="AA:BB:CC:DD:EE:FF"
                     maxlength="17" autocomplete="off" />
        </div>
        <div class="field">
          <label>IP Address *</label>
          <InputText v-model="reservationForm.ip_address" class="w-full" placeholder="192.168.1.100" />
        </div>
        <div class="field">
          <label>Hostname</label>
          <InputText v-model="reservationForm.hostname" class="w-full" placeholder="mydevice" />
        </div>
        <div class="field">
          <label>Description</label>
          <InputText v-model="reservationForm.description" class="w-full" />
        </div>
        <div class="field" v-if="editingReservation">
          <label>Enabled</label>
          <ToggleSwitch v-model="reservationForm.enabled" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showReservationDialog = false" />
        <Button :label="editingReservation ? 'Save' : 'Create'" @click="saveReservation" :loading="savingReservation" />
      </template>
    </Dialog>

    <!-- Delete Scope Dialog -->
    <Dialog v-model:visible="showDeleteScopeDialog" header="Delete Scope" modal :style="{ width: '24rem' }" data-track="dialog-dhcp-delete-scope">
      <p>Delete DHCP scope for <strong>{{ deletingScope?.subnet_cidr }}</strong>?</p>
      <p class="text-sm muted">The underlying DHCP Scope range will be kept.</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteScopeDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteScope" :loading="savingScope" />
      </template>
    </Dialog>

    <!-- Delete Reservation Dialog -->
    <Dialog v-model:visible="showDeleteReservationDialog" header="Delete Reservation" modal :style="{ width: '24rem' }" data-track="dialog-dhcp-delete-reservation">
      <p>Delete reservation for <strong>{{ deletingReservation?.mac_address }}</strong> → {{ deletingReservation?.ip_address }}?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteReservationDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteReservation" :loading="savingReservation" />
      </template>
    </Dialog>

    <!-- Lease Context Menu -->
    <ContextMenu ref="leaseContextMenuRef" :model="leaseContextMenuItems" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
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
import ToggleSwitch from 'primevue/toggleswitch';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import { useDhcpStore } from '../stores/dhcp.js';
import EmptyState from './EmptyState.vue';
import api from '../api/client.js';
import { apiError, displayHostname as _displayHostname } from '../utils/format.js';
import { loadJson } from '../utils/storage.js';
import ScopeDialog from './ScopeDialog.vue';

// No props needed — shows all scopes globally

const store = useDhcpStore();
const toast = useToast();

const scopeTab = ref('scopes');
const scopeFilterText = ref('');
const selectedScope = ref(null);
const syncing = ref(false);
const loadingLeases = ref(false);

// Scope dialog
const scopeDialogRef = ref(null);
const savingScope = ref(false);

// Reservation dialog
const showReservationDialog = ref(false);
const editingReservation = ref(null);
const savingReservation = ref(false);
const reservationForm = ref({ subnet_id: null, mac_address: '', ip_address: '', hostname: '', description: '', enabled: true });
const allocatedSubnets = ref([]);

// ── MAC Address input sanitization ──
// Hex-only characters, colons auto-inserted every 2 hex chars, max 17 chars
// (XX:XX:XX:XX:XX:XX). Invalid keystrokes are rejected + toast warn.
const MAC_HEX_RE = /[0-9a-fA-F]/;
const MAC_ALLOWED_RE = /^[0-9a-fA-F:]*$/;

function formatMacFromHex(hex) {
  // hex: only hex chars, no colons. Insert ':' every 2 chars up to 12.
  const clean = hex.slice(0, 12).toUpperCase();
  const pairs = [];
  for (let i = 0; i < clean.length; i += 2) pairs.push(clean.slice(i, i + 2));
  return pairs.join(':');
}

let _macInvalidToastTs = 0;
function warnInvalidMac() {
  // Debounce the toast — users holding a key shouldn't get flooded.
  const now = Date.now();
  if (now - _macInvalidToastTs < 1500) return;
  _macInvalidToastTs = now;
  toast.add({ severity: 'warn', summary: 'Invalid character for a MAC address', life: 2000 });
}

function onMacKeydown(event) {
  // Allow nav / editing keys
  const nav = ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
               'Home', 'End', 'Tab', 'Enter', 'Escape'];
  if (nav.includes(event.key)) return;
  if (event.ctrlKey || event.metaKey) return; // Cut/Copy/Paste/Select-All
  // Printable keys: must be hex or colon
  if (event.key.length === 1 && !MAC_HEX_RE.test(event.key) && event.key !== ':') {
    event.preventDefault();
    warnInvalidMac();
  }
}

function onMacPaste(event) {
  const txt = (event.clipboardData || window.clipboardData)?.getData('text') || '';
  if (!MAC_ALLOWED_RE.test(txt)) {
    event.preventDefault();
    warnInvalidMac();
    return;
  }
  // Let the default paste happen, then onMacInput will re-format it.
}

function onMacInput(event) {
  const raw = event.target.value;
  // Strip anything non-hex-non-colon (catches any path that slipped through),
  // then reformat colons deterministically.
  const hexOnly = raw.replace(/[^0-9a-fA-F]/g, '');
  const formatted = formatMacFromHex(hexOnly);
  if (formatted !== raw) {
    // Re-display the normalized form. Keep cursor at end of the field — most
    // natural for sequential typing.
    event.target.value = formatted;
  }
  reservationForm.value.mac_address = formatted;
}

const dhcpSearch = ref(loadJson('cidrella_dhcp_search', ''));
const dhcpAllSearch = ref(loadJson('cidrella_dhcp_all_search', ''));
watch(dhcpSearch, (val) => { try { localStorage.setItem('cidrella_dhcp_search', JSON.stringify(val)); } catch {} });
watch(dhcpAllSearch, (val) => { try { localStorage.setItem('cidrella_dhcp_all_search', JSON.stringify(val)); } catch {} });

// Lease context menu
const leaseContextMenuRef = ref();
const selectedLease = ref(null);
const leaseContextMenuItems = computed(() => {
  const r = selectedLease.value;
  if (!r) return [];
  const items = [];
  if (r.type === 'reserved') {
    items.push(
      { label: 'Edit Reservation', icon: 'pi pi-pencil', command: () => openReservationDialog(r) },
      { label: 'Delete Reservation', icon: 'pi pi-trash', command: () => confirmDeleteReservation(r) }
    );
  } else if (r.mac_address && r.ip_address) {
    items.push(
      { label: 'Convert to Reservation', icon: 'pi pi-lock', command: () => convertLeaseToReservation(r) }
    );
  }
  if (r.ip_address) {
    if (items.length) items.push({ separator: true });
    items.push({ label: 'Probe Now', icon: 'pi pi-wifi', command: () => probeIp(r) });
  }
  return items;
});

async function probeIp(lease) {
  const ip = lease.ip_address;
  toast.add({ severity: 'info', summary: 'Probing...', detail: `Sending probe to ${ip}`, life: 2000 });
  try {
    const res = await api.post('/scans/probe', { ip, subnet_id: lease.subnet_id });
    const r = res.data;
    if (r.responded) {
      toast.add({
        severity: 'success',
        summary: `${ip} is Online`,
        detail: `Method: ${r.method.toUpperCase()}${r.mac ? ` · MAC: ${r.mac}` : ''}`,
        life: 5000
      });
    } else {
      toast.add({
        severity: 'warn',
        summary: `${ip} is Offline`,
        detail: `No response via ${r.method.toUpperCase()}`,
        life: 5000
      });
    }
    // Refetch leases so the Online badge updates
    await store.fetchLeases();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Probe Failed', detail: apiError(err), life: 5000 });
  }
}
function onLeaseRightClick(event) {
  selectedLease.value = event.data;
  if (leaseContextMenuItems.value.length) {
    leaseContextMenuRef.value.show(event.originalEvent);
  }
}

function dhcpMatchSearch(item, query) {
  return (item.ip_address && item.ip_address.toLowerCase().includes(query)) ||
    (item.mac_address && item.mac_address.toLowerCase().includes(query)) ||
    (item.hostname && item.hostname.toLowerCase().includes(query)) ||
    (item.vendor && item.vendor.toLowerCase().includes(query)) ||
    (item.type && item.type.toLowerCase().includes(query)) ||
    (item.status && item.status.toLowerCase().includes(query));
}

const searchedScopeLeases = computed(() => {
  const q = dhcpSearch.value.trim().toLowerCase();
  if (!q) return scopeLeases.value;
  return scopeLeases.value.filter(r => dhcpMatchSearch(r, q));
});

const searchedAllLeases = computed(() => {
  const q = dhcpAllSearch.value.trim().toLowerCase();
  if (!q) return filteredLeases.value;
  return filteredLeases.value.filter(r => dhcpMatchSearch(r, q));
});

function displayHostname(hostname, domainName) {
  return _displayHostname(hostname, domainName) || '—';
}

// Delete dialogs
const showDeleteScopeDialog = ref(false);
const deletingScope = ref(null);
const showDeleteReservationDialog = ref(false);
const deletingReservation = ref(null);

// All scopes and leases
const filteredScopes = computed(() => {
  const q = scopeFilterText.value.trim().toLowerCase();
  if (!q) return store.scopes;
  return store.scopes.filter(s =>
    (s.subnet_name && s.subnet_name.toLowerCase().includes(q)) ||
    (s.subnet_cidr && s.subnet_cidr.toLowerCase().includes(q)) ||
    (s.start_ip && s.start_ip.includes(q)) ||
    (s.end_ip && s.end_ip.includes(q))
  );
});

const filteredLeases = computed(() => store.leases.map(l => ({ ...l, hostname: l.hostname || ' ' })));

const scopeGateway = computed(() => {
  const s = selectedScope.value;
  if (!s) return null;
  // Check scope options first (option 3), then legacy column, then subnet fallback
  const opt3 = s.options?.find(o => o.option_code === 3);
  if (opt3?.value) return opt3.value;
  return s.gateway || s.subnet_gateway || null;
});

const scopeLeaseTime = computed(() => {
  const s = selectedScope.value;
  if (!s) return null;
  // Option 51 overrides the scope's lease_time column
  const opt51 = s.options?.find(o => o.option_code === 51);
  if (opt51?.value) return `${opt51.value}s`;
  return s.lease_time || null;
});

// Filter leases for selected scope
const scopeLeases = computed(() => {
  if (!selectedScope.value) return [];
  return store.leases.filter(l => l.subnet_id === selectedScope.value.subnet_id).map(l => ({ ...l, hostname: l.hostname || ' ' }));
});


function selectScope(scope) {
  selectedScope.value = scope;
  try { localStorage.setItem('cidrella_dhcp_selected_scope_id', JSON.stringify(scope?.id || null)); } catch {}
}

const formatDate = formatDateTime;

// Scope dialog methods
async function openScopeDialog(scope = null) {
  if (scope) {
    // Ensure the header reflects this scope while editing
    selectedScope.value = scope;
    scopeDialogRef.value.openEdit(scope);
  } else {
    scopeDialogRef.value.openNewWithPicker();
  }
}

async function onScopeSaved() {
  await store.fetchScopes();
  // Re-select if the scope was updated
  if (selectedScope.value) {
    const fresh = store.scopes.find(s => s.id === selectedScope.value.id);
    if (fresh) selectedScope.value = fresh;
  }
}

function confirmDeleteScope(scope) {
  deletingScope.value = scope;
  showDeleteScopeDialog.value = true;
}

async function doDeleteScope() {
  savingScope.value = true;
  try {
    await store.deleteScope(deletingScope.value.id);
    showDeleteScopeDialog.value = false;
    if (selectedScope.value?.id === deletingScope.value.id) {
      selectedScope.value = null;
    }
    toast.add({ severity: 'success', summary: 'Scope deleted', life: 3000 });
    window.dispatchEvent(new Event('ipam:stats-changed'));
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingScope.value = false;
  }
}

function convertLeaseToReservation(lease) {
  editingReservation.value = null;
  reservationForm.value = {
    subnet_id: lease.subnet_id,
    mac_address: lease.mac_address,
    ip_address: lease.ip_address,
    hostname: lease.hostname || '',
    description: '',
    enabled: true
  };
  showReservationDialog.value = true;
}

// Reservation CRUD
async function openReservationDialog(reservation = null) {
  editingReservation.value = reservation;
  if (reservation) {
    reservationForm.value = {
      subnet_id: reservation.subnet_id,
      mac_address: reservation.mac_address,
      ip_address: reservation.ip_address,
      hostname: reservation.hostname || '',
      description: reservation.description || '',
      enabled: reservation.enabled !== undefined ? !!reservation.enabled : true
    };
  } else {
    reservationForm.value = { subnet_id: selectedScope.value?.subnet_id || null, mac_address: '', ip_address: '', hostname: '', description: '', enabled: true };
    try {
      const res = await api.get('/subnets');
      const flattenTree = (nodes) => {
        let result = [];
        for (const n of nodes) {
          if (n.status === 'allocated') {
            result.push({ ...n, _label: `${n.name} (${n.cidr})` });
          }
          if (n.children?.length) result.push(...flattenTree(n.children));
        }
        return result;
      };
      const allSubnets = (res.data.folders || []).flatMap(f => f.subnets || []);
      allocatedSubnets.value = flattenTree(allSubnets);
    } catch { /* ignore */ }
  }
  showReservationDialog.value = true;
}

async function saveReservation() {
  savingReservation.value = true;
  try {
    const payload = {
      mac_address: reservationForm.value.mac_address,
      ip_address: reservationForm.value.ip_address,
      hostname: reservationForm.value.hostname || null,
      description: reservationForm.value.description || null,
      enabled: reservationForm.value.enabled
    };

    if (editingReservation.value) {
      const resId = editingReservation.value.reservation_id || editingReservation.value.id;
      await store.updateReservation(resId, payload);
      toast.add({ severity: 'success', summary: 'Reservation updated', life: 3000 });
    } else {
      await store.createReservation({
        subnet_id: reservationForm.value.subnet_id,
        ...payload
      });
      toast.add({ severity: 'success', summary: 'Reservation created', life: 3000 });
    }
    showReservationDialog.value = false;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingReservation.value = false;
  }
}

function confirmDeleteReservation(reservation) {
  deletingReservation.value = reservation;
  showDeleteReservationDialog.value = true;
}

async function doDeleteReservation() {
  savingReservation.value = true;
  try {
    const resId = deletingReservation.value.reservation_id || deletingReservation.value.id;
    await store.deleteReservation(resId);
    showDeleteReservationDialog.value = false;
    toast.add({ severity: 'success', summary: 'Reservation deleted', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingReservation.value = false;
  }
}

// Lease sync
async function doSyncLeases() {
  syncing.value = true;
  try {
    const result = await store.syncLeases();
    toast.add({ severity: 'success', summary: 'Leases synced', detail: `${result.synced} leases`, life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    syncing.value = false;
  }
}

onMounted(async () => {
  await Promise.all([
    store.fetchScopes(),
    store.fetchLeases()
  ]);
  // Restore previously selected scope, or auto-select first
  const savedScopeId = loadJson('cidrella_dhcp_selected_scope_id', null);
  if (savedScopeId) {
    const scope = filteredScopes.value.find(s => s.id === savedScopeId);
    if (scope) {
      selectedScope.value = scope;
      return;
    }
  }
  if (filteredScopes.value.length > 0 && !selectedScope.value) {
    selectedScope.value = filteredScopes.value[0];
  }
});

defineExpose({ openScopeDialog });
</script>

<style scoped>
.dhcp-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  grid-template-rows: 1fr;
  gap: 1.5rem;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── Scope Sidebar ── */
.scope-panel {
  background: var(--p-content-background);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  overflow: hidden;
  color: var(--p-text-color);
}
.scope-panel :deep(.p-tabpanels) {
  padding: 0;
}
.scope-panel :deep(.p-tablist) {
  background: var(--p-surface-ground);
}

.sidebar-search {
  display: flex;
  align-items: center;
  padding: 0 0.6rem;
  border-bottom: 1px solid var(--p-surface-border);
  gap: 0.4rem;
  height: 2.4rem;
  box-sizing: border-box;
  flex-shrink: 0;
}
.search-icon {
  font-size: var(--app-fs-sm);
  color: var(--p-text-muted-color);
}
.sidebar-filter {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--p-text-color);
  font-size: var(--app-fs-sm);
  outline: none;
}
.sidebar-filter::placeholder {
  color: var(--p-text-muted-color);
}

.scope-list {
  overflow-y: auto;
}

.scope-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 1rem;
  cursor: pointer;
  border-bottom: 1px solid var(--p-surface-border);
  border-left: 3px solid transparent;
  transition: background 0.15s;
}
.scope-item:hover {
  background: var(--p-highlight-background);
}
.scope-item.active {
  background: var(--p-highlight-background);
  border-left-color: var(--p-primary-color);
}

.scope-info {
  flex: 1;
  min-width: 0;
}
.scope-name {
  font-weight: 600;
  font-size: var(--app-fs-md);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--p-text-color);
  font-family: monospace;
}
.scope-meta {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.2rem;
  align-items: center;
}
.scope-range {
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
  font-family: monospace;
}
.scope-actions {
  display: flex;
  gap: 0.15rem;
  flex-shrink: 0;
}

/* ── Leases Panel ── */
.leases-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.leases-panel > :deep(.p-datatable) {
  flex: 1;
  min-height: 0;
}

.dhcp-toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--p-surface-border);
  flex-shrink: 0;
}
.dhcp-toolbar .toolbar-divider {
  width: 1px;
  height: 1.2rem;
  background: var(--p-surface-border);
}

.panel-header {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--p-surface-border);
}
.panel-header h3 {
  margin: 0;
  font-size: var(--app-fs-md);
  font-weight: 600;
}

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
.info-bar-name { font-weight: 700; font-size: var(--app-fs-md); color: var(--p-primary-color); font-family: monospace; white-space: nowrap; }
.info-bar-sep { width: 1px; height: 1rem; background: var(--p-surface-border); flex-shrink: 0; }
.info-bar-pair { display: flex; align-items: baseline; gap: 4px; white-space: nowrap; }
.info-bar-label { font-size: var(--app-fs-xs); text-transform: uppercase; color: var(--p-text-muted-color); letter-spacing: 0.08em; }
.info-bar-val { font-size: var(--app-fs-sm); font-weight: 600; font-family: monospace; }

.type-badge {
  font-size: var(--app-fs-xs);
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
  letter-spacing: 0.02em;
}
.badge-reserved { background: color-mix(in srgb, var(--p-primary-color) 15%, transparent); color: var(--p-primary-color); }
.badge-dynamic { background: color-mix(in srgb, var(--p-surface-500) 15%, transparent); color: var(--p-text-color); }

.search-bar { display: flex; align-items: center; gap: 0.25rem; padding: 0.4rem 0; flex-shrink: 0; }
.search-input { width: 22rem; }

.text-sm { font-size: var(--app-fs-sm); }
.muted { color: var(--p-text-muted-color); }

code {
  font-family: monospace;
  font-size: var(--app-fs-sm);
}

.empty-state {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--p-surface-400);
  font-size: var(--app-fs-base);
}
.empty-state.centered {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 4rem 2rem;
}
.loading-state {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--p-surface-400);
}

.form-grid {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.field label {
  display: block;
  margin-bottom: 0.4rem;
  font-size: var(--app-fs-sm);
  font-weight: 500;
}

@media (max-width: 900px) {
  .dhcp-layout {
    grid-template-columns: 1fr;
  }
}
</style>
