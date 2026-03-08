<template>
  <div class="layout-b">
    <!-- Menubar -->
    <Menubar :model="menuItems">
      <template #start>
        <Button label="Add Organization" icon="pi pi-plus" size="small" data-track="toolbar-add-org" @click="dialogs.openWizard()" :class="{ 'pulse-attention': store.folders.length === 0 }" :text="store.folders.length > 0" />
      </template>
      <template #item="{ item, props: itemProps }">
        <a v-bind="itemProps.action" :class="{ 'active-menuitem': item.key === activeTab }" :data-track="item.dataTrack">
          <span :class="item.icon" />
          <span class="ml-1">{{ item.label }}</span>
        </a>
      </template>
      <template #end>
        <div class="toolbar-right">
          <template v-if="activeTab === 'networks' && mergeSelectedIdsRaw.length > 0">
            <span class="merge-badge">{{ mergeSelectedIdsRaw.length }} selected</span>
            <Button v-if="mergeSelectedIdsRaw.length >= 2 && mergeValidation.valid"
                    label="Merge" icon="pi pi-sitemap" size="small" severity="warn"
                    data-track="toolbar-merge" @click="dialogs.openMergeConfirm(mergeSelectedIdsRaw)" />
            <Button label="Cancel" size="small" severity="secondary" text data-track="toolbar-merge-cancel" @click="clearMergeSelection" />
            <span class="toolbar-divider"></span>
          </template>
          <Select v-model="selectedOrgId" :options="orgOptions" optionLabel="name" optionValue="id"
                  size="small" data-track="toolbar-org-filter" class="org-selector" />
        </div>
      </template>
    </Menubar>

    <!-- Networks Tab -->
    <div class="content-area" v-if="activeTab === 'networks'">
      <!-- Left Sidebar -->
      <div class="sidebar-panel">
        <Tabs v-model:value="sidebarMode">
          <TabList>
            <Tab value="orgs" data-track="sidebar-tab-orgs"><i class="pi pi-building" style="margin-right: 0.3rem" />Organizations</Tab>
            <Tab value="browse" data-track="sidebar-tab-browse"><i class="pi pi-list" style="margin-right: 0.3rem" />Browse</Tab>
          </TabList>
          <TabPanels>
            <TabPanel value="orgs">
              <div class="sidebar-search">
                <i class="pi pi-search search-icon"></i>
                <input type="text" v-model="filterText" placeholder="Filter networks..." class="sidebar-filter" data-track="sidebar-filter" />
              </div>

              <!-- Organizations mode -->
              <div class="sidebar-tree"
             @dragover.prevent="onTreeContainerDragOver"
             @dragenter.prevent="onTreeContainerDragEnter"
             @dragleave="onTreeContainerDragLeave"
             @drop.prevent="onTreeContainerDrop">
          <template v-for="folder in filteredFolders" :key="'folder-' + folder.id">
            <div class="tree-folder"
                 :class="{ 'drop-target': dropTargetFolderId === folder.id }"
                 @click="selectFolder(folder)"
                 @contextmenu.prevent="openFolderContextMenu($event, folder)"
                 @dragover.prevent="onFolderDragOver($event, folder.id)"
                 @dragleave="onFolderDragLeave($event, folder.id)"
                 @drop.prevent="onDropSubnet($event, folder.id)">
              <i class="pi" :class="expandedFolders[folder.id] ? 'pi-chevron-down' : 'pi-chevron-right'" style="font-size:0.65rem"
                 @click.stop="toggleFolder(folder.id)"></i>
              <i class="pi pi-building" style="font-size:0.8rem"></i>
              <span class="folder-label">{{ folder.name }}</span>
              <span class="count-badge">{{ allocatedSubnetsForFolder(folder).length }}</span>
            </div>
            <template v-if="expandedFolders[folder.id]">
              <template v-for="subnet in allocatedSubnetsForFolder(folder)" :key="'subnet-' + subnet.id">
                <div class="tree-item"
                     :class="{
                       active: selectedSubnetId === subnet.id,
                       'merge-selected': isMergeSelected(subnet.id),
                     }"
                     @click="selectSubnetById(subnet)"
                     @contextmenu.prevent="openSubnetContextMenuById($event, subnet)">
                  <div class="tree-item-row">
                    <span class="item-name">{{ subnet.cidr }}</span>
                  </div>
                  <div class="tree-item-meta">
                    <span v-if="subnet.name">{{ subnet.name }}</span>
                    <template v-if="subnet.vlan_id">
                      <span>&middot;</span>
                      <span>VLAN {{ subnet.vlan_id }}</span>
                    </template>
                  </div>
                </div>
              </template>
            </template>
          </template>
          <div v-if="filteredFolders.length === 0" class="sidebar-empty">
            No organizations found.
          </div>
        </div>
            </TabPanel>
            <TabPanel value="browse">
              <div class="sidebar-search">
                <i class="pi pi-search search-icon"></i>
                <input type="text" v-model="filterText" placeholder="Filter networks..." class="sidebar-filter" data-track="sidebar-filter-browse" />
              </div>
              <div class="sidebar-tree">
                <template v-for="item in filteredBrowseNodes" :key="item.node.key">
                  <div class="tree-item"
                       :style="{ paddingLeft: (0.75 + item.depth * 1.2) + 'rem' }"
                       :class="{
                         active: selectedSubnetId === item.node.data.id,
                         'merge-selected': isMergeSelected(item.node.data.id),
                         'tree-item-unallocated': item.node.data.status === 'unallocated',
                       }"
                       :draggable="isDraggableBrowseNode(item.node)"
                       @dragstart="onBrowseDragStart($event, item.node.data, item.node)"
                       @click="selectBrowseNode(item.node)"
                       @contextmenu.prevent="openSubnetContextMenu($event, item.node)">
                    <div class="tree-item-row">
                      <i v-if="item.node.children && item.node.children.length > 0"
                         class="pi" :class="browseExpanded[item.node.key] ? 'pi-chevron-down' : 'pi-chevron-right'"
                         style="font-size:0.6rem; margin-right: 0.25rem"
                         @click.stop="toggleBrowseExpand(item.node.key)"></i>
                      <span class="item-name">{{ item.node.data.cidr }}</span>
                      <span v-if="item.node.data.status === 'allocated'" class="status-dot allocated"></span>
                    </div>
                    <div class="tree-item-meta">
                      <span v-if="item.node.data.name">{{ item.node.data.name }}</span>
                      <span v-else-if="item.node.data.status === 'unallocated'" class="unalloc-label">unallocated</span>
                    </div>
                  </div>
                </template>
                <div v-if="filteredBrowseNodes.length === 0" class="sidebar-empty">
                  No networks found.
                </div>
              </div>
            </TabPanel>
          </TabPanels>
        </Tabs>
      </div>

      <!-- Right Detail Panel -->
      <div class="detail-panel">
        <div class="networks-toolbar">
          <Button label="Add Network" icon="pi pi-plus" size="small" text data-track="toolbar-add-network" @click="dialogs.openCreateNetwork(selectedFolder?.id)" />
        </div>
        <SubnetDetail v-if="selectedSubnetId" :subnet-id="selectedSubnetId" :compact="true" />
        <OrgNetworkTable v-else-if="selectedFolder" :folder="selectedFolder"
            :merge-selected-ids="mergeSelectedIdsRaw"
            @select-subnet="onOrgTableSelectSubnet"
            @merge-toggle="toggleMergeSelect"
            @context-menu="openSubnetContextMenu" />
        <div v-else class="empty-detail">
          <i class="pi pi-sitemap" style="font-size: 2rem; opacity: 0.3"></i>
          <span>{{ store.folders.length === 0 ? 'Add an Organization to get started' : 'Select a network' }}</span>
        </div>
      </div>
    </div>

    <!-- DNS Tab -->
    <div v-else-if="activeTab === 'dns'" class="tab-content">
      <DnsPanel ref="dnsPanelRef" :org-id="selectedOrgId" />
    </div>

    <!-- DHCP Tab -->
    <div v-else-if="activeTab === 'dhcp'" class="tab-content">
      <DhcpPanel ref="dhcpPanelRef" :org-id="selectedOrgId" />
    </div>

    <!-- Context Menus -->
    <ContextMenu ref="subnetContextMenuRef" :model="subnetContextMenuItems" />
    <ContextMenu ref="folderContextMenuRef" :model="folderContextMenuItems" />

    <!-- All Dialogs -->
    <NetworkDialogs ref="dialogs"
                    :selected-node="selectedNode"
                    :name-template="nameTemplate"
                    :merge-selected-ids="mergeSelectedIdsRaw"
                    :folders="store.folders"
                    @org-created="onTreeChanged"
                    @org-updated="onTreeChanged"
                    @org-deleted="onOrgDeleted"
                    @network-created="onTreeChanged"
                    @network-configured="onNetworkConfigured"
                    @network-updated="onTreeChanged"
                    @network-divided="onNetworkDivided"
                    @network-deleted="onNetworkDeleted"
                    @networks-merged="onNetworksMerged"
                    @group-configured="onTreeChanged" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import Select from 'primevue/select';
