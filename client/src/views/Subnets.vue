<template>
  <div class="subnets-page">
    <div class="page-header">
      <h2>Subnets</h2>
      <div class="header-actions">
        <template v-if="mergeSelectedIds.length > 0">
          <Button label="Cancel" severity="secondary" icon="pi pi-times" @click="clearMergeSelection" />
          <Button label="Merge Selected" icon="pi pi-sitemap" @click="openMergeConfirm"
                  :disabled="mergeSelectedIds.length < 2 || !mergeValidation.valid" :badge="String(mergeSelectedIds.length)" />
          <Button label="Apply Template" icon="pi pi-sync" @click="executeApplyTemplate(mergeSelectedIds)"
                  :disabled="mergeSelectedIds.length === 0" />
          <small v-if="mergeSelectedIds.length >= 2 && !mergeValidation.valid" class="merge-validation-error">{{ mergeValidation.error }}</small>
        </template>
        <Button label="Add Supernet" icon="pi pi-plus" @click="showSupernet = true" />
      </div>
    </div>

    <Tree :value="store.treeNodes" selectionMode="single" v-model:selectionKeys="selectedKeys"
          v-model:expandedKeys="expandedKeys"
          :loading="store.loading" class="subnet-tree"
          @node-select="onNodeSelect">
      <template #default="{ node }">
        <span class="tree-node" :class="{ unallocated: node.data.status === 'unallocated', 'merge-selected': isMergeSelected(node.data.id) }"
              @contextmenu.prevent="openContextMenu($event, node)"
              @click.ctrl.prevent.stop="toggleMergeSelect(node.data.id)"
              @click.meta.prevent.stop="toggleMergeSelect(node.data.id)">
          <span class="node-cidr">{{ node.data.cidr }}</span>
          <span class="node-prefix">/{{ node.data.prefix_length }}</span>
          <span v-if="node.data.status === 'allocated'" class="node-name">{{ node.data.name }}</span>
          <span v-else-if="node.data.name && node.data.name !== node.data.cidr" class="node-name faded">{{ node.data.name }}</span>
          <span v-if="node.data.status === 'unallocated'" class="node-badge unalloc-badge">unallocated</span>
          <span v-if="node.data.status === 'allocated' && node.data.range_count > 0" class="node-badge range-badge">
            {{ node.data.range_count }} ranges
          </span>
          <span v-if="isMergeSelected(node.data.id)" class="node-badge merge-badge">merge</span>
        </span>
      </template>
    </Tree>

    <div v-if="!store.loading && store.treeNodes.length === 0" class="empty-state">
      No supernets configured. Click "Add Supernet" to define your address space.
    </div>

    <!-- Context Menu -->
    <ContextMenu ref="contextMenuRef" :model="contextMenuItems" />

    <!-- Add Supernet Dialog -->
    <Dialog v-model:visible="showSupernet" header="Add Supernet" modal :style="{ width: '26rem' }">
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
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showSupernet = false" />
        <Button label="Create" @click="createSupernet" :loading="saving" :disabled="!!supernetValidationError" />
      </template>
    </Dialog>

    <!-- Divide Dialog -->
    <Dialog v-model:visible="showDivide" header="Divide Subnet" modal :style="{ width: '36rem' }">
      <p>Dividing <strong>{{ selectedNode?.data.cidr }}</strong> into equal subnets</p>

      <div class="form-grid">
        <div class="field">
          <label>Divide into</label>
          <div class="divide-count-row">
            <input type="range" class="divide-slider"
                   :min="1" :max="maxDivideSteps"
                   v-model.number="divideSteps"
                   :step="1"
                   :list="'detents-' + selectedNode?.data.id" />
            <datalist :id="'detents-' + selectedNode?.data.id">
              <option v-for="s in maxDivideSteps" :key="s" :value="s" />
            </datalist>
            <InputNumber v-model="divideCount" :min="2" :max="maxDivideCount"
                         class="divide-count-input" @update:modelValue="onDivideCountInput" />
            <span class="divide-count-label">subnets (/{{ divideTargetPrefix }})</span>
          </div>
        </div>
      </div>

      <!-- Real-time preview -->
      <div v-if="dividePreviewSubnets.length > 0 && dividePreviewSubnets.length <= 256" class="divide-preview">
        <h4>Preview: {{ dividePreviewSubnets.length }} subnets (/{{ divideTargetPrefix }})</h4>
        <ul class="remainder-list">
          <li v-for="cidr in dividePreviewSubnets" :key="cidr">{{ cidr }}</li>
        </ul>
      </div>
      <div v-else-if="dividePreviewSubnets.length > 256" class="divide-preview divide-preview-warn">
        <p>Cannot divide into more than 256 subnets ({{ dividePreviewSubnets.length }} requested)</p>
      </div>

      <Message v-if="selectedNode?.data.status === 'allocated'" severity="warn" class="mt-3">
        This subnet is allocated. Division will migrate its configuration to the child containing the gateway, or remove it if no child matches.
      </Message>

      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDivide = false" />
        <Button label="Divide" @click="executeDivide" :loading="saving"
                :disabled="dividePreviewSubnets.length === 0 || dividePreviewSubnets.length > 256" />
      </template>
    </Dialog>

    <!-- Configure Dialog -->
    <Dialog v-model:visible="showConfigure" header="Configure Subnet" modal :style="{ width: '30rem' }">
      <p>Configuring <strong>{{ selectedNode?.data.cidr }}</strong></p>
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
        <div class="field" v-if="selectedNode && selectedNode.data.prefix_length <= 29">
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

    <!-- Edit Dialog (for allocated subnets) -->
    <Dialog v-model:visible="showEdit" header="Edit Subnet" modal :style="{ width: '28rem' }">
      <div class="form-grid">
        <div class="field">
          <label>Name *</label>
          <div class="name-with-template">
            <InputText v-model="editForm.name" class="w-full" />
            <Button icon="pi pi-sync" severity="secondary" text rounded size="small"
                    title="Apply name template"
                    @click="applyTemplateToEdit" />
          </div>
        </div>
        <div class="field">
          <label>Description</label>
          <InputText v-model="editForm.description" class="w-full" />
        </div>
        <div class="field">
          <label>VLAN ID</label>
          <InputNumber v-model="editForm.vlan_id" :min="1" :max="4094" class="w-full" />
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

    <!-- Delete Dialog -->
    <Dialog v-model:visible="showDelete" header="Delete Subnet" modal :style="{ width: '26rem' }">
      <template v-if="selectedNode">
        <p>Delete <strong>{{ selectedNode.data.cidr }}</strong>?</p>
        <p v-if="selectedNode.data.status === 'allocated'" class="warn-text">
          This will remove all configuration, ranges, and IP assignments.
        </p>
        <p v-if="selectedNode.data.child_count > 0" class="warn-text">
          This subnet has {{ selectedNode.data.child_count }} children that will also be affected.
        </p>
      </template>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDelete = false" />
        <Button label="Delete" severity="danger" @click="executeDelete" :loading="saving" />
      </template>
    </Dialog>

    <!-- Merge Confirmation Dialog -->
    <Dialog v-model:visible="showMerge" header="Merge Subnets" modal :style="{ width: '32rem' }">
      <template v-if="mergePreview">
        <p>Merging <strong>{{ mergePreview.source_cidrs.length }}</strong> subnets into:</p>
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

    <Toast />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import Tree from 'primevue/tree';
