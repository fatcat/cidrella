<template>
  <div class="layout-b">
    <!-- Left rail, mirrors Analytics / System layout (user-requested 2026-04-18) -->
    <aside class="ipam-sidebar">
      <nav class="ipam-nav">
        <a v-for="item in menuItems" :key="item.key"
           class="ipam-nav-item" :class="{ active: item.key === activeTab }"
           :data-track="item.dataTrack" @click="activeTab = item.key">
          <i :class="item.icon"></i>
          <span>{{ item.label }}</span>
        </a>
      </nav>
    </aside>

    <div class="ipam-content">
    <!-- Networks Tab -->
    <div class="content-area" v-if="activeTab === 'networks'">
      <!-- Left Sidebar -->
      <div class="sidebar-panel">
        <Tabs v-model:value="sidebarMode">
          <TabList>
            <Tab value="folders" data-track="sidebar-tab-folders"><i class="pi pi-folder" style="margin-right: 0.3rem" />Folders</Tab>
            <Tab value="browse" data-track="sidebar-tab-browse"><i class="pi pi-list" style="margin-right: 0.3rem" />Browse Unallocated</Tab>
          </TabList>
          <TabPanels>
            <TabPanel value="folders">
              <div class="sidebar-search">
                <i class="pi pi-search search-icon"></i>
                <input type="text" v-model="filterText" placeholder="Filter networks..." class="sidebar-filter" data-track="sidebar-filter" />
              </div>

              <!-- Folders mode -->
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
              <i class="pi pi-folder" style="font-size:0.8rem"></i>
              <span class="folder-label">{{ folder.name }}</span>
              <span class="count-badge">{{ allocatedSubnetsForFolder(folder).length }}</span>
            </div>
            <template v-if="expandedFolders[folder.id] || filterText.trim()">
              <template v-for="subnet in allocatedSubnetsForFolder(folder)" :key="'subnet-' + subnet.id">
                <div class="tree-item"
                     :class="{
                       active: selectedSubnetId === subnet.id,
                       'merge-selected': isMergeSelected(subnet.id),
                     }"
                     :draggable="true"
                     @dragstart="onFolderSubnetDragStart($event, subnet)"
                     @click="selectSubnetById(subnet)"
                     @contextmenu.prevent="openSubnetContextMenuById($event, subnet)">
                  <div class="tree-item-row">
                    <span class="item-name">{{ subnet.cidr }}</span>
                    <span class="tree-item-actions">
                      <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                              @click.stop="openSubnetEditById(subnet)" data-track="sidebar-net-edit" />
                      <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                              @click.stop="openSubnetDeleteById(subnet)" data-track="sidebar-net-delete" />
                    </span>
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
          <!-- Ungrouped networks drop zone -->
          <div class="tree-folder ungrouped-zone"
               :class="{ 'drop-target': dropTargetFolderId === 'ungrouped' }"
               @dragover.prevent="onUngroupedDragOver"
               @dragleave="onUngroupedDragLeave"
               @drop.prevent="onDropUngrouped">
            <i class="pi pi-inbox" style="font-size:0.8rem"></i>
            <span class="folder-label">Ungrouped</span>
            <span class="count-badge">{{ ungroupedSubnets.length }}</span>
          </div>
          <template v-for="subnet in ungroupedSubnets" :key="'ungrouped-' + subnet.id">
            <div class="tree-item"
                 :class="{
                   active: selectedSubnetId === subnet.id,
                   'merge-selected': isMergeSelected(subnet.id),
                 }"
                 :draggable="true"
                 @dragstart="onUngroupedDragStart($event, subnet)"
                 @click="selectSubnetById(subnet)"
                 @contextmenu.prevent="openSubnetContextMenuById($event, subnet)">
              <div class="tree-item-row">
                <span class="item-name">{{ subnet.cidr }}</span>
                <span class="tree-item-actions">
                  <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                          @click.stop="openSubnetEditById(subnet)" data-track="sidebar-net-edit" />
                  <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                          @click.stop="openSubnetDeleteById(subnet)" data-track="sidebar-net-delete" />
                </span>
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
          <div v-if="filteredFolders.length === 0 && ungroupedSubnets.length === 0" class="sidebar-empty">
            No folders or networks found.
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
                       @click="selectNode(item.node)"
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
          <Button label="Add Folder" icon="pi pi-plus" size="small" data-track="toolbar-add-folder" @click="dialogs.openCreateFolder()" text />
          <Button label="Add Network" icon="pi pi-plus" size="small" data-track="toolbar-add-network-top" @click="dialogs.openQuickAddNetwork()" text />
          <template v-if="mergeSelectedIdsRaw.length > 0">
            <span class="toolbar-divider"></span>
            <span class="badge badge-orange">{{ mergeSelectedIdsRaw.length }} selected</span>
            <Button v-if="mergeSelectedIdsRaw.length >= 2 && mergeValidation.valid"
                    label="Merge" icon="pi pi-sitemap" size="small" severity="warn"
                    data-track="toolbar-merge" @click="dialogs.openMergeConfirm(mergeSelectedIdsRaw)" />
            <Button label="Cancel" size="small" severity="secondary" text data-track="toolbar-merge-cancel" @click="clearMergeSelection" />
          </template>
        </div>
        <SubnetDetail v-if="selectedSubnetId" :subnet-id="selectedSubnetId" :compact="true" />
        <FolderNetworkTable v-else-if="selectedFolder" :folder="selectedFolder"
            :merge-selected-ids="mergeSelectedIdsRaw"
            @select-subnet="onFolderTableSelectSubnet"
            @merge-toggle="toggleMergeSelect"
            @context-menu="openSubnetContextMenu"
            @edit-subnet="node => dialogs.openEdit(node)"
            @delete-subnet="node => dialogs.openDelete(node)" />
        <EmptyState v-else-if="isFirstRunEmpty"
          icon="pi-sitemap"
          title="No networks yet"
          description="Add a folder to organize subnets, or add a network directly to get started."
          :actions="[
            { label: 'Add Folder', icon: 'pi-folder-plus', severity: 'secondary', dataTrack: 'empty-add-folder', onClick: () => dialogs.openCreateFolder() },
            { label: 'Add Network', icon: 'pi-plus', severity: 'primary', dataTrack: 'empty-add-network', onClick: () => dialogs.openQuickAddNetwork() }
          ]" />
        <div v-else class="empty-detail">
          <i class="pi pi-sitemap" style="font-size: 2rem; opacity: 0.3"></i>
          <span>Select a network to view details</span>
        </div>
      </div>
    </div>

    <!-- DNS Tab -->
    <div v-else-if="activeTab === 'dns'" class="tab-content">
      <DnsPanel ref="dnsPanelRef" />
    </div>

    <!-- DHCP Tab -->
    <div v-else-if="activeTab === 'dhcp'" class="tab-content">
      <DhcpPanel ref="dhcpPanelRef" />
    </div>
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
                    @folder-created="onTreeChanged"
                    @folder-updated="onTreeChanged"
                    @folder-deleted="onFolderDeleted"
                    @network-created="onNetworkCreated"
                    @network-configured="onNetworkConfigured"
                    @network-updated="onTreeChanged"
                    @network-divided="onNetworkDivided"
                    @network-deleted="onNetworkDeleted"
                    @networks-merged="onNetworksMerged"
                    @group-configured="onTreeChanged" />

    <!-- Scope dialog shared by the "Add DHCP Scope" context menu item. The
         subnet row is passed as `subnetCtx` so gateway, subnet-mask, and
         domain-name options pre-populate from the network. -->
    <ScopeDialog ref="scopeDialogRef" @saved="onTreeChanged" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import ContextMenu from 'primevue/contextmenu';
