<template>
  <!-- Create/Edit Organization Dialog -->
  <Dialog v-model:visible="showFolderDialog" :header="editingFolder ? 'Edit Organization' : 'Create Organization'" modal :style="{ width: '26rem' }" data-track="dialog-org-edit">
    <div class="form-grid">
      <div class="field">
        <label>Name *</label>
        <InputText v-model="folderForm.name" class="w-full" />
      </div>
      <div class="field">
        <label>Description</label>
        <InputText v-model="folderForm.description" class="w-full" />
      </div>
      <div class="field">
        <label class="toggle-label">
          <input type="checkbox" v-model="folderForm.scan_enabled" />
          Include owned hosts in liveness scans by default
        </label>
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showFolderDialog = false" />
      <Button label="Save" @click="saveFolder" :loading="saving" />
    </template>
  </Dialog>

  <!-- Create Organization with Network Dialog -->
  <Dialog v-model:visible="showOrgDialog" header="Create Organization" modal :style="{ width: '28rem' }" data-track="dialog-org-create">
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

  <!-- Guided Setup Wizard -->
  <Dialog v-model:visible="showWizard" header="New Organization Setup" modal :style="{ width: '32rem' }" data-track="dialog-org-wizard"
          :closable="true" @hide="onWizardClose">
    <!-- Step indicators -->
    <div class="wizard-steps">
      <div class="wizard-step" :class="{ active: wizardStep === 1, done: wizardStep > 1 }">
        <span class="step-num">1</span>
        <span class="step-label">Organization</span>
      </div>
      <div class="wizard-step-line" :class="{ done: wizardStep > 1 }"></div>
      <div class="wizard-step" :class="{ active: wizardStep === 2, done: wizardStep > 2 }">
        <span class="step-num">2</span>
        <span class="step-label">Network</span>
      </div>
      <div class="wizard-step-line" :class="{ done: wizardStep > 2 }"></div>
      <div class="wizard-step" :class="{ active: wizardStep === 3 }">
        <span class="step-num">3</span>
        <span class="step-label">Import</span>
      </div>
    </div>

    <!-- Step 1: Organization -->
    <div v-if="wizardStep === 1" class="form-grid">
      <div class="field">
        <label>Organization Name *</label>
        <InputText v-model="wizardOrg.name" class="w-full" />
      </div>
      <div class="field">
        <label>Description</label>
        <InputText v-model="wizardOrg.description" class="w-full" />
      </div>
    </div>

    <!-- Step 2: Network -->
    <div v-if="wizardStep === 2" class="form-grid">
      <div class="field">
        <label>CIDR *</label>
        <InputText v-model="wizardNet.cidr" placeholder="10.0.0.0/8" class="w-full" />
        <small v-if="wizardCidrError" class="field-error">{{ wizardCidrError }}</small>
      </div>
      <div class="field">
        <label>Name</label>
        <div class="name-with-template">
          <InputText v-model="wizardNet.name" class="w-full" :placeholder="wizardAutoName || ''" />
          <Button icon="pi pi-sync" severity="secondary" text rounded size="small"
                  title="Apply name template" @click="wizardNet.name = wizardAutoName" />
        </div>
      </div>
      <div class="field">
        <label>Description</label>
        <InputText v-model="wizardNet.description" class="w-full" />
      </div>
      <div class="field">
        <label>VLAN</label>
        <div style="display: flex; gap: 0.25rem; align-items: center">
          <AutoComplete v-model="wizardVlanSelection" :suggestions="vlanSuggestions"
                        @complete="searchWizardVlans" optionLabel="display"
                        placeholder="Search by name or ID..." class="w-full"
                        @item-select="onWizardVlanSelect" @clear="wizardNet.vlan_id = null" dropdown />
          <Button icon="pi pi-plus" text rounded size="small"
                  title="Create VLAN" @click="wizardNewVlanNameManual = false; wizardNewVlanForm = { vlan_id: null, name: '' }; showWizardCreateVlan = true" />
        </div>
      </div>
      <div class="field">
        <label>Default Gateway Position</label>
        <SelectButton v-model="wizardNet.gateway_position" :options="gatewayOptions"
                      optionLabel="label" optionValue="value" size="small" />
      </div>
      <div class="field">
        <label>Domain Name</label>
        <InputText v-model="wizardNet.domain_name" class="w-full" />
        <Message v-if="domainWarningShown && !wizardNet.domain_name" severity="warn" :closable="false" class="mt-1">
          No domain name entered — DNS features will be limited. Click "Create &amp; Continue" again to proceed anyway.
        </Message>
      </div>
      <div class="field" v-if="wizardPrefixLength <= 29">
        <label class="toggle-label">
          <input type="checkbox" v-model="wizardNet.create_dhcp_scope" />
          Create DHCP scope
        </label>
      </div>
      <template v-if="wizardNet.create_dhcp_scope && wizardPrefixLength <= 29">
        <div class="field">
          <label>Start IP</label>
          <InputText v-model="wizardNet.dhcp_start_ip" class="w-full" />
        </div>
        <div class="field">
          <label>End IP</label>
          <InputText v-model="wizardNet.dhcp_end_ip" class="w-full" />
        </div>
      </template>
      <div class="field">
        <label class="toggle-label">
          <input type="checkbox" v-model="wizardNet.create_reverse_dns" />
          Create reverse DNS zone
        </label>
      </div>
      <div class="field">
        <label class="toggle-label">
          <input type="checkbox" v-model="wizardNet.scan_enabled" />
          Include hosts in liveness scans by default
        </label>
      </div>
    </div>

    <!-- Step 3: Pi-hole Import -->
    <div v-if="wizardStep === 3" class="pihole-import-step">
      <Tabs :value="piholeTab">
        <TabList>
          <Tab value="online"><i class="pi pi-globe" style="margin-right: 0.3rem" />Online</Tab>
          <Tab value="file"><i class="pi pi-upload" style="margin-right: 0.3rem" />File Upload</Tab>
        </TabList>
        <TabPanels>
          <TabPanel value="online">
            <div class="form-grid" style="margin-top: 0.5rem">
              <div class="field">
                <label>Pi-hole URL</label>
                <InputText v-model="piholeUrl" placeholder="http://pihole.local" class="w-full"
                           :class="{ 'pihole-reachable': piholeProbeStatus === 'ok', 'pihole-unreachable': piholeProbeStatus === 'fail' }" />
                <small v-if="piholeProbeStatus === 'fail'" class="field-error">{{ piholeProbeError }}</small>
                <small v-if="piholeProbeStatus === 'ok' && piholeNeedsPassword && !piholePassword" class="field-warn">Password required</small>
              </div>
              <div class="field">
                <label>Password (optional)</label>
                <InputText v-model="piholePassword" type="password" class="w-full" placeholder="Leave empty if none" />
              </div>
              <div class="field" style="text-align: right">
                <Button label="Connect" icon="pi pi-download" size="small"
                        @click="fetchPiholeConfig" :loading="piholeFetching"
                        :disabled="piholeProbeStatus !== 'ok' || (piholeNeedsPassword && !piholePassword)" />
              </div>
            </div>
          </TabPanel>
          <TabPanel value="file">
            <div class="form-grid" style="margin-top: 0.5rem">
              <div class="field">
                <label>Select pihole.toml</label>
                <input type="file" accept=".toml" @change="onPiholeFileSelect" ref="piholeFileInput" />
              </div>
              <div class="field" style="text-align: right" v-if="piholeFileContent">
                <Button label="Parse" icon="pi pi-cog" size="small"
                        @click="parsePiholeFile" :loading="piholeParsing" />
              </div>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>

      <!-- Preview -->
      <div v-if="piholePreview" class="pihole-preview">
        <h4>Import Preview</h4>
        <div class="preview-summary">
          <div class="preview-item">
            <span class="preview-count">{{ piholePreview.hosts.length }}</span>
            <span class="preview-label">A records</span>
          </div>
          <div class="preview-item">
            <span class="preview-count">{{ piholePreview.cnames.length }}</span>
            <span class="preview-label">CNAME records</span>
          </div>
          <div class="preview-item">
            <span class="preview-count">{{ piholePreview.dhcpHosts.length }}</span>
            <span class="preview-label">DHCP reservations</span>
          </div>
        </div>
        <small v-if="piholePreview.zoneName" class="muted">Zone: {{ piholePreview.zoneName }}</small>
      </div>

      <!-- Import results -->
      <div v-if="piholeImportResults" class="pihole-results">
        <Message severity="success" :closable="false">
          Import complete:
          {{ piholeImportResults.a.created }} A,
          {{ piholeImportResults.cname.created }} CNAME,
          {{ piholeImportResults.dhcp.created }} DHCP created
          <template v-if="piholeImportResults.dhcp.noSubnet > 0">
            ({{ piholeImportResults.dhcp.noSubnet }} DHCP skipped — no matching subnet)
          </template>
        </Message>
      </div>
    </div>

    <template #footer>
      <div class="wizard-footer">
        <Button v-if="wizardStep > 1" label="Back" icon="pi pi-arrow-left" severity="secondary" text
                @click="wizardStep--" />
        <span style="flex: 1"></span>
        <Button label="Cancel" severity="secondary" text @click="showWizard = false" />
        <Button v-if="wizardStep === 1" label="Save & Exit" severity="secondary"
                @click="wizardSaveAndExit" :loading="saving" :disabled="!wizardOrg.name" />
        <Button v-if="wizardStep === 1" label="Continue" icon="pi pi-arrow-right" iconPos="right"
                @click="wizardStep = 2" :disabled="!wizardOrg.name" />
        <Button v-if="wizardStep === 2" label="Create & Continue" icon="pi pi-arrow-right" iconPos="right"
                @click="wizardCreateAndContinue" :loading="saving"
                :disabled="!!wizardCidrError || !wizardNet.cidr" />
        <Button v-if="wizardStep === 3" label="Skip" severity="secondary"
                @click="wizardFinish" :disabled="piholeImporting" />
        <Button v-if="wizardStep === 3 && !piholeImportResults" label="Import" icon="pi pi-download"
                @click="executePiholeImport" :loading="piholeImporting"
                :disabled="!piholePreview" />
        <Button v-if="wizardStep === 3 && piholeImportResults" label="Done" icon="pi pi-check"
                @click="wizardFinish" />
      </div>
    </template>
  </Dialog>

  <!-- Create VLAN from Wizard -->
  <Dialog v-model:visible="showWizardCreateVlan" header="Create VLAN" modal :style="{ width: '24rem' }">
    <div class="form-grid">
      <div class="field">
        <label>VLAN ID *</label>
        <InputNumber v-model="wizardNewVlanForm.vlan_id" :min="1" :max="4094" :useGrouping="false" class="w-full"
                     @update:modelValue="onWizardNewVlanIdInput" />
      </div>
      <div class="field">
        <label>Name *</label>
        <InputText v-model="wizardNewVlanForm.name" class="w-full" @input="wizardNewVlanNameManual = true" />
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showWizardCreateVlan = false" />
      <Button label="Save" @click="createVlanFromWizard" :loading="saving"
              :disabled="!wizardNewVlanForm.vlan_id || !wizardNewVlanForm.name" />
    </template>
  </Dialog>

  <!-- Delete Organization Dialog -->
  <Dialog v-model:visible="showDeleteFolderDialog" header="Delete Organization" modal :style="{ width: '28rem' }" data-track="dialog-org-delete"
          @hide="deleteConfirmText = ''">
    <p>Delete organization <strong>{{ deletingFolder?.name }}</strong>?</p>
    <template v-if="deletingFolder?.subnets?.length > 0 || deletingFolder?.zone_count > 0">
      <p class="warn-text">
        This will permanently delete
        <template v-if="deletingFolder.subnets?.length > 0">{{ deletingFolder.subnets.length }} network(s)</template>
        <template v-if="deletingFolder.subnets?.length > 0 && deletingFolder.zone_count > 0"> and </template>
        <template v-if="deletingFolder.zone_count > 0">{{ deletingFolder.zone_count }} DNS zone(s)</template>
        and all associated DHCP scopes, reservations, and records.
      </p>
      <p class="warn-text" style="margin-top: 0.5rem;">Type <strong>DELETE</strong> to confirm:</p>
      <InputText v-model="deleteConfirmText" placeholder="DELETE" style="width: 100%" />
    </template>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showDeleteFolderDialog = false" />
      <Button label="Delete" severity="danger" @click="executeDeleteFolder" :loading="saving"
              :disabled="(deletingFolder?.subnets?.length > 0 || deletingFolder?.zone_count > 0) && deleteConfirmText !== 'DELETE'" />
    </template>
  </Dialog>

  <!-- Create Network Dialog -->
  <Dialog v-model:visible="showSubnetDialog" header="Create Network" modal :style="{ width: '28rem' }" data-track="dialog-network-create">
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
  <Dialog v-model:visible="showDivide" header="Divide Network" modal :style="{ width: '36rem' }" data-track="dialog-network-divide">
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

  <!-- Edit Network Dialog -->
  <Dialog v-model:visible="showNetworkDialog" :header="networkDialogHeader" modal :style="{ width: '30rem' }" data-track="dialog-network-edit">
    <div class="form-grid">
      <template v-if="networkDialogMode === 'create'">
        <div class="field">
          <label>CIDR *</label>
          <InputText v-model="networkForm.cidr" placeholder="10.0.0.0/8" class="w-full" />
          <small v-if="createCidrError" class="field-error">{{ createCidrError }}</small>
        </div>
        <div class="field">
          <label>Organization</label>
          <Select v-model="networkForm.folder_id" :options="folderOptions" optionLabel="name" optionValue="id"
                  placeholder="Select organization" class="w-full" />
        </div>
      </template>
      <div class="field">
        <label>Name *</label>
        <div class="name-with-template">
          <InputText v-model="networkForm.name" class="w-full" :placeholder="createAutoName || ''" />
          <Button icon="pi pi-sync" severity="secondary" text rounded size="small"
                  title="Apply name template" @click="applyTemplateToEdit" />
        </div>
      </div>
      <div class="field">
        <label>Description</label>
        <InputText v-model="networkForm.description" class="w-full" />
      </div>
      <div class="field">
        <label>VLAN</label>
        <div style="display: flex; gap: 0.25rem; align-items: center">
          <AutoComplete v-model="editVlanSelection" :suggestions="vlanSuggestions"
                        @complete="searchVlans" optionLabel="display"
                        placeholder="Search by name or ID..." class="w-full"
                        @item-select="onVlanSelect" @clear="onVlanClear" dropdown />
          <Button icon="pi pi-plus" text rounded size="small"
                  title="Create VLAN" @click="newVlanNameManual = false; newVlanForm = { vlan_id: null, name: '' }; showCreateVlanFromEdit = true" />
        </div>
      </div>
      <div class="field">
        <label>Gateway</label>
        <InputText v-model="networkForm.gateway_address" placeholder="Auto (system default)" class="w-full" />
      </div>
      <div class="field">
        <label>Domain Name</label>
        <InputText v-model="networkForm.domain_name" placeholder="e.g. office.example.com" class="w-full" />
      </div>
      <div class="field">
        <label>Liveness Scanning</label>
        <div class="scan-toggle-group">
          <button type="button" :class="['scan-toggle-btn', 'scan-inherit', { active: networkForm.scan_enabled === null }]"
                  @click="networkForm.scan_enabled = null">Inherit</button>
          <button type="button" :class="['scan-toggle-btn', 'scan-enabled', { active: networkForm.scan_enabled === true, resolved: networkForm.scan_enabled === null && resolvedOrgScanEnabled }]"
                  @click="networkForm.scan_enabled = true">Enabled</button>
          <button type="button" :class="['scan-toggle-btn', 'scan-disabled', { active: networkForm.scan_enabled === false, resolved: networkForm.scan_enabled === null && !resolvedOrgScanEnabled }]"
                  @click="networkForm.scan_enabled = false">Disabled</button>
        </div>
        <small class="field-help" v-if="networkForm.scan_enabled === null">
          Inherits from organization — scanning is {{ resolvedOrgScanEnabled ? 'enabled' : 'disabled' }} for this network
        </small>
        <small class="field-help" v-else-if="networkForm.scan_enabled === true">Scanning is enabled for this network</small>
        <small class="field-help" v-else>Scanning is disabled for this network</small>
      </div>
      <template v-if="networkDialogMode === 'configure' || networkDialogMode === 'create'">
        <div class="field" v-if="effectivePrefixLength <= 29">
          <label class="toggle-label">
            <input type="checkbox" v-model="networkForm.create_dhcp_scope" />
            Create DHCP scope
          </label>
        </div>
        <template v-if="networkForm.create_dhcp_scope">
          <div class="field">
            <label>Start IP *</label>
            <InputText v-model="networkForm.dhcp_start_ip" class="w-full" :placeholder="dhcpDefaults.start" />
          </div>
          <div class="field">
            <label>End IP *</label>
            <InputText v-model="networkForm.dhcp_end_ip" class="w-full" :placeholder="dhcpDefaults.end" />
          </div>
        </template>
        <div class="field">
          <label class="toggle-label">
            <input type="checkbox" v-model="networkForm.create_reverse_dns" />
            Create reverse DNS zone
          </label>
        </div>
      </template>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showNetworkDialog = false" />
      <Button :label="networkDialogMode === 'create' ? 'Create' : 'Save'" @click="executeNetworkSave" :loading="saving"
              :disabled="networkDialogMode === 'create' && !!createCidrError" />
    </template>
  </Dialog>

  <!-- Create VLAN from Edit Dialog -->
  <Dialog v-model:visible="showCreateVlanFromEdit" header="Create VLAN" modal :style="{ width: '24rem' }">
    <div class="form-grid">
      <div class="field">
        <label>VLAN ID *</label>
        <InputNumber v-model="newVlanForm.vlan_id" :min="1" :max="4094" :useGrouping="false" class="w-full"
                     @update:modelValue="onNewVlanIdInput" />
      </div>
      <div class="field">
        <label>Name *</label>
        <InputText v-model="newVlanForm.name" class="w-full" @input="newVlanNameManual = true" />
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
  <Dialog v-model:visible="showDelete" header="Delete Network" modal :style="{ width: '26rem' }" data-track="dialog-network-delete">
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

  <!-- Deallocate Network Dialog -->
  <Dialog v-model:visible="showDeallocate" header="Deallocate Network" modal :style="{ width: '26rem' }" data-track="dialog-network-deallocate">
    <template v-if="props.selectedNode">
      <p>Deallocate <strong>{{ props.selectedNode.data.cidr }}</strong>?</p>
      <p class="warn-text">
        This will remove all configuration, ranges, and IP assignments. The network block will remain as unallocated space.
      </p>
    </template>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showDeallocate = false" />
      <Button label="Deallocate" severity="danger" @click="executeDeallocate" :loading="saving" />
    </template>
  </Dialog>

  <!-- Merge Networks Dialog -->
  <Dialog v-model:visible="showMerge" header="Merge Networks" modal :style="{ width: '32rem' }" data-track="dialog-network-merge">
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
  <Dialog v-model:visible="showGroupConfigure" header="Allocate Group" modal :style="{ width: '28rem' }" data-track="dialog-group-allocate">
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
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import { useSubnetStore } from '../stores/subnets.js';
import api from '../api/client.js';
import { validateSupernet, isValidCidr, normalizeCidr, applyNameTemplate, calculateSubnets, subtractCidr, isSubnetOf, parseCidr, ipToLong, longToIp } from '../utils/ip.js';

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
const deleteConfirmText = ref('');
const folderForm = ref({ name: '', description: '', scan_enabled: true });
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

