<template>
  <div class="dhcp-page" style="display: flex; flex-direction: column; height: 100%;">
    <TabView>
      <!-- Scopes Tab -->
      <TabPanel header="Scopes">

        <DataTable :value="store.scopes" :loading="store.loading" stripedRows
                   emptyMessage="No DHCP scopes configured." size="small"
                   :paginator="store.scopes.length > 256" :rows="256"
                   :rowsPerPageOptions="[64, 128, 256, 512]"
                   scrollable scrollHeight="flex">
          <Column header="Network" style="min-width: 10rem">
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
          <Column header="Options" style="min-width: 12rem">
            <template #body="{ data }">
              <span v-if="data.options && data.options.length > 0" class="option-tags-compact">
                <span v-for="opt in data.options" :key="opt.option_code" class="option-tag-compact"
                      :title="opt.value">{{ optionLabel(opt.option_code) }}</span>
              </span>
              <span v-else class="muted">—</span>
            </template>
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
                   emptyMessage="No DHCP reservations." size="small"
                   :paginator="store.reservations.length > 256" :rows="256"
                   :rowsPerPageOptions="[64, 128, 256, 512]"
                   scrollable scrollHeight="flex">
          <Column field="mac_address" header="MAC Address" sortable style="min-width: 10rem">
            <template #body="{ data }"><code>{{ data.mac_address }}</code></template>
          </Column>
          <Column field="ip_address" header="IP Address" sortable style="min-width: 8rem" />
          <Column field="hostname" header="Hostname" sortable style="min-width: 8rem">
            <template #body="{ data }">{{ data.hostname || '—' }}</template>
          </Column>
          <Column header="Network" style="min-width: 8rem">
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

      <!-- Option Defaults Tab -->
      <TabPanel header="Option Defaults">
        <div class="section-header">
          <Button label="Add Custom Option" icon="pi pi-plus" size="small" severity="secondary"
                  @click="customOptionForm = { code: null, label: '', name: '', type: 'text', description: '' }; showCustomOptionDialog = true" />
          <Button label="Save Defaults" icon="pi pi-save" size="small" @click="saveDefaults" :loading="savingDefaults" />
        </div>
        <DataTable :value="optionDefaultRows" size="small" :loading="loadingOptions"
                   emptyMessage="No DHCP options available."
                   rowGroupMode="subheader" groupRowsBy="_group"
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
                         :placeholder="data.code === 1 ? 'Defaults to network\'s mask' : data.code === 3 ? 'Defaults to network\'s gateway' : placeholderForType(data.type)" />
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
      </TabPanel>

      <!-- Leases Tab -->
      <TabPanel header="Leases">
        <div class="section-header">
          <Button label="Sync Now" icon="pi pi-sync" size="small" severity="secondary"
                  @click="doSyncLeases" :loading="syncing" />
        </div>

        <DataTable :value="store.leases" stripedRows
                   emptyMessage="No active DHCP leases." size="small"
                   :paginator="store.leases.length > 256" :rows="256"
                   :rowsPerPageOptions="[64, 128, 256, 512]"
                   scrollable scrollHeight="flex">
          <Column field="ip_address" header="IP Address" sortable style="min-width: 8rem" />
          <Column field="mac_address" header="MAC Address" sortable style="min-width: 10rem">
            <template #body="{ data }"><code>{{ data.mac_address }}</code></template>
          </Column>
          <Column field="hostname" header="Hostname" sortable style="min-width: 8rem">
            <template #body="{ data }">{{ data.hostname || '—' }}</template>
          </Column>
          <Column header="Network" style="min-width: 8rem">
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
            modal :style="{ width: '36rem' }">
      <div class="form-grid">
        <div class="field" v-if="!editingScope">
          <label>DHCP Scope Range *</label>
          <Select v-model="scopeForm.range_id" :options="availableRanges" optionLabel="_label" optionValue="id"
                  class="w-full" placeholder="Select a DHCP Scope range" :loading="loadingRanges" />
          <small class="field-help">Only DHCP Scope ranges without existing scopes are shown</small>
        </div>
        <div class="field" v-if="editingScope">
          <label>Start IP</label>
          <InputText v-model="scopeForm.start_ip" class="w-full" placeholder="e.g. 192.168.1.10" />
        </div>
        <div class="field" v-if="editingScope">
          <label>End IP</label>
          <InputText v-model="scopeForm.end_ip" class="w-full" placeholder="e.g. 192.168.1.254" />
        </div>
        <div class="field">
          <label>Lease Time</label>
          <InputText v-model="scopeForm.lease_time" class="w-full" placeholder="e.g. 24h, 3600, 1d" />
          <small class="field-help">Duration: number with optional suffix (s/m/h/d)</small>
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

      <!-- Inline Options Section -->
      <div class="scope-options-section">
        <div class="scope-options-header" @click="scopeOptionsExpanded = !scopeOptionsExpanded">
          <i class="pi" :class="scopeOptionsExpanded ? 'pi-chevron-down' : 'pi-chevron-right'" style="font-size: 0.7rem"></i>
          <span class="scope-options-title">DHCP Options</span>
          <span class="scope-options-count" v-if="scopeForm.selectedOptions.length > 0">{{ scopeForm.selectedOptions.length }} selected</span>
        </div>
        <div v-if="scopeOptionsExpanded" class="scope-options-list">
          <template v-for="group in optionGroups" :key="group.name">
            <div class="scope-option-group-header">{{ group.label }}</div>
            <div v-for="opt in group.options" :key="opt.code" class="scope-option-row">
              <div class="scope-option-check">
                <input type="checkbox"
                       :checked="scopeForm.selectedOptions.includes(opt.code)"
                       @change="toggleScopeOption(opt.code, $event.target.checked)" />
              </div>
              <div class="scope-option-info">
                <span class="scope-option-label">{{ opt.label }}</span>
                <span class="scope-option-code">({{ opt.code }})</span>
                <i class="pi pi-question-circle scope-option-help" @click="showOptionHelp($event, opt)" />
              </div>
              <div class="scope-option-value">
                <template v-if="scopeForm.selectedOptions.includes(opt.code)">
                  <Select v-if="opt.type === 'select'" v-model="scopeForm.optionValues[opt.code]"
                          :options="opt.choices" size="small" :placeholder="defaultValues[opt.code] || '—'" showClear />
                  <InputNumber v-else-if="opt.type === 'number'" v-model="scopeForm.optionValues[opt.code]"
                               size="small" :useGrouping="false" :placeholder="defaultValues[opt.code] || '0'" />
                  <InputText v-else v-model="scopeForm.optionValues[opt.code]" size="small"
                             :placeholder="defaultValues[opt.code] || placeholderForType(opt.type)" />
                </template>
                <span v-else-if="defaultValues[opt.code]" class="scope-option-default">
                  default: {{ defaultValues[opt.code] }}
                </span>
              </div>
            </div>
          </template>
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
          <label>Network *</label>
          <Select v-model="reservationForm.subnet_id" :options="allocatedSubnets" optionLabel="_label" optionValue="id"
                  class="w-full" placeholder="Select network" />
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
      <p class="text-sm muted">The underlying DHCP Scope range will be kept.</p>
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

    <!-- Custom Option Dialog -->
    <Dialog v-model:visible="showCustomOptionDialog" header="Add Custom Option" modal :style="{ width: '26rem' }">
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

    <Toast />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useToast } from 'primevue/usetoast';