import EmptyState from '../components/EmptyState.vue';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import SubnetDetail from './SubnetDetail.vue';
import FolderNetworkTable from '../components/FolderNetworkTable.vue';
import NetworkDialogs from '../components/NetworkDialogs.vue';
import ScopeDialog from '../components/ScopeDialog.vue';
import { defineAsyncComponent } from 'vue';
const DnsPanel = defineAsyncComponent(() => import('../components/DnsPanel.vue'));
const DhcpPanel = defineAsyncComponent(() => import('../components/DhcpPanel.vue'));
import { useSubnetStore } from '../stores/subnets.js';
import { loadJson, saveJson } from '../utils/storage.js';
import { collectAllocatedSubnets } from '../utils/tree.js';
import { apiError } from '../utils/format.js';
import { applyNameTemplate, canMergeCidrs } from '../utils/ip.js';

const store = useSubnetStore();
const toast = useToast();
const dialogs = ref(null);
const dnsPanelRef = ref(null);
const dhcpPanelRef = ref(null);

// ── Top-level tab state ──
const activeTab = ref(loadJson('cidrella_b_active_tab', 'networks'));

const menuItems = computed(() => [
  { key: 'networks', label: 'Networks', icon: 'pi pi-sitemap', dataTrack: 'tab-networks', command: () => { activeTab.value = 'networks'; } },
  { key: 'dns', label: 'DNS', icon: 'pi pi-globe', dataTrack: 'tab-dns', command: () => { activeTab.value = 'dns'; } },
  { key: 'dhcp', label: 'DHCP', icon: 'pi pi-server', dataTrack: 'tab-dhcp', command: () => { activeTab.value = 'dhcp'; } },
]);