import Menubar from 'primevue/menubar';
import ContextMenu from 'primevue/contextmenu';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import SubnetDetail from './SubnetDetail.vue';
import OrgNetworkTable from '../components/OrgNetworkTable.vue';
import NetworkDialogs from '../components/NetworkDialogs.vue';
import { defineAsyncComponent } from 'vue';
const DnsPanel = defineAsyncComponent(() => import('../components/DnsPanel.vue'));
const DhcpPanel = defineAsyncComponent(() => import('../components/DhcpPanel.vue'));
import { useSubnetStore } from '../stores/subnets.js';
import { applyNameTemplate, canMergeCidrs } from '../utils/ip.js';

const store = useSubnetStore();
const toast = useToast();
const router = useRouter();
const dialogs = ref(null);
const dnsPanelRef = ref(null);
const dhcpPanelRef = ref(null);

// ── Top-level tab state ──
const activeTab = ref(loadJson('ipam_b_active_tab', 'networks'));

const menuItems = computed(() => [
  { key: 'networks', label: 'Networks', icon: 'pi pi-sitemap', dataTrack: 'tab-networks', command: () => { activeTab.value = 'networks'; } },
  { key: 'dns', label: 'DNS', icon: 'pi pi-globe', dataTrack: 'tab-dns', command: () => { activeTab.value = 'dns'; } },
  { key: 'dhcp', label: 'DHCP', icon: 'pi pi-server', dataTrack: 'tab-dhcp', command: () => { activeTab.value = 'dhcp'; } },
  { separator: true },
  { label: 'Settings', icon: 'pi pi-cog', dataTrack: 'toolbar-settings', command: () => { router.push('/system'); } },
]);
const selectedOrgId = ref(loadJson('ipam_b_selected_org_id', null));

