<!-- Network settings. Extracted from System.vue tab 0 (1:1): naming-template
     settings, scan settings, and the Address Types / range-types table with
     its add/edit/delete dialogs + its own row context menu. Loads on mount. -->
<template>
  <div>
    <div v-if="loadingSettings" class="muted">Loading settings...</div>
    <template v-else>
      <div class="content-card settings-form">
        <h3>Network Naming</h3>
        <div class="field">
          <label>Name Template</label>
          <InputText v-model="settings.subnet_name_template" class="w-full" />
          <small class="field-help">
            Variables: %1, %2, %3, %4 (octets), %bitmask (prefix length)
          </small>
          <div v-if="templatePreview" class="template-preview">
            Preview: <strong>{{ templatePreview }}</strong>
          </div>
        </div>
      </div>

      <div class="content-card settings-form">
        <h3>Network Scanning</h3>
        <p class="field-help" style="margin-bottom: 0.75rem;">
          Configure automatic network scanning for allocated networks. Uses ARP probes for local subnets and ICMP ping for remote subnets.
        </p>
        <div class="field">
          <label>Enable Scanning by Default</label>
          <ToggleSwitch v-model="settings.default_scan_enabled" />
          <small class="field-help">Global default for liveness scanning. Individual subnets and hosts can override this.</small>
        </div>
        <div class="field">
          <label>Default Scan Interval</label>
          <Select v-model="settings.default_scan_interval" :options="scanIntervalOptions" optionLabel="label" optionValue="value"
                  class="w-full" style="max-width: 16rem;" />
          <small class="field-help">Applied to newly configured networks.</small>
        </div>
        <div class="field">
          <label>IP Lifecycle History Retention</label>
          <Select v-model="settings.ip_history_retention_days" :options="historyRetentionOptions" optionLabel="label" optionValue="value"
                  class="w-full" style="max-width: 16rem;" />
          <small class="field-help">How long to keep IP lifecycle events (online/offline, rogue, status changes). Events older than this are automatically purged.</small>
        </div>
        <hr style="border: none; border-top: 1px solid var(--p-surface-border); margin: 0.75rem 0;" />
        <div class="field">
          <label>On-Demand Scan</label>
          <div class="scan-row">
            <Select v-model="scanSubnetId" :options="allocatedSubnets" optionLabel="label" optionValue="value"
                    placeholder="Select network" class="w-full" style="max-width: 20rem;" />
            <Button label="Scan Now" icon="pi pi-search" size="small" @click="doStartScan"
                    :loading="startingScan" :disabled="!scanSubnetId" />
          </div>
          <small class="field-help">Probe all scannable IPs in the selected network.</small>
        </div>
        <div class="settings-actions">
          <Button label="Save Settings" icon="pi pi-save" @click="saveSettings" :loading="savingSettings" :disabled="!settingsDirty" />
        </div>
      </div>

      <div class="content-card">
        <div class="card-header">
          <h3>Address Types</h3>
          <Button label="Add Type" icon="pi pi-plus" size="small" text data-track="sys-add-range-type" @click="showRangeTypeDialog = true" />
        </div>
        <div class="range-types-section">
            <DataTable :value="rangeTypes" :loading="loadingRangeTypes" stripedRows size="small"
                       :paginator="rangeTypes.length > 256" :rows="256"
                       :rowsPerPageOptions="[64, 128, 256, 512]"
                       @row-contextmenu="onRangeTypeRightClick" contextMenu
                       scrollable scrollHeight="flex">
              <template #empty>
                <EmptyState icon="pi-tags" title="No address types" />
              </template>
              <Column header="Color" style="width: 4rem">
                <template #body="{ data }">
                  <span class="color-swatch" :style="{ background: data.color }"></span>
                </template>
              </Column>
              <Column field="name" header="Name" sortable />
              <Column field="description" header="Description">
                <template #body="{ data }">{{ data.description ?? '—' }}</template>
              </Column>
              <Column header="Type" style="width: 7rem">
                <template #body="{ data }">
                  <span :class="data.is_system ? 'badge badge-muted' : 'badge badge-primary'">
                    {{ data.is_system ? 'System' : 'Custom' }}
                  </span>
                </template>
              </Column>
            </DataTable>
        </div>
      </div>
    </template>

    <ContextMenu ref="rangeTypeContextMenuRef" :model="rangeTypeContextMenuItems" />

    <!-- Address Type Dialog -->
    <Dialog v-model:visible="showRangeTypeDialog" :header="editingRangeType ? 'Edit Address Type' : 'Add Address Type'"
            modal :style="{ width: '24rem' }">
      <div class="form-grid">
        <div class="field">
          <label>Name *</label>
          <InputText v-model="rangeTypeForm.name" class="w-full" />
        </div>
        <div class="field">
          <label>Color</label>
          <div class="color-picker-row">
            <input type="color" v-model="rangeTypeForm.color" />
            <InputText v-model="rangeTypeForm.color" style="width: 8rem; font-family: monospace;" />
          </div>
        </div>
        <div class="field">
          <label>Description</label>
          <InputText v-model="rangeTypeForm.description" class="w-full" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="closeRangeTypeDialog" />
        <Button :label="editingRangeType ? 'Save' : 'Create'" @click="saveRangeType" :loading="savingRangeType" />
      </template>
    </Dialog>

    <!-- Delete Address Type Dialog -->
    <Dialog v-model:visible="showDeleteRangeTypeDialog" header="Delete Address Type" modal :style="{ width: '24rem' }">
      <p>Delete address type <strong>{{ deletingRangeType?.name }}</strong>?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteRangeTypeDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteRangeType" :loading="savingRangeType" />
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import Button from 'primevue/button';
import EmptyState from '../../components/EmptyState.vue';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import InputText from 'primevue/inputtext';
import ToggleSwitch from 'primevue/toggleswitch';
import ContextMenu from 'primevue/contextmenu';
import { useToast } from 'primevue/usetoast';
import { useSubnetStore } from '../../stores/subnets.js';
import { applyNameTemplate } from '../../utils/ip.js';
import { apiError } from '../../utils/format.js';
import { collectAllocatedSubnets } from '../../utils/tree.js';
import api from '../../api/client.js';