// ── Persistence helpers ──
let _persistTimer = null;
function persistState() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      saveJson('cidrella_b_selected_subnet_id', selectedSubnetId.value);
      saveJson('cidrella_b_selected_folder_id', selectedFolder.value?.id || null);
      saveJson('cidrella_b_sidebar_mode', sidebarMode.value);
      saveJson('cidrella_b_expanded_folders', expandedFolders.value);
      saveJson('cidrella_b_browse_expanded', browseExpanded.value);
      saveJson('cidrella_b_expanded_unallocated', expandedUnallocated.value);
      saveJson('cidrella_b_active_tab', activeTab.value);
    } catch { /* */ }
  }, 300);
}

// ── Settings ──
const nameTemplate = ref('%1.%2.%3.%4/%bitmask');
async function loadSettings() {
  try {
    const settings = await store.getSettings();
    if (settings.subnet_name_template) nameTemplate.value = settings.subnet_name_template;
    return settings;
  } catch { return null; }
}

// ── Sidebar state ──
const sidebarMode = ref(loadJson('cidrella_b_sidebar_mode', 'folders'));
const filterText = ref('');
const expandedFolders = ref(loadJson('cidrella_b_expanded_folders', {}));
const browseExpanded = ref(loadJson('cidrella_b_browse_expanded', {}));
const expandedUnallocated = ref(loadJson('cidrella_b_expanded_unallocated', false));

watch(activeTab, persistState);
watch(sidebarMode, persistState);
watch(expandedFolders, persistState, { deep: true });
watch(browseExpanded, persistState, { deep: true });
watch(expandedUnallocated, persistState);

// ── Selection state ──
const selectedSubnetId = ref(loadJson('cidrella_b_selected_subnet_id', null));
const selectedNode = ref(null);
const selectedFolder = ref(null);

watch(selectedSubnetId, persistState);

// ── Context menu refs ──
const subnetContextMenuRef = ref(null);
const folderContextMenuRef = ref(null);
const scopeDialogRef = ref(null);

// ── Folder operations ──
function toggleFolder(folderId) {
  expandedFolders.value = { ...expandedFolders.value, [folderId]: !expandedFolders.value[folderId] };
}

function selectFolder(folder) {
  clearMergeSelection();
  selectedFolder.value = folder;
  // Clear subnet detail so folder network table shows
  selectedSubnetId.value = null;
  selectedNode.value = null;
  // Expand the folder in sidebar
  if (!expandedFolders.value[folder.id]) {
    expandedFolders.value = { ...expandedFolders.value, [folder.id]: true };
  }
}

function onFolderTableSelectSubnet(node) {
  selectedNode.value = node;
  selectedSubnetId.value = node.data.id;
}

function allocatedSubnetsForFolder(folder) {
  if (!folder.subnets) return [];
  return collectAllocatedSubnets(folder.subnets, filterText.value.trim());
}

function selectSubnetById(subnet) {
  if (ctrlHeld.value && subnet.id) {
    toggleMergeSelect(subnet.id);
    return;
  }
  clearMergeSelection();
  const node = findNodeInTrees(subnet.id) || { data: subnet, key: `subnet-${subnet.id}`, children: [] };
  selectedNode.value = node;
  selectedSubnetId.value = subnet.id;
}

function openSubnetContextMenuById(event, subnet) {
  const node = findNodeInTrees(subnet.id) || { data: subnet, key: `subnet-${subnet.id}`, children: [] };
  openSubnetContextMenu(event, node);
}

function subnetToNode(subnet) {
  return findNodeInTrees(subnet.id) || { data: subnet, key: `subnet-${subnet.id}`, children: [] };
}

function openSubnetEditById(subnet) {
  const node = subnetToNode(subnet);
  // NetworkDialogs reads from props.selectedNode on save, so keep parent state
  // in sync with whichever row the pencil/trash icon was clicked on.
  selectedNode.value = node;
  dialogs.value.openEdit(node);
}

function openSubnetDeleteById(subnet) {
  const node = subnetToNode(subnet);
  selectedNode.value = node;
  dialogs.value.openDelete(node);
}

