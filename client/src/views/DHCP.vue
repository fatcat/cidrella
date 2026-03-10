<template>
  <div class="dhcp-page" style="display: flex; flex-direction: column; height: 100%;">
    <!-- Option Defaults -->
    <div class="section-header">
      <Button label="Add Custom Option" icon="pi pi-plus" size="small" severity="secondary"
              @click="customOptionForm = { code: null, label: '', name: '', type: 'text', description: '' }; showCustomOptionDialog = true" />
      <Button label="Apply Config" icon="pi pi-refresh" size="small" data-track="sys-apply-dhcp-config" @click="applyConfig" />
      <Button label="Save Defaults" icon="pi pi-save" size="small" data-track="dhcp-save-defaults" @click="saveDefaults" :loading="savingDefaults" />
    </div>
    <DataTable :value="optionDefaultRows" size="small" :loading="loadingOptions"
               emptyMessage="No DHCP options available."
               rowGroupMode="subheader" groupRowsBy="_group"
               :rowClass="(data) => defaultEnabled[data.code] ? 'option-enabled-row' : ''"
               scrollable scrollHeight="flex">
      <template #groupheader="{ data }">
        <strong>{{ data._group }}</strong>
      </template>
      <Column field="code" header="Code" style="width: 4rem" />
      <Column field="label" header="Option" style="min-width: 12rem">
        <template #body="{ data }">
          {{ data.label }}
          <i class="pi pi-question-circle option-help-icon" @click="showOptionHelp($event, data)" />
        </template>
      </Column>
      <Column field="type" header="Type" style="width: 6rem">
        <template #body="{ data }">
          <span class="text-sm muted">{{ data.type }}</span>
        </template>
      </Column>
      <Column header="Default Value" style="min-width: 14rem">
        <template #body="{ data }">
          <Select v-if="data.type === 'select'" v-model="defaultValues[data.code]"
                  :options="data.choices" class="w-full" size="small" showClear placeholder="—" />
          <InputNumber v-else-if="data.type === 'number'" v-model="defaultValues[data.code]"
                       class="w-full" size="small" :useGrouping="false" placeholder="—" />
          <InputText v-else v-model="defaultValues[data.code]" class="w-full" size="small"
                     :placeholder="data.code === 1 ? 'Defaults to network\'s mask' : data.code === 3 ? 'Defaults to network\'s gateway' : data.code === 15 ? 'Defaults to network\'s domain' : data.code === 119 ? 'Defaults to network\'s domain' : placeholderForType(data.type)"
                     @blur="data.type === 'ip-list' || data.type === 'ip' ? resolveDefaultHostname(data.code) : null" />
        </template>
      </Column>
      <Column header="Enabled by Default" style="width: 9rem; text-align: center">
        <template #body="{ data }">
          <input type="checkbox" :checked="!!defaultEnabled[data.code]"
                 @change="defaultEnabled[data.code] = $event.target.checked" />
        </template>
      </Column>
      <Column header="" style="width: 3rem">
        <template #body="{ data }">
          <div class="action-buttons">
            <Button icon="pi pi-times" severity="secondary" text rounded size="small"
                    @click="defaultValues[data.code] = null" title="Clear" />
            <Button v-if="data.custom" icon="pi pi-trash" severity="danger" text rounded size="small"
                    @click="deleteCustomOption(data.code)" title="Delete custom option" />
          </div>
        </template>
      </Column>
    </DataTable>

    <!-- Help Popover -->
    <Popover ref="helpPopoverRef">
      <div class="option-help-popover">
        <strong>{{ helpPopoverData.label }}</strong>
        <p>{{ helpPopoverData.description }}</p>
        <a v-if="helpPopoverData.rfcUrl" :href="helpPopoverData.rfcUrl" target="_blank" rel="noopener" class="rfc-link">
          {{ helpPopoverData.rfc }}
        </a>
      </div>
    </Popover>

    <!-- Custom Option Dialog -->
    <Dialog v-model:visible="showCustomOptionDialog" header="Add Custom Option" modal :style="{ width: '26rem' }" data-track="dialog-dhcp-custom-option">
      <div class="form-grid">
        <div class="field">
          <label>Option Code (128–254) *</label>
          <InputNumber v-model="customOptionForm.code" class="w-full" :min="128" :max="254" :useGrouping="false" placeholder="e.g. 200" />
        </div>
        <div class="field">
          <label>Label *</label>
          <InputText v-model="customOptionForm.label" class="w-full" placeholder="e.g. Vendor Config URL" />
        </div>
        <div class="field">
          <label>Type</label>
          <Select v-model="customOptionForm.type" :options="['ip', 'ip-list', 'text', 'text-list', 'number']" class="w-full" />
        </div>
        <div class="field">
          <label>Description</label>
          <InputText v-model="customOptionForm.description" class="w-full" placeholder="Brief explanation" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showCustomOptionDialog = false" />
        <Button label="Create" @click="createCustomOption" :loading="savingCustomOption"
                :disabled="!customOptionForm.code || !customOptionForm.label" />
      </template>
    </Dialog>

  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Select from 'primevue/select';
import Popover from 'primevue/popover';
import { useDhcpStore } from '../stores/dhcp.js';
import api from '../api/client.js';

const store = useDhcpStore();
const toast = useToast();

// DHCP Options
const optionCatalog = ref([]);
const defaultValues = reactive({});
const defaultEnabled = reactive({});
const loadingOptions = ref(false);
const savingDefaults = ref(false);
const optionGroupOrder = ref([]);