// ── Guided Setup Wizard ──
const showWizard = ref(false);
const wizardStep = ref(1);
const wizardOrg = ref({ name: '', description: '' });
const wizardNet = ref({
  cidr: '', name: '', description: '', vlan_id: null,
  gateway_position: 'first', domain_name: '',
  create_dhcp_scope: false, create_reverse_dns: false,
  dhcp_start_ip: '', dhcp_end_ip: '',
  scan_enabled: true,
});
const gatewayOptions = [
  { label: 'First Addr', value: 'first' },
  { label: 'Last Addr', value: 'last' },
  { label: 'None', value: 'none' },
];
const domainWarningShown = ref(false);
const wizardVlanSelection = ref(null);
const showWizardCreateVlan = ref(false);
const wizardNewVlanForm = ref({ vlan_id: null, name: '' });
const wizardNewVlanNameManual = ref(false);
// Track created resources for cleanup on cancel
const wizardCreatedFolderId = ref(null);
const wizardCreatedVlanId = ref(null);

// Ensure the org exists (commit eagerly), returns folder_id
async function ensureWizardOrg() {
  if (wizardCreatedFolderId.value) return wizardCreatedFolderId.value;
  await store.createFolder({
    name: wizardOrg.value.name,
    description: wizardOrg.value.description || undefined,
    gateway_position: wizardNet.value.gateway_position || 'first',
    scan_enabled: wizardNet.value.scan_enabled,
  });
  const folder = store.folders.find(f => f.name === wizardOrg.value.name.trim());
  wizardCreatedFolderId.value = folder?.id;
  return folder?.id;
}

