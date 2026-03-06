<template>
  <!-- Create/Edit Organization Dialog -->
  <Dialog v-model:visible="showFolderDialog" :header="editingFolder ? 'Edit Organization' : 'Create Organization'" modal :style="{ width: '26rem' }">
    <div class="form-grid">
      <div class="field">
        <label>Name *</label>
        <InputText v-model="folderForm.name" class="w-full" />
      </div>
      <div class="field">
        <label>Description</label>
        <InputText v-model="folderForm.description" class="w-full" />
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showFolderDialog = false" />
      <Button label="Save" @click="saveFolder" :loading="saving" />
    </template>
  </Dialog>

  <!-- Create Organization with Network Dialog -->
  <Dialog v-model:visible="showOrgDialog" header="Create Organization" modal :style="{ width: '28rem' }">
    <div class="form-grid">
      <div class="field">
        <label>Organization Name *</label>
        <InputText v-model="orgForm.name" class="w-full" />
      </div>
      <div class="field">
        <label>Description</label>
        <InputText v-model="orgForm.description" class="w-full" />
      </div>
      <div class="field">
        <label>Network CIDR *</label>
        <InputText v-model="orgForm.cidr" placeholder="e.g. 10.0.0.0/8" class="w-full" />
        <small v-if="orgValidationError" class="field-error">{{ orgValidationError }}</small>
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showOrgDialog = false" />
      <Button label="Create" @click="createOrg" :loading="saving" :disabled="!!orgValidationError || !orgForm.name || !orgForm.cidr" />
    </template>
  </Dialog>

  <!-- Delete Organization Dialog -->
  <Dialog v-model:visible="showDeleteFolderDialog" header="Delete Organization" modal :style="{ width: '24rem' }">
    <p>Delete organization <strong>{{ deletingFolder?.name }}</strong>?</p>
    <p class="warn-text" v-if="deletingFolder?.subnets?.length > 0">
      This organization contains {{ deletingFolder.subnets.length }} networks. Move or delete them first.
    </p>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showDeleteFolderDialog = false" />
      <Button label="Delete" severity="danger" @click="executeDeleteFolder" :loading="saving"
              :disabled="deletingFolder?.subnets?.length > 0" />
    </template>
  </Dialog>

  <!-- Create Network Dialog -->
  <Dialog v-model:visible="showSubnetDialog" header="Create Network" modal :style="{ width: '28rem' }">
    <div class="form-grid">
      <div class="field">
        <label>CIDR *</label>
        <InputText v-model="supernetForm.cidr" placeholder="10.0.0.0/8" class="w-full" />
        <small v-if="supernetValidationError" class="field-error">{{ supernetValidationError }}</small>
      </div>
      <div class="field">
        <label>Name</label>
        <InputText v-model="supernetForm.name" :placeholder="supernetAutoName || 'Optional — defaults to template'" class="w-full" />
      </div>
      <div class="field">
        <label>Organization</label>
        <div style="display: flex; gap: 0.5rem;">
          <Select v-model="supernetForm.folder_id" :options="folderOptions" optionLabel="name" optionValue="id"
                  placeholder="Select organization" class="w-full" />
          <Button icon="pi pi-plus" @click="quickCreateOrg" v-tooltip="'New Organization'" />
        </div>
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showSubnetDialog = false" />
      <Button label="Create" @click="createSupernet" :loading="saving" :disabled="!!supernetValidationError" />
    </template>
  </Dialog>

  <!-- Divide Network Dialog -->
  <Dialog v-model:visible="showDivide" header="Divide Network" modal :style="{ width: '36rem' }">
    <p>Network: <strong>{{ props.selectedNode?.data.cidr }}</strong></p>

    <div class="divide-mode-toggle">
      <SelectButton v-model="divideMode" :options="divideModeOptions" optionLabel="label" optionValue="value" />
    </div>

    <!-- Equal Division mode -->
    <template v-if="divideMode === 'equal'">
      <div class="form-grid">
        <div class="field">
          <label>Divide into</label>
          <div class="divide-count-row">
            <input type="range" class="divide-slider"
                   :min="1" :max="maxDivideSteps"
                   v-model.number="divideSteps"
                   :step="1" />
            <InputNumber v-model="divideCount" :min="2" :max="maxDivideCount"
                         class="divide-count-input" @update:modelValue="onDivideCountInput" />
            <span class="divide-count-label">networks (/{{ divideTargetPrefix }})</span>
          </div>
        </div>
      </div>

      <div v-if="dividePreviewSubnets.length > 0 && dividePreviewSubnets.length <= 256" class="divide-preview">
        <h4>Preview: {{ dividePreviewSubnets.length }} networks (/{{ divideTargetPrefix }})</h4>
        <ul class="remainder-list">
          <li v-for="cidr in dividePreviewSubnets" :key="cidr">{{ cidr }}</li>
        </ul>
      </div>
      <div v-else-if="dividePreviewSubnets.length > 256" class="divide-preview divide-preview-warn">
        <p>Cannot divide into more than 256 networks ({{ dividePreviewSubnets.length }} requested)</p>
      </div>
    </template>

    <!-- Specific Subnet mode (carve) -->
    <template v-else>
      <div class="form-grid">
        <div class="field">
          <label>Network CIDR *</label>
          <div class="carve-cidr-row">
            <InputText v-model="carveNetwork" class="carve-network-input" />
            <span class="carve-slash">/</span>
            <InputNumber v-model="carvePrefix" :min="(props.selectedNode?.data.prefix_length || 0) + 1" :max="32"
                         class="carve-prefix-input" :useGrouping="false" />
          </div>
          <small v-if="carveValidationError" class="field-error">{{ carveValidationError }}</small>
        </div>
      </div>

      <div v-if="carvePreview && !carveValidationError" class="divide-preview">
        <h4>Result</h4>
        <ul class="remainder-list">
          <li class="carved-highlight">{{ carveCidr }} (created)</li>
          <li v-for="cidr in carvePreview" :key="cidr">{{ cidr }} (remainder)</li>
        </ul>
      </div>
    </template>

    <Message v-if="props.selectedNode?.data.status === 'allocated'" severity="warn" class="mt-3">
      This network is allocated. Division will migrate its configuration to the child containing the gateway.
    </Message>

    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showDivide = false" />
      <Button v-if="divideMode === 'equal'" label="Divide" @click="executeDivide" :loading="saving"
              :disabled="dividePreviewSubnets.length === 0 || dividePreviewSubnets.length > 256" />
      <Button v-else label="Create Network" @click="executeCarve" :loading="saving"
              :disabled="!!carveValidationError || !carveNetwork" />
    </template>
  </Dialog>

  <!-- Configure Network Dialog -->
  <Dialog v-model:visible="showConfigure" header="Configure Network" modal :style="{ width: '30rem' }">
    <p>Configuring <strong>{{ props.selectedNode?.data.cidr }}</strong></p>
    <div class="form-grid">
      <div class="field">
        <label>Name *</label>
        <InputText v-model="configForm.name" class="w-full" />
      </div>
      <div class="field">
        <label>Description</label>
        <InputText v-model="configForm.description" class="w-full" />
      </div>
      <div class="field">
        <label>VLAN ID</label>
        <InputNumber v-model="configForm.vlan_id" :min="1" :max="4094" class="w-full" />
      </div>
      <div class="field">
        <label>Gateway Address</label>
        <InputText v-model="configForm.gateway_address" placeholder="Auto (system default)" class="w-full" />
      </div>
      <div class="field" v-if="props.selectedNode && props.selectedNode.data.prefix_length <= 29">
        <label class="toggle-label">
          <input type="checkbox" v-model="configForm.create_dhcp_scope" />
          Create DHCP scope
        </label>
      </div>
      <div class="field">
        <label class="toggle-label">
          <input type="checkbox" v-model="configForm.create_reverse_dns" />
          Create reverse DNS zone
        </label>
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showConfigure = false" />
      <Button label="Configure" @click="executeConfigure" :loading="saving" />
    </template>
  </Dialog>

  <!-- Edit Network Dialog -->
  <Dialog v-model:visible="showEdit" header="Edit Network" modal :style="{ width: '28rem' }">
    <div class="form-grid">
      <div class="field">
        <label>Name *</label>
        <div class="name-with-template">
          <InputText v-model="editForm.name" class="w-full" />
          <Button icon="pi pi-sync" severity="secondary" text rounded size="small"
                  title="Apply name template" @click="applyTemplateToEdit" />
        </div>
      </div>
      <div class="field">
        <label>Description</label>
        <InputText v-model="editForm.description" class="w-full" />
      </div>
      <div class="field">
        <label>VLAN</label>
        <div style="display: flex; gap: 0.25rem; align-items: center">
          <AutoComplete v-model="editVlanSelection" :suggestions="vlanSuggestions"
                        @complete="searchVlans" optionLabel="display"
                        placeholder="Search by name or ID..." class="w-full"
                        @item-select="onVlanSelect" @clear="onVlanClear" dropdown />
          <Button icon="pi pi-plus" text rounded size="small"
                  title="Create VLAN" @click="showCreateVlanFromEdit = true" />
        </div>
      </div>
      <div class="field">
        <label>Gateway</label>
        <InputText v-model="editForm.gateway_address" class="w-full" />
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showEdit = false" />
      <Button label="Save" @click="executeEdit" :loading="saving" />
    </template>
  </Dialog>

  <!-- Create VLAN from Edit Dialog -->
  <Dialog v-model:visible="showCreateVlanFromEdit" header="Create VLAN" modal :style="{ width: '24rem' }">
    <div class="form-grid">
      <div class="field">
        <label>VLAN ID *</label>
        <InputNumber v-model="newVlanForm.vlan_id" :min="1" :max="4094" class="w-full" />
      </div>
      <div class="field">
        <label>Name *</label>
        <InputText v-model="newVlanForm.name" class="w-full" />
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showCreateVlanFromEdit = false" />
      <Button label="Save" @click="createVlanFromEdit" :loading="saving"
              :disabled="!newVlanForm.vlan_id || !newVlanForm.name" />
    </template>
  </Dialog>

  <!-- VLAN Shared Warning Dialog -->
  <Dialog v-model:visible="showVlanWarning" header="VLAN Already Assigned" modal :style="{ width: '26rem' }">
    <p>Usually networks do not share VLANs, are you sure?</p>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="cancelVlanAssignment" />
      <Button label="Yes" @click="confirmVlanAssignment" />
    </template>
  </Dialog>

  <!-- Delete Network Dialog -->
  <Dialog v-model:visible="showDelete" header="Delete Network" modal :style="{ width: '26rem' }">
    <template v-if="props.selectedNode">
      <p>Delete <strong>{{ props.selectedNode.data.cidr }}</strong>?</p>
      <p v-if="props.selectedNode.data.status === 'allocated'" class="warn-text">
        This will remove all configuration, ranges, and IP assignments.
      </p>
      <p v-if="props.selectedNode.data.child_count > 0" class="warn-text">
        This network has {{ props.selectedNode.data.child_count }} children that will also be affected.
      </p>
    </template>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showDelete = false" />
      <Button label="Delete" severity="danger" @click="executeDelete" :loading="saving" />
    </template>
  </Dialog>

  <!-- Merge Networks Dialog -->
  <Dialog v-model:visible="showMerge" header="Merge Networks" modal :style="{ width: '32rem' }">
    <template v-if="mergePreview">
      <p>Merging <strong>{{ mergePreview.source_cidrs.length }}</strong> networks into:</p>
      <p class="merge-result-cidr">{{ mergePreview.merged_cidr }}</p>
      <div v-if="mergePreview.gateway_preserved" class="merge-info">
        Gateway <strong>{{ mergePreview.gateway_preserved.gateway }}</strong> from {{ mergePreview.gateway_preserved.cidr }} will be preserved.
      </div>
      <div v-if="mergePreview.config_loss.length > 0" class="warn-text">
        Configuration will be lost for: {{ mergePreview.config_loss.join(', ') }}
      </div>
    </template>
    <template v-if="mergeError">
      <p class="warn-text">{{ mergeError }}</p>
    </template>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showMerge = false" />
      <Button v-if="mergePreview && !mergeError" label="Merge" severity="warn" @click="executeMerge" :loading="saving" />
    </template>
  </Dialog>

  <!-- Group Allocate Dialog -->
  <Dialog v-model:visible="showGroupConfigure" header="Allocate Group" modal :style="{ width: '28rem' }">
    <p>Allocate <strong>{{ groupDropIds.length }}</strong> networks to this organization?</p>
    <p style="font-size: 0.85rem; color: var(--p-text-muted-color);">
      Each network will be named using the current template and allocated with default settings.
    </p>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showGroupConfigure = false" />
      <Button label="Allocate All" @click="executeGroupConfigure" :loading="saving" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import SelectButton from 'primevue/selectbutton';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Select from 'primevue/select';
