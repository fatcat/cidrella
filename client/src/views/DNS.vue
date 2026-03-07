<template>
  <div class="dns-page" style="display: flex; flex-direction: column; height: 100%;">
    <!-- Forwarders & Actions Row -->
    <div class="settings-row">
      <div class="forwarders-group">
        <label class="schedule-label">Forwarders:</label>
        <div class="forwarder-inputs">
          <div v-for="(srv, i) in forwarders" :key="i" class="forwarder-row">
            <InputText v-model="forwarders[i]" size="small" placeholder="e.g. 8.8.8.8" style="width: 10rem" />
            <Button icon="pi pi-times" severity="danger" text rounded size="small"
                    @click="forwarders.splice(i, 1)" v-if="forwarders.length > 1" />
          </div>
          <Button icon="pi pi-plus" severity="secondary" text rounded size="small"
                  @click="forwarders.push('')" title="Add forwarder" />
        </div>
      </div>
      <Button label="Save Forwarders" icon="pi pi-save" size="small" @click="saveForwarders" :loading="savingForwarders" />
    </div>

    <div class="dns-layout">
      <!-- Zone List -->
      <div class="zone-panel">
        <div class="panel-header">
          <h3>Zones</h3>
        </div>
        <div class="zone-list" v-if="!store.loading">
          <div v-for="zone in store.zones" :key="zone.id"
               class="zone-item" :class="{ active: selectedZone?.id === zone.id }"
               @click="selectZone(zone)">
            <div class="zone-info">
              <div class="zone-name">
                <i :class="zone.type === 'forward' ? 'pi pi-globe' : 'pi pi-replay'" />
                {{ zone.name }}
              </div>
              <div class="zone-meta">
                <span class="zone-type-badge" :class="zone.type">{{ zone.type }}</span>
                <span class="record-count">{{ zone.record_count }} records</span>
                <span v-if="!zone.enabled" class="badge-disabled">disabled</span>
              </div>
            </div>
            <div class="zone-actions">
              <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                      @click.stop="openZoneDialog(zone)" />
              <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                      @click.stop="confirmDeleteZone(zone)" />
            </div>
          </div>
          <div v-if="store.zones.length === 0" class="empty-state">
            No zones configured. Click "Add Zone" to get started.
          </div>
        </div>
        <div v-else class="loading-state">
          <i class="pi pi-spin pi-spinner" /> Loading zones...
        </div>
      </div>

      <!-- Records Panel -->
      <div class="records-panel">
        <template v-if="selectedZone">
          <div class="panel-header">
            <h3>{{ selectedZone.name }} — Records</h3>
            <Button label="Add Record" icon="pi pi-plus" size="small" @click="openRecordDialog()" />
          </div>

          <DataTable :value="records" :loading="loadingRecords" stripedRows
                     emptyMessage="No records in this zone." size="small"
                     :paginator="records.length > 256" :rows="256"
                     :rowsPerPageOptions="[64, 128, 256, 512]"
                     scrollable scrollHeight="flex">
            <Column field="name" header="Name" sortable style="min-width: 8rem" />
            <Column field="type" header="Type" sortable style="width: 5rem">
              <template #body="{ data }">
                <span class="type-badge">{{ data.type }}</span>
              </template>
            </Column>
            <Column field="value" header="Value" sortable style="min-width: 10rem" />
            <Column header="Priority" style="width: 5rem">
              <template #body="{ data }">{{ data.priority ?? '—' }}</template>
            </Column>
            <Column header="Port" style="width: 4rem">
              <template #body="{ data }">{{ data.port ?? '—' }}</template>
            </Column>
            <Column header="TTL" style="width: 4rem">
              <template #body="{ data }">{{ data.ttl ?? '—' }}</template>
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
                          @click="openRecordDialog(data)" />
                  <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                          @click="confirmDeleteRecord(data)" />
                </div>
              </template>
            </Column>
          </DataTable>
        </template>
        <div v-else class="empty-state centered">
          <i class="pi pi-arrow-left" style="font-size: 2rem; opacity: 0.3;" />
          <p>Select a zone to view its records</p>
        </div>

      </div>
    </div>

    <!-- Zone Dialog -->
    <Dialog v-model:visible="showZoneDialog" :header="editingZone ? 'Edit Zone' : 'Add Zone'"
            modal :style="{ width: '32rem' }">
      <div class="form-grid">
        <div class="field">
          <label>Zone Name *</label>
          <InputText v-model="zoneForm.name" class="w-full" placeholder="e.g. example.com" />
        </div>
        <div class="field" v-if="!editingZone">
          <label>Type *</label>
          <Select v-model="zoneForm.type" :options="zoneTypes" optionLabel="label" optionValue="value"
                    class="w-full" />
        </div>
        <div class="field">
          <label>Description</label>
          <InputText v-model="zoneForm.description" class="w-full" />
        </div>
        <div class="field" v-if="editingZone">
          <label>Enabled</label>
          <ToggleSwitch v-model="zoneForm.enabled" />
        </div>

        <!-- SOA Fields -->
        <div class="soa-section">
          <h4>SOA Record</h4>
          <div class="field">
            <label>Primary Nameserver</label>
            <InputText v-model="zoneForm.soa_primary_ns" class="w-full" placeholder="ns1.example.com" />
          </div>
          <div class="field">
            <label>Admin Email</label>
            <InputText v-model="zoneForm.soa_admin_email" class="w-full" placeholder="admin.example.com" />
            <small class="field-help">Use dotted notation (admin.example.com = admin@example.com)</small>
          </div>
          <div class="soa-grid">
            <div class="field">
              <label>Refresh (s)</label>
              <InputNumber v-model="zoneForm.soa_refresh" class="w-full" :min="0" />
            </div>
            <div class="field">
              <label>Retry (s)</label>
              <InputNumber v-model="zoneForm.soa_retry" class="w-full" :min="0" />
            </div>
            <div class="field">
              <label>Expire (s)</label>
              <InputNumber v-model="zoneForm.soa_expire" class="w-full" :min="0" />
            </div>
            <div class="field">
              <label>Minimum TTL (s)</label>
              <InputNumber v-model="zoneForm.soa_minimum_ttl" class="w-full" :min="0" />
            </div>
          </div>
          <div v-if="editingZone" class="field">
            <label>Serial</label>
            <span class="soa-serial">{{ editingZone.soa_serial || 1 }}</span>
            <small class="field-help">Auto-incremented on changes</small>
          </div>
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showZoneDialog = false" />
        <Button :label="editingZone ? 'Save' : 'Create'" @click="saveZone" :loading="savingZone" />
      </template>
    </Dialog>

    <!-- Record Dialog -->
    <Dialog v-model:visible="showRecordDialog" :header="editingRecord ? 'Edit Record' : 'Add Record'"
            modal :style="{ width: '28rem' }">
      <div class="form-grid">
        <div class="field">
          <label>{{ recordForm.type === 'PTR' ? 'IP Octet(s) *' : 'Name *' }}</label>
          <InputText v-model="recordForm.name" class="w-full"
                     :placeholder="recordForm.type === 'PTR' ? 'e.g. 10 (last octet)' : 'e.g. www or @'" />
          <small v-if="recordForm.type === 'PTR'" class="field-help">Reversed IP octets relative to zone (e.g. "10" for .10 in the network)</small>
        </div>
        <div class="field">
          <label>Type *</label>
          <Select v-model="recordForm.type" :options="availableRecordTypes" class="w-full" :disabled="!!editingRecord" />
        </div>
        <div class="field">
          <label>{{ recordForm.type === 'PTR' ? 'Hostname *' : 'Value *' }}</label>
          <InputText v-model="recordForm.value" class="w-full" :placeholder="valuePlaceholder" />
        </div>
        <div class="field" v-if="['MX', 'SRV'].includes(recordForm.type)">
          <label>Priority *</label>
          <InputNumber v-model="recordForm.priority" class="w-full" :min="0" :max="65535" />
        </div>
        <div class="field" v-if="recordForm.type === 'SRV'">
          <label>Weight</label>
          <InputNumber v-model="recordForm.weight" class="w-full" :min="0" :max="65535" />
        </div>
        <div class="field" v-if="recordForm.type === 'SRV'">
          <label>Port *</label>
          <InputNumber v-model="recordForm.port" class="w-full" :min="0" :max="65535" />
        </div>
        <div class="field">
          <label>TTL (seconds)</label>
          <InputNumber v-model="recordForm.ttl" class="w-full" :min="0" placeholder="Default" />
          <small class="field-help">Leave empty to use zone default</small>
        </div>
        <div class="field">
          <label>Enabled</label>
          <ToggleSwitch v-model="recordForm.enabled" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showRecordDialog = false" />
        <Button :label="editingRecord ? 'Save' : 'Create'" @click="saveRecord" :loading="savingRecord" />
      </template>
    </Dialog>

    <!-- Delete Zone Dialog -->
    <Dialog v-model:visible="showDeleteZoneDialog" header="Delete Zone" modal :style="{ width: '24rem' }">
      <p>Delete zone <strong>{{ deletingZone?.name }}</strong> and all its records?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteZoneDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteZone" :loading="savingZone" />
      </template>
    </Dialog>

    <!-- Delete Record Dialog -->
    <Dialog v-model:visible="showDeleteRecordDialog" header="Delete Record" modal :style="{ width: '24rem' }">
      <p>Delete {{ deletingRecord?.type }} record <strong>{{ deletingRecord?.name }}</strong>?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteRecordDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteRecord" :loading="savingRecord" />
      </template>
    </Dialog>

    <Toast />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import Toast from 'primevue/toast';