const wizardCidrError = computed(() => {
  const cidr = (wizardNet.value.cidr || '').trim();
  if (!cidr) return null;
  if (!isValidCidr(cidr)) return 'Invalid CIDR notation';
  return null;
});

const wizardAutoName = computed(() => {
  const cidr = (wizardNet.value.cidr || '').trim();
  if (!cidr || !isValidCidr(cidr)) return '';
  try { return applyNameTemplate(props.nameTemplate, normalizeCidr(cidr)); }
  catch { return ''; }
});

const wizardPrefixLength = computed(() => {
  const cidr = (wizardNet.value.cidr || '').trim();
  if (cidr && isValidCidr(cidr)) return parseCidr(cidr).prefix;
  return 32;
});

function nearestPow2(n) {
  if (n <= 1) return 1;
  const lower = Math.pow(2, Math.floor(Math.log2(n)));
  const upper = lower * 2;
  return (n - lower) <= (upper - n) ? lower : upper;
}

function dhcpRangeDefaults(p, gw) {
  const size = p.broadcastLong - p.networkLong + 1;
  const prefix = Math.round(32 - Math.log2(size));
  // Only auto-fill for /21 through /26
  if (prefix < 21 || prefix > 26) return { start: '', end: '' };
  const gwLong = gw ? ipToLong(gw) : null;
  let poolEnd, poolSize;
  if (prefix <= 23) {
    // /21, /22, /23: cap end at network + 128, pool size = 64
    poolEnd = p.networkLong + 128;
    poolSize = 64;
  } else {
    // /24, /25, /26: use power-of-2 formula
    poolEnd = p.networkLong + nearestPow2(size * 0.35);
    poolSize = nearestPow2(size * 0.15);
  }
  let poolStart = poolEnd - poolSize + 1;
  // Ensure within usable range
  poolStart = Math.max(poolStart, p.networkLong + 1);
  poolEnd = Math.min(poolEnd, p.broadcastLong - 1);
  if (gwLong === poolStart) poolStart++;
  else if (gwLong === poolEnd) poolEnd--;
  return { start: longToIp(poolStart), end: longToIp(poolEnd) };
}