import Message from 'primevue/message';
import AutoComplete from 'primevue/autocomplete';
import { useSubnetStore } from '../stores/subnets.js';
import api from '../api/client.js';
import { validateSupernet, isValidCidr, normalizeCidr, applyNameTemplate, calculateSubnets, subtractCidr, isSubnetOf, parseCidr } from '../utils/ip.js';

const props = defineProps({
  selectedNode: { type: Object, default: null },
  nameTemplate: { type: String, default: '%1.%2.%3.%4/%bitmask' },
  mergeSelectedIds: { type: Array, default: () => [] },
  folders: { type: Array, default: () => [] },
});

const emit = defineEmits([
  'org-created', 'org-updated', 'org-deleted',
  'network-created', 'network-configured', 'network-updated',
  'network-divided', 'network-deleted', 'networks-merged',
  'group-configured',
]);

const store = useSubnetStore();
const toast = useToast();
const saving = ref(false);

// ── Folder / Organization dialogs ──
const showFolderDialog = ref(false);
const showOrgDialog = ref(false);
const showDeleteFolderDialog = ref(false);
const editingFolder = ref(null);
const deletingFolder = ref(null);
const folderForm = ref({ name: '', description: '' });
const orgForm = ref({ name: '', description: '', cidr: '' });

const orgValidationError = computed(() => {
  const cidr = orgForm.value.cidr.trim();
  if (!cidr) return null;
  if (!isValidCidr(cidr)) return 'Invalid CIDR notation';
  const normalized = normalizeCidr(cidr);
  const result = validateSupernet(normalized);
  if (!result.valid) return result.error;
  return null;
});

