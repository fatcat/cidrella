<template>
  <div class="subnets-page">
    <div class="split-pane">
      <!-- Left Pane: Tree -->
      <div class="left-pane" :style="{ width: leftPaneWidth + 'px' }">
        <div class="pane-header">
          <h3 style="margin:0">Subnets</h3>
          <div class="header-actions">
            <template v-if="mergeSelectedIds.length > 0">
              <Button icon="pi pi-times" severity="secondary" size="small" text @click="clearMergeSelection" title="Cancel merge" />
              <Button label="Merge" icon="pi pi-sitemap" size="small" @click="openMergeConfirm"
                      :disabled="mergeSelectedIds.length < 2 || !mergeValidation.valid" :badge="String(mergeSelectedIds.length)" />
            </template>
            <Button label="Org" icon="pi pi-plus" size="small" @click="showOrgDialog = true" />
          </div>
        </div>

        <div class="tree-container"
             :class="{ 'pane-drop-target': dropTargetFolderId && dropTargetFolderId === selectedFolder?.id }"
             @dragover.prevent="onTreeContainerDragOver"
             @dragenter.prevent="onTreeContainerDragEnter"
             @dragleave="onTreeContainerDragLeave"
             @drop.prevent="onTreeContainerDrop">
          <TreeTable :value="store.allocatedTreeNodes" selectionMode="single" v-model:selectionKeys="selectedKeys"
                v-model:expandedKeys="expandedKeys"
                :loading="store.loading" class="subnet-treetable"
                :metaKeySelection="false"
                @node-select="onNodeSelect"
                >
            <Column field="name" header="Name" expander style="">
              <template #body="{ node }">
                <span v-if="node.data.type === 'folder'" class="tree-node folder-node"
                      @contextmenu.prevent="openFolderContextMenu($event, node)"
                      @dragover.prevent.stop="onFolderDragOver($event, node.data.id)"
                      @dragenter.prevent.stop="dropTargetFolderId = node.data.id"
                      @dragleave.stop="onFolderDragLeave($event, node.data.id)"
                      @drop.prevent.stop="onDropSubnet($event, node.data.id)">
                  <i class="pi pi-building" style="font-size: 0.85rem"></i>
                  <span class="folder-name">{{ node.data.name }}</span>
                </span>
                <span v-else class="tree-node" :class="{ unallocated: node.data.status === 'unallocated', 'merge-selected': isMergeSelected(node.data.id) }"
                      @contextmenu.prevent="openContextMenu($event, node)"
                      @click.ctrl.prevent.stop="toggleMergeSelect(node.data.id)"
                      @click.meta.prevent.stop="toggleMergeSelect(node.data.id)">
                  {{ node.data.name || '—' }}
                  <span v-if="isMergeSelected(node.data.id)" class="node-badge merge-badge">merge</span>
                </span>
              </template>
            </Column>
            <Column field="cidr" header="Network" style="">
              <template #body="{ node }">
                <span @contextmenu.prevent="node.data.type === 'folder' ? openFolderContextMenu($event, node) : openContextMenu($event, node)" class="cell-fill">
                  <span v-if="node.data.type === 'folder'" class="folder-count-text">{{ node.children?.length || 0 }} subnets</span>
                  <span v-else class="node-cidr">{{ node.data.cidr }}</span>
                </span>
              </template>
            </Column>
            <Column field="vlan_id" header="VLAN" style="width: 1%">
              <template #body="{ node }">
                <span @contextmenu.prevent="node.data.type === 'folder' ? openFolderContextMenu($event, node) : openContextMenu($event, node)" class="cell-fill">
                  <span v-if="node.data.type === 'subnet' && node.data.vlan_id" class="text-muted">{{ node.data.vlan_id }}</span>
                </span>
              </template>
            </Column>
            <Column field="description" header="Description">
              <template #body="{ node }">
                <span @contextmenu.prevent="node.data.type === 'folder' ? openFolderContextMenu($event, node) : openContextMenu($event, node)" class="cell-fill">
                  <span v-if="node.data.type === 'subnet' && node.data.description" class="text-muted">{{ node.data.description }}</span>
                </span>
              </template>
            </Column>
            <Column field="available" header="Available" style="width: 1%">
              <template #body="{ node }">
                <span @contextmenu.prevent="node.data.type === 'folder' ? openFolderContextMenu($event, node) : openContextMenu($event, node)" class="cell-fill">
                  <template v-if="node.data.type === 'subnet'">
                    <span v-if="node.data.status === 'allocated'">{{ Math.max(0, node.data.total_addresses - 2 - (node.data.used_count || 0)) }}</span>
                    <span v-else class="text-muted">{{ Math.max(0, node.data.total_addresses - 2) }}</span>
                  </template>
                </span>
              </template>
            </Column>
          </TreeTable>

          <div v-if="!store.loading && store.allocatedTreeNodes.length === 0" class="empty-state">
            No organizations yet. Click "Org" to create one.
          </div>
        </div>
      </div>

      <!-- Resize Handle -->
      <div class="resize-handle" @mousedown="startResize"></div>

      <!-- Right Pane: Detail or Browse -->
      <div class="right-pane">
        <!-- Browse mode: show unallocated subnet hierarchy -->
        <template v-if="rightPaneMode === 'browse'">
          <div class="browse-pane">
            <div class="browse-header">
              <h3 style="margin:0">Available Subnets</h3>
              <div class="header-actions">
                <Button label="Add Subnet" icon="pi pi-plus" size="small" severity="secondary"
                        @click="showSubnetDialog = true" />
                <Button icon="pi pi-times" severity="secondary" text rounded size="small"
                        title="Close browse" @click="rightPaneMode = 'detail'" />
              </div>
            </div>
            <div class="browse-tree-container">
              <TreeTable :value="store.unallocatedTreeNodes" selectionMode="single"
                    v-model:selectionKeys="browseSelectedKeys"
                    v-model:expandedKeys="browseExpandedKeys"
                    class="subnet-treetable browse-treetable"
                    :metaKeySelection="false"
                    @node-select="onBrowseNodeSelect"
                    >
                <Column field="name" header="Network" expander style="">
                  <template #body="{ node }">
                    <span class="tree-node browse-node"
                          :class="{ 'is-leaf': node.leaf || (!node.leaf && node.data.parent_id), 'merge-selected': isMergeSelected(node.data.id) }"
                          :draggable="node.leaf || node.data.parent_id ? 'true' : 'false'"
                          @dragstart.stop="onBrowseDragStart($event, node.data, node)"
                          @contextmenu.prevent="openContextMenu($event, node)"
                          @click.ctrl.prevent.stop="toggleMergeSelect(node.data.id)"
                          @click.meta.prevent.stop="toggleMergeSelect(node.data.id)">
                      <span class="node-cidr">{{ node.data.cidr }}</span>
                    </span>
                  </template>
                </Column>
                <Column field="size" header="Size" style="width: 1%">
                  <template #body="{ node }">
                    <span @contextmenu.prevent="openContextMenu($event, node)" class="cell-fill">
                      <span class="text-muted">{{ Math.max(0, node.data.total_addresses - 2) }}</span>
                    </span>
                  </template>
                </Column>
                <Column field="status" header="Status" style="width: 1%">
                  <template #body="{ node }">
                    <span @contextmenu.prevent="openContextMenu($event, node)" class="cell-fill">
                      <span v-if="!node.leaf && allChildrenAllocated(node)" class="status-allocated">allocated</span>
                      <span v-else-if="!node.leaf && !node.data.parent_id" class="status-divided">divided</span>
                      <span v-else-if="!node.leaf" class="status-drag">drag to allocate</span>
                      <span v-else class="status-divided">unallocated</span>
                      <span v-if="isMergeSelected(node.data.id)" class="status-merge">merge</span>
                    </span>
                  </template>
                </Column>
              </TreeTable>
              <div v-if="store.unallocatedTreeNodes.length === 0" class="empty-state">
                No unallocated subnets. Use "Add Subnet" to create one.
              </div>
            </div>
          </div>
        </template>
        <!-- Detail mode: show subnet detail or org networks -->
        <template v-else-if="selectedType === 'subnet' && selectedSubnetId">
          <SubnetDetail :subnet-id="selectedSubnetId" />
        </template>
        <template v-else-if="selectedType === 'folder' && selectedFolder">
          <div class="org-networks-pane">
            <div class="browse-header">
              <h3 style="margin:0"><i class="pi pi-building"></i> {{ selectedFolder.name }}</h3>
            </div>
            <p v-if="selectedFolder.description" class="org-description">{{ selectedFolder.description }}</p>
            <div class="browse-tree-container">
              <TreeTable :value="selectedFolderTreeNodes" selectionMode="single"
                    v-model:selectionKeys="orgTreeSelectedKeys"
                    v-model:expandedKeys="orgTreeExpandedKeys"
                    class="subnet-treetable browse-treetable"
                    :metaKeySelection="false"
                    @node-select="onOrgTreeNodeSelect"
                    >
                <Column field="name" header="Name" expander style="">
                  <template #body="{ node }">
                    <span class="tree-node browse-node"
                          :class="{ 'is-leaf': isDraggableOrgNode(node), 'is-allocated': node.data.status === 'allocated', 'merge-selected': isMergeSelected(node.data.id) }"
                          :draggable="isDraggableOrgNode(node) ? 'true' : 'false'"
                          @dragstart.stop="onBrowseDragStart($event, node.data, node)"
                          @contextmenu.prevent="openContextMenu($event, node)">
                      {{ node.data.name || '—' }}
                      <span v-if="isMergeSelected(node.data.id)" class="node-badge merge-badge">merge</span>
                    </span>
                  </template>
                </Column>
                <Column field="cidr" header="Network" style="">
                  <template #body="{ node }">
                    <span @contextmenu.prevent="openContextMenu($event, node)" class="cell-fill">
                      <span class="node-cidr">{{ node.data.cidr }}</span>
                    </span>
                  </template>
                </Column>
                <Column field="vlan_id" header="VLAN" style="width: 1%">
                  <template #body="{ node }">
                    <span @contextmenu.prevent="openContextMenu($event, node)" class="cell-fill">
                      <span v-if="node.data.vlan_id" class="text-muted">{{ node.data.vlan_id }}</span>
                    </span>
                  </template>
                </Column>
                <Column field="description" header="Description">
                  <template #body="{ node }">
                    <span @contextmenu.prevent="openContextMenu($event, node)" class="cell-fill">
                      <span v-if="node.data.description" class="text-muted">{{ node.data.description }}</span>
                    </span>
                  </template>
                </Column>
                <Column field="status" header="Status" style="width: 1%">
                  <template #body="{ node }">
                    <span @contextmenu.prevent="openContextMenu($event, node)" class="cell-fill">
                      <span v-if="node.data.status === 'allocated' || (!node.leaf && allChildrenAllocated(node))" class="status-allocated">allocated</span>
                      <span v-else-if="!node.leaf && node.data.parent_id" class="status-drag">drag to allocate</span>
                      <span v-else-if="!node.leaf" class="status-divided">divided</span>
                      <span v-else class="status-divided">unallocated</span>
                    </span>
                  </template>
                </Column>
              </TreeTable>
              <div v-if="selectedFolderTreeNodes.length === 0" class="empty-state">
                No subnets in this organization.
              </div>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="empty-detail">
            <i class="pi pi-sitemap" style="font-size: 2rem; opacity: 0.3;"></i>
            <p>Select a subnet to view details</p>
          </div>
        </template>
      </div>
    </div>

    <!-- Context Menus -->
    <ContextMenu ref="contextMenuRef" :model="contextMenuItems" />
    <ContextMenu ref="folderContextMenuRef" :model="folderContextMenuItems" />

    <!-- Create/Edit Organization Dialog -->
    <Dialog v-model:visible="showFolderDialog" :header="editingFolder ? 'Edit Organization' : 'Edit Organization'" modal :style="{ width: '26rem' }">
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

    <!-- Create Organization Dialog (with supernet) -->
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
          <label>Supernet CIDR *</label>
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
        This organization contains {{ deletingFolder.subnets.length }} subnets. Move or delete them first.
      </p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteFolderDialog = false" />
        <Button label="Delete" severity="danger" @click="executeDeleteFolder" :loading="saving"
                :disabled="deletingFolder?.subnets?.length > 0" />
      </template>
    </Dialog>

    <!-- Create Subnet Dialog -->
    <Dialog v-model:visible="showSubnetDialog" header="Create Subnet" modal :style="{ width: '28rem' }">
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
          <label>Folder</label>
          <Select v-model="supernetForm.folder_id" :options="folderOptions" optionLabel="name" optionValue="id"
                  placeholder="Select folder" class="w-full" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showSubnetDialog = false" />
        <Button label="Create" @click="createSupernet" :loading="saving" :disabled="!!supernetValidationError" />
      </template>
    </Dialog>

    <!-- Divide Dialog -->
    <Dialog v-model:visible="showDivide" header="Divide Subnet" modal :style="{ width: '36rem' }">
      <p>Subnet: <strong>{{ selectedNode?.data.cidr }}</strong></p>

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
              <span class="divide-count-label">subnets (/{{ divideTargetPrefix }})</span>
            </div>
          </div>
        </div>

        <div v-if="dividePreviewSubnets.length > 0 && dividePreviewSubnets.length <= 256" class="divide-preview">
          <h4>Preview: {{ dividePreviewSubnets.length }} subnets (/{{ divideTargetPrefix }})</h4>
          <ul class="remainder-list">
            <li v-for="cidr in dividePreviewSubnets" :key="cidr">{{ cidr }}</li>
          </ul>
        </div>
        <div v-else-if="dividePreviewSubnets.length > 256" class="divide-preview divide-preview-warn">
          <p>Cannot divide into more than 256 subnets ({{ dividePreviewSubnets.length }} requested)</p>
        </div>
      </template>

      <!-- Specific Subnet mode (carve) -->
      <template v-else>
        <div class="form-grid">
          <div class="field">
            <label>Subnet CIDR *</label>
            <div class="carve-cidr-row">
              <InputText v-model="carveNetwork" class="carve-network-input" />
              <span class="carve-slash">/</span>
              <InputNumber v-model="carvePrefix" :min="(selectedNode?.data.prefix_length || 0) + 1" :max="32"
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

      <Message v-if="selectedNode?.data.status === 'allocated'" severity="warn" class="mt-3">
        This subnet is allocated. Division will migrate its configuration to the child containing the gateway.
      </Message>

      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDivide = false" />
        <Button v-if="divideMode === 'equal'" label="Divide" @click="executeDivide" :loading="saving"
                :disabled="dividePreviewSubnets.length === 0 || dividePreviewSubnets.length > 256" />
        <Button v-else label="Create Subnet" @click="executeCarve" :loading="saving"
                :disabled="!!carveValidationError || !carveNetwork" />
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

    <!-- Edit Dialog -->
    <Dialog v-model:visible="showEdit" header="Edit Subnet" modal :style="{ width: '28rem' }">
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
            <Button icon="pi pi-plus" severity="secondary" text rounded size="small"
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

    <!-- Delete Subnet Dialog -->
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

    <!-- Merge Dialog -->
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

    <!-- Group Allocate Dialog -->
    <Dialog v-model:visible="showGroupConfigure" header="Allocate Group" modal :style="{ width: '28rem' }">
      <p>Allocate <strong>{{ groupDropIds.length }}</strong> subnets to this organization?</p>
      <p style="font-size: 0.85rem; color: var(--p-text-muted-color);">
        Each subnet will be named using the current template and allocated with default settings.
      </p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showGroupConfigure = false" />
        <Button label="Allocate All" @click="executeGroupConfigure" :loading="saving" />
      </template>
    </Dialog>

    <Toast />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useToast } from 'primevue/usetoast';