const orgOptions = computed(() => [
  { id: null, name: 'All Organizations' },
  ...store.folders.map(f => ({ id: f.id, name: f.name }))
]);

// ── Persistence helpers ──
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

let _persistTimer = null;
function persistState() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      localStorage.setItem('ipam_b_selected_subnet_id', JSON.stringify(selectedSubnetId.value));
      localStorage.setItem('ipam_b_selected_folder_id', JSON.stringify(selectedFolder.value?.id || null));
      localStorage.setItem('ipam_b_sidebar_mode', JSON.stringify(sidebarMode.value));
      localStorage.setItem('ipam_b_expanded_folders', JSON.stringify(expandedFolders.value));
      localStorage.setItem('ipam_b_browse_expanded', JSON.stringify(browseExpanded.value));
      localStorage.setItem('ipam_b_active_tab', JSON.stringify(activeTab.value));
      localStorage.setItem('ipam_b_selected_org_id', JSON.stringify(selectedOrgId.value));
    } catch { /* */ }
  }, 300);
}

// ── Settings ──
const nameTemplate = ref('%1.%2.%3.%4/%bitmask');
async function loadSettings() {
  try {
    const settings = await store.getSettings();
    if (settings.subnet_name_template) nameTemplate.value = settings.subnet_name_template;
  } catch { /* use default */ }
}

