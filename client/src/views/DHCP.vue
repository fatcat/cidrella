<template>
  <div class="dhcp-page">
    <div class="page-header">
      <h2>DHCP Management</h2>
      <div class="header-actions">
        <Button label="Apply Config" icon="pi pi-refresh" severity="secondary" @click="applyConfig" :loading="applying" />
      </div>
    </div>

    <TabView>
      <!-- Scopes Tab -->
      <TabPanel header="Scopes">
        <div class="section-header">
          <Button label="Add Scope" icon="pi pi-plus" size="small" @click="openScopeDialog()" />
        </div>

        <DataTable :value="store.scopes" :loading="store.loading" stripedRows
                   emptyMessage="No DHCP scopes configured." size="small">
          <Column header="Subnet" style="min-width: 10rem">
            <template #body="{ data }">
              <div>
                <strong>{{ data.subnet_name }}</strong>
                <div class="text-sm muted">{{ data.subnet_cidr }}</div>
              </div>
            </template>
          </Column>
          <Column header="Range" style="min-width: 12rem">
            <template #body="{ data }">{{ data.start_ip }} — {{ data.end_ip }}</template>
          </Column>
          <Column field="lease_time" header="Lease Time" style="width: 7rem" />
          <Column header="Gateway" style="width: 8rem">
            <template #body="{ data }">{{ data.gateway || data.subnet_gateway || '—' }}</template>
          </Column>
          <Column header="DNS" style="width: 10rem">
            <template #body="{ data }">{{ formatDns(data.dns_servers) }}</template>
          </Column>
          <Column field="domain_name" header="Domain" style="width: 8rem">
            <template #body="{ data }">{{ data.domain_name || '—' }}</template>
          </Column>
          <Column header="Enabled" style="width: 5rem">
            <template #body="{ data }">
              <span :class="data.enabled ? 'badge-enabled' : 'badge-disabled'">
                {{ data.enabled ? 'Yes' : 'No' }}
              </span>
            </template>
          </Column>
          <Column header="" style="width: 5rem">
            <template #body="{ data }">
              <div class="action-buttons">
                <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                        @click="openScopeDialog(data)" />
                <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                        @click="confirmDeleteScope(data)" />
              </div>
            </template>
          </Column>
        </DataTable>
      </TabPanel>

      <!-- Reservations Tab -->
      <TabPanel header="Reservations">
        <div class="section-header">
          <Button label="Add Reservation" icon="pi pi-plus" size="small" @click="openReservationDialog()" />
        </div>

        <DataTable :value="store.reservations" stripedRows
                   emptyMessage="No DHCP reservations." size="small">
          <Column field="mac_address" header="MAC Address" sortable style="min-width: 10rem">
            <template #body="{ data }"><code>{{ data.mac_address }}</code></template>
          </Column>
          <Column field="ip_address" header="IP Address" sortable style="min-width: 8rem" />
          <Column field="hostname" header="Hostname" sortable style="min-width: 8rem">
            <template #body="{ data }">{{ data.hostname || '—' }}</template>
          </Column>
          <Column header="Subnet" style="min-width: 8rem">
            <template #body="{ data }">{{ data.subnet_name || data.subnet_cidr }}</template>
          </Column>
          <Column header="Enabled" style="width: 5rem">
            <template #body="{ data }">
              <span :class="data.enabled ? 'badge-enabled' : 'badge-disabled'">
                {{ data.enabled ? 'Yes' : 'No' }}
              </span>
            </template>
          </Column>
          <Column header="" style="width: 5rem">
            <template #body="{ data }">
              <div class="action-buttons">
                <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                        @click="openReservationDialog(data)" />
                <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                        @click="confirmDeleteReservation(data)" />
              </div>
            </template>
          </Column>
        </DataTable>
      </TabPanel>

      <!-- Leases Tab -->
      <TabPanel header="Leases">
        <div class="section-header">
          <Button label="Sync Now" icon="pi pi-sync" size="small" severity="secondary"
                  @click="doSyncLeases" :loading="syncing" />
        </div>

        <DataTable :value="store.leases" stripedRows
                   emptyMessage="No active DHCP leases." size="small">
          <Column field="ip_address" header="IP Address" sortable style="min-width: 8rem" />
          <Column field="mac_address" header="MAC Address" sortable style="min-width: 10rem">
            <template #body="{ data }"><code>{{ data.mac_address }}</code></template>
          </Column>
          <Column field="hostname" header="Hostname" sortable style="min-width: 8rem">
            <template #body="{ data }">{{ data.hostname || '—' }}</template>
          </Column>
          <Column header="Subnet" style="min-width: 8rem">
            <template #body="{ data }">{{ data.subnet_name || data.subnet_cidr || '—' }}</template>
          </Column>
          <Column header="Expires" sortable field="expires_at" style="min-width: 10rem">
            <template #body="{ data }">
              {{ data.expires_at === 'infinite' ? 'Never' : formatDate(data.expires_at) }}
            </template>
          </Column>
        </DataTable>
      </TabPanel>
    </TabView>

    <!-- Scope Dialog -->
    <Dialog v-model:visible="showScopeDialog" :header="editingScope ? 'Edit Scope' : 'Add Scope'"
            modal :style="{ width: '28rem' }">
      <div class="form-grid">
        <div class="field" v-if="!editingScope">
          <label>DHCP Pool Range *</label>
          <Select v-model="scopeForm.range_id" :options="availableRanges" optionLabel="_label" optionValue="id"
                  class="w-full" placeholder="Select a DHCP Pool range" :loading="loadingRanges" />
          <small class="field-help">Only DHCP Pool ranges without existing scopes are shown</small>
        </div>
        <div class="field">
          <label>Lease Time</label>
          <InputText v-model="scopeForm.lease_time" class="w-full" placeholder="e.g. 24h, 3600, 1d" />
          <small class="field-help">Duration: number with optional suffix (s/m/h/d)</small>
        </div>
        <div class="field">
          <label>Gateway</label>
          <InputText v-model="scopeForm.gateway" class="w-full" placeholder="Override subnet gateway" />
          <small class="field-help">Leave empty to use subnet's default gateway</small>
        </div>
        <div class="field">
          <label>DNS Servers</label>
          <InputText v-model="scopeForm.dns_servers_text" class="w-full" placeholder="e.g. 192.168.1.1, 8.8.8.8" />
          <small class="field-help">Comma-separated list of DNS server IPs</small>
        </div>
        <div class="field">
          <label>Domain Name</label>
          <InputText v-model="scopeForm.domain_name" class="w-full" placeholder="e.g. home.lan" />
        </div>
        <div class="field">
          <label>Description</label>
          <InputText v-model="scopeForm.description" class="w-full" />
        </div>
        <div class="field" v-if="editingScope">
          <label>Enabled</label>
          <ToggleSwitch v-model="scopeForm.enabled" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showScopeDialog = false" />
        <Button :label="editingScope ? 'Save' : 'Create'" @click="saveScope" :loading="savingScope" />
      </template>
    </Dialog>

    <!-- Reservation Dialog -->
    <Dialog v-model:visible="showReservationDialog" :header="editingReservation ? 'Edit Reservation' : 'Add Reservation'"
            modal :style="{ width: '28rem' }">
      <div class="form-grid">
        <div class="field" v-if="!editingReservation">
          <label>Subnet *</label>
          <Select v-model="reservationForm.subnet_id" :options="allocatedSubnets" optionLabel="_label" optionValue="id"
                  class="w-full" placeholder="Select subnet" />
        </div>
        <div class="field">
          <label>MAC Address *</label>
          <InputText v-model="reservationForm.mac_address" class="w-full" placeholder="AA:BB:CC:DD:EE:FF" />
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
    <Dialog v-model:visible="showDeleteScopeDialog" header="Delete Scope" modal :style="{ width: '24rem' }">
      <p>Delete DHCP scope for <strong>{{ deletingScope?.subnet_cidr }}</strong>?</p>
      <p class="text-sm muted">The underlying DHCP Pool range will be kept.</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteScopeDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteScope" :loading="savingScope" />
      </template>
    </Dialog>

    <!-- Delete Reservation Dialog -->
    <Dialog v-model:visible="showDeleteReservationDialog" header="Delete Reservation" modal :style="{ width: '24rem' }">
      <p>Delete reservation for <strong>{{ deletingReservation?.mac_address }}</strong> → {{ deletingReservation?.ip_address }}?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteReservationDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteReservation" :loading="savingReservation" />
      </template>
    </Dialog>

    <Toast />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import TabView from 'primevue/tabview';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import Toast from 'primevue/toast';