import ContextMenu from 'primevue/contextmenu';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Message from 'primevue/message';
import Toast from 'primevue/toast';
import { useSubnetStore } from '../stores/subnets.js';
import { validateSupernet, isValidCidr, normalizeCidr, applyNameTemplate, calculateSubnets, canMergeCidrs } from '../utils/ip.js';

const store = useSubnetStore();
const router = useRouter();
const toast = useToast();

// Persist expanded/selected keys via localStorage
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

const expandedKeys = ref(loadJson('ipam_subnet_expanded_keys', {}));
const selectedKeys = ref(loadJson('ipam_subnet_selected_keys', {}));
const selectedNode = ref(null);
const contextMenuRef = ref(null);

watch(expandedKeys, (val) => localStorage.setItem('ipam_subnet_expanded_keys', JSON.stringify(val)), { deep: true });
watch(selectedKeys, (val) => localStorage.setItem('ipam_subnet_selected_keys', JSON.stringify(val)), { deep: true });

const showSupernet = ref(false);
const showDivide = ref(false);
const showConfigure = ref(false);
const showEdit = ref(false);
const showDelete = ref(false);
const showMerge = ref(false);
const saving = ref(false);

// Settings
const nameTemplate = ref('%1.%2.%3.%4/%bitmask');

async function loadSettings() {
  try {
    const settings = await store.getSettings();
    if (settings.subnet_name_template) nameTemplate.value = settings.subnet_name_template;
  } catch { /* use default */ }
}

// Supernet form
const supernetForm = ref({ cidr: '', name: '' });

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
  try {
    return applyNameTemplate(nameTemplate.value, normalizeCidr(cidr));
  } catch { return ''; }
});

// Divide form
const divideSteps = ref(1);
const divideCount = ref(2);

