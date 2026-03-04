<template>
  <div class="dns-page">
    <div class="page-header">
      <h2>DNS Management</h2>
      <div class="header-actions">
        <Button label="Apply Config" icon="pi pi-refresh" severity="secondary" @click="applyConfig" :loading="applying" />
        <Button label="Add Zone" icon="pi pi-plus" @click="openZoneDialog()" />
      </div>
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
                     emptyMessage="No records in this zone." size="small">
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
            modal :style="{ width: '28rem' }">
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
          <label>Name *</label>
          <InputText v-model="recordForm.name" class="w-full" placeholder="e.g. www or @" />
        </div>
        <div class="field">
          <label>Type *</label>
          <Select v-model="recordForm.type" :options="recordTypes" class="w-full" :disabled="!!editingRecord" />
        </div>
        <div class="field">
          <label>Value *</label>
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
const zoneForm = ref({ name: '', type: 'forward', description: '', enabled: true });
const zoneTypes = [
  { label: 'Forward', value: 'forward' },
  { label: 'Reverse', value: 'reverse' }
];

// Record dialog
const showRecordDialog = ref(false);
const editingRecord = ref(null);
const savingRecord = ref(false);
const recordForm = ref({ name: '', type: 'A', value: '', priority: null, weight: null, port: null, enabled: true });
const recordTypes = ['A', 'CNAME', 'MX', 'TXT', 'SRV'];

// Delete dialogs
const showDeleteZoneDialog = ref(false);
const deletingZone = ref(null);
const showDeleteRecordDialog = ref(false);
const deletingRecord = ref(null);

const applying = ref(false);

const valuePlaceholder = computed(() => {
  switch (recordForm.value.type) {
    case 'A': return '192.168.1.10';
    case 'CNAME': return 'target.example.com';
    case 'MX': return 'mail.example.com';
    case 'TXT': return 'v=spf1 include:...';
    case 'SRV': return 'server.example.com';
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
    zoneForm.value = { name: zone.name, type: zone.type, description: zone.description || '', enabled: !!zone.enabled };
  } else {
    zoneForm.value = { name: '', type: 'forward', description: '', enabled: true };
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
      enabled: !!record.enabled
    };
  } else {
    recordForm.value = { name: '', type: 'A', value: '', priority: null, weight: null, port: null, enabled: true };
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

async function applyConfig() {
  applying.value = true;
  try {
    const result = await store.applyConfig();
    toast.add({ severity: 'success', summary: 'Config applied', detail: `${result.zones} zones, ${result.records} records`, life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    applying.value = false;
  }
}

onMounted(async () => {
  await store.fetchZones();
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

.dns-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 1.5rem;
  align-items: start;
}

.zone-panel {
  background: var(--p-content-background);
  border: 1px solid var(--p-surface-200);
  border-radius: 8px;
  overflow: hidden;
  color: var(--p-text-color);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--p-surface-200);
  background: var(--p-surface-100);
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
  border-bottom: 1px solid var(--p-surface-100);
  transition: background 0.15s;
}
.zone-item:hover { background: var(--p-surface-50); }
.zone-item.active { background: var(--p-primary-50); border-left: 3px solid var(--p-primary-500); }

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
.zone-type-badge.forward { background: var(--p-blue-100); color: var(--p-blue-700); }
.zone-type-badge.reverse { background: var(--p-orange-100); color: var(--p-orange-700); }

.record-count { font-size: 0.75rem; color: var(--p-surface-500); }

.zone-actions { display: flex; gap: 0.15rem; flex-shrink: 0; }

.records-panel {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.type-badge {
  font-size: 0.75rem;
  font-weight: 600;
  background: var(--p-surface-100);
  color: var(--p-text-color);
  padding: 0.15rem 0.4rem;
  border-radius: 3px;
  font-family: monospace;
}

.badge-enabled { font-size: 0.75rem; color: var(--p-green-600); }
.badge-disabled { font-size: 0.75rem; color: var(--p-red-600); background: var(--p-red-50); padding: 0.1rem 0.4rem; border-radius: 3px; }

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
  gap: 1rem;
}
.field label {
  display: block;
  margin-bottom: 0.35rem;
  font-size: 0.85rem;
  font-weight: 600;
}

@media (max-width: 900px) {
  .dns-layout {
    grid-template-columns: 1fr;
  }
}
</style>