import { useDnsStore } from '../stores/dns.js';

const store = useDnsStore();
const toast = useToast();

// Zone state
const selectedZone = ref(null);
const records = ref([]);
const loadingRecords = ref(false);

// Zone dialog
const showZoneDialog = ref(false);
const editingZone = ref(null);
const savingZone = ref(false);
const zoneForm = ref({
  name: '', type: 'forward', description: '', enabled: true,
  soa_primary_ns: 'ns1.localhost', soa_admin_email: 'admin.localhost',
  soa_refresh: 3600, soa_retry: 900, soa_expire: 604800, soa_minimum_ttl: 86400
});
const zoneTypes = [
  { label: 'Forward', value: 'forward' },
  { label: 'Reverse', value: 'reverse' }
];

// Record dialog
const showRecordDialog = ref(false);
const editingRecord = ref(null);
const savingRecord = ref(false);
const recordForm = ref({ name: '', type: 'A', value: '', priority: null, weight: null, port: null, ttl: null, enabled: true });
const allRecordTypes = ['A', 'CNAME', 'MX', 'TXT', 'SRV', 'PTR'];
const availableRecordTypes = computed(() => {
  if (selectedZone.value?.type === 'reverse') return ['PTR'];
  return allRecordTypes;
});

// Delete dialogs
const showDeleteZoneDialog = ref(false);
const deletingZone = ref(null);
const showDeleteRecordDialog = ref(false);
const deletingRecord = ref(null);