import { useDhcpStore } from '../stores/dhcp.js';
import { useSubnetStore } from '../stores/subnets.js';
import api from '../api/client.js';

const store = useDhcpStore();
const subnetStore = useSubnetStore();
const toast = useToast();

const applying = ref(false);
const syncing = ref(false);

// Scope dialog
const showScopeDialog = ref(false);
const editingScope = ref(null);
const savingScope = ref(false);
const scopeForm = ref({ range_id: null, lease_time: '24h', gateway: '', dns_servers_text: '', domain_name: '', description: '', enabled: true });
const availableRanges = ref([]);
const loadingRanges = ref(false);

// Reservation dialog
const showReservationDialog = ref(false);
const editingReservation = ref(null);
const savingReservation = ref(false);
const reservationForm = ref({ subnet_id: null, mac_address: '', ip_address: '', hostname: '', description: '', enabled: true });
const allocatedSubnets = ref([]);

// Delete dialogs
const showDeleteScopeDialog = ref(false);
const deletingScope = ref(null);
const showDeleteReservationDialog = ref(false);
const deletingReservation = ref(null);

function formatDns(jsonStr) {
  if (!jsonStr) return '—';
  try {
    const arr = JSON.parse(jsonStr);
    return arr.join(', ');
  } catch { return '—'; }
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch { return iso; }
}