function gatewayIpFromPosition(cidr, position) {
  if (!position || position === 'none') return null;
  const p = parseCidr(cidr);
  return position === 'last' ? p.lastUsable : p.firstUsable;
}

const wizardDhcpDefaults = computed(() => {
  const cidr = (wizardNet.value.cidr || '').trim();
  if (!cidr || !isValidCidr(cidr)) return { start: '', end: '' };
  const p = parseCidr(cidr);
  const gw = gatewayIpFromPosition(cidr, wizardNet.value.gateway_position);
  return dhcpRangeDefaults(p, gw);
});

watch(() => wizardNet.value.gateway_position, () => {
  if (wizardNet.value.create_dhcp_scope) {
    const d = wizardDhcpDefaults.value;
    wizardNet.value.dhcp_start_ip = d.start || '';
    wizardNet.value.dhcp_end_ip = d.end || '';
  }
});

watch(() => wizardNet.value.create_dhcp_scope, (checked) => {
  if (checked && !wizardNet.value.dhcp_start_ip && !wizardNet.value.dhcp_end_ip) {
    const d = wizardDhcpDefaults.value;
    if (d.start) wizardNet.value.dhcp_start_ip = d.start;
    if (d.end) wizardNet.value.dhcp_end_ip = d.end;
  }
});