// Forwarders
const forwarders = ref(['8.8.8.8', '1.1.1.1']);
const savingForwarders = ref(false);

const valuePlaceholder = computed(() => {
  switch (recordForm.value.type) {
    case 'A': return '192.168.1.10';
    case 'CNAME': return 'target.example.com';
    case 'MX': return 'mail.example.com';
    case 'TXT': return 'v=spf1 include:...';
    case 'SRV': return 'server.example.com';
    case 'PTR': return 'host.example.com';
    default: return '';
  }
});

async function selectZone(zone) {
  selectedZone.value = zone;
  loadingRecords.value = true;
  try {
    records.value = await store.getRecords(zone.id);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    loadingRecords.value = false;
  }
}

// Zone CRUD
function openZoneDialog(zone = null) {
  editingZone.value = zone;
  if (zone) {
    zoneForm.value = {
      name: zone.name, type: zone.type, description: zone.description || '', enabled: !!zone.enabled,
      soa_primary_ns: zone.soa_primary_ns || 'ns1.localhost',
      soa_admin_email: zone.soa_admin_email || 'admin.localhost',
      soa_refresh: zone.soa_refresh ?? 3600, soa_retry: zone.soa_retry ?? 900,
      soa_expire: zone.soa_expire ?? 604800, soa_minimum_ttl: zone.soa_minimum_ttl ?? 86400
    };
  } else {
    zoneForm.value = {
      name: '', type: 'forward', description: '', enabled: true,
      soa_primary_ns: 'ns1.localhost', soa_admin_email: 'admin.localhost',
      soa_refresh: 3600, soa_retry: 900, soa_expire: 604800, soa_minimum_ttl: 86400
    };
  }
  showZoneDialog.value = true;
}