// ── Sidebar state ──
const sidebarMode = ref(loadJson('ipam_b_sidebar_mode', 'orgs'));
const filterText = ref('');
const expandedFolders = ref(loadJson('ipam_b_expanded_folders', {}));
const browseExpanded = ref(loadJson('ipam_b_browse_expanded', {}));

watch(activeTab, persistState);
watch(selectedOrgId, persistState);
watch(sidebarMode, persistState);
watch(expandedFolders, persistState, { deep: true });
watch(browseExpanded, persistState, { deep: true });

// ── Selection state ──
const selectedSubnetId = ref(loadJson('ipam_b_selected_subnet_id', null));
const selectedNode = ref(null);
const selectedFolder = ref(null);

watch(selectedSubnetId, persistState);

// ── Context menu refs ──
const subnetContextMenuRef = ref(null);
const folderContextMenuRef = ref(null);

// ── Folder operations ──
function toggleFolder(folderId) {
  expandedFolders.value = { ...expandedFolders.value, [folderId]: !expandedFolders.value[folderId] };
}

function selectFolder(folder) {
  selectedFolder.value = folder;
  // Clear subnet detail so org network table shows
  selectedSubnetId.value = null;
  selectedNode.value = null;
  // Expand the folder in sidebar
  if (!expandedFolders.value[folder.id]) {
    expandedFolders.value = { ...expandedFolders.value, [folder.id]: true };
  }
}

function onOrgTableSelectSubnet(node) {
  selectedNode.value = node;
  selectedSubnetId.value = node.data.id;
}

function allocatedSubnetsForFolder(folder) {
  if (!folder.subnets) return [];
  const result = [];
  function collect(nodes) {
    for (const s of nodes) {
      if (s.status === 'allocated') result.push(s);
      if (s.children && s.children.length > 0) collect(s.children);
    }
  }
  collect(folder.subnets);
  return result;
}

function selectSubnetById(subnet) {
  if (ctrlHeld.value && subnet.id) {
    toggleMergeSelect(subnet.id);
    return;
  }
  const node = findNodeInTrees(subnet.id) || { data: subnet, key: `subnet-${subnet.id}`, children: [] };
  selectedNode.value = node;
  selectedSubnetId.value = subnet.id;
}

function openSubnetContextMenuById(event, subnet) {
  const node = findNodeInTrees(subnet.id) || { data: subnet, key: `subnet-${subnet.id}`, children: [] };
  openSubnetContextMenu(event, node);
}

// ── Subnet selection ──
function selectSubnet(node) {
  if (ctrlHeld.value && node.data.id) {
    toggleMergeSelect(node.data.id);
    return;
  }
  selectedNode.value = node;
  // Only show detail for allocated subnets (unallocated have no IP data)
  if (node.data.status === 'allocated') {
    selectedSubnetId.value = node.data.id;
  }
}

function selectBrowseNode(node) {
  if (ctrlHeld.value && node.data.id) {
    toggleMergeSelect(node.data.id);
    return;
  }
  selectedNode.value = node;
  if (node.data.status === 'allocated') {
    selectedSubnetId.value = node.data.id;
  }
}

function toggleBrowseExpand(key) {
  browseExpanded.value = { ...browseExpanded.value, [key]: !browseExpanded.value[key] };
}