import TabView from 'primevue/tabview';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import Popover from 'primevue/popover';
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
const scopeForm = ref({ range_id: null, lease_time: '24h', description: '', enabled: true, selectedOptions: [], optionValues: {} });
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

// DHCP Options
const optionCatalog = ref([]);
const defaultValues = reactive({});
const loadingOptions = ref(false);
const savingDefaults = ref(false);
const scopeOptionsExpanded = ref(false);

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
  // Any group not in the order
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

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch { return iso; }
}

// DHCP Options functions
async function loadOptions() {
  loadingOptions.value = true;
  try {
    const res = await api.get('/dhcp/options');
    optionCatalog.value = res.data.catalog;
    if (res.data.groups) optionGroupOrder.value = res.data.groups;
    // Populate defaultValues reactive object
    Object.keys(defaultValues).forEach(k => delete defaultValues[k]);
    for (const [code, value] of Object.entries(res.data.defaults || {})) {
      defaultValues[Number(code)] = value;
    }
  } catch (err) {
    console.error('Failed to load DHCP options:', err);
  } finally {
    loadingOptions.value = false;
  }
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
    await api.put('/dhcp/options/defaults', { options });
    toast.add({ severity: 'success', summary: 'Defaults saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingDefaults.value = false;
  }
}

function optionLabel(code) {
  const opt = optionCatalog.value.find(o => o.code === code);
  return opt ? opt.label : `Option ${code}`;
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

function toggleScopeOption(code, checked) {
  if (checked) {
    if (!scopeForm.value.selectedOptions.includes(code)) {
      scopeForm.value.selectedOptions.push(code);
    }
    // Pre-fill from default if no value set
    if (scopeForm.value.optionValues[code] == null || scopeForm.value.optionValues[code] === '') {
      const def = defaultValues[code];
      if (def != null) scopeForm.value.optionValues[code] = def;
    }
  } else {
    scopeForm.value.selectedOptions = scopeForm.value.selectedOptions.filter(c => c !== code);
    delete scopeForm.value.optionValues[code];
  }
}

// When creating a new scope and user picks a range, auto-populate subnet mask (option 1) and gateway (option 3)
watch(() => scopeForm.value.range_id, (rangeId) => {
  if (!rangeId || editingScope.value) return;
  const range = availableRanges.value.find(r => r.id === rangeId);
  // Auto-populate subnet mask from the network's prefix length
  if (range?.subnet_cidr) {
    const prefix = parseInt(range.subnet_cidr.split('/')[1], 10);
    if (prefix >= 0 && prefix <= 32) {
      const maskLong = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
      const mask = [(maskLong >>> 24) & 255, (maskLong >>> 16) & 255, (maskLong >>> 8) & 255, maskLong & 255].join('.');
      if (!scopeForm.value.selectedOptions.includes(1)) {
        scopeForm.value.selectedOptions.push(1);
      }
      scopeForm.value.optionValues[1] = mask;
    }
  }
  // Auto-populate gateway
  if (range?.subnet_gateway) {
    if (!scopeForm.value.selectedOptions.includes(3)) {
      scopeForm.value.selectedOptions.push(3);
    }
    scopeForm.value.optionValues[3] = range.subnet_gateway;
  }
});

// Scope CRUD
async function openScopeDialog(scope = null) {
  editingScope.value = scope;
  if (scope) {
    // Build selectedOptions and optionValues from scope.options array
    const selOpts = [];
    const optVals = {};
    if (scope.options && Array.isArray(scope.options)) {
      for (const o of scope.options) {
        selOpts.push(o.option_code);
        optVals[o.option_code] = o.value;
      }
    }
    scopeForm.value = {
      range_id: scope.range_id,
      start_ip: scope.start_ip || '',
      end_ip: scope.end_ip || '',
      lease_time: scope.lease_time || '24h',
      description: scope.description || '',
      enabled: !!scope.enabled,
      selectedOptions: selOpts,
      optionValues: optVals
    };
  } else {
    // Auto-select all options that have defaults
    const autoSelected = [];
    const autoValues = {};
    for (const code of Object.keys(defaultValues)) {
      const c = Number(code);
      autoSelected.push(c);
      autoValues[c] = defaultValues[code];
    }
    scopeForm.value = { range_id: null, lease_time: '24h', description: '', enabled: true, selectedOptions: autoSelected, optionValues: autoValues };
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
  scopeOptionsExpanded.value = scopeForm.value.selectedOptions.length > 0;
  showScopeDialog.value = true;
}

async function saveScope() {
  savingScope.value = true;
  try {
    // Build options array from selectedOptions + optionValues
    const options = scopeForm.value.selectedOptions
      .filter(code => scopeForm.value.optionValues[code] != null && scopeForm.value.optionValues[code] !== '')
      .map(code => ({ code, value: String(scopeForm.value.optionValues[code]) }));

    const payload = {
      lease_time: scopeForm.value.lease_time,
      description: scopeForm.value.description || null,
      enabled: scopeForm.value.enabled,
      options
    };

    if (editingScope.value) {
      if (scopeForm.value.start_ip) payload.start_ip = scopeForm.value.start_ip;
      if (scopeForm.value.end_ip) payload.end_ip = scopeForm.value.end_ip;
      await store.updateScope(editingScope.value.id, payload);
      toast.add({ severity: 'success', summary: 'Scope updated', life: 3000 });
    } else {
      const range = availableRanges.value.find(r => r.id === scopeForm.value.range_id);
      await store.createScope({
        range_id: scopeForm.value.range_id,
        subnet_id: range?.subnet_id,
        ...payload
      });
      toast.add({ severity: 'success', summary: 'Scope created', life: 3000 });
    }
    showScopeDialog.value = false;
    window.dispatchEvent(new Event('ipam:stats-changed'));
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
    window.dispatchEvent(new Event('ipam:stats-changed'));
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
    // Re-check health 3 times over 6 seconds to update dnsmasq/DNS status
    for (let i = 0; i < 3; i++) {
      setTimeout(() => window.dispatchEvent(new Event('ipam:stats-changed')), (i + 1) * 2000);
    }
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
    store.fetchLeases(),
    loadOptions()
  ]);
});

defineExpose({ openScopeDialog, applyConfig });
</script>

<style scoped>
.dhcp-page :deep(.p-tabview) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.dhcp-page :deep(.p-tabview-panels) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dhcp-page :deep(.p-tabview-panel) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

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
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.action-buttons { display: flex; gap: 0.25rem; }

.badge-enabled { font-size: 0.75rem; color: var(--p-green-500); }
.badge-disabled { font-size: 0.75rem; color: var(--p-red-500); background: color-mix(in srgb, var(--p-red-500) 15%, transparent); padding: 0.1rem 0.4rem; border-radius: 3px; }

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

.options-summary label {
  display: block;
  margin-bottom: 0.35rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.option-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.option-tag {
  background: color-mix(in srgb, var(--p-primary-color) 20%, transparent);
  color: var(--p-primary-color);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
}
.option-tags-compact { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.option-tag-compact {
  background: var(--p-surface-ground);
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
  font-size: 0.7rem;
  cursor: default;
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

/* Help popover */
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
</style>