async function createOrg() {
  saving.value = true;
  try {
    await store.createFolder({
      name: orgForm.value.name,
      description: orgForm.value.description || undefined,
      cidr: orgForm.value.cidr,
    });
    showOrgDialog.value = false;
    orgForm.value = { name: '', description: '', cidr: '' };
    toast.add({ severity: 'success', summary: 'Organization created', life: 3000 });
    emit('org-created');
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

async function quickCreateOrg() {
  const name = prompt('Organization name:');
  if (!name || !name.trim()) return;
  try {
    await store.createFolder({ name: name.trim() });
    toast.add({ severity: 'success', summary: 'Organization created', life: 3000 });
    const created = store.folders.find(f => f.name === name.trim());
    if (created) supernetForm.value.folder_id = created.id;
    emit('org-created');
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  }
}

async function saveFolder() {
  saving.value = true;
  try {
    if (editingFolder.value) {
      await store.updateFolder(editingFolder.value.id, folderForm.value);
      toast.add({ severity: 'success', summary: 'Folder updated', life: 3000 });
      emit('org-updated');
    } else {
      await store.createFolder(folderForm.value);
      toast.add({ severity: 'success', summary: 'Folder created', life: 3000 });
      emit('org-created');
    }
    showFolderDialog.value = false;
    editingFolder.value = null;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

async function executeDeleteFolder() {
  saving.value = true;
  try {
    await store.deleteFolder(deletingFolder.value.id);
    showDeleteFolderDialog.value = false;
    toast.add({ severity: 'success', summary: 'Folder deleted', life: 3000 });
    emit('org-deleted', deletingFolder.value.id);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

// ── Create Network dialog ──
const showSubnetDialog = ref(false);
const supernetForm = ref({ cidr: '', name: '', folder_id: null });
const folderOptions = computed(() => store.folders);

const supernetValidationError = computed(() => {
  const cidr = supernetForm.value.cidr.trim();
  if (!cidr) return null;
  if (!isValidCidr(cidr)) return 'Invalid CIDR notation';
  const normalized = normalizeCidr(cidr);
  const result = validateSupernet(normalized);
  if (!result.valid) return result.error;
  return null;
});

const supernetAutoName = computed(() => {
  const cidr = supernetForm.value.cidr.trim();
  if (!cidr || !isValidCidr(cidr)) return '';
  try { return applyNameTemplate(props.nameTemplate, normalizeCidr(cidr)); }
  catch { return ''; }
});

async function createSupernet() {
  saving.value = true;
  try {
    await store.createSupernet({
      cidr: supernetForm.value.cidr,
      name: supernetForm.value.name || undefined,
      folder_id: supernetForm.value.folder_id || undefined,
    });
    showSubnetDialog.value = false;
    supernetForm.value = { cidr: '', name: '', folder_id: store.folders[0]?.id || null };
    toast.add({ severity: 'success', summary: 'Network created', life: 3000 });
    emit('network-created');
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

// ── Divide dialog ──
const showDivide = ref(false);
const divideMode = ref('equal');
const divideModeOptions = [
  { label: 'Equal Division', value: 'equal' },
  { label: 'Specific Network', value: 'carve' },
];
const divideSteps = ref(1);
const divideCount = ref(2);
const carveNetwork = ref('');
const carvePrefix = ref(25);
const carveCidr = computed(() => `${carveNetwork.value}/${carvePrefix.value}`);

const carveValidationError = computed(() => {
  const cidr = carveCidr.value;
  if (!carveNetwork.value) return 'Enter a network address';
  if (!isValidCidr(cidr)) return 'Invalid CIDR notation';
  if (!props.selectedNode) return null;
  const parentCidr = props.selectedNode.data.cidr;
  const normalized = normalizeCidr(cidr);
  const parentParsed = parseCidr(parentCidr);
  const childParsed = parseCidr(normalized);
  if (childParsed.prefix <= parentParsed.prefix) return 'Must have a longer prefix than parent';
  if (!isSubnetOf(normalized, parentCidr)) return `Not within ${parentCidr}`;
  return null;
});

const carvePreview = computed(() => {
  const cidr = carveCidr.value;
  if (!carveNetwork.value || !props.selectedNode || carveValidationError.value) return null;
  try { return subtractCidr(props.selectedNode.data.cidr, normalizeCidr(cidr)); }
  catch { return null; }
});

const maxDivideSteps = computed(() => {
  if (!props.selectedNode) return 1;
  return Math.min(32 - props.selectedNode.data.prefix_length, 8);
});

const maxDivideCount = computed(() => Math.pow(2, maxDivideSteps.value));

const divideTargetPrefix = computed(() => {
  if (!props.selectedNode) return 32;
  return props.selectedNode.data.prefix_length + divideSteps.value;
});

const dividePreviewSubnets = computed(() => {
  if (!props.selectedNode) return [];
  const parentCidr = props.selectedNode.data.cidr;
  const targetPrefix = props.selectedNode.data.prefix_length + divideSteps.value;
  if (targetPrefix > 32) return [];
  return calculateSubnets(parentCidr, targetPrefix);
});

watch(divideSteps, (steps) => { divideCount.value = Math.pow(2, steps); });

function onDivideCountInput(val) {
  if (!val || val < 2) return;
  const steps = Math.round(Math.log2(val));
  const clamped = Math.max(1, Math.min(steps, maxDivideSteps.value));
  divideSteps.value = clamped;
  divideCount.value = Math.pow(2, clamped);
}

async function executeDivide() {
  saving.value = true;
  try {
    const nodeId = props.selectedNode.data.id;
    const isAllocated = props.selectedNode.data.status === 'allocated';
    await store.divideSubnet(nodeId, { new_prefix: divideTargetPrefix.value, force: isAllocated });
    showDivide.value = false;
    toast.add({ severity: 'success', summary: 'Network divided', life: 3000 });
    emit('network-divided', nodeId);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

async function executeCarve() {
  saving.value = true;
  try {
    const nodeId = props.selectedNode.data.id;
    const isAllocated = props.selectedNode.data.status === 'allocated';
    await store.divideSubnet(nodeId, { cidr: normalizeCidr(carveCidr.value), force: isAllocated });
    showDivide.value = false;
    toast.add({ severity: 'success', summary: 'Network created', life: 3000 });
    emit('network-divided', nodeId);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

// ── Configure dialog ──
const showConfigure = ref(false);
const configForm = ref({ name: '', description: '', vlan_id: null, gateway_address: '', create_dhcp_scope: false, create_reverse_dns: false });
const dropTargetFolderIdForConfigure = ref(null);

watch(showConfigure, (val) => { if (!val) dropTargetFolderIdForConfigure.value = null; });

async function executeConfigure() {
  saving.value = true;
  try {
    const payload = { ...configForm.value };
    if (dropTargetFolderIdForConfigure.value) {
      payload.folder_id = dropTargetFolderIdForConfigure.value;
    }
    await store.configureSubnet(props.selectedNode.data.id, payload);
    showConfigure.value = false;
    dropTargetFolderIdForConfigure.value = null;
    toast.add({ severity: 'success', summary: 'Network configured', life: 3000 });
    emit('network-configured', props.selectedNode.data.id);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

// ── Edit dialog ──
const showEdit = ref(false);
const editForm = ref({ name: '', description: '', vlan_id: null, gateway_address: '' });
const editVlanSelection = ref(null);
const vlanSuggestions = ref([]);
const showVlanWarning = ref(false);
const pendingVlanSelection = ref(null);
const showCreateVlanFromEdit = ref(false);
const newVlanForm = ref({ vlan_id: null, name: '' });

function getSubnetFolderId() {
  const folderId = props.selectedNode?.data?.folder_id;
  if (folderId) return folderId;
  const subnetId = props.selectedNode?.data?.id;
  if (subnetId) {
    for (const f of store.folders) {
      if (f.subnets) {
        const found = (function find(nodes) {
          for (const n of nodes) {
            if (n.id === subnetId) return true;
            if (n.children && find(n.children)) return true;
          }
          return false;
        })(f.subnets);
        if (found) return f.id;
      }
    }
  }
  return null;
}

async function searchVlans(event) {
  const folderId = getSubnetFolderId();
  if (!folderId) { vlanSuggestions.value = []; return; }
  try {
    const res = await api.get('/vlans/search', { params: { folder_id: folderId, q: event.query } });
    vlanSuggestions.value = res.data.map(v => ({ ...v, display: `VLAN ${v.vlan_id} — ${v.name}` }));
  } catch { vlanSuggestions.value = []; }
}

function onVlanSelect(event) {
  const vlan = event.value;
  const currentVlanId = props.selectedNode?.data?.vlan_id;
  if (vlan.subnet_count > 0 && vlan.vlan_id !== currentVlanId) {
    pendingVlanSelection.value = vlan;
    showVlanWarning.value = true;
  } else {
    editForm.value.vlan_id = vlan.vlan_id;
  }
}

function confirmVlanAssignment() {
  editForm.value.vlan_id = pendingVlanSelection.value.vlan_id;
  showVlanWarning.value = false;
  pendingVlanSelection.value = null;
}

function cancelVlanAssignment() {
  showVlanWarning.value = false;
  pendingVlanSelection.value = null;
  const d = props.selectedNode?.data;
  if (d?.vlan_id) {
    editVlanSelection.value = `VLAN ${d.vlan_id}`;
  } else {
    editVlanSelection.value = null;
  }
  editForm.value.vlan_id = d?.vlan_id || null;
}

function onVlanClear() {
  editForm.value.vlan_id = null;
  editVlanSelection.value = null;
}

async function createVlanFromEdit() {
  const folderId = getSubnetFolderId();
  if (!folderId) return;
  saving.value = true;
  try {
    const res = await api.post('/vlans', {
      folder_id: folderId,
      vlan_id: newVlanForm.value.vlan_id,
      name: newVlanForm.value.name,
    });
    const created = res.data;
    editForm.value.vlan_id = created.vlan_id;
    editVlanSelection.value = { ...created, display: `VLAN ${created.vlan_id} — ${created.name}` };
    showCreateVlanFromEdit.value = false;
    newVlanForm.value = { vlan_id: null, name: '' };
    toast.add({ severity: 'success', summary: 'VLAN created', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

function applyTemplateToEdit() {
  const defaultTemplate = '%1.%2.%3.%4/%bitmask';
  if (!props.nameTemplate || props.nameTemplate === defaultTemplate) {
    toast.add({ severity: 'warn', summary: 'No custom template', detail: 'Configure a name template in System settings first', life: 4000 });
    return;
  }
  editForm.value.name = applyNameTemplate(props.nameTemplate, props.selectedNode.data.cidr);
}

async function executeEdit() {
  saving.value = true;
  try {
    await store.updateSubnet(props.selectedNode.data.id, editForm.value);
    showEdit.value = false;
    toast.add({ severity: 'success', summary: 'Network updated', life: 3000 });
    emit('network-updated', props.selectedNode.data.id);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

// ── Delete dialog ──
const showDelete = ref(false);

async function executeDelete() {
  saving.value = true;
  try {
    await store.deleteSubnet(props.selectedNode.data.id);
    showDelete.value = false;
    toast.add({ severity: 'success', summary: 'Network deleted', life: 3000 });
    emit('network-deleted', props.selectedNode.data.id);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

// ── Merge dialog ──
const showMerge = ref(false);
const mergePreview = ref(null);
const mergeError = ref(null);

async function executeMerge() {
  saving.value = true;
  try {
    await store.mergeSubnets(props.mergeSelectedIds);
    showMerge.value = false;
    toast.add({ severity: 'success', summary: 'Networks merged', life: 3000 });
    emit('networks-merged');
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

// ── Group Allocate dialog ──
const showGroupConfigure = ref(false);
const groupDropIds = ref([]);
const groupDropFolderId = ref(null);

async function executeGroupConfigure() {
  saving.value = true;
  const count = groupDropIds.value.length;
  try {
    for (const id of groupDropIds.value) {
      const subnet = findSubnetInTree(id);
      if (!subnet) continue;
      const autoName = applyNameTemplate(props.nameTemplate, subnet.cidr);
      await store.configureSubnetNoRefresh(id, {
        name: autoName, description: '', vlan_id: null,
        gateway_address: '', create_dhcp_scope: false,
        create_reverse_dns: false, folder_id: groupDropFolderId.value,
      });
    }
    await store.fetchTree();
    showGroupConfigure.value = false;
    groupDropIds.value = [];
    groupDropFolderId.value = null;
    toast.add({ severity: 'success', summary: `${count} networks allocated`, life: 3000 });
    emit('group-configured');
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

function findSubnetInTree(id, nodes) {
  for (const f of (nodes || store.folders)) {
    if (nodes) {
      if (f.id === id) return f;
      if (f.children) {
        const found = findSubnetInTree(id, f.children);
        if (found) return found;
      }
    } else {
      if (f.subnets) {
        const found = findSubnetInTree(id, f.subnets);
        if (found) return found;
      }
    }
  }
  return null;
}

// ── Apply template ──
async function executeApplyTemplate(ids) {
  saving.value = true;
  try {
    await store.applyTemplate(ids);
    toast.add({ severity: 'success', summary: 'Template applied', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

// ── Exposed methods ──
function openOrgDialog() {
  orgForm.value = { name: '', description: '', cidr: '' };
  showOrgDialog.value = true;
}

function openEditFolder(folder) {
  editingFolder.value = folder;
  folderForm.value = { name: folder.name, description: folder.description || '' };
  showFolderDialog.value = true;
}

function openDeleteFolder(folder) {
  deletingFolder.value = folder;
  showDeleteFolderDialog.value = true;
}

function openSubnetDialog(folderId) {
  supernetForm.value = { cidr: '', name: '', folder_id: folderId || store.folders[0]?.id || null };
  showSubnetDialog.value = true;
}

function openDivide(node) {
  divideMode.value = 'equal';
  divideSteps.value = 1;
  divideCount.value = 2;
  const d = (node || props.selectedNode)?.data;
  if (d) {
    carveNetwork.value = d.network_address || d.cidr.split('/')[0];
    carvePrefix.value = d.prefix_length + 1;
  } else {
    carveNetwork.value = '';
    carvePrefix.value = 25;
  }
  showDivide.value = true;
}

function openConfigure(node, folderId) {
  const d = (node || props.selectedNode)?.data;
  if (!d) return;
  const autoName = applyNameTemplate(props.nameTemplate, d.cidr);
  configForm.value = { name: autoName, description: '', vlan_id: null, gateway_address: '', create_dhcp_scope: false, create_reverse_dns: false };
  if (folderId) dropTargetFolderIdForConfigure.value = folderId;
  showConfigure.value = true;
}

function openEdit(node) {
  const d = (node || props.selectedNode)?.data;
  if (!d) return;
  editForm.value = { name: d.name, description: d.description || '', vlan_id: d.vlan_id, gateway_address: d.gateway_address || '' };
  const folderId = getSubnetFolderId();
  if (d.vlan_id && folderId) {
    api.get('/vlans/search', { params: { folder_id: folderId, q: String(d.vlan_id) } }).then(res => {
      const match = res.data.find(v => v.vlan_id === d.vlan_id);
      if (match) editVlanSelection.value = { ...match, display: `VLAN ${match.vlan_id} — ${match.name}` };
      else editVlanSelection.value = `VLAN ${d.vlan_id}`;
    }).catch(() => { editVlanSelection.value = `VLAN ${d.vlan_id}`; });
  } else {
    editVlanSelection.value = null;
  }
  showEdit.value = true;
}

function openDelete(node) {
  showDelete.value = true;
}

async function openMergeConfirm(ids) {
  const mergeIds = ids || props.mergeSelectedIds;
  if (mergeIds.length < 2) return;
  mergeError.value = null;
  mergePreview.value = null;
  try {
    const preview = await store.previewMerge(mergeIds);
    mergePreview.value = preview;
    showMerge.value = true;
  } catch (err) {
    mergeError.value = err.response?.data?.error || err.message;
    showMerge.value = true;
  }
}

function openGroupConfigure(leafIds, folderId) {
  groupDropIds.value = leafIds;
  groupDropFolderId.value = folderId;
  showGroupConfigure.value = true;
}

defineExpose({
  openOrgDialog, openEditFolder, openDeleteFolder,
  openSubnetDialog, openDivide, openConfigure,
  openEdit, openDelete, openMergeConfirm,
  openGroupConfigure, executeApplyTemplate,
});
</script>

<style scoped>
.form-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.field label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--p-text-muted-color);
}
.field-error {
  color: #ef4444;
  font-size: 0.75rem;
}
.warn-text {
  color: #ef4444;
  font-size: 0.85rem;
}
.merge-result-cidr {
  font-size: 1.3rem;
  font-weight: 700;
  font-family: monospace;
  color: var(--p-primary-color);
  margin: 0.5rem 0;
}
.merge-info {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  margin-bottom: 0.5rem;
}
.toggle-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
}
.name-with-template {
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.divide-mode-toggle {
  margin-bottom: 0.75rem;
}
.divide-count-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.divide-slider {
  flex: 1;
}
.divide-count-input {
  width: 5rem;
}
.divide-count-label {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}
.divide-preview {
  margin-top: 0.75rem;
  padding: 0.5rem 0.75rem;
  background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
  border-radius: 6px;
  max-height: 200px;
  overflow-y: auto;
}
.divide-preview h4 {
  margin: 0 0 0.35rem;
  font-size: 0.8rem;
}
.divide-preview-warn {
  background: color-mix(in srgb, #ef4444 10%, transparent);
  color: #ef4444;
}
.remainder-list {
  list-style: none;
  padding: 0;
  margin: 0;
  font-family: monospace;
  font-size: 0.8rem;
}
.remainder-list li {
  padding: 0.15rem 0;
}
.carved-highlight {
  color: var(--p-primary-color);
  font-weight: 600;
}
.carve-cidr-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.carve-network-input {
  flex: 1;
}
.carve-slash {
  font-size: 1.1rem;
  font-weight: 600;
}
.carve-prefix-input {
  width: 4rem;
}
.mt-3 {
  margin-top: 0.75rem;
}
.w-full {
  width: 100%;
}
</style>