// ── Filtered data ──
const filteredFolders = computed(() => {
  const q = filterText.value.toLowerCase().trim();
  let folders = store.folders;
  if (selectedOrgId.value != null) {
    folders = folders.filter(f => f.id === selectedOrgId.value);
  }
  if (!q) return folders;
  return folders.filter(f => {
    if (f.name.toLowerCase().includes(q)) return true;
    if (f.subnets?.some(s => s.cidr.includes(q) || s.name?.toLowerCase().includes(q))) return true;
    return false;
  });
});

const filteredBrowseNodes = computed(() => {
  const flat = [];
  const orgId = selectedOrgId.value;
  function flatten(nodes, depth) {
    for (const n of nodes) {
      // Filter by org at root level (depth 0)
      if (orgId != null && depth === 0 && n.data.folder_id !== orgId) continue;
      const q = filterText.value.toLowerCase().trim();
      const match = !q || n.data.cidr.includes(q) || n.data.name?.toLowerCase().includes(q);
      if (match) flat.push({ node: n, depth });
      if (n.children && n.children.length > 0 && (browseExpanded.value[n.key] || q)) {
        flatten(n.children, depth + 1);
      }
    }
  }
  flatten(store.unallocatedTreeNodes, 0);
  return flat;
});

// ── Context menus ──
const contextNode = ref(null);
const contextFolder = ref(null);

function openSubnetContextMenu(event, node) {
  contextNode.value = node;
  selectedNode.value = node;
  subnetContextMenuRef.value.show(event);
}

function openFolderContextMenu(event, folder) {
  contextFolder.value = folder;
  folderContextMenuRef.value.show(event);
}

const subnetContextMenuItems = computed(() => {
  const node = contextNode.value;
  if (!node) return [];
  const d = node.data;
  const isLeaf = (d.child_count || 0) === 0 && (!node.children || node.children.length === 0);
  const items = [];

  if (isLeaf) {
    items.push({ label: 'Divide', icon: 'pi pi-share-alt', command: () => dialogs.value.openDivide(node) });
  }
  items.push({ label: 'Edit', icon: 'pi pi-pencil', command: () => dialogs.value.openEdit(node) });

  if (d.parent_id) {
    if (mergeSelectedIdsRaw.value.length >= 2 && mergeValidation.value.valid) {
      items.push({ label: 'Merge Selected', icon: 'pi pi-sitemap', command: () => dialogs.value.openMergeConfirm(mergeSelectedIdsRaw.value) });
    } else {
      items.push({ label: 'Merge...', icon: 'pi pi-sitemap', command: () => {
        if (!isMergeSelected(d.id)) toggleMergeSelect(d.id);
        if (mergeSelectedIdsRaw.value.length >= 2 && mergeValidation.value.valid) {
          dialogs.value.openMergeConfirm(mergeSelectedIdsRaw.value);
        }
      }});
    }
  }

  if (d.status === 'allocated') {
    const expected = applyNameTemplate(nameTemplate.value, d.cidr);
    if (d.name !== expected) {
      items.push({ label: 'Apply Template', icon: 'pi pi-sync', command: () => dialogs.value.executeApplyTemplate([d.id]) });
    }
  }

  items.push({ separator: true });
  if (d.status === 'allocated') {
    items.push({ label: 'Deallocate', icon: 'pi pi-undo', class: 'p-error', command: () => dialogs.value.openDeallocate(node) });
  } else {
    items.push({ label: 'Delete', icon: 'pi pi-trash', class: 'p-error', command: () => dialogs.value.openDelete(node) });
  }
  return items;
});

const folderContextMenuItems = computed(() => {
  const f = contextFolder.value;
  if (!f) return [];
  return [
    { label: 'Edit Organization', icon: 'pi pi-pencil', command: () => dialogs.value.openEditFolder(f) },
    { separator: true },
    { label: 'Delete Organization', icon: 'pi pi-trash', class: 'p-error', command: () => dialogs.value.openDeleteFolder(f) },
  ];
});

// ── Merge multi-select ──
const mergeSelectedIdsRaw = ref([]);