// Scope CRUD
async function openScopeDialog(scope = null) {
  editingScope.value = scope;
  if (scope) {
    scopeForm.value = {
      range_id: scope.range_id,
      lease_time: scope.lease_time || '24h',
      gateway: scope.gateway || '',
      dns_servers_text: scope.dns_servers ? JSON.parse(scope.dns_servers).join(', ') : '',
      domain_name: scope.domain_name || '',
      description: scope.description || '',
      enabled: !!scope.enabled
    };
  } else {
    scopeForm.value = { range_id: null, lease_time: '24h', gateway: '', dns_servers_text: '', domain_name: '', description: '', enabled: true };
    loadingRanges.value = true;
    try {
      const ranges = await store.fetchAvailableRanges();
      availableRanges.value = ranges.map(r => ({
        ...r,
        _label: `${r.subnet_name} (${r.start_ip} — ${r.end_ip})`
      }));
    } finally {
      loadingRanges.value = false;
    }
  }
  showScopeDialog.value = true;
}

async function saveScope() {
  savingScope.value = true;
  try {
    const dns_servers = scopeForm.value.dns_servers_text.trim()
      ? JSON.stringify(scopeForm.value.dns_servers_text.split(',').map(s => s.trim()).filter(Boolean))
      : null;

    const payload = {
      lease_time: scopeForm.value.lease_time,
      gateway: scopeForm.value.gateway || null,
      dns_servers,
      domain_name: scopeForm.value.domain_name || null,
      description: scopeForm.value.description || null,
      enabled: scopeForm.value.enabled
    };

    if (editingScope.value) {
      await store.updateScope(editingScope.value.id, payload);
      toast.add({ severity: 'success', summary: 'Scope updated', life: 3000 });
    } else {
      // Find the range to get subnet_id
      const range = availableRanges.value.find(r => r.id === scopeForm.value.range_id);
      await store.createScope({
        range_id: scopeForm.value.range_id,
        subnet_id: range?.subnet_id,
        ...payload
      });
      toast.add({ severity: 'success', summary: 'Scope created', life: 3000 });
    }
    showScopeDialog.value = false;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingScope.value = false;
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
    toast.add({ severity: 'success', summary: 'Scope deleted', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingScope.value = false;
  }
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
      enabled: !!reservation.enabled
    };
  } else {
    reservationForm.value = { subnet_id: null, mac_address: '', ip_address: '', hostname: '', description: '', enabled: true };
    // Load allocated subnets
    try {
      const res = await api.get('/subnets');
      const flatten = (nodes) => {
        let result = [];
        for (const n of nodes) {
          if (n.status === 'allocated') {
            result.push({ ...n, _label: `${n.name} (${n.cidr})` });
          }
          if (n.children?.length) result.push(...flatten(n.children));
        }
        return result;
      };
      allocatedSubnets.value = flatten(res.data.tree || []);
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
      await store.updateReservation(editingReservation.value.id, payload);
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
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
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
    await store.deleteReservation(deletingReservation.value.id);
    showDeleteReservationDialog.value = false;
    toast.add({ severity: 'success', summary: 'Reservation deleted', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingReservation.value = false;
  }
}

// Leases
async function doSyncLeases() {
  syncing.value = true;
  try {
    const result = await store.syncLeases();
    toast.add({ severity: 'success', summary: 'Leases synced', detail: `${result.synced} leases`, life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    syncing.value = false;
  }
}

async function applyConfig() {
  applying.value = true;
  try {
    const result = await store.applyConfig();
    toast.add({ severity: 'success', summary: 'Config applied', detail: `${result.scopes} scopes, ${result.reservations} reservations`, life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    applying.value = false;
  }
}

onMounted(async () => {
  await Promise.all([
    store.fetchScopes(),
    store.fetchReservations(),
    store.fetchLeases()
  ]);
});
</script>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}
.page-header h2 { margin: 0; }
.header-actions { display: flex; gap: 0.5rem; }

.section-header {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0.75rem;
}

.action-buttons { display: flex; gap: 0.25rem; }

.badge-enabled { font-size: 0.75rem; color: var(--p-green-600); }
.badge-disabled { font-size: 0.75rem; color: var(--p-red-600); background: var(--p-red-50); padding: 0.1rem 0.4rem; border-radius: 3px; }

.text-sm { font-size: 0.8rem; }
.muted { color: var(--p-text-muted-color); }

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
.field-help {
  display: block;
  margin-top: 0.2rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

code {
  font-family: monospace;
  font-size: 0.85rem;
}
</style>