const maxDivideSteps = computed(() => {
  if (!selectedNode.value) return 1;
  return Math.min(32 - selectedNode.value.data.prefix_length, 8); // Cap at 256 subnets
});

const maxDivideCount = computed(() => Math.pow(2, maxDivideSteps.value));

const divideTargetPrefix = computed(() => {
  if (!selectedNode.value) return 32;
  return selectedNode.value.data.prefix_length + divideSteps.value;
});

// Real-time preview
const dividePreviewSubnets = computed(() => {
  if (!selectedNode.value) return [];
  const parentCidr = selectedNode.value.data.cidr;
  const targetPrefix = selectedNode.value.data.prefix_length + divideSteps.value;
  if (targetPrefix > 32) return [];
  return calculateSubnets(parentCidr, targetPrefix);
});

watch(divideSteps, (steps) => {
  divideCount.value = Math.pow(2, steps);
});

function onDivideCountInput(val) {
  if (!val || val < 2) return;
  const steps = Math.round(Math.log2(val));
  const clamped = Math.max(1, Math.min(steps, maxDivideSteps.value));
  divideSteps.value = clamped;
  divideCount.value = Math.pow(2, clamped);
}

// Configure form
const configForm = ref({ name: '', description: '', vlan_id: null, gateway_address: '', create_dhcp_scope: false, create_reverse_dns: false });
const editForm = ref({ name: '', description: '', vlan_id: null, gateway_address: '' });

// Merge via ctrl-click (no checkbox mode)
const mergeSelectedIdsRaw = ref([]);

const mergeSelectedIds = computed(() => mergeSelectedIdsRaw.value);

function isMergeSelected(id) {
  return mergeSelectedIdsRaw.value.includes(id);
}

// Helper: find subnet data by id in tree
function findSubnetInTree(id, nodes) {
  for (const n of nodes || store.tree) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findSubnetInTree(id, n.children);
      if (found) return found;
    }
  }
  return null;
}

function toggleMergeSelect(id) {
  const idx = mergeSelectedIdsRaw.value.indexOf(id);
  if (idx >= 0) {
    // Always allow deselection
    mergeSelectedIdsRaw.value.splice(idx, 1);
    return;
  }

  // Validate: must be a leaf and have a parent
  const subnet = findSubnetInTree(id);
  if (!subnet || !subnet.parent_id) {
    toast.add({ severity: 'warn', summary: 'Cannot merge', detail: 'Root supernets cannot be merged', life: 3000 });
    return;
  }
  const hasChildren = (subnet.child_count || 0) > 0 || (subnet.children && subnet.children.length > 0);
  if (hasChildren) {
    toast.add({ severity: 'warn', summary: 'Cannot merge', detail: 'Subnet has children and cannot be merged', life: 3000 });
    return;
  }

  // If there are already selected subnets, validate compatibility
  if (mergeSelectedIdsRaw.value.length > 0) {
    const firstSubnet = findSubnetInTree(mergeSelectedIdsRaw.value[0]);
    if (!firstSubnet) return;

    // Must be same parent
    if (subnet.parent_id !== firstSubnet.parent_id) {
      toast.add({ severity: 'warn', summary: 'Cannot merge', detail: 'Subnets must be siblings (same parent)', life: 3000 });
      return;
    }

    // Must be same prefix length
    if (subnet.prefix_length !== firstSubnet.prefix_length) {
      toast.add({ severity: 'warn', summary: 'Cannot merge', detail: 'All subnets must have the same prefix length', life: 3000 });
      return;
    }
  }

  mergeSelectedIdsRaw.value.push(id);
}

// Real-time merge validation for the selected set
const mergeValidation = computed(() => {
  if (mergeSelectedIdsRaw.value.length < 2) return { valid: false, error: '' };
  const cidrs = mergeSelectedIdsRaw.value.map(id => {
    const s = findSubnetInTree(id);
    return s?.cidr;
  }).filter(Boolean);
  if (cidrs.length < 2) return { valid: false, error: 'Cannot find subnets' };
  return canMergeCidrs(cidrs);
});

function clearMergeSelection() {
  mergeSelectedIdsRaw.value = [];
}

const mergePreview = ref(null);
const mergeError = ref(null);

// Helper: find nodes matching a name template
function getApplyTemplateTargets(nodes) {
  const targets = [];
  for (const n of nodes) {
    if (n.data.status === 'allocated') {
      const expected = applyNameTemplate(nameTemplate.value, n.data.cidr);
      if (n.data.name !== expected) targets.push(n.data);
    }
    if (n.children) targets.push(...getApplyTemplateTargets(n.children));
  }
  return targets;
}