import Button from 'primevue/button';
import SelectButton from 'primevue/selectbutton';
import TreeTable from 'primevue/treetable';
import Column from 'primevue/column';
import ContextMenu from 'primevue/contextmenu';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Select from 'primevue/select';
import Message from 'primevue/message';
import Toast from 'primevue/toast';
import AutoComplete from 'primevue/autocomplete';
import SubnetDetail from './SubnetDetail.vue';
import { useSubnetStore } from '../stores/subnets.js';
import api from '../api/client.js';
import { validateSupernet, isValidCidr, normalizeCidr, applyNameTemplate, calculateSubnets, canMergeCidrs, subtractCidr, isSubnetOf, parseCidr } from '../utils/ip.js';

const store = useSubnetStore();
const toast = useToast();

// Persist expanded/selected keys
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
const folderContextMenuRef = ref(null);

// Debounced localStorage persistence — avoids blocking main thread on selection
let _persistTimer = null;
function persistState() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      localStorage.setItem('ipam_subnet_expanded_keys', JSON.stringify(expandedKeys.value));
      localStorage.setItem('ipam_subnet_selected_keys', JSON.stringify(selectedKeys.value));
      localStorage.setItem('ipam_selected_type', JSON.stringify(selectedType.value));
      localStorage.setItem('ipam_selected_subnet_id', JSON.stringify(selectedSubnetId.value));
      localStorage.setItem('ipam_selected_folder', JSON.stringify(selectedFolder.value));
      localStorage.setItem('ipam_right_pane_mode', JSON.stringify(rightPaneMode.value));
      localStorage.setItem('ipam_browse_expanded_keys', JSON.stringify(browseExpandedKeys.value));
      localStorage.setItem('ipam_org_expanded_keys', JSON.stringify(orgTreeExpandedKeys.value));
    } catch { /* localStorage full or unavailable */ }
  }, 300);
}

