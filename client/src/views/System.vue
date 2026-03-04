<template>
  <div class="system-page">
    <h2>System</h2>

    <TabView>
      <TabPanel header="Settings">
        <div v-if="loadingSettings" class="muted">Loading settings...</div>
        <div v-else class="settings-form">
          <div class="setting-group">
            <h3>Subnet Naming</h3>
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

          <div class="setting-group">
            <h3>Network Defaults</h3>
            <div class="field">
              <label>Default Gateway Position</label>
              <div class="radio-group">
                <label class="radio-label">
                  <input type="radio" v-model="settings.default_gateway_position" value="first" />
                  First usable IP
                </label>
                <label class="radio-label">
                  <input type="radio" v-model="settings.default_gateway_position" value="last" />
                  Last usable IP
                </label>
              </div>
            </div>
          </div>

          <div class="setting-group">
            <h3>DNS</h3>
            <div class="field">
              <label>Upstream Forwarders</label>
              <div class="forwarders-list">
                <div v-for="(server, idx) in forwarders" :key="idx" class="forwarder-row">
                  <InputText v-model="forwarders[idx]" placeholder="e.g. 8.8.8.8" style="flex: 1;" />
                  <Button icon="pi pi-times" severity="danger" text rounded size="small"
                          @click="forwarders.splice(idx, 1)" :disabled="forwarders.length <= 1" />
                </div>
                <Button label="Add Server" icon="pi pi-plus" severity="secondary" size="small" text
                        @click="forwarders.push('')" />
              </div>
              <small class="field-help">DNS servers used for upstream resolution (e.g., 8.8.8.8, 1.1.1.1)</small>
            </div>
          </div>

          <div class="settings-actions">
            <Button label="Save Settings" icon="pi pi-save" @click="saveSettings" :loading="savingSettings" />
          </div>
        </div>
      </TabPanel>
      <TabPanel header="Range Types">
        <div class="range-types-section">
          <div class="section-header">
            <Button label="Add Type" icon="pi pi-plus" size="small" @click="showRangeTypeDialog = true" />
          </div>
          <DataTable :value="rangeTypes" :loading="loadingRangeTypes" stripedRows emptyMessage="No range types found." size="small">
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
                <span :class="data.is_system ? 'badge-system' : 'badge-custom'">
                  {{ data.is_system ? 'System' : 'Custom' }}
                </span>
              </template>
            </Column>
            <Column header="" style="width: 5rem">
              <template #body="{ data }">
                <div class="action-buttons" v-if="!data.is_system">
                  <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                          @click="editRangeType(data)" />
                  <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                          @click="confirmDeleteRangeType(data)" />
                </div>
              </template>
            </Column>
          </DataTable>
        </div>

        <!-- Range Type Dialog -->
        <Dialog v-model:visible="showRangeTypeDialog" :header="editingRangeType ? 'Edit Range Type' : 'Add Range Type'"
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

        <!-- Delete Range Type Dialog -->
        <Dialog v-model:visible="showDeleteRangeTypeDialog" header="Delete Range Type" modal :style="{ width: '24rem' }">
          <p>Delete range type <strong>{{ deletingRangeType?.name }}</strong>?</p>
          <template #footer>
            <Button label="Cancel" severity="secondary" @click="showDeleteRangeTypeDialog = false" />
            <Button label="Delete" severity="danger" @click="doDeleteRangeType" :loading="savingRangeType" />
          </template>
        </Dialog>
      </TabPanel>
      <TabPanel header="Subnet Calculator">
        <SubnetCalculator />
      </TabPanel>
    </TabView>

    <Toast />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import TabView from 'primevue/tabview';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import Toast from 'primevue/toast';
import SubnetCalculator from './SubnetCalculator.vue';
import { useSubnetStore } from '../stores/subnets.js';
import { useDnsStore } from '../stores/dns.js';
import { applyNameTemplate } from '../utils/ip.js';

const store = useSubnetStore();
const dnsStore = useDnsStore();
const toast = useToast();

const loadingSettings = ref(true);
const savingSettings = ref(false);
const settings = ref({
  subnet_name_template: '%1.%2.%3.%4/%bitmask',
  default_gateway_position: 'first'
});
const forwarders = ref(['8.8.8.8', '1.1.1.1']);

const templatePreview = computed(() => {
  try {
    return applyNameTemplate(settings.value.subnet_name_template, '192.168.1.0/24');
  } catch { return ''; }
});

onMounted(async () => {
  try {
    const [data, servers] = await Promise.all([
      store.getSettings(),
      dnsStore.getForwarders().catch(() => ['8.8.8.8', '1.1.1.1']),
      loadRangeTypes()
    ]);
    settings.value = {
      subnet_name_template: data.subnet_name_template || '%1.%2.%3.%4/%bitmask',
      default_gateway_position: data.default_gateway_position || 'first'
    };
    forwarders.value = servers;
  } catch { /* use defaults */ }
  loadingSettings.value = false;
});

// Range Types
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
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { savingRangeType.value = false; }
}

async function saveSettings() {
  savingSettings.value = true;
  try {
    const validForwarders = forwarders.value.filter(s => s.trim());
    await Promise.all([
      store.updateSetting('subnet_name_template', settings.value.subnet_name_template),
      store.updateSetting('default_gateway_position', settings.value.default_gateway_position),
      validForwarders.length > 0 ? dnsStore.updateForwarders(validForwarders) : Promise.resolve()
    ]);
    if (validForwarders.length > 0) {
      forwarders.value = validForwarders;
    }
    toast.add({ severity: 'success', summary: 'Settings saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingSettings.value = false;
  }
}
</script>

<style scoped>
.system-page h2 {
  margin: 0 0 1.5rem 0;
}
.muted {
  color: var(--p-text-muted-color);
}
.settings-form {
  max-width: 32rem;
}
.setting-group {
  margin-bottom: 1.5rem;
}
.setting-group h3 {
  margin: 0 0 0.75rem 0;
  font-size: 1rem;
  color: var(--p-text-color);
}
.field {
  margin-bottom: 1rem;
}
.field label {
  display: block;
  margin-bottom: 0.35rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.field-help {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
.template-preview {
  margin-top: 0.5rem;
  padding: 0.4rem 0.75rem;
  background: var(--p-surface-ground);
  border: 1px solid var(--p-surface-border);
  border-radius: 4px;
  font-family: monospace;
  font-size: 0.85rem;
  color: var(--p-text-color);
}
.radio-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.radio-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.9rem;
}
.forwarders-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.forwarder-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.settings-actions {
  margin-top: 1rem;
}
.section-header {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0.75rem;
}
.color-swatch {
  display: inline-block;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid rgba(0,0,0,0.1);
}
.badge-system {
  font-size: 0.75rem;
  background: var(--p-surface-200);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}
.badge-custom {
  font-size: 0.75rem;
  background: var(--p-primary-100);
  color: var(--p-primary-700);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}
.action-buttons {
  display: flex;
  gap: 0.25rem;
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
</style>