function isMergeSelected(id) {
  return mergeSelectedIdsRaw.value.includes(id);
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

function toggleMergeSelect(id) {
  const idx = mergeSelectedIdsRaw.value.indexOf(id);
  if (idx >= 0) {
    mergeSelectedIdsRaw.value.splice(idx, 1);
    return;
  }
  const subnet = findSubnetInTree(id);
  if (!subnet || !subnet.parent_id) {
    toast.add({ severity: 'warn', summary: 'Cannot merge', detail: 'Root networks cannot be merged', life: 3000 });
    return;
  }
  const hasChildren = (subnet.child_count || 0) > 0 || (subnet.children && subnet.children.length > 0);
  if (hasChildren) {
    toast.add({ severity: 'warn', summary: 'Cannot merge', detail: 'Network has children and cannot be merged', life: 3000 });
    return;
  }
  if (mergeSelectedIdsRaw.value.length > 0) {
    const firstSubnet = findSubnetInTree(mergeSelectedIdsRaw.value[0]);
    if (!firstSubnet) return;
    if (subnet.parent_id !== firstSubnet.parent_id) {
      toast.add({ severity: 'warn', summary: 'Cannot merge', detail: 'Networks must be siblings (same parent)', life: 3000 });
      return;
    }
    if (subnet.prefix_length !== firstSubnet.prefix_length) {
      toast.add({ severity: 'warn', summary: 'Cannot merge', detail: 'All networks must have the same prefix length', life: 3000 });
      return;
    }
  }
  mergeSelectedIdsRaw.value.push(id);
}

const mergeValidation = computed(() => {
  if (mergeSelectedIdsRaw.value.length < 2) return { valid: false, error: '' };
  const cidrs = mergeSelectedIdsRaw.value.map(id => {
    const s = findSubnetInTree(id);
    return s?.cidr;
  }).filter(Boolean);
  if (cidrs.length < 2) return { valid: false, error: 'Cannot find network' };
  return canMergeCidrs(cidrs);
});

function clearMergeSelection() {
  mergeSelectedIdsRaw.value = [];
}

// ── Ctrl key tracking ──
const ctrlHeld = ref(false);
function onKeyDown(e) { if (e.ctrlKey || e.metaKey) ctrlHeld.value = true; }
function onKeyUp(e) { if (!e.ctrlKey && !e.metaKey) ctrlHeld.value = false; }

// ── Drag & drop ──
const dropTargetFolderId = ref(null);

function onFolderDragOver(event, folderId) {
  event.dataTransfer.dropEffect = 'move';
  dropTargetFolderId.value = folderId;
}

function onFolderDragLeave(event, folderId) {
  if (dropTargetFolderId.value === folderId) dropTargetFolderId.value = null;
}

function onTreeContainerDragOver(event) {
  if (selectedFolder.value) {
    event.dataTransfer.dropEffect = 'move';
    dropTargetFolderId.value = selectedFolder.value.id;
  }
}

function onTreeContainerDragEnter() {
  if (selectedFolder.value) dropTargetFolderId.value = selectedFolder.value.id;
}

function onTreeContainerDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) dropTargetFolderId.value = null;
}

function onTreeContainerDrop(event) {
  if (selectedFolder.value) onDropSubnet(event, selectedFolder.value.id);
}

function onDropSubnet(event, folderId) {
  dropTargetFolderId.value = null;
  const subnetIdsJson = event.dataTransfer.getData('application/x-subnet-ids');
  const subnetId = event.dataTransfer.getData('application/x-subnet-id');
  const cidr = event.dataTransfer.getData('text/plain');

  if (subnetIdsJson) {
    const leafIds = JSON.parse(subnetIdsJson);
    dialogs.value.openGroupConfigure(leafIds, folderId);
    return;
  }
  if (!subnetId) return;

  const subnet = findSubnetInTree(parseInt(subnetId, 10));
  if (!subnet) return;

  selectedNode.value = { data: { ...subnet, type: 'subnet' }, key: `subnet-${subnet.id}`, children: subnet.children || [] };
  dialogs.value.openEdit(selectedNode.value, folderId);
}

