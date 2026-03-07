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

    <!-- Scope Dialog (shared component) -->
    <ScopeDialog ref="scopeDialogRef" @saved="onScopeSaved" />

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
import { ref, reactive, computed, onMounted } from 'vue';
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
import api from '../api/client.js';
import ScopeDialog from '../components/ScopeDialog.vue';

const store = useDhcpStore();
const toast = useToast();

const applying = ref(false);
const syncing = ref(false);

// Scope dialog (shared component)
const scopeDialogRef = ref(null);
const savingScope = ref(false);

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
    // Populate defaultEnabled
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
  // Could be comma-separated mix of IPs and hostnames
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
    // Invalidate scope dialog's cached options so next open picks up new defaults
    scopeDialogRef.value?.reloadOptions();
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

// Scope dialog methods (delegated to shared ScopeDialog component)
async function openScopeDialog(scope = null) {
  if (scope) {
    scopeDialogRef.value.openEdit(scope);
  } else {
    scopeDialogRef.value.openNewWithPicker();
  }
}

async function onScopeSaved() {
  await store.fetchScopes();
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