const store = useSubnetStore();
const toast = useToast();

// Settings
const loadingSettings = ref(true);
const savingSettings = ref(false);
const settings = ref({
  subnet_name_template: '%1.%2.%3.%4/%bitmask',
  default_scan_interval: 'off',
  default_scan_enabled: true,
  ip_history_retention_days: '7'
});
const savedSettings = ref(null);

const settingsDirty = computed(() => {
  if (!savedSettings.value) return false;
  const s = savedSettings.value;
  const c = settings.value;
  return c.subnet_name_template !== s.subnet_name_template ||
    c.default_scan_interval !== s.default_scan_interval ||
    c.default_scan_enabled !== s.default_scan_enabled ||
    c.ip_history_retention_days !== s.ip_history_retention_days;
});
const scanIntervalOptions = [
  { label: 'Off', value: 'off' },
  { label: 'Every 5 minutes', value: '5m' },
  { label: 'Every 15 minutes', value: '15m' },
  { label: 'Every 30 minutes', value: '30m' },
  { label: 'Every 1 hour', value: '1h' },
  { label: 'Every 4 hours', value: '4h' },
];
const historyRetentionOptions = [
  { label: '3 days', value: '3' },
  { label: '7 days', value: '7' },
  { label: '10 days', value: '10' },
  { label: '14 days', value: '14' },
  { label: '21 days', value: '21' },
  { label: '30 days', value: '30' },
];

// On-demand scan
const scanSubnetId = ref(null);
const startingScan = ref(false);

const allocatedSubnets = computed(() => {
  const result = [];
  for (const f of store.folders) {
    if (!f.subnets) continue;
    for (const s of collectAllocatedSubnets(f.subnets)) {
      result.push({ label: `${s.cidr} — ${s.name}`, value: s.id });
    }
  }
  return result;
});