function searchWizardVlans(event) {
  // Reuse the existing vlan search but scoped — wizard has no folder yet so search all
  api.get('/vlans/search', { params: { q: event.query } }).then(res => {
    vlanSuggestions.value = res.data.map(v => ({ ...v, display: `VLAN ${v.vlan_id} — ${v.name}` }));
  }).catch(() => { vlanSuggestions.value = []; });
}

function onWizardVlanSelect(event) {
  wizardNet.value.vlan_id = event.value.vlan_id;
}

function onWizardNewVlanIdInput(val) {
  if (!wizardNewVlanNameManual.value) {
    wizardNewVlanForm.value.name = val ? `VLAN${val}` : '';
  }
}

async function createVlanFromWizard() {
  saving.value = true;
  try {
    const folderId = await ensureWizardOrg();
    const res = await api.post('/vlans', {
      folder_id: folderId,
      vlan_id: wizardNewVlanForm.value.vlan_id,
      name: wizardNewVlanForm.value.name,
    });
    const created = res.data;
    wizardNet.value.vlan_id = created.vlan_id;
    wizardVlanSelection.value = { ...created, display: `VLAN ${created.vlan_id} — ${created.name}` };
    wizardCreatedVlanId.value = created.id;
    showWizardCreateVlan.value = false;
    wizardNewVlanForm.value = { vlan_id: null, name: '' };
    wizardNewVlanNameManual.value = false;
    toast.add({ severity: 'success', summary: 'VLAN created', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

async function wizardSaveAndExit() {
  saving.value = true;
  try {
    await ensureWizardOrg();
    wizardCreatedFolderId.value = null; // don't clean up on close — user chose to save
    showWizard.value = false;
    toast.add({ severity: 'success', summary: 'Organization created', life: 3000 });
    emit('org-created');
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

async function wizardCreateAndContinue() {
  if (!wizardNet.value.domain_name && !domainWarningShown.value) {
    domainWarningShown.value = true;
    return;
  }
  saving.value = true;
  try {
    const folderId = await ensureWizardOrg();

    const cidr = wizardNet.value.cidr.trim();
    const created = await store.createSupernet({
      cidr,
      name: wizardNet.value.name || undefined,
      folder_id: folderId,
    });

    const payload = {
      name: wizardNet.value.name || wizardAutoName.value || cidr,
      description: wizardNet.value.description || undefined,
      vlan_id: wizardNet.value.vlan_id || undefined,
      gateway_address: gatewayIpFromPosition(cidr, wizardNet.value.gateway_position) || undefined,
      domain_name: wizardNet.value.domain_name || undefined,
      create_dhcp_scope: wizardNet.value.create_dhcp_scope,
      create_reverse_dns: wizardNet.value.create_reverse_dns,
    };
    if (payload.create_dhcp_scope) {
      payload.dhcp_start_ip = wizardNet.value.dhcp_start_ip || wizardDhcpDefaults.value.start;
      payload.dhcp_end_ip = wizardNet.value.dhcp_end_ip || wizardDhcpDefaults.value.end;
    }
    await store.configureSubnet(created.id, payload);

    wizardCreatedSubnetId.value = created.id;
    toast.add({ severity: 'success', summary: 'Organization and network created', life: 3000 });
    wizardStep.value = 3;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { saving.value = false; }
}

function wizardFinish() {
  wizardCreatedFolderId.value = null;
  wizardCreatedVlanId.value = null;
  showWizard.value = false;
  emit('org-created');
  emit('network-created');
}

// ── Pi-hole Import (Step 3) ──
const piholeTab = ref('online');
const piholeUrl = ref('');
const piholePassword = ref('');
const piholeProbeStatus = ref(null); // null | 'ok' | 'fail'
const piholeProbeError = ref('');
const piholeNeedsPassword = ref(false);
const piholeFetching = ref(false);
const piholeParsing = ref(false);
const piholeImporting = ref(false);
const piholePreview = ref(null);
const piholeImportResults = ref(null);
const piholeFileContent = ref(null);
const piholeFileInput = ref(null);
const wizardCreatedSubnetId = ref(null);

function cleanPiholeUrl(raw) {
  let url = raw.trim();
  if (!url) return '';
  // Add scheme if missing
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  try {
    const parsed = new URL(url);
    // Strip path, query, hash — keep only scheme://host[:port]
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

let piholeProbeTimer = null;

async function probePihole() {
  const url = cleanPiholeUrl(piholeUrl.value);
  if (!url) { piholeProbeStatus.value = null; return; }
  // Update the input to the cleaned URL
  if (url !== piholeUrl.value.trim()) piholeUrl.value = url;
  try {
    const res = await api.post('/pihole/probe', { url, password: piholePassword.value || undefined });
    if (res.data.reachable) {
      piholeProbeStatus.value = 'ok';
      piholeNeedsPassword.value = res.data.needsPassword;
      piholeProbeError.value = '';
    } else {
      piholeProbeStatus.value = 'fail';
      piholeProbeError.value = res.data.error || 'Could not connect';
    }
  } catch (err) {
    piholeProbeStatus.value = 'fail';
    piholeProbeError.value = err.response?.data?.error || err.message;
  }
}

// Auto-probe when URL changes (debounced)
watch(piholeUrl, (val) => {
  clearTimeout(piholeProbeTimer);
  piholeProbeStatus.value = null;
  piholeProbeError.value = '';
  const trimmed = val?.trim();
  if (!trimmed) return;
  piholeProbeTimer = setTimeout(() => probePihole(), 600);
});

async function fetchPiholeConfig() {
  piholeFetching.value = true;
  try {
    const res = await api.post('/pihole/fetch', {
      url: piholeUrl.value.trim(),
      password: piholePassword.value || undefined
    });
    piholePreview.value = res.data;
    piholeImportResults.value = null;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Fetch failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { piholeFetching.value = false; }
}

function onPiholeFileSelect(event) {
  const file = event.target.files[0];
  if (!file) { piholeFileContent.value = null; return; }
  const reader = new FileReader();
  reader.onload = (e) => { piholeFileContent.value = e.target.result; };
  reader.readAsText(file);
}

async function parsePiholeFile() {
  piholeParsing.value = true;
  try {
    const res = await api.post('/pihole/parse', piholeFileContent.value, {
      headers: { 'Content-Type': 'text/plain' }
    });
    piholePreview.value = res.data;
    piholeImportResults.value = null;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Parse failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { piholeParsing.value = false; }
}

async function executePiholeImport() {
  if (!piholePreview.value) return;
  piholeImporting.value = true;
  try {
    // Find the forward zone for the domain created in step 2
    const dnsStore = (await import('../stores/dns.js')).useDnsStore();
    await dnsStore.fetchZones();
    const domainName = piholePreview.value.zoneName || wizardNet.value.domain_name;

    let zone = dnsStore.zones.find(z => z.name === domainName && z.type === 'forward');
    if (!zone && domainName) {
      // Create the zone if it doesn't exist
      zone = await dnsStore.createZone({ name: domainName, type: 'forward', folder_id: wizardCreatedFolderId.value });
    }
    if (!zone) {
      toast.add({ severity: 'error', summary: 'No zone found', detail: 'Could not find or create a forward DNS zone for import', life: 5000 });
      return;
    }

    const res = await api.post('/pihole/import', {
      zoneId: zone.id,
      hosts: piholePreview.value.hosts,
      cnames: piholePreview.value.cnames,
      dhcpHosts: piholePreview.value.dhcpHosts,
    });
    piholeImportResults.value = res.data.results;
    toast.add({ severity: 'success', summary: 'Pi-hole import complete', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Import failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { piholeImporting.value = false; }
}

function resetPiholeState() {
  piholeTab.value = 'online';
  piholeUrl.value = '';
  piholePassword.value = '';
  piholeProbeStatus.value = null;
  piholeProbeError.value = '';
  piholeNeedsPassword.value = false;
  piholePreview.value = null;
  piholeImportResults.value = null;
  piholeFileContent.value = null;
  wizardCreatedSubnetId.value = null;
}

async function onWizardClose() {
  // Clean up eagerly-created resources if user cancelled
  if (wizardCreatedVlanId.value) {
    try { await api.delete(`/vlans/${wizardCreatedVlanId.value}`); } catch { /* best effort */ }
  }
  if (wizardCreatedFolderId.value) {
    try { await store.deleteFolder(wizardCreatedFolderId.value, true); } catch { /* best effort */ }
    emit('org-deleted');
  }
  // Reset wizard state
  wizardStep.value = 1;
  wizardOrg.value = { name: '', description: '' };
  wizardNet.value = {
    cidr: '', name: '', description: '', vlan_id: null,
    gateway_position: 'first', domain_name: '',
    create_dhcp_scope: false, create_reverse_dns: false,
    dhcp_start_ip: '', dhcp_end_ip: '',
  };
  domainWarningShown.value = false;
  wizardVlanSelection.value = null;
  wizardCreatedFolderId.value = null;
  wizardCreatedVlanId.value = null;
  resetPiholeState();
}

function openWizard() {
  onWizardClose(); // reset
  showWizard.value = true;
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
    const force = deletingFolder.value?.subnets?.length > 0 || deletingFolder.value?.zone_count > 0;
    await store.deleteFolder(deletingFolder.value.id, force);
    showDeleteFolderDialog.value = false;
    deleteConfirmText.value = '';
    toast.add({ severity: 'success', summary: 'Organization deleted', life: 3000 });
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

// ── Unified Configure / Edit dialog ──
const showNetworkDialog = ref(false);
const networkDialogMode = ref('edit'); // 'create', 'configure', or 'edit'
const networkForm = ref({ name: '', description: '', vlan_id: null, gateway_address: '', domain_name: '', create_dhcp_scope: false, create_reverse_dns: false, dhcp_start_ip: '', dhcp_end_ip: '', scan_enabled: null });
const resolvedOrgScanEnabled = computed(() => {
  const folderId = props.selectedNode?.data?.folder_id || getSubnetFolderId();
  if (!folderId) return true; // default
  const folder = store.folders.find(f => f.id === folderId);
  return folder ? !!folder.scan_enabled : true;
});
const dropTargetFolderIdForConfigure = ref(null);

const networkDialogHeader = computed(() => {
  if (networkDialogMode.value === 'create') return 'Add Network';
  if (networkDialogMode.value === 'configure') return 'Configure Network';
  return 'Edit Network';
});

const createCidrError = computed(() => {
  if (networkDialogMode.value !== 'create') return null;
  const cidr = (networkForm.value.cidr || '').trim();
  if (!cidr) return null;
  if (!isValidCidr(cidr)) return 'Invalid CIDR notation';
  return null;
});

const createAutoName = computed(() => {
  if (networkDialogMode.value !== 'create') return '';
  const cidr = (networkForm.value.cidr || '').trim();
  if (!cidr || !isValidCidr(cidr)) return '';
  try { return applyNameTemplate(props.nameTemplate, normalizeCidr(cidr)); }
  catch { return ''; }
});

const effectivePrefixLength = computed(() => {
  if (networkDialogMode.value === 'create') {
    const cidr = (networkForm.value.cidr || '').trim();
    if (cidr && isValidCidr(cidr)) return parseCidr(cidr).prefix;
    return 32;
  }
  return props.selectedNode?.data?.prefix_length ?? 32;
});

const dhcpDefaults = computed(() => {
  if (networkDialogMode.value === 'create') {
    const cidr = (networkForm.value.cidr || '').trim();
    if (!cidr || !isValidCidr(cidr)) return { start: '', end: '' };
    return dhcpRangeDefaults(parseCidr(cidr), networkForm.value.gateway_address || null);
  }
  const d = props.selectedNode?.data;
  if (!d) return { start: '', end: '' };
  return dhcpRangeDefaults(parseCidr(d.cidr), networkForm.value.gateway_address || null);
});

watch(showNetworkDialog, (val) => { if (!val) dropTargetFolderIdForConfigure.value = null; });
const editVlanSelection = ref(null);
const vlanSuggestions = ref([]);
const showVlanWarning = ref(false);
const pendingVlanSelection = ref(null);
const showCreateVlanFromEdit = ref(false);
const newVlanForm = ref({ vlan_id: null, name: '' });
const newVlanNameManual = ref(false);

function onNewVlanIdInput(val) {
  if (!newVlanNameManual.value) {
    newVlanForm.value.name = val ? `VLAN${val}` : '';
  }
}

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
  } catch (err) {
    vlanSuggestions.value = [];
    const detail = err.response?.data?.error || err.message;
    toast.add({ severity: 'error', summary: 'VLAN lookup failed', detail, life: 5000 });
  }
}

function onVlanSelect(event) {
  const vlan = event.value;
  const currentVlanId = props.selectedNode?.data?.vlan_id;
  if (vlan.subnet_count > 0 && vlan.vlan_id !== currentVlanId) {
    pendingVlanSelection.value = vlan;
    showVlanWarning.value = true;
  } else {
    networkForm.value.vlan_id = vlan.vlan_id;
    if (!networkForm.value.name) networkForm.value.name = vlan.name;
  }
}

function confirmVlanAssignment() {
  networkForm.value.vlan_id = pendingVlanSelection.value.vlan_id;
  if (!networkForm.value.name) networkForm.value.name = pendingVlanSelection.value.name;
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
  networkForm.value.vlan_id = d?.vlan_id || null;
}

function onVlanClear() {
  networkForm.value.vlan_id = null;
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
    networkForm.value.vlan_id = created.vlan_id;
    if (!networkForm.value.name) networkForm.value.name = created.name;
    editVlanSelection.value = { ...created, display: `VLAN ${created.vlan_id} — ${created.name}` };
    showCreateVlanFromEdit.value = false;
    newVlanForm.value = { vlan_id: null, name: '' };
    newVlanNameManual.value = false;
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
  const cidr = networkDialogMode.value === 'create'
    ? networkForm.value.cidr
    : props.selectedNode.data.cidr;
  if (cidr && isValidCidr(cidr)) {
    networkForm.value.name = applyNameTemplate(props.nameTemplate, cidr);
  }
}

async function executeNetworkSave() {
  saving.value = true;
  try {
    if (networkDialogMode.value === 'create') {
      // Create the supernet first, then configure it
      const cidr = networkForm.value.cidr.trim();
      const created = await store.createSupernet({
        cidr,
        name: networkForm.value.name || undefined,
        folder_id: networkForm.value.folder_id || undefined,
      });
      // Now configure it with full options
      const payload = { ...networkForm.value };
      payload.name = payload.name || createAutoName.value || cidr;
      delete payload.cidr;
      delete payload.folder_id;
      if (payload.create_dhcp_scope) {
        payload.dhcp_start_ip = payload.dhcp_start_ip || dhcpDefaults.value.start;
        payload.dhcp_end_ip = payload.dhcp_end_ip || dhcpDefaults.value.end;
      }
      await store.configureSubnet(created.id, payload);
      showNetworkDialog.value = false;
      toast.add({ severity: 'success', summary: 'Network created', life: 3000 });
      emit('network-created');
    } else if (networkDialogMode.value === 'configure') {
      const id = props.selectedNode.data.id;
      const payload = { ...networkForm.value };
      if (dropTargetFolderIdForConfigure.value) {
        payload.folder_id = dropTargetFolderIdForConfigure.value;
      }
      // Use user-specified or default DHCP range
      if (payload.create_dhcp_scope) {
        payload.dhcp_start_ip = payload.dhcp_start_ip || dhcpDefaults.value.start;
        payload.dhcp_end_ip = payload.dhcp_end_ip || dhcpDefaults.value.end;
      }
      await store.configureSubnet(id, payload);
      showNetworkDialog.value = false;
      toast.add({ severity: 'success', summary: 'Network configured', life: 3000 });
      emit('network-configured', id);
    } else {
      const id = props.selectedNode.data.id;
      const { create_dhcp_scope, create_reverse_dns, ...editPayload } = networkForm.value;
      await store.updateSubnet(id, editPayload);
      showNetworkDialog.value = false;
      toast.add({ severity: 'success', summary: 'Network updated', life: 3000 });
      emit('network-updated', id);
    }
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

// ── Deallocate dialog ──
const showDeallocate = ref(false);

async function executeDeallocate() {
  saving.value = true;
  try {
    await store.deleteSubnet(props.selectedNode.data.id);
    showDeallocate.value = false;
    toast.add({ severity: 'success', summary: 'Network deallocated', life: 3000 });
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
        create_reverse_dns: false, dhcp_start_ip: '', dhcp_end_ip: '',
        folder_id: groupDropFolderId.value,
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
  folderForm.value = { name: folder.name, description: folder.description || '', scan_enabled: folder.scan_enabled !== 0 };
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

function openCreateNetwork(folderId) {
  networkDialogMode.value = 'create';
  networkForm.value = {
    cidr: '',
    name: '',
    description: '',
    vlan_id: null,
    gateway_address: '',
    domain_name: '',
    folder_id: folderId || store.folders[0]?.id || null,
    create_dhcp_scope: false,
    create_reverse_dns: false,
    dhcp_start_ip: '',
    dhcp_end_ip: '',
  };
  editVlanSelection.value = null;
  showNetworkDialog.value = true;
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
  openEdit(node, folderId);
}

function openEdit(node, folderId) {
  const d = (node || props.selectedNode)?.data;
  if (!d) return;
  const isUnconfigured = d.status === 'unallocated';
  networkDialogMode.value = isUnconfigured ? 'configure' : 'edit';

  const autoName = isUnconfigured ? applyNameTemplate(props.nameTemplate, d.cidr) : null;
  networkForm.value = {
    name: d.name || autoName || '',
    description: d.description || '',
    vlan_id: d.vlan_id || null,
    gateway_address: d.gateway_address || '',
    domain_name: d.domain_name || '',
    create_dhcp_scope: false,
    create_reverse_dns: false,
    dhcp_start_ip: '',
    dhcp_end_ip: '',
    scan_enabled: d.scan_enabled === null || d.scan_enabled === undefined ? null : !!d.scan_enabled,
  };

  if (folderId) dropTargetFolderIdForConfigure.value = folderId;

  // Load VLAN display if one is set
  const resolvedFolderId = folderId || getSubnetFolderId();
  if (d.vlan_id && resolvedFolderId) {
    api.get('/vlans/search', { params: { folder_id: resolvedFolderId, q: String(d.vlan_id) } }).then(res => {
      const match = res.data.find(v => v.vlan_id === d.vlan_id);
      if (match) editVlanSelection.value = { ...match, display: `VLAN ${match.vlan_id} — ${match.name}` };
      else editVlanSelection.value = `VLAN ${d.vlan_id}`;
    }).catch((err) => {
      editVlanSelection.value = `VLAN ${d.vlan_id}`;
      const detail = err.response?.data?.error || err.message;
      toast.add({ severity: 'error', summary: 'VLAN lookup failed', detail, life: 5000 });
    });
  } else {
    editVlanSelection.value = null;
  }
  showNetworkDialog.value = true;
}

function openDelete(node) {
  showDelete.value = true;
}

function openDeallocate(node) {
  showDeallocate.value = true;
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
  openWizard, openOrgDialog, openEditFolder, openDeleteFolder,
  openSubnetDialog, openCreateNetwork, openDivide, openConfigure,
  openEdit, openDelete, openDeallocate, openMergeConfirm,
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

/* Wizard styles */
.wizard-steps {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  margin-bottom: 1.25rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--p-surface-border);
}
.wizard-step {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  font-size: 0.75rem;
  font-weight: 700;
  background: var(--p-surface-200);
  color: var(--p-text-muted-color);
  transition: all 0.2s;
}
.step-label {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--p-text-muted-color);
  transition: color 0.2s;
}
.wizard-step.active .step-num {
  background: var(--p-primary-color);
  color: #fff;
}
.wizard-step.active .step-label {
  color: var(--p-text-color);
  font-weight: 600;
}
.wizard-step.done .step-num {
  background: color-mix(in srgb, var(--p-primary-color) 20%, transparent);
  color: var(--p-primary-color);
}
.wizard-step.done .step-label {
  color: var(--p-text-color);
}
.wizard-step-line {
  width: 3rem;
  height: 2px;
  background: var(--p-surface-200);
  margin: 0 0.5rem;
  transition: background 0.2s;
}
.wizard-step-line.done {
  background: var(--p-primary-color);
}
.wizard-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}

/* Pi-hole import styles */
.pihole-import-step {
  min-height: 12rem;
}
.pihole-reachable {
  border-color: var(--p-green-500) !important;
  box-shadow: 0 0 0 1px var(--p-green-500);
}
.pihole-unreachable {
  border-color: var(--p-red-500) !important;
  box-shadow: 0 0 0 1px var(--p-red-500);
}
.field-warn {
  color: var(--p-orange-500);
}
.pihole-preview {
  margin-top: 1rem;
  padding: 0.75rem;
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  background: var(--p-surface-50);
}
.pihole-preview h4 {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.preview-summary {
  display: flex;
  gap: 1.5rem;
}
.preview-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.preview-count {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--p-primary-color);
}
.preview-label {
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}
.pihole-results {
  margin-top: 1rem;
}

/* Scan toggle button group */
.scan-toggle-group {
  display: inline-flex;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--p-surface-border);
}
.scan-toggle-btn {
  padding: 0.3rem 0.75rem;
  font-size: 0.8rem;
  font-weight: 500;
  border: none;
  cursor: pointer;
  background: var(--p-surface-ground);
  color: var(--p-text-muted-color);
  transition: background 0.15s, color 0.15s;
}
.scan-toggle-btn + .scan-toggle-btn {
  border-left: 1px solid var(--p-surface-border);
}
.scan-toggle-btn:hover {
  background: var(--p-surface-200);
}
.p-dark .scan-toggle-btn:hover {
  background: var(--p-surface-700);
}
/* Active states */
.scan-inherit.active {
  background: var(--p-surface-300);
  color: var(--p-text-color);
}
.p-dark .scan-inherit.active {
  background: var(--p-surface-600);
}
.scan-enabled.active {
  background: color-mix(in srgb, var(--p-green-500) 25%, transparent);
  color: var(--p-green-500);
}
.scan-disabled.active {
  background: color-mix(in srgb, var(--p-blue-500) 25%, transparent);
  color: var(--p-blue-500);
}
/* Resolved (inherited) indicator — subtle highlight */
.scan-enabled.resolved {
  background: color-mix(in srgb, var(--p-green-500) 10%, transparent);
  color: var(--p-green-500);
  opacity: 0.7;
}
.scan-disabled.resolved {
  background: color-mix(in srgb, var(--p-blue-500) 10%, transparent);
  color: var(--p-blue-500);
  opacity: 0.7;
}
</style>