// Context menu
const contextMenuItems = computed(() => {
  const node = selectedNode.value;
  if (!node) return [];

  const d = node.data;
  const isLeaf = (d.child_count || 0) === 0 && (!node.children || node.children.length === 0);
  const items = [];

  if (isLeaf) {
    items.push({ label: 'Divide', icon: 'pi pi-share-alt', command: () => openDivide() });
  }

  if (d.status === 'unallocated') {
    items.push({ label: 'Configure', icon: 'pi pi-cog', command: () => openConfigure() });
  } else {
    items.push({ label: 'View Details', icon: 'pi pi-eye', command: () => router.push(`/subnets/${d.id}`) });
    items.push({ label: 'Edit', icon: 'pi pi-pencil', command: () => openEdit() });
  }

  // Merge option
  if (d.parent_id) {
    if (mergeSelectedIdsRaw.value.length >= 2 && mergeValidation.value.valid) {
      // Already have a valid selection — offer to execute the merge
      items.push({ label: 'Merge Selected', icon: 'pi pi-sitemap', command: () => openMergeConfirm() });
    } else {
      items.push({ label: 'Merge...', icon: 'pi pi-sitemap', command: () => {
        if (!isMergeSelected(d.id)) toggleMergeSelect(d.id);
        // If we now have 2+ valid, open the merge dialog
        if (mergeSelectedIdsRaw.value.length >= 2 && mergeValidation.value.valid) {
          openMergeConfirm();
        }
      }});
    }
  }

  // Apply Template — only show if this node (or children) have names not matching the template
  if (d.status === 'allocated') {
    const expected = applyNameTemplate(nameTemplate.value, d.cidr);
    if (d.name !== expected) {
      items.push({ label: 'Apply Template', icon: 'pi pi-sync', command: () => executeApplyTemplate([d.id]) });
    }
  }
  // Apply Template to children
  if (node.children && node.children.length > 0) {
    const targets = getApplyTemplateTargets(node.children);
    if (targets.length > 0) {
      items.push({ label: `Apply Template to Children (${targets.length})`, icon: 'pi pi-sync', command: () => executeApplyTemplate(targets.map(t => t.id)) });
    }
  }

  items.push({ separator: true });
  items.push({ label: 'Delete', icon: 'pi pi-trash', class: 'p-error', command: () => showDelete.value = true });

  return items;
});

onMounted(async () => {
  await Promise.all([store.fetchTree(), loadSettings()]);
});

function onNodeSelect(node) {
  selectedNode.value = node;
  if (node.data.status === 'allocated') {
    router.push(`/subnets/${node.data.id}`);
  }
}

function openContextMenu(event, node) {
  selectedNode.value = node;
  selectedKeys.value = { [node.key]: true };
  contextMenuRef.value.show(event);
}