// ── Subnet selection ──
function selectNode(node) {
  if (ctrlHeld.value && node.data.id) {
    toggleMergeSelect(node.data.id);
    return;
  }
  clearMergeSelection();
  selectedNode.value = node;
  // Only show detail for allocated subnets (unallocated have no IP data)
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
  // Exclude the virtual "Ungrouped" folder (id=null), shown separately
  const realFolders = store.folders.filter(f => f.id !== null);
  if (!q) return realFolders;
  return realFolders.filter(f => {
    if (f.name.toLowerCase().includes(q)) return true;
    // Deep check: any subnet (allocated or not) matches
    if (f.subnets && allocatedSubnetsForFolder(f).length > 0) return true;
    return false;
  });
});

// Ungrouped subnets: from virtual folder with id=null (created by server)
const ungroupedSubnets = computed(() => {
  const ungroupedFolder = store.folders.find(f => f.id === null);
  if (!ungroupedFolder?.subnets) return [];
  return collectAllocatedSubnets(ungroupedFolder.subnets, filterText.value.trim());
});

// True empty state, zero real folders AND zero subnets anywhere.
const isFirstRunEmpty = computed(() => {
  const realFolders = store.folders.filter(f => f.id !== null);
  const anySubnets = store.folders.some(f => f.subnets && f.subnets.length > 0);
  return realFolders.length === 0 && !anySubnets;
});