function isDraggableBrowseNode(node) {
  if (node.data.status === 'allocated') return false;
  if (node.leaf || !node.children || node.children.length === 0) return true;
  if (node.data.parent_id) return true;
  return false;
}

function collectLeafIds(node) {
  if (node.leaf || !node.children || node.children.length === 0) return [node.data.id];
  const ids = [];
  for (const child of node.children) ids.push(...collectLeafIds(child));
  return ids;
}

function onBrowseDragStart(event, subnet, node) {
  const isGroup = node && !node.leaf && node.children && node.children.length > 0;
  if (isGroup) {
    const leafIds = collectLeafIds(node);
    event.dataTransfer.setData('application/x-subnet-ids', JSON.stringify(leafIds));
    event.dataTransfer.setData('application/x-subnet-id', String(subnet.id));
  } else {
    event.dataTransfer.setData('application/x-subnet-id', String(subnet.id));
  }
  event.dataTransfer.setData('text/plain', subnet.cidr);
  event.dataTransfer.effectAllowed = 'move';
}

// ── Event handlers from dialogs ──
function onTreeChanged() {
  // Tree is auto-refreshed by store — just update stale refs
  refreshSelectionRefs();
}

function onOrgDeleted(folderId) {
  if (selectedFolder.value?.id === folderId) {
    selectedFolder.value = null;
    selectedSubnetId.value = null;
    selectedNode.value = null;
  }
}

function onNetworkConfigured(subnetId) {
  selectedSubnetId.value = subnetId;
  refreshSelectionRefs();
}

function onNetworkDivided(nodeId) {
  // Expand the divided node in browse tree
  const key = `subnet-${nodeId}`;
  browseExpanded.value = { ...browseExpanded.value, [key]: true };
  refreshSelectionRefs();
}

function onNetworkDeleted(deletedId) {
  if (selectedSubnetId.value === deletedId) {
    selectedSubnetId.value = null;
    selectedNode.value = null;
  }
}

function onNetworksMerged() {
  clearMergeSelection();
  refreshSelectionRefs();
}

function refreshSelectionRefs() {
  if (selectedSubnetId.value) {
    const node = findNodeInTrees(selectedSubnetId.value);
    if (node) selectedNode.value = node;
  }
}

function findNodeInTrees(subnetId) {
  function search(nodes) {
    for (const n of nodes) {
      if (n.data.id === subnetId && n.data.type !== 'folder') return n;
      if (n.children) {
        const found = search(n.children);
        if (found) return found;
      }
    }
    return null;
  }
  return search(store.allocatedTreeNodes) || search(store.unallocatedTreeNodes);
}

// Refresh stale folder/node refs after store updates
watch(() => store.folders, () => {
  if (selectedFolder.value) {
    const fresh = store.folders.find(f => f.id === selectedFolder.value.id);
    if (fresh) selectedFolder.value = fresh;
  }
  refreshSelectionRefs();
}, { deep: false });