// Supernet
async function createSupernet() {
  saving.value = true;
  try {
    await store.createSupernet({ cidr: supernetForm.value.cidr, name: supernetForm.value.name || undefined });
    showSupernet.value = false;
    supernetForm.value = { cidr: '', name: '' };
    toast.add({ severity: 'success', summary: 'Supernet created', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

// Divide
function openDivide() {
  divideSteps.value = 1;
  divideCount.value = 2;
  showDivide.value = true;
}

async function executeDivide() {
  saving.value = true;
  try {
    const nodeId = selectedNode.value.data.id;
    const isAllocated = selectedNode.value.data.status === 'allocated';
    await store.divideSubnet(nodeId, {
      new_prefix: divideTargetPrefix.value,
      force: isAllocated
    });
    showDivide.value = false;
    // Auto-expand the parent node to show new children
    expandedKeys.value = { ...expandedKeys.value, [String(nodeId)]: true };
    toast.add({ severity: 'success', summary: 'Subnet divided', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

// Configure
function openConfigure() {
  const cidr = selectedNode.value.data.cidr;
  const autoName = applyNameTemplate(nameTemplate.value, cidr);
  configForm.value = { name: autoName, description: '', vlan_id: null, gateway_address: '', create_dhcp_scope: false, create_reverse_dns: false };
  showConfigure.value = true;
}

async function executeConfigure() {
  saving.value = true;
  try {
    await store.configureSubnet(selectedNode.value.data.id, configForm.value);
    showConfigure.value = false;
    toast.add({ severity: 'success', summary: 'Subnet configured', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

// Edit
function openEdit() {
  const d = selectedNode.value.data;
  editForm.value = { name: d.name, description: d.description || '', vlan_id: d.vlan_id, gateway_address: d.gateway_address || '' };
  showEdit.value = true;
}

async function executeEdit() {
  saving.value = true;
  try {
    await store.updateSubnet(selectedNode.value.data.id, editForm.value);
    showEdit.value = false;
    toast.add({ severity: 'success', summary: 'Subnet updated', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

// Delete
async function executeDelete() {
  saving.value = true;
  try {
    await store.deleteSubnet(selectedNode.value.data.id);
    showDelete.value = false;
    selectedNode.value = null;
    selectedKeys.value = {};
    toast.add({ severity: 'success', summary: 'Subnet deleted', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

// Merge
async function openMergeConfirm() {
  const ids = mergeSelectedIds.value;
  if (ids.length < 2) return;

  mergeError.value = null;
  mergePreview.value = null;

  try {
    const preview = await store.previewMerge(ids);
    mergePreview.value = preview;
    showMerge.value = true;
  } catch (err) {
    mergeError.value = err.response?.data?.error || err.message;
    showMerge.value = true;
  }
}

async function executeMerge() {
  saving.value = true;
  try {
    await store.mergeSubnets(mergeSelectedIds.value);
    showMerge.value = false;
    clearMergeSelection();
    toast.add({ severity: 'success', summary: 'Subnets merged', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

function applyTemplateToEdit() {
  const defaultTemplate = '%1.%2.%3.%4/%bitmask';
  if (!nameTemplate.value || nameTemplate.value === defaultTemplate) {
    toast.add({ severity: 'warn', summary: 'No custom template', detail: 'Configure a name template in System settings first', life: 4000 });
    return;
  }
  editForm.value.name = applyNameTemplate(nameTemplate.value, selectedNode.value.data.cidr);
}

// Apply Template
async function executeApplyTemplate(ids) {
  saving.value = true;
  try {
    await store.applyTemplate(ids);
    toast.add({ severity: 'success', summary: 'Template applied', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}
.page-header h2 { margin: 0; }
.header-actions {
  display: flex;
  gap: 0.5rem;
}

.subnet-tree {
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
}

.tree-node {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.15rem 0;
}
.tree-node.unallocated {
  opacity: 0.55;
}
.tree-node.merge-selected {
  background: var(--p-primary-50);
  border-radius: 4px;
  padding: 0.15rem 0.35rem;
}
.node-cidr {
  font-family: monospace;
  font-weight: 600;
}
.node-prefix {
  font-family: monospace;
  color: var(--p-text-muted-color);
  font-size: 0.85em;
}
.node-name {
  color: var(--p-primary-color);
  font-weight: 500;
}
.node-name.faded {
  opacity: 0.6;
}
.node-badge {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
}
.unalloc-badge {
  background: var(--p-surface-200);
  color: var(--p-text-muted-color);
}
.range-badge {
  background: var(--p-primary-100);
  color: var(--p-primary-700);
}
.merge-badge {
  background: var(--p-orange-100);
  color: var(--p-orange-700);
  font-weight: 600;
}

.empty-state {
  text-align: center;
  padding: 3rem;
  color: var(--p-text-muted-color);
  background: var(--p-surface-card);
  border: 1px dashed var(--p-surface-border);
  border-radius: 8px;
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
.field-error {
  color: var(--p-red-500);
  font-size: 0.8rem;
  margin-top: 0.25rem;
  display: block;
}
.toggle-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

.divide-preview {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  background: var(--p-surface-ground);
  color: var(--p-text-color);
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
}
.divide-preview h4 { margin: 0 0 0.5rem 0; }
.divide-preview p { margin: 0.25rem 0; }
.divide-preview-warn {
  border-color: var(--p-orange-500);
  color: var(--p-orange-500);
}
.remainder-list {
  margin: 0.25rem 0;
  padding-left: 1.25rem;
  font-family: monospace;
  font-size: 0.85rem;
  max-height: 12rem;
  overflow-y: auto;
}

.divide-count-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.divide-slider {
  flex: 1;
  cursor: pointer;
}
.divide-count-input {
  width: 5rem;
}
.divide-count-input :deep(input) {
  text-align: center;
  width: 100%;
}
.divide-count-label {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  white-space: nowrap;
}

.merge-result-cidr {
  font-family: monospace;
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--p-primary-color);
  margin: 0.5rem 0;
}
.merge-info {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  margin: 0.5rem 0;
}

.name-with-template {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.name-with-template .w-full {
  flex: 1;
}
.merge-validation-error {
  color: var(--p-orange-500);
  font-size: 0.8rem;
  align-self: center;
}

.warn-text {
  color: var(--p-red-500);
  font-size: 0.85rem;
}
.mt-3 { margin-top: 0.75rem; }
</style>