async function saveZone() {
  savingZone.value = true;
  try {
    if (editingZone.value) {
      await store.updateZone(editingZone.value.id, zoneForm.value);
      toast.add({ severity: 'success', summary: 'Zone updated', life: 3000 });
      if (selectedZone.value?.id === editingZone.value.id) {
        selectedZone.value = store.zones.find(z => z.id === editingZone.value.id) || null;
      }
    } else {
      const zone = await store.createZone(zoneForm.value);
      toast.add({ severity: 'success', summary: 'Zone created', life: 3000 });
      selectZone(store.zones.find(z => z.id === zone.id) || zone);
    }
    showZoneDialog.value = false;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingZone.value = false;
  }
}

function confirmDeleteZone(zone) {
  deletingZone.value = zone;
  showDeleteZoneDialog.value = true;
}

async function doDeleteZone() {
  savingZone.value = true;
  try {
    await store.deleteZone(deletingZone.value.id);
    if (selectedZone.value?.id === deletingZone.value.id) {
      selectedZone.value = null;
      records.value = [];
    }
    showDeleteZoneDialog.value = false;
    toast.add({ severity: 'success', summary: 'Zone deleted', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingZone.value = false;
  }
}

// Record CRUD
function openRecordDialog(record = null) {
  editingRecord.value = record;
  if (record) {
    recordForm.value = {
      name: record.name, type: record.type, value: record.value,
      priority: record.priority, weight: record.weight, port: record.port,
      ttl: record.ttl, enabled: !!record.enabled
    };
  } else {
    const defaultType = selectedZone.value?.type === 'reverse' ? 'PTR' : 'A';
    recordForm.value = { name: '', type: defaultType, value: '', priority: null, weight: null, port: null, ttl: null, enabled: true };
  }
  showRecordDialog.value = true;
}

async function saveRecord() {
  savingRecord.value = true;
  try {
    if (editingRecord.value) {
      await store.updateRecord(selectedZone.value.id, editingRecord.value.id, recordForm.value);
      toast.add({ severity: 'success', summary: 'Record updated', life: 3000 });
    } else {
      await store.createRecord(selectedZone.value.id, recordForm.value);
      toast.add({ severity: 'success', summary: 'Record created', life: 3000 });
    }
    showRecordDialog.value = false;
    records.value = await store.getRecords(selectedZone.value.id);
    await store.fetchZones(); // refresh record counts
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingRecord.value = false;
  }
}

function confirmDeleteRecord(record) {
  deletingRecord.value = record;
  showDeleteRecordDialog.value = true;
}

async function doDeleteRecord() {
  savingRecord.value = true;
  try {
    await store.deleteRecord(selectedZone.value.id, deletingRecord.value.id);
    showDeleteRecordDialog.value = false;
    toast.add({ severity: 'success', summary: 'Record deleted', life: 3000 });
    records.value = await store.getRecords(selectedZone.value.id);
    await store.fetchZones();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingRecord.value = false;
  }
}

async function saveForwarders() {
  savingForwarders.value = true;
  try {
    const servers = forwarders.value.map(s => s.trim()).filter(Boolean);
    await store.updateForwarders(servers);
    forwarders.value = servers;
    toast.add({ severity: 'success', summary: 'Forwarders saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingForwarders.value = false;
  }
}

onMounted(async () => {
  await Promise.all([
    store.fetchZones(),
    store.getForwarders().then(s => forwarders.value = s).catch(() => {})
  ]);
});

defineExpose({ openZoneDialog });
</script>

<style scoped>
.settings-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}
.forwarders-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.forwarder-inputs {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.forwarder-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.schedule-label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

.dns-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 1.5rem;
  flex: 1;
  min-height: 0;
}

.zone-panel {
  background: var(--p-content-background);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  overflow: hidden;
  color: var(--p-text-color);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--p-surface-border);
  background: var(--p-surface-ground);
  color: var(--p-text-color);
}
.panel-header h3 { margin: 0; font-size: 0.9rem; color: var(--p-text-color); }

.zone-list { max-height: 500px; overflow-y: auto; }

.zone-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.6rem 1rem;
  cursor: pointer;
  border-bottom: 1px solid var(--p-surface-border);
  transition: background 0.15s;
}
.zone-item:hover { background: var(--p-highlight-background); }
.zone-item.active { background: var(--p-highlight-background); border-left: 3px solid var(--p-primary-color); }

.zone-info { flex: 1; min-width: 0; }
.zone-name {
  font-weight: 600;
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--p-text-color);
}
.zone-meta { display: flex; gap: 0.4rem; margin-top: 0.2rem; align-items: center; }

