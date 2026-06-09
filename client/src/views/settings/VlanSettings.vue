<!-- VLANs. Extracted from System.vue tab 1 (1:1) — table + add/edit/delete dialogs
     + its own row context menu. Loads on mount. -->
<template>
  <div class="content-card range-types-section">
    <div class="card-header">
      <h3>VLANs</h3>
      <Button label="Add VLAN" icon="pi pi-plus" size="small" data-track="sys-add-vlan" @click="openVlanDialog()" />
    </div>
    <DataTable :value="vlans" :loading="loadingVlans" stripedRows emptyMessage="No VLANs found." size="small"
               :paginator="vlans.length > 256" :rows="256"
               :rowsPerPageOptions="[64, 128, 256, 512]"
               @row-contextmenu="onVlanRightClick" contextMenu
               scrollable scrollHeight="flex">
      <Column field="vlan_id" header="VLAN ID" sortable style="width: 6rem" />
      <Column field="name" header="Name" sortable />
      <Column field="subnet_names" header="Network" sortable>
        <template #body="{ data }">{{ data.subnet_names || '—' }}</template>
      </Column>
    </DataTable>

    <ContextMenu ref="vlanContextMenuRef" :model="vlanContextMenuItems" />

    <!-- VLAN Dialog -->
    <Dialog v-model:visible="showVlanDialog" :header="editingVlan ? 'Edit VLAN' : 'Add VLAN'"
            modal :style="{ width: '28rem' }">
      <div class="form-grid">
        <div class="field" v-if="!editingVlan">
          <label>Network *</label>
          <Select v-model="vlanForm.subnet_id" :options="availableNetworks" optionLabel="label" optionValue="value"
                  placeholder="Select a network" class="w-full" filter />
        </div>
        <div class="field">
          <label>VLAN ID *</label>
          <InputNumber v-model="vlanForm.vlan_id" :min="1" :max="4094" :useGrouping="false" class="w-full"
                       @input="onVlanIdInput" />
        </div>
        <div class="field">
          <label>Name *</label>
          <InputText v-model="vlanForm.name" class="w-full" @input="vlanNameManual = true" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="closeVlanDialog" />
        <Button :label="editingVlan ? 'Save' : 'Create'" @click="saveVlan" :loading="savingVlan"
                :disabled="(!editingVlan && !vlanForm.subnet_id) || !vlanForm.vlan_id || !vlanForm.name" />
      </template>
    </Dialog>

    <!-- Delete VLAN Dialog -->
    <Dialog v-model:visible="showDeleteVlanDialog" header="Delete VLAN" modal :style="{ width: '24rem' }">
      <p>Delete VLAN <strong>{{ deletingVlan?.vlan_id }} — {{ deletingVlan?.name }}</strong>?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteVlanDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteVlan" :loading="savingVlan" />
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import InputNumber from 'primevue/inputnumber';
import InputText from 'primevue/inputtext';
import ContextMenu from 'primevue/contextmenu';
import { useToast } from 'primevue/usetoast';
import { useSubnetStore } from '../../stores/subnets.js';
import { apiError } from '../../utils/format.js';
import api from '../../api/client.js';

const store = useSubnetStore();
const toast = useToast();

const vlans = ref([]);
const loadingVlans = ref(false);
const savingVlan = ref(false);
const showVlanDialog = ref(false);
const showDeleteVlanDialog = ref(false);
const editingVlan = ref(null);
const deletingVlan = ref(null);
const vlanForm = ref({ vlan_id: null, name: '', subnet_id: null });
const vlanNameManual = ref(false);

const availableNetworks = computed(() => {
  const usedVlanIds = new Set(vlans.value.map(v => v.vlan_id));
  const result = [];
  function collect(subnets) {
    for (const s of subnets) {
      if (s.status === 'allocated' && !s.vlan_id && !usedVlanIds.has(s.vlan_id)) {
        result.push({ label: `${s.cidr} — ${s.name || s.cidr}`, value: s.id });
      }
      if (s.children) collect(s.children);
    }
  }
  for (const f of store.folders) {
    if (f.subnets) collect(f.subnets);
  }
  return result;
});

function onVlanIdInput(e) {
  const val = e.value;
  if (!vlanNameManual.value) {
    vlanForm.value.name = val ? `VLAN${val}` : '';
  }
}

async function loadVlans() {
  loadingVlans.value = true;
  try {
    const res = await api.get('/vlans');
    vlans.value = res.data;
  } finally { loadingVlans.value = false; }
}

function openVlanDialog() {
  editingVlan.value = null;
  vlanNameManual.value = false;
  vlanForm.value = { vlan_id: null, name: '', subnet_id: null };
  showVlanDialog.value = true;
}

function editVlan(vlan) {
  editingVlan.value = vlan;
  vlanNameManual.value = vlan.name !== `VLAN${vlan.vlan_id}`;
  vlanForm.value = { vlan_id: vlan.vlan_id, name: vlan.name };
  showVlanDialog.value = true;
}

function closeVlanDialog() {
  showVlanDialog.value = false;
  editingVlan.value = null;
  vlanForm.value = { vlan_id: null, name: '', subnet_id: null };
}

async function saveVlan() {
  savingVlan.value = true;
  const isEditing = !!editingVlan.value;
  try {
    if (isEditing) {
      await api.put(`/vlans/${editingVlan.value.id}`, { vlan_id: vlanForm.value.vlan_id, name: vlanForm.value.name });
      toast.add({ severity: 'success', summary: 'VLAN updated', life: 3000 });
    } else {
      await api.post('/vlans', vlanForm.value);
      toast.add({ severity: 'success', summary: 'VLAN created', life: 3000 });
    }
    closeVlanDialog();
    await loadVlans();
    if (!isEditing) await store.fetchTree();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally { savingVlan.value = false; }
}

function confirmDeleteVlan(vlan) {
  deletingVlan.value = vlan;
  showDeleteVlanDialog.value = true;
}

async function doDeleteVlan() {
  savingVlan.value = true;
  try {
    await api.delete(`/vlans/${deletingVlan.value.id}`);
    showDeleteVlanDialog.value = false;
    toast.add({ severity: 'success', summary: 'VLAN deleted', life: 3000 });
    await loadVlans();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally { savingVlan.value = false; }
}

const vlanContextMenuRef = ref();
const selectedVlan = ref(null);
const vlanContextMenuItems = computed(() => {
  const v = selectedVlan.value;
  if (!v) return [];
  return [
    { label: 'Edit VLAN', icon: 'pi pi-pencil', command: () => editVlan(v) },
    { label: 'Delete VLAN', icon: 'pi pi-trash', command: () => confirmDeleteVlan(v) }
  ];
});
function onVlanRightClick(event) {
  selectedVlan.value = event.data;
  vlanContextMenuRef.value.show(event.originalEvent);
}

onMounted(loadVlans);
</script>

<style scoped>
.content-card { padding: 1.25rem; background: var(--p-surface-card); border: 1px solid var(--p-surface-border); border-radius: 8px; }
.card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
.card-header h3 { margin: 0; font-size: var(--app-fs-lg); color: var(--p-text-color); }
.range-types-section { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.form-grid { display: flex; flex-direction: column; gap: 1rem; }
.field { margin-bottom: 1rem; }
.field label { display: block; margin-bottom: 0.4rem; font-size: var(--app-fs-sm); font-weight: 500; }
.w-full { width: 100%; }
</style>