watch(expandedKeys, persistState, { deep: true });
watch(selectedKeys, persistState, { deep: true });

// Selection tracking (persisted)
const selectedType = ref(loadJson('ipam_selected_type', null));
const selectedSubnetId = ref(loadJson('ipam_selected_subnet_id', null));
const selectedFolder = ref(loadJson('ipam_selected_folder', null));

watch(selectedType, persistState);
watch(selectedSubnetId, persistState);
watch(selectedFolder, persistState);

// Helper: find a tree node by subnet ID across all trees
function findNodeInTrees(subnetId) {
  function search(nodes) {
    for (const n of nodes) {
      if (n.data.id === subnetId) return n;
      if (n.children) {
        const found = search(n.children);
        if (found) return found;
      }
    }
    return null;
  }
  return search(store.allocatedTreeNodes) || search(store.unallocatedTreeNodes);
}

// After any store.fetchTree(), refresh stale selectedNode/selectedFolder references
watch(() => store.folders, () => {
  if (selectedType.value === 'folder' && selectedFolder.value) {
    const fresh = store.folders.find(f => f.id === selectedFolder.value.id);
    if (fresh) {
      selectedFolder.value = fresh;
    }
  }
  if (selectedType.value === 'subnet' && selectedSubnetId.value) {
    const node = findNodeInTrees(selectedSubnetId.value);
    if (node) {
      selectedNode.value = node;
      selectedKeys.value = { [node.key]: true };
    }
  }
}, { deep: false });