const filteredBrowseNodes = computed(() => {
  const flat = [];
  function flatten(nodes, depth) {
    for (const n of nodes) {
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

  if (d.status !== 'allocated') {
    items.push({ label: 'Allocate', icon: 'pi pi-check-circle', command: () => dialogs.value.openEdit(node) });
  }
  if (isLeaf) {
    items.push({ label: 'Divide', icon: 'pi pi-share-alt', command: () => dialogs.value.openDivide(node) });
  }
  if (d.status === 'allocated') {
    items.push({ label: 'Edit', icon: 'pi pi-pencil', command: () => dialogs.value.openEdit(node) });
  }

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

  // Quick entry point to create a DHCP scope targeted at this subnet. Only
  // makes sense for allocated leaves, divided subnets can't host a scope
  // and unallocated ones have nothing to scope against. `openNewWithPicker`
  // pre-selects subnet mask, gateway, and domain options from the subnet.
  if (d.status === 'allocated' && isLeaf) {
    items.push({
      label: 'Add DHCP Scope',
      icon: 'pi pi-server',
      command: () => scopeDialogRef.value?.openNewWithPicker(d)
    });
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
    { label: 'Edit Folder', icon: 'pi pi-pencil', command: () => dialogs.value.openEditFolder(f) },
    { separator: true },
    { label: 'Delete Folder', icon: 'pi pi-trash', class: 'p-error', command: () => dialogs.value.openDeleteFolder(f) },
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

async function onDropSubnet(event, folderId) {
  dropTargetFolderId.value = null;
  const subnetIdsJson = event.dataTransfer.getData('application/x-subnet-ids');
  const subnetId = event.dataTransfer.getData('application/x-subnet-id');

  if (subnetIdsJson) {
    const leafIds = JSON.parse(subnetIdsJson);
    dialogs.value.openGroupConfigure(leafIds, folderId);
    return;
  }
  if (!subnetId) return;

  const subnet = findSubnetInTree(parseInt(subnetId, 10));
  if (!subnet) return;

  // Skip if already in this folder
  if (subnet.folder_id === folderId) return;

  try {
    await store.updateSubnet(subnet.id, { folder_id: folderId });
    const folder = store.folders.find(f => f.id === folderId);
    toast.add({ severity: 'success', summary: 'Moved', detail: `${subnet.cidr} moved to ${folder?.name || 'folder'}`, life: 2000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 3000 });
  }
}

function onFolderSubnetDragStart(event, subnet) {
  event.dataTransfer.setData('application/x-subnet-id', String(subnet.id));
  event.dataTransfer.setData('text/plain', subnet.cidr);
  event.dataTransfer.effectAllowed = 'move';
}

function onUngroupedDragOver(event) {
  event.dataTransfer.dropEffect = 'move';
  dropTargetFolderId.value = 'ungrouped';
}

function onUngroupedDragLeave() {
  if (dropTargetFolderId.value === 'ungrouped') dropTargetFolderId.value = null;
}

async function onDropUngrouped(event) {
  dropTargetFolderId.value = null;
  const subnetId = event.dataTransfer.getData('application/x-subnet-id');
  if (!subnetId) return;
  const subnet = findSubnetInTree(parseInt(subnetId, 10));
  if (!subnet || !subnet.folder_id) return;
  try {
    await store.updateSubnet(subnet.id, { folder_id: null });
    toast.add({ severity: 'success', summary: 'Moved', detail: `${subnet.cidr} moved to ungrouped`, life: 2000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 3000 });
  }
}

function onUngroupedDragStart(event, subnet) {
  event.dataTransfer.setData('application/x-subnet-id', String(subnet.id));
  event.dataTransfer.setData('text/plain', subnet.cidr);
  event.dataTransfer.effectAllowed = 'move';
}

// ── Event handlers from dialogs ──
function onTreeChanged() {
  // Tree is auto-refreshed by store, just update stale refs
  refreshSelectionRefs();
}

function onNetworkCreated() {
  refreshSelectionRefs();
  sidebarMode.value = 'browse';
}

function onFolderDeleted(folderId) {
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
  const [, settings] = await Promise.all([store.fetchTree(), loadSettings()]);

  // Auto-trigger first-time wizard if no networks exist and wizard not completed
  if (store.subnetCount === 0 && settings?.setup_wizard_completed !== '1') {
    dialogs.value?.openWizard();
  }

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
      // Subnet no longer exists, clear so folder restoration kicks in
      selectedSubnetId.value = null;
    }
  }

  // Restore folder selection
  if (!selectedSubnetId.value) {
    const savedFolderId = loadJson('cidrella_b_selected_folder_id', null);
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
  flex-direction: row;
  height: 100%;
  overflow: hidden;
  box-sizing: border-box;
}

/* ── IP Management left rail ── */
.ipam-sidebar {
  width: 180px;
  flex-shrink: 0;
  background: var(--p-surface-card);
  border-right: 1px solid var(--p-surface-border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.ipam-nav {
  display: flex;
  flex-direction: column;
  padding: 0.25rem 0;
}
.ipam-nav-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  font-size: var(--app-fs-base);
  color: var(--p-text-color);
  text-decoration: none;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.1s, border-color 0.1s;
}
.ipam-nav-item:hover {
  background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
}
.ipam-nav-item.active {
  background: color-mix(in srgb, var(--p-primary-color) 15%, transparent);
  color: var(--p-primary-color);
  font-weight: 600;
  border-left-color: var(--p-primary-color);
}
.ipam-nav-item i {
  width: 1.25rem;
  text-align: center;
  font-size: var(--app-fs-md);
}

.ipam-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tab-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
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
  display: flex;
  flex-direction: column;
  min-height: 0;
}
/* Force PrimeVue Tabs chain to participate in the flex column so .sidebar-tree
   can own a bounded height and scroll. Without these, TabPanels grows to fit
   the content and the parent panel's `overflow: hidden` just clips. */
.sidebar-panel :deep(.p-tabs) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.sidebar-panel :deep(.p-tabpanels) {
  padding: 0;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sidebar-panel :deep(.p-tabpanel) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sidebar-panel :deep(.p-tablist) {
  background: var(--p-surface-ground);
  flex-shrink: 0;
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
  font-size: var(--app-fs-sm);
  color: var(--p-text-muted-color);
}
.sidebar-filter {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--p-text-color);
  font-size: var(--app-fs-sm);
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
  font-size: var(--app-fs-sm);
  color: var(--p-text-muted-color);
}

/* ── Tree items ── */
.tree-folder {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  font-weight: 600;
  font-size: var(--app-fs-md);
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
.ungrouped-zone {
  border-top: 1px solid var(--p-surface-border);
  margin-top: 0.25rem;
  font-weight: 500;
  opacity: 0.8;
}
.unallocated-zone {
  border-top: 1px solid var(--p-surface-border);
  margin-top: 0.25rem;
  font-weight: 500;
  opacity: 0.7;
}
.folder-label {
  flex: 1;
}
.count-badge {
  font-size: var(--app-fs-xs);
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
.tree-item[draggable="true"] {
  cursor: grab;
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
.tree-item-actions {
  display: flex;
  gap: 0.1rem;
  margin-left: auto;
  flex-shrink: 0;
}
.item-name {
  font-size: var(--app-fs-md);
  font-weight: 500;
  font-family: monospace;
  color: var(--p-text-color);
}
.tree-item-meta {
  display: flex;
  gap: 0.5rem;
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
  margin-top: 0.15rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.allocated {
  background: var(--p-green-500);
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
  font-size: var(--app-fs-base);
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