const optionGroups = computed(() => {
  const order = optionGroupOrder.value.map(g => g.name);
  const groups = {};
  for (const opt of optionCatalog.value) {
    const g = opt.group || 'Common';
    if (!groups[g]) groups[g] = [];
    groups[g].push(opt);
  }
  const result = [];
  for (const name of order) {
    if (groups[name]?.length) {
      const meta = optionGroupOrder.value.find(g => g.name === name);
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

const optionDefaultRows = computed(() => {
  const rows = [];
  for (const group of optionGroups.value) {
    for (const opt of group.options) {
      rows.push({ ...opt, _group: group.label });
    }
  }
  return rows;
});

// Help popover
const helpPopoverRef = ref(null);
const helpPopoverData = ref({ label: '', description: '', rfc: '', rfcUrl: '' });

function showOptionHelp(event, opt) {
  helpPopoverData.value = { label: opt.label, description: opt.description || '', rfc: opt.rfc || '', rfcUrl: opt.rfcUrl || '' };
  helpPopoverRef.value.toggle(event);
}

// Custom option dialog
const showCustomOptionDialog = ref(false);
const savingCustomOption = ref(false);
const customOptionForm = ref({ code: null, label: '', name: '', type: 'text', description: '' });

async function createCustomOption() {
  savingCustomOption.value = true;
  try {
    const f = customOptionForm.value;
    await api.post('/dhcp/options/custom', {
      code: f.code, label: f.label, name: f.name || `custom-${f.code}`, type: f.type, description: f.description
    });
    showCustomOptionDialog.value = false;
    toast.add({ severity: 'success', summary: 'Custom option created', life: 3000 });
    await loadOptions();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingCustomOption.value = false;
  }
}

async function deleteCustomOption(code) {
  try {
    await api.delete(`/dhcp/options/custom/${code}`);
    toast.add({ severity: 'success', summary: 'Custom option deleted', life: 3000 });
    await loadOptions();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  }
}

async function loadOptions() {
  loadingOptions.value = true;
  try {
    const res = await api.get('/dhcp/options');
    optionCatalog.value = res.data.catalog;
    if (res.data.groups) optionGroupOrder.value = res.data.groups;
    Object.keys(defaultValues).forEach(k => delete defaultValues[k]);
    for (const [code, value] of Object.entries(res.data.defaults || {})) {
      defaultValues[Number(code)] = value;
    }
    Object.keys(defaultEnabled).forEach(k => delete defaultEnabled[k]);
    for (const code of (res.data.enabledDefaults || [])) {
      defaultEnabled[Number(code)] = true;
    }
  } catch (err) {
    console.error('Failed to load DHCP options:', err);
  } finally {
    loadingOptions.value = false;
  }
}

const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

async function resolveHostname(value) {
  if (!value || IP_RE.test(value.trim())) return value;
  const parts = value.split(',').map(s => s.trim()).filter(Boolean);
  const resolved = [];
  for (const part of parts) {
    if (IP_RE.test(part)) {
      resolved.push(part);
    } else {
      try {
        const res = await api.get(`/dns/resolve?name=${encodeURIComponent(part)}`);
        resolved.push(...res.data.ips);
      } catch {
        toast.add({ severity: 'warn', summary: `Could not resolve "${part}"`, life: 3000 });
        resolved.push(part);
      }
    }
  }
  return resolved.join(',');
}

async function resolveDefaultHostname(code) {
  const val = defaultValues[code];
  if (!val) return;
  const resolved = await resolveHostname(val);
  if (resolved !== val) defaultValues[code] = resolved;
}

async function saveDefaults() {
  savingDefaults.value = true;
  try {
    const options = [];
    for (const opt of optionCatalog.value) {
      const val = defaultValues[opt.code];
      if (val != null && val !== '') {
        options.push({ code: opt.code, value: String(val) });
      }
    }
    const enabledDefaults = Object.keys(defaultEnabled).filter(k => defaultEnabled[k]).map(Number);
    await api.put('/dhcp/options/defaults', { options, enabledDefaults });
    toast.add({ severity: 'success', summary: 'Defaults saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingDefaults.value = false;
  }
}

function placeholderForType(type) {
  switch (type) {
    case 'ip': return 'e.g. 192.168.1.1';
    case 'ip-list': return 'e.g. 8.8.8.8, 1.1.1.1';
    case 'text': return 'Value';
    case 'text-list': return 'e.g. domain1.com, domain2.com';
    case 'number': return '0';
    default: return '';
  }
}

async function applyConfig() {
  try {
    const result = await store.applyConfig();
    toast.add({ severity: 'success', summary: 'Config applied', detail: `${result.scopes} scopes, ${result.reservations} reservations`, life: 3000 });
    for (let i = 0; i < 3; i++) {
      setTimeout(() => window.dispatchEvent(new Event('ipam:stats-changed')), (i + 1) * 2000);
    }
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  }
}

onMounted(async () => {
  await loadOptions();
});

</script>

<style scoped>
.section-header {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.action-buttons { display: flex; gap: 0.25rem; }

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

/* Defaults table help icon */
.option-help-icon {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
  cursor: pointer;
  margin-left: 0.3rem;
  vertical-align: middle;
}
.option-help-icon:hover {
  color: var(--p-primary-color);
}

/* Subtle highlight for enabled-by-default rows */
:deep(.option-enabled-row) {
  background: color-mix(in srgb, var(--p-primary-color) 6%, transparent) !important;
}
</style>