// Split pane resize
const leftPaneWidth = ref(parseInt(localStorage.getItem('ipam_left_pane_width') || '340', 10));
let resizing = false;

function startResize(e) {
  resizing = true;
  const startX = e.clientX;
  const startWidth = leftPaneWidth.value;

  function onMouseMove(e) {
    if (!resizing) return;
    const delta = e.clientX - startX;
    leftPaneWidth.value = Math.max(240, Math.min(600, startWidth + delta));
  }
  function onMouseUp() {
    resizing = false;
    localStorage.setItem('ipam_left_pane_width', String(leftPaneWidth.value));
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

// Dialog state
const showFolderDialog = ref(false);
const showDeleteFolderDialog = ref(false);
const showSubnetDialog = ref(false);
const showDivide = ref(false);
const showConfigure = ref(false);
const showEdit = ref(false);
const showDelete = ref(false);
const showMerge = ref(false);
const saving = ref(false);

// Folder state
const editingFolder = ref(null);
const deletingFolder = ref(null);
const folderForm = ref({ name: '', description: '' });

// Settings
const nameTemplate = ref('%1.%2.%3.%4/%bitmask');

async function loadSettings() {
  try {
    const settings = await store.getSettings();
    if (settings.subnet_name_template) nameTemplate.value = settings.subnet_name_template;
  } catch { /* use default */ }
}

// Right pane mode: 'detail' or 'browse' (persisted)
const rightPaneMode = ref(loadJson('ipam_right_pane_mode', 'detail'));
watch(rightPaneMode, persistState);
const browseSelectedKeys = ref({});
const browseExpandedKeys = ref(loadJson('ipam_browse_expanded_keys', {}));
watch(browseExpandedKeys, persistState, { deep: true });

// Org tree (right pane when org is selected)
const orgTreeSelectedKeys = ref({});
const orgTreeExpandedKeys = ref(loadJson('ipam_org_expanded_keys', {}));
watch(orgTreeExpandedKeys, persistState, { deep: true });

const selectedFolderTreeNodes = computed(() => {
  if (!selectedFolder.value) return [];
  const folder = store.folders.find(f => f.id === selectedFolder.value.id);
  if (!folder || !folder.subnets) return [];
  return store.toSubnetNodes(folder.subnets);
});

const previousOrgKey = ref(null);
function onOrgTreeNodeSelect(node) {
  if (ctrlHeld.value && node.data.type !== 'folder') {
    toggleMergeSelect(node.data.id);
    if (previousOrgKey.value) {
      orgTreeSelectedKeys.value = { [previousOrgKey.value]: true };
    }
    return;
  }
  previousOrgKey.value = node.key;
  selectedNode.value = node;
  // If allocated subnet clicked, switch to detail view
  if (node.data.status === 'allocated') {
    selectedType.value = 'subnet';
    selectedSubnetId.value = node.data.id;
  }
}

// Organization dialog
const showOrgDialog = ref(false);
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
      cidr: orgForm.value.cidr
    });
    showOrgDialog.value = false;
    orgForm.value = { name: '', description: '', cidr: '' };
    toast.add({ severity: 'success', summary: 'Organization created', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

// Folder options for subnet creation
const folderOptions = computed(() => store.folders);

// Supernet form
const supernetForm = ref({ cidr: '', name: '', folder_id: null });

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
const divideMode = ref('equal');
const divideModeOptions = [
  { label: 'Equal Division', value: 'equal' },
  { label: 'Specific Subnet', value: 'carve' }
];
const divideSteps = ref(1);
const divideCount = ref(2);

// Carve (specific subnet) form
const carveNetwork = ref('');
const carvePrefix = ref(25);
const carveCidr = computed(() => `${carveNetwork.value}/${carvePrefix.value}`);

const carveValidationError = computed(() => {
  const cidr = carveCidr.value;
  if (!carveNetwork.value) return 'Enter a network address';
  if (!isValidCidr(cidr)) return 'Invalid CIDR notation';
  if (!selectedNode.value) return null;
  const parentCidr = selectedNode.value.data.cidr;
  const normalized = normalizeCidr(cidr);
  const parentParsed = parseCidr(parentCidr);
  const childParsed = parseCidr(normalized);
  if (childParsed.prefix <= parentParsed.prefix) return 'Must have a longer prefix than parent';
  if (!isSubnetOf(normalized, parentCidr)) return `Not within ${parentCidr}`;
  return null;
});

const carvePreview = computed(() => {
  const cidr = carveCidr.value;
  if (!carveNetwork.value || !selectedNode.value || carveValidationError.value) return null;
  try {
    return subtractCidr(selectedNode.value.data.cidr, normalizeCidr(cidr));
  } catch { return null; }
});

const maxDivideSteps = computed(() => {
  if (!selectedNode.value) return 1;
  return Math.min(32 - selectedNode.value.data.prefix_length, 8);
});

const maxDivideCount = computed(() => Math.pow(2, maxDivideSteps.value));

const divideTargetPrefix = computed(() => {
  if (!selectedNode.value) return 32;
  return selectedNode.value.data.prefix_length + divideSteps.value;
});

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
const showVlanWarning = ref(false);
const pendingVlanSelection = ref(null);

// Merge via ctrl-click
const mergeSelectedIdsRaw = ref([]);
const mergeSelectedIds = computed(() => mergeSelectedIdsRaw.value);

function isMergeSelected(id) {
  return mergeSelectedIdsRaw.value.includes(id);
}

function findSubnetInTree(id, nodes) {
  for (const f of (nodes || store.folders)) {
    if (nodes) {
      // Searching within subnet nodes
      if (f.id === id) return f;
      if (f.children) {
        const found = findSubnetInTree(id, f.children);
        if (found) return found;
      }
    } else {
      // Top-level: search within folder subnets
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
    toast.add({ severity: 'warn', summary: 'Cannot merge', detail: 'Root supernets cannot be merged', life: 3000 });
    return;
  }
  const hasChildren = (subnet.child_count || 0) > 0 || (subnet.children && subnet.children.length > 0);
  if (hasChildren) {
    toast.add({ severity: 'warn', summary: 'Cannot merge', detail: 'Subnet has children and cannot be merged', life: 3000 });
    return;
  }

  if (mergeSelectedIdsRaw.value.length > 0) {
    const firstSubnet = findSubnetInTree(mergeSelectedIdsRaw.value[0]);
    if (!firstSubnet) return;
    if (subnet.parent_id !== firstSubnet.parent_id) {
      toast.add({ severity: 'warn', summary: 'Cannot merge', detail: 'Subnets must be siblings (same parent)', life: 3000 });
      return;
    }
    if (subnet.prefix_length !== firstSubnet.prefix_length) {
      toast.add({ severity: 'warn', summary: 'Cannot merge', detail: 'All subnets must have the same prefix length', life: 3000 });
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
  if (cidrs.length < 2) return { valid: false, error: 'Cannot find subnets' };
  return canMergeCidrs(cidrs);
});

function clearMergeSelection() {
  mergeSelectedIdsRaw.value = [];
}

const mergePreview = ref(null);
const mergeError = ref(null);

// Apply template helpers
function getApplyTemplateTargets(nodes) {
  const targets = [];
  for (const n of nodes) {
    const d = n.data || n;
    if (d.status === 'allocated') {
      const expected = applyNameTemplate(nameTemplate.value, d.cidr);
      if (d.name !== expected) targets.push(d);
    }
    const children = n.children || d.children;
    if (children && children.length > 0) targets.push(...getApplyTemplateTargets(children));
  }
  return targets;
}

// Node selection handler
const previousSelectedKey = ref(null);
function onNodeSelect(node) {
  // Ctrl/Meta+click triggers merge select instead of normal selection
  if (ctrlHeld.value && node.data.type !== 'folder') {
    toggleMergeSelect(node.data.id);
    // Restore previous selection — PrimeVue already changed selectionKeys
    if (previousSelectedKey.value) {
      selectedKeys.value = { [previousSelectedKey.value]: true };
    }
    return;
  }
  previousSelectedKey.value = node.key;
  selectedNode.value = node;
  rightPaneMode.value = 'detail';
  if (node.data.type === 'folder') {
    selectedType.value = 'folder';
    selectedSubnetId.value = null;
    selectedFolder.value = node.data;
  } else {
    selectedType.value = 'subnet';
    selectedFolder.value = null;
    selectedSubnetId.value = node.data.id;
  }
}


// Context menus
function openContextMenu(event, node) {
  selectedNode.value = node;
  selectedKeys.value = { [node.key]: true };
  contextMenuRef.value.show(event);
}

const selectedFolderForContext = ref(null);

function openFolderContextMenu(event, node) {
  selectedFolderForContext.value = node.data;
  folderContextMenuRef.value.show(event);
}

const folderContextMenuItems = computed(() => {
  const f = selectedFolderForContext.value;
  if (!f) return [];
  return [
    { label: 'Edit Organization', icon: 'pi pi-pencil', command: () => openEditFolder(f) },
    { separator: true },
    { label: 'Delete Organization', icon: 'pi pi-trash', class: 'p-error', command: () => openDeleteFolder(f) },
  ];
});

const contextMenuItems = computed(() => {
  const node = selectedNode.value;
  if (!node || node.data.type === 'folder') return [];

  const d = node.data;
  const isLeaf = (d.child_count || 0) === 0 && (!node.children || node.children.length === 0);
  const items = [];

  if (isLeaf) {
    items.push({ label: 'Divide', icon: 'pi pi-share-alt', command: () => openDivide() });
  }

  if (d.status === 'unallocated') {
    items.push({ label: 'Configure', icon: 'pi pi-cog', command: () => openConfigure() });
  } else {
    items.push({ label: 'Edit', icon: 'pi pi-pencil', command: () => openEdit() });
  }

  if (d.parent_id) {
    if (mergeSelectedIdsRaw.value.length >= 2 && mergeValidation.value.valid) {
      items.push({ label: 'Merge Selected', icon: 'pi pi-sitemap', command: () => openMergeConfirm() });
    } else {
      items.push({ label: 'Merge...', icon: 'pi pi-sitemap', command: () => {
        if (!isMergeSelected(d.id)) toggleMergeSelect(d.id);
        if (mergeSelectedIdsRaw.value.length >= 2 && mergeValidation.value.valid) {
          openMergeConfirm();
        }
      }});
    }
  }

  if (d.status === 'allocated') {
    const expected = applyNameTemplate(nameTemplate.value, d.cidr);
    if (d.name !== expected) {
      items.push({ label: 'Apply Template', icon: 'pi pi-sync', command: () => executeApplyTemplate([d.id]) });
    }
  }
  if (node.children && node.children.length > 0) {
    const targets = getApplyTemplateTargets(node.children);
    if (targets.length > 0) {
      items.push({ label: `Apply Template to Children (${targets.length})`, icon: 'pi pi-sync', command: () => executeApplyTemplate(targets.map(t => (t.data || t).id)) });
    }
  }

  items.push({ separator: true });
  items.push({ label: 'Delete', icon: 'pi pi-trash', class: 'p-error', command: () => showDelete.value = true });

  return items;
});

// Track ctrl/meta key state for merge multi-select in TreeTable
const ctrlHeld = ref(false);
function onKeyDown(e) { if (e.ctrlKey || e.metaKey) ctrlHeld.value = true; }
function onKeyUp(e) { if (!e.ctrlKey && !e.metaKey) ctrlHeld.value = false; }

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  await Promise.all([store.fetchTree(), loadSettings()]);
  // Pre-select first folder's first allocated subnet if available
  if (store.folders.length > 0 && supernetForm.value.folder_id === null) {
    supernetForm.value.folder_id = store.folders[0]?.id || null;
  }
  // Restore persisted selection state — the watcher on store.folders handles this
  // but we need an initial restore after the first fetchTree
  if (selectedType.value === 'folder' && selectedFolder.value) {
    const folder = store.folders.find(f => f.id === selectedFolder.value.id);
    if (folder) selectedFolder.value = folder;
  } else if (selectedType.value === 'subnet' && selectedSubnetId.value) {
    const node = findNodeInTrees(selectedSubnetId.value);
    if (node) {
      selectedNode.value = node;
      previousSelectedKey.value = node.key;
    }
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
});

// Drag & drop: from browse tree to left pane folders
const dropTargetFolderId = ref(null);

function onFolderDragOver(event, folderId) {
  event.dataTransfer.dropEffect = 'move';
  dropTargetFolderId.value = folderId;
}

function onFolderDragLeave(event, folderId) {
  if (dropTargetFolderId.value === folderId) {
    dropTargetFolderId.value = null;
  }
}

// Tree container-level drop zone: when a folder is selected, the whole left pane accepts drops
function onTreeContainerDragOver(event) {
  if (selectedFolder.value) {
    event.dataTransfer.dropEffect = 'move';
    dropTargetFolderId.value = selectedFolder.value.id;
  }
}

function onTreeContainerDragEnter(event) {
  if (selectedFolder.value) {
    dropTargetFolderId.value = selectedFolder.value.id;
  }
}

function onTreeContainerDragLeave(e) {
  // Only clear if leaving the container entirely (not entering a child)
  if (!e.currentTarget.contains(e.relatedTarget)) {
    dropTargetFolderId.value = null;
  }
}

function onTreeContainerDrop(event) {
  if (selectedFolder.value) {
    onDropSubnet(event, selectedFolder.value.id);
  }
}

function onDropSubnet(event, folderId) {
  dropTargetFolderId.value = null;
  const subnetIdsJson = event.dataTransfer.getData('application/x-subnet-ids');
  const subnetId = event.dataTransfer.getData('application/x-subnet-id');
  const cidr = event.dataTransfer.getData('text/plain');

  if (subnetIdsJson) {
    // Group drag: allocate all leaf children at once
    const leafIds = JSON.parse(subnetIdsJson);
    groupDropIds.value = leafIds;
    groupDropFolderId.value = folderId;
    showGroupConfigure.value = true;
    return;
  }

  if (!subnetId) return;

  // Find the subnet and open configure dialog
  const subnet = findSubnetInTree(parseInt(subnetId, 10));
  if (!subnet) return;

  // Set up node for configure dialog
  selectedNode.value = { data: { ...subnet, type: 'subnet' }, key: `subnet-${subnet.id}`, children: subnet.children || [] };
  dropTargetFolderIdForConfigure.value = folderId;

  const autoName = applyNameTemplate(nameTemplate.value, cidr || subnet.cidr);
  configForm.value = { name: autoName, description: '', vlan_id: null, gateway_address: '', create_dhcp_scope: false, create_reverse_dns: false };
  showConfigure.value = true;
}

// Group drop state
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
      const autoName = applyNameTemplate(nameTemplate.value, subnet.cidr);
      await store.configureSubnetNoRefresh(id, {
        name: autoName,
        description: '',
        vlan_id: null,
        gateway_address: '',
        create_dhcp_scope: false,
        create_reverse_dns: false,
        folder_id: groupDropFolderId.value
      });
    }
    await store.fetchTree();
    showGroupConfigure.value = false;
    groupDropIds.value = [];
    groupDropFolderId.value = null;
    toast.add({ severity: 'success', summary: `${count} subnets allocated`, life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

const dropTargetFolderIdForConfigure = ref(null);
watch(showConfigure, (val) => { if (!val) dropTargetFolderIdForConfigure.value = null; });

// Org tree: determine if a node is draggable
function allChildrenAllocated(node) {
  if (!node.children || node.children.length === 0) return node.data.status === 'allocated';
  return node.children.every(c => allChildrenAllocated(c));
}

function isDraggableOrgNode(node) {
  if (node.data.status === 'allocated') return false;
  if (node.leaf) return true;
  // Non-leaf with parent_id = divided child, draggable as group
  if (node.data.parent_id) return true;
  return false;
}

// Collect all leaf descendant IDs from a tree node
function collectLeafIds(node) {
  if (node.leaf || !node.children || node.children.length === 0) {
    return [node.data.id];
  }
  const ids = [];
  for (const child of node.children) {
    ids.push(...collectLeafIds(child));
  }
  return ids;
}

// Browse tree: drag start
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

// Browse tree: node selection
const previousBrowseKey = ref(null);
function onBrowseNodeSelect(node) {
  if (ctrlHeld.value) {
    toggleMergeSelect(node.data.id);
    if (previousBrowseKey.value) {
      browseSelectedKeys.value = { [previousBrowseKey.value]: true };
    }
    return;
  }
  previousBrowseKey.value = node.key;
  selectedNode.value = node;
}

// Folder operations
function openEditFolder(folder) {
  editingFolder.value = folder;
  folderForm.value = { name: folder.name, description: folder.description || '' };
  showFolderDialog.value = true;
}

function openDeleteFolder(folder) {
  deletingFolder.value = folder;
  showDeleteFolderDialog.value = true;
}

async function saveFolder() {
  saving.value = true;
  try {
    if (editingFolder.value) {
      await store.updateFolder(editingFolder.value.id, folderForm.value);
      toast.add({ severity: 'success', summary: 'Folder updated', life: 3000 });
    } else {
      await store.createFolder(folderForm.value);
      toast.add({ severity: 'success', summary: 'Folder created', life: 3000 });
    }
    showFolderDialog.value = false;
    editingFolder.value = null;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

async function executeDeleteFolder() {
  saving.value = true;
  try {
    await store.deleteFolder(deletingFolder.value.id);
    showDeleteFolderDialog.value = false;
    selectedType.value = null;
    selectedFolder.value = null;
    selectedNode.value = null;
    selectedSubnetId.value = null;
    selectedKeys.value = {};
    toast.add({ severity: 'success', summary: 'Folder deleted', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

// Supernet
async function createSupernet() {
  saving.value = true;
  try {
    await store.createSupernet({
      cidr: supernetForm.value.cidr,
      name: supernetForm.value.name || undefined,
      folder_id: supernetForm.value.folder_id || undefined
    });
    showSubnetDialog.value = false;
    supernetForm.value = { cidr: '', name: '', folder_id: store.folders[0]?.id || null };
    toast.add({ severity: 'success', summary: 'Subnet created', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

// Divide
function openDivide() {
  divideMode.value = 'equal';
  divideSteps.value = 1;
  divideCount.value = 2;
  const node = selectedNode.value?.data;
  if (node) {
    carveNetwork.value = node.network_address || node.cidr.split('/')[0];
    carvePrefix.value = node.prefix_length + 1;
  } else {
    carveNetwork.value = '';
    carvePrefix.value = 25;
  }
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
    expandedKeys.value = { ...expandedKeys.value, [`subnet-${nodeId}`]: true };
    toast.add({ severity: 'success', summary: 'Subnet divided', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

async function executeCarve() {
  saving.value = true;
  try {
    const nodeId = selectedNode.value.data.id;
    const isAllocated = selectedNode.value.data.status === 'allocated';
    await store.divideSubnet(nodeId, {
      cidr: normalizeCidr(carveCidr.value),
      force: isAllocated
    });
    showDivide.value = false;
    browseExpandedKeys.value = { ...browseExpandedKeys.value, [`subnet-${nodeId}`]: true };
    toast.add({ severity: 'success', summary: 'Subnet created', life: 3000 });
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
    const payload = { ...configForm.value };
    if (dropTargetFolderIdForConfigure.value) {
      payload.folder_id = dropTargetFolderIdForConfigure.value;
    }
    await store.configureSubnet(selectedNode.value.data.id, payload);
    showConfigure.value = false;
    dropTargetFolderIdForConfigure.value = null;
    // Auto-select the newly configured subnet to show detail
    rightPaneMode.value = 'detail';
    selectedType.value = 'subnet';
    selectedSubnetId.value = selectedNode.value.data.id;
    toast.add({ severity: 'success', summary: 'Subnet configured', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    saving.value = false;
  }
}

// Edit
// VLAN autocomplete state
const editVlanSelection = ref(null);
const vlanSuggestions = ref([]);
const showCreateVlanFromEdit = ref(false);
const newVlanForm = ref({ vlan_id: null, name: '' });

// Get folder_id for the current subnet — either from the subnet itself or the selected folder
function getSubnetFolderId() {
  const folderId = selectedNode.value?.data?.folder_id;
  if (folderId) return folderId;
  // Child subnets don't have folder_id — use the selected folder context
  if (selectedFolder.value) return selectedFolder.value.id;
  // Try to find it from the store folders
  const subnetId = selectedNode.value?.data?.id;
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
  const currentVlanId = selectedNode.value?.data?.vlan_id;
  // If VLAN is already used by other subnets (and it's not the current subnet's own VLAN), warn
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
  // Revert autocomplete to previous value
  const d = selectedNode.value?.data;
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
      name: newVlanForm.value.name
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

function openEdit() {
  const d = selectedNode.value.data;
  editForm.value = { name: d.name, description: d.description || '', vlan_id: d.vlan_id, gateway_address: d.gateway_address || '' };
  // Pre-populate VLAN autocomplete if subnet has a vlan_id
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
    const deletedNode = selectedNode.value;
    const wasViewingFolder = selectedType.value === 'folder';
    const folderId = deletedNode.data.folder_id;

    await store.deleteSubnet(deletedNode.data.id);
    showDelete.value = false;

    // If user was viewing a folder's org pane, stay on the folder view
    if (wasViewingFolder && folderId) {
      const folder = store.folders.find(f => f.id === folderId);
      if (folder) {
        selectedFolder.value = folder;
        selectedNode.value = null;
        selectedSubnetId.value = null;
        // selectedType stays 'folder', selectedKeys stay as-is
        toast.add({ severity: 'success', summary: 'Subnet deleted', life: 3000 });
        return;
      }
    }

    // Otherwise find the best next selection in the allocated tree
    let nextNode = null;
    function findSibling(nodes) {
      for (const n of nodes) {
        if (n.data.id !== deletedNode.data.id && n.data.type !== 'folder' && n.data.folder_id === folderId) {
          return n;
        }
        if (n.children) {
          const found = findSibling(n.children);
          if (found) return found;
        }
      }
      return null;
    }
    nextNode = findSibling(store.allocatedTreeNodes);

    if (nextNode) {
      selectedNode.value = nextNode;
      selectedKeys.value = { [nextNode.key]: true };
      selectedType.value = 'subnet';
      selectedSubnetId.value = nextNode.data.id;
    } else if (folderId) {
      const folder = store.folders.find(f => f.id === folderId);
      if (folder) {
        selectedType.value = 'folder';
        selectedFolder.value = folder;
        selectedSubnetId.value = null;
        selectedNode.value = null;
        selectedKeys.value = { [`folder-${folder.id}`]: true };
      }
    } else {
      selectedNode.value = null;
      selectedKeys.value = {};
      selectedType.value = null;
      selectedSubnetId.value = null;
    }

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
.subnets-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.split-pane {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.left-pane {
  display: flex;
  flex-direction: column;
  min-width: 240px;
  max-width: 600px;
  border-right: 1px solid var(--p-surface-border);
  overflow: hidden;
}
.pane-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 1rem;
  height: 42px;
  border-bottom: 1px solid var(--p-surface-border);
  flex-shrink: 0;
}
.header-actions {
  display: flex;
  gap: 0.35rem;
  align-items: center;
}
.tree-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
.subnet-treetable {
  background: transparent;
  border: none;
  padding: 0;
  width: 100%;
}
.subnet-treetable :deep(.p-treetable-table-container) {
  overflow: hidden;
}
.subnet-treetable :deep(.p-treetable-table) {
  font-size: 0.85rem;
  width: 100%;
}
.subnet-treetable :deep(.p-treetable-tbody > tr > td),
.subnet-treetable :deep(.p-treetable-thead > tr > th) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 4px;
  padding-right: 4px;
}
.subnet-treetable :deep(.p-treetable-thead > tr > th) {
  background: var(--p-surface-ground);
  border: none;
  border-bottom: 1px solid var(--p-surface-border);
  padding: 0.4rem 0.6rem;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--p-text-muted-color);
}
.subnet-treetable :deep(.p-treetable-tbody > tr > td) {
  padding: 0.3rem 0.6rem;
  border: none;
}
.subnet-treetable :deep(.p-treetable-tbody > tr) {
  background: transparent;
}
.subnet-treetable :deep(.p-treetable-tbody > tr:nth-child(even)) {
  background: rgba(255, 255, 255, 0.04);
}
.subnet-treetable :deep(.p-treetable-tbody > tr:hover) {
  background: var(--p-surface-hover);
}
.subnet-treetable :deep(.p-treetable-tbody > tr.p-treetable-row-selected) {
  background: var(--p-highlight-background);
  color: var(--p-highlight-text-color);
}
.subnet-treetable :deep(.p-treetable-toggler) {
  width: 1.5rem;
  height: 1.5rem;
  margin-right: 0.25rem;
}
.text-muted {
  color: var(--p-text-muted-color);
}
.folder-count-text {
  color: var(--p-text-muted-color);
  font-size: 0.8rem;
}
.resize-handle {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  flex-shrink: 0;
  transition: background 0.15s;
}
.resize-handle:hover {
  background: var(--p-primary-200);
}
.right-pane {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

/* Tree nodes */
.cell-fill {
  display: block;
  width: 100%;
  height: 100%;
  cursor: default;
}
.tree-node {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.1rem 0;
  font-size: 0.85rem;
}
.tree-node.unallocated {
  opacity: 0.55;
}
.tree-node.merge-selected {
  background: var(--p-primary-50);
  border-radius: 4px;
  padding: 0.1rem 0.3rem;
}
.folder-node {
  font-weight: 600;
}
.folder-name {
  color: var(--p-text-color);
}
.folder-count {
  font-size: 0.7rem;
  background: var(--p-surface-200);
  padding: 0.05rem 0.35rem;
  border-radius: 8px;
  font-weight: 400;
}
.node-cidr {
  font-family: monospace;
  font-weight: 600;
}
.node-prefix {
  font-family: monospace;
  color: var(--p-text-muted-color);
  font-size: 0.8em;
}
.node-name {
  color: var(--p-primary-color);
  font-weight: 500;
}
.node-name.faded { opacity: 0.6; }
.node-badge {
  font-size: 0.65rem;
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
}
.unalloc-badge { background: var(--p-surface-200); color: var(--p-text-muted-color); }
.range-badge { background: var(--p-primary-100); color: var(--p-primary-700); }
.merge-badge { background: var(--p-orange-100); color: var(--p-orange-700); font-weight: 600; }

/* Detail pane */
.folder-detail {
  padding: 1.5rem;
}
.folder-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}
.folder-detail-header h3 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.folder-description {
  color: var(--p-text-muted-color);
  margin: 0 0 0.5rem 0;
}
.folder-meta {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.empty-detail {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 0.75rem;
  color: var(--p-text-muted-color);
}
.empty-state {
  text-align: center;
  padding: 2rem;
  color: var(--p-text-muted-color);
  font-size: 0.9rem;
}

/* Forms */
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
.name-with-template {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.name-with-template .w-full { flex: 1; }

/* Divide */
.divide-preview {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  background: var(--p-surface-ground);
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
}
.divide-preview h4 { margin: 0 0 0.5rem 0; }
.divide-preview p { margin: 0.25rem 0; }
.divide-preview-warn { border-color: var(--p-orange-500); color: var(--p-orange-500); }
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
.divide-slider { flex: 1; cursor: pointer; }
.divide-count-input { width: 5rem; }
.divide-count-input :deep(input) { text-align: center; width: 100%; }
.divide-count-label { font-size: 0.85rem; color: var(--p-text-muted-color); white-space: nowrap; }

/* Merge */
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
.merge-validation-error {
  color: var(--p-orange-500);
  font-size: 0.8rem;
  align-self: center;
}

/* Browse pane */
.browse-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.browse-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 1rem;
  height: 42px;
  border-bottom: 1px solid var(--p-surface-border);
  flex-shrink: 0;
}
.browse-tree-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
.browse-node.is-leaf {
  cursor: grab;
}
.browse-node.is-leaf:active {
  cursor: grabbing;
}
.divided-badge { background: var(--p-surface-200); color: var(--p-text-muted-color); }
.alloc-badge { background: var(--p-green-50); color: var(--p-green-600); }
.browse-node.is-allocated { opacity: 0.7; }

/* Plain text status styles for table columns */
.status-allocated { color: var(--p-green-400); font-size: 0.8rem; }
.status-divided { color: var(--p-text-muted-color); font-size: 0.8rem; }
.status-drag { color: var(--p-primary-400); font-size: 0.8rem; font-style: italic; }
.status-merge { color: var(--p-orange-400); font-size: 0.8rem; font-weight: 600; }

/* Org networks pane */
.org-networks-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.org-description {
  padding: 0 1rem;
  margin: 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.drag-hint {
  background: var(--p-primary-50);
  color: var(--p-primary-500);
  font-style: italic;
}

.divide-mode-toggle {
  margin-bottom: 1rem;
}
.carved-highlight {
  font-weight: 600;
  color: var(--p-primary-color);
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
  color: var(--p-text-muted-color);
}
.carve-prefix-input {
  width: 4.5rem;
}
.carve-prefix-input :deep(input) {
  text-align: center;
  width: 100%;
}

.tree-container.pane-drop-target {
  outline: 2px dashed var(--p-primary-color);
  outline-offset: -2px;
  border-radius: 4px;
}

.warn-text { color: var(--p-red-500); font-size: 0.85rem; }
.mt-3 { margin-top: 0.75rem; }
</style>