async function doStartScan() {
  if (!scanSubnetId.value) return;
  startingScan.value = true;
  try {
    await store.startScan(scanSubnetId.value);
    window.dispatchEvent(new Event('ipam:scan-started'));
    toast.add({ severity: 'success', summary: 'Scan started', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Scan Error', detail: apiError(err), life: 5000 });
  } finally {
    startingScan.value = false;
  }
}

const templatePreview = computed(() => {
  try {
    return applyNameTemplate(settings.value.subnet_name_template, '192.168.1.0/24');
  } catch { return ''; }
});

async function saveSettings() {
  savingSettings.value = true;
  try {
    await api.put('/settings/bulk', {
      settings: {
        subnet_name_template: settings.value.subnet_name_template,
        default_scan_interval: settings.value.default_scan_interval === 'off' ? '' : settings.value.default_scan_interval,
        default_scan_enabled: settings.value.default_scan_enabled ? '1' : '0',
        ip_history_retention_days: settings.value.ip_history_retention_days,
      }
    });
    savedSettings.value = { ...settings.value };
    toast.add({ severity: 'success', summary: 'Settings saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingSettings.value = false;
  }
}

// Address Types
const rangeTypes = ref([]);
const loadingRangeTypes = ref(false);
const savingRangeType = ref(false);
const showRangeTypeDialog = ref(false);
const showDeleteRangeTypeDialog = ref(false);
const editingRangeType = ref(null);
const deletingRangeType = ref(null);
const rangeTypeForm = ref({ name: '', color: '#6b7280', description: '' });

async function loadRangeTypes() {
  loadingRangeTypes.value = true;
  try { rangeTypes.value = await store.getRangeTypes(); }
  finally { loadingRangeTypes.value = false; }
}

function editRangeType(type) {
  editingRangeType.value = type;
  rangeTypeForm.value = { name: type.name, color: type.color, description: type.description || '' };
  showRangeTypeDialog.value = true;
}

function closeRangeTypeDialog() {
  showRangeTypeDialog.value = false;
  editingRangeType.value = null;
  rangeTypeForm.value = { name: '', color: '#6b7280', description: '' };
}

async function saveRangeType() {
  savingRangeType.value = true;
  try {
    if (editingRangeType.value) {
      await store.updateRangeType(editingRangeType.value.id, rangeTypeForm.value);
      toast.add({ severity: 'success', summary: 'Range type updated', life: 3000 });
    } else {
      await store.createRangeType(rangeTypeForm.value);
      toast.add({ severity: 'success', summary: 'Range type created', life: 3000 });
    }
    closeRangeTypeDialog();
    await loadRangeTypes();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally { savingRangeType.value = false; }
}

function confirmDeleteRangeType(type) {
  deletingRangeType.value = type;
  showDeleteRangeTypeDialog.value = true;
}

async function doDeleteRangeType() {
  savingRangeType.value = true;
  try {
    await store.deleteRangeType(deletingRangeType.value.id);
    showDeleteRangeTypeDialog.value = false;
    toast.add({ severity: 'success', summary: 'Range type deleted', life: 3000 });
    await loadRangeTypes();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally { savingRangeType.value = false; }
}

// Address Types context menu
const rangeTypeContextMenuRef = ref();
const selectedRangeType = ref(null);
const rangeTypeContextMenuItems = computed(() => {
  const r = selectedRangeType.value;
  if (!r || r.is_system) return [];
  return [
    { label: 'Edit Type', icon: 'pi pi-pencil', command: () => editRangeType(r) },
    { label: 'Delete Type', icon: 'pi pi-trash', command: () => confirmDeleteRangeType(r) }
  ];
});
function onRangeTypeRightClick(event) {
  selectedRangeType.value = event.data;
  if (rangeTypeContextMenuItems.value.length) {
    rangeTypeContextMenuRef.value.show(event.originalEvent);
  }
}

onMounted(async () => {
  try {
    const [data] = await Promise.all([
      store.getSettings(),
      loadRangeTypes(),
      store.folders.length === 0 ? store.fetchTree() : Promise.resolve()
    ]);
    const vals = {
      subnet_name_template: data.subnet_name_template || '%1.%2.%3.%4/%bitmask',
      default_scan_interval: data.default_scan_interval || 'off',
      default_scan_enabled: data.default_scan_enabled === '1' || data.default_scan_enabled === true,
      ip_history_retention_days: data.ip_history_retention_days || '7'
    };
    settings.value = { ...vals };
    savedSettings.value = { ...vals };
  } catch { /* use defaults */ }
  loadingSettings.value = false;
});
</script>

<style scoped>
.muted {
  color: var(--p-text-muted-color);
}
.content-card {
  margin: 0;
  padding: 1.25rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
}
.content-card h3 {
  margin: 0 0 0.75rem 0;
}
.card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
.card-header h3 { margin: 0; }
.content-card + .content-card {
  margin-top: 0.75rem;
}
.settings-form .field {
  max-width: 32rem;
}
.scan-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.field {
  margin-bottom: 1rem;
}
.field label {
  display: block;
  margin-bottom: 0.4rem;
  font-size: var(--app-fs-sm);
  font-weight: 500;
}
.field-help {
  display: block;
  margin-top: 0.25rem;
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
}
.template-preview {
  margin-top: 0.5rem;
  padding: 0.4rem 0.75rem;
  background: var(--p-surface-content);
  border: 1px solid var(--p-surface-border);
  border-radius: 4px;
  font-family: monospace;
  font-size: var(--app-fs-sm);
  color: var(--p-text-color);
}
.settings-actions {
  margin-top: 1rem;
  display: flex;
  justify-content: flex-end;
}
.color-swatch {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid var(--p-surface-border);
}
.form-grid {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.color-picker-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.color-picker-row input[type="color"] {
  width: 36px;
  height: 36px;
  border: none;
  padding: 0;
  cursor: pointer;
}
.range-types-section {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.w-full { width: 100%; }
</style>