// ── Lifecycle ──
onMounted(async () => {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  await Promise.all([store.fetchTree(), loadSettings()]);

  // Auto-expand first folder
  if (store.folders.length > 0) {
    const firstId = store.folders[0].id;
    if (!expandedFolders.value[firstId]) {
      expandedFolders.value = { ...expandedFolders.value, [firstId]: true };
    }
  }

  // Restore selection
  if (selectedSubnetId.value) {
    const node = findNodeInTrees(selectedSubnetId.value);
    if (node) {
      selectedNode.value = node;
    } else {
      // Subnet no longer exists — clear so folder restoration kicks in
      selectedSubnetId.value = null;
    }
  }

  // Restore folder selection
  if (!selectedSubnetId.value) {
    const savedFolderId = loadJson('ipam_b_selected_folder_id', null);
    if (savedFolderId) {
      const folder = store.folders.find(f => f.id === savedFolderId);
      if (folder) selectedFolder.value = folder;
    } else if (store.folders.length > 0) {
      selectedFolder.value = store.folders[0];
    }
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
});
</script>

<style scoped>
.layout-b {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* ── Menubar ── */
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.org-selector {
  min-width: 10rem;
  font-size: 0.8rem;
}
.toolbar-divider {
  width: 1px;
  height: 1.2rem;
  background: var(--p-surface-border);
}
:deep(.p-menubar-item-content) {
  padding: 0.45rem 0.65rem !important;
}
:deep(.active-menuitem) {
  background: color-mix(in srgb, var(--p-primary-color) 15%, transparent) !important;
  color: var(--p-primary-color) !important;
  font-weight: 600;
}

.tab-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.merge-badge {
  font-size: 0.8rem;
  background: color-mix(in srgb, var(--p-orange-500) 20%, transparent);
  color: var(--p-orange-500);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 500;
}

/* ── Content Area ── */
.content-area {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 1.5rem;
  flex: 1;
  min-height: 0;
}

/* ── Sidebar ── */
.sidebar-panel {
  background: var(--p-content-background);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  overflow: hidden;
  color: var(--p-text-color);
}
.sidebar-panel :deep(.p-tabpanels) {
  padding: 0;
}
.sidebar-panel :deep(.p-tablist) {
  background: var(--p-surface-ground);
}

.sidebar-search {
  display: flex;
  align-items: center;
  padding: 0 0.6rem;
  border-bottom: 1px solid var(--p-surface-border);
  gap: 0.4rem;
  height: 2.4rem;
  box-sizing: border-box;
  flex-shrink: 0;
}
.search-icon {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
.sidebar-filter {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--p-text-color);
  font-size: 0.8rem;
  outline: none;
}
.sidebar-filter::placeholder {
  color: var(--p-text-muted-color);
}
.sidebar-tree {
  flex: 1;
  overflow-y: auto;
  padding: 0.25rem 0;
}
.sidebar-empty {
  padding: 1rem;
  text-align: center;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}

/* ── Tree items ── */
.tree-folder {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.5rem 1rem;
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--p-text-color);
  cursor: pointer;
  border-bottom: 1px solid var(--p-surface-border);
  transition: background 0.15s;
}
.tree-folder:hover {
  background: var(--p-highlight-background);
}
.tree-folder.drop-target {
  background: var(--p-highlight-background);
}
.folder-label {
  flex: 1;
}
.count-badge {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
  font-weight: 400;
}
.tree-item {
  padding: 0.6rem 1rem 0.6rem 2rem;
  cursor: pointer;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--p-surface-border);
  transition: background 0.15s;
}
.tree-item:hover {
  background: var(--p-highlight-background);
}
.tree-item.active {
  background: var(--p-highlight-background);
  border-left-color: var(--p-primary-color);
}
.tree-item.merge-selected {
  background: color-mix(in srgb, var(--p-orange-500) 15%, transparent);
  border-left-color: var(--p-orange-500);
}
.tree-item-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.item-name {
  font-size: 0.85rem;
  font-weight: 500;
  font-family: monospace;
}
.tree-item-meta {
  display: flex;
  gap: 0.35rem;
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
  margin-top: 0.15rem;
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.allocated {
  background: #22c55e;
}
.unalloc-label {
  font-style: italic;
}
.tree-item-unallocated {
  opacity: 0.75;
}

/* ── Detail Panel ── */
.detail-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.networks-toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--p-surface-border);
  flex-shrink: 0;
}
.networks-toolbar .toolbar-divider {
  width: 1px;
  height: 1.2rem;
  background: var(--p-surface-border);
}
.empty-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}

/* Pulse animation for empty-state call to action */
.pulse-attention {
  animation: pulse-glow 2s ease-in-out infinite;
}
@keyframes pulse-glow {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
</style>