.zone-type-badge {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 600;
}
.zone-type-badge.forward { background: color-mix(in srgb, var(--p-blue-500) 20%, transparent); color: var(--p-blue-500); }
.zone-type-badge.reverse { background: color-mix(in srgb, var(--p-orange-500) 20%, transparent); color: var(--p-orange-500); }

.record-count { font-size: 0.75rem; color: var(--p-surface-500); }

.zone-actions { display: flex; gap: 0.15rem; flex-shrink: 0; }

.records-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.type-badge {
  font-size: 0.75rem;
  font-weight: 600;
  background: var(--p-surface-ground);
  color: var(--p-text-color);
  padding: 0.15rem 0.4rem;
  border-radius: 3px;
  font-family: monospace;
}

.badge-enabled { font-size: 0.75rem; color: var(--p-green-500); }
.badge-disabled { font-size: 0.75rem; color: var(--p-red-500); background: color-mix(in srgb, var(--p-red-500) 15%, transparent); padding: 0.1rem 0.4rem; border-radius: 3px; }

.action-buttons { display: flex; gap: 0.25rem; }

.empty-state {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--p-surface-400);
  font-size: 0.9rem;
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
  gap: 1.25rem;
}
.field label {
  display: block;
  margin-bottom: 0.35rem;
  font-size: 0.85rem;
  font-weight: 600;
}

.soa-section {
  border-top: 1px solid var(--p-surface-border);
  padding-top: 0.75rem;
  margin-top: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.soa-section h4 {
  margin: 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
}
.soa-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
}
.soa-serial {
  font-family: monospace;
  font-weight: 600;
  font-size: 0.9rem;
}
.field-help {
  display: block;
  margin-top: 0.4rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

@media (max-width: 900px) {
  .dns-layout {
    grid-template-columns: 1fr;
  }
}
</style>
