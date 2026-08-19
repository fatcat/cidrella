<template>
  <!-- Create/Edit Folder Dialog -->
  <Dialog v-model:visible="showFolderDialog" :header="editingFolder ? 'Edit Folder' : 'Create Folder'" modal :style="{ width: '26rem' }" data-track="dialog-folder-edit"
          @hide="folderCreateFromEdit = false">
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

  <!-- First-time Guided Setup Wizard -->
  <Dialog v-model:visible="showWizard" header="First-time Guided Setup" modal :style="{ width: '32rem' }" data-track="dialog-setup-wizard"
          :closable="true" @hide="onWizardClose">
    <!-- Step indicators -->
    <div class="wizard-steps">
      <div class="wizard-step" :class="{ active: wizardStep === 1, done: wizardStep > 1 }">
        <span class="step-num">1</span>
        <span class="step-label">Interfaces</span>
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

    <!-- Step 1: Interfaces -->
    <div v-if="wizardStep === 1">
      <p class="field-help" style="margin-bottom: 0.75rem;">
        Select which network interfaces CIDRella should listen on for DNS and DHCP.
      </p>
      <div v-if="wizardIfaceLoading" style="text-align: center; padding: 2rem;">
        <i class="pi pi-spinner pi-spin" style="font-size: 1.5rem;"></i>
      </div>
      <div v-else-if="wizardIfaces.length === 0" class="field-help" style="padding: 1rem; text-align: center;">
        No network interfaces found.
      </div>
      <table v-else class="wizard-iface-table">
        <thead>
          <tr>
            <th>Interface</th>
            <th>IP Address</th>
            <th style="text-align: center;">DNS</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="iface in wizardIfaces" :key="iface.name">
            <td>
              <span class="iface-name">{{ iface.name }}</span>
              <Tag v-if="iface.state === 'down'" value="down" severity="warn" style="margin-left: 0.4rem; font-size: 0.7rem;" />
            </td>
            <td>
              <template v-if="iface.addresses && iface.addresses.length">
                <div v-for="addr in iface.addresses" :key="addr.address">{{ addr.address }}</div>
              </template>
              <span v-else class="muted">--</span>
            </td>
            <td style="text-align: center;">
              <ToggleSwitch v-model="iface.dns" />
            </td>
          </tr>
        </tbody>
      </table>
      <div class="field" style="margin-top: 0.75rem;">
        <label style="display: block; margin-bottom: 0.3rem;">DNS listen port</label>
        <!-- PrimeVue InputNumber only commits its model on blur/Enter, which delays
             the "non-53" warning. Use a plain numeric <input> so the warning fires
             on every keystroke. -->
        <input type="number" min="1" max="65535" step="1"
               :value="wizardDnsListenPort"
               @input="wizardDnsListenPort = Number($event.target.value) || 0"
               class="port-input port-input-plain" style="width: 6.5rem" />
        <small class="field-help" style="display: block; margin-top: 0.4rem;">
          Default 53. Change only if another DNS service holds that port.
        </small>
        <Message v-if="wizardDnsListenPort !== 53" severity="warn" :closable="false" class="mt-1">
          Most DHCP clients (Windows, macOS, systemd-resolved, Android) ignore non-standard DNS ports and
          will still try {{ resolverIpForHint }}:53.
          Only change this if clients are statically configured or a port-53 redirect (iptables/NAT) is in place.
        </Message>
      </div>
      <small class="field-help" style="margin-top: 0.5rem; display: block;">
        DHCP can be enabled per-interface later from System &rarr; Interfaces once your network is fully configured.
      </small>
    </div>

    <!-- Step 2: Network -->
    <div v-if="wizardStep === 2" class="form-grid wizard-network-grid">
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
        <label>Gateway</label>
        <div class="gateway-row">
          <SelectButton v-model="wizardNet.gateway_position" :options="gatewayPositionOptions"
                        optionLabel="label" optionValue="value" size="small" />
        </div>
        <InputText v-model="wizardNet.gateway_address"
                   :placeholder="wizardGatewayPlaceholder"
                   :disabled="wizardNet.gateway_position !== 'custom' && wizardNet.gateway_position !== 'none'"
                   class="w-full" />
      </div>
      <div class="field">
        <label>Domain Name</label>
        <InputText v-model="wizardNet.domain_name" class="w-full" />
        <Message v-if="domainWarningShown && !wizardNet.domain_name" severity="warn" :closable="false" class="mt-1">
          No domain name entered, so DNS features will be limited. Click "Create &amp; Continue" again to proceed anyway.
        </Message>
      </div>
      <div class="field wizard-toggle-stack">
        <label class="toggle-label">
          <input type="checkbox" v-model="wizardNet.create_reverse_dns" />
          Create reverse DNS zone
        </label>
        <label class="toggle-label">
          <input type="checkbox" v-model="wizardNet.scan_enabled" />
          Include hosts in liveness scans by default
        </label>
        <label class="toggle-label">
          <input type="checkbox" v-model="wizardNet.create_dhcp_scope" />
          Create DHCP scope
        </label>
      </div>
      <template v-if="wizardNet.create_dhcp_scope && wizardPrefixLength <= 29">
        <Message v-if="wizardDhcpRiskySize" severity="warn" :closable="false" class="mt-1">
          A /{{ wizardPrefixLength }} is larger than CIDRella will auto-size a DHCP pool for.
          RAM is the primary concern: every IP in an allocated subnet gets a row in
          <code>ip_addresses</code>, and CIDRella's target hosts have only 1–2&nbsp;GB.
          See <code>docs/SIZING.md</code> in the repo for the sizing table. You can continue,
          just enter Start IP and End IP manually.
        </Message>
        <div class="wizard-dhcp-row">
          <div class="field">
            <label>DHCP Scope Start IP</label>
            <InputText v-model="wizardNet.dhcp_start_ip" class="w-full" />
          </div>
          <div class="field">
            <label>DHCP Scope End IP</label>
            <InputText v-model="wizardNet.dhcp_end_ip" class="w-full" />
          </div>
        </div>
        <small v-if="wizardDhcpScopeError" class="field-error">{{ wizardDhcpScopeError }}</small>
      </template>
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
          {{ piholeImportResults.a.created }} A created<template v-if="piholeImportResults.a.updated">, {{ piholeImportResults.a.updated }} updated</template>;
          {{ piholeImportResults.cname.created }} CNAME created<template v-if="piholeImportResults.cname.updated">, {{ piholeImportResults.cname.updated }} updated</template>;
          {{ piholeImportResults.dhcp.created }} DHCP created
          <template v-if="piholeImportResults.dhcp.noSubnet > 0">
            ({{ piholeImportResults.dhcp.noSubnet }} DHCP skipped: no matching subnet)
          </template>
        </Message>
      </div>
    </div>

    <template #footer>
      <div class="wizard-footer">
        <span style="flex: 1"></span>
        <Button label="Skip" severity="secondary" text @click="wizardSkip" />
        <Button v-if="wizardStep === 1" label="Continue" icon="pi pi-arrow-right" iconPos="right"
                @click="wizardSaveInterfaces" :loading="wizardIfaceSaving"
                :disabled="!wizardHasSelectedIface" />
        <Button v-if="wizardStep === 2" label="Create & Continue" icon="pi pi-arrow-right" iconPos="right"
                @click="wizardCreateAndContinue" :loading="saving"
                :disabled="!!wizardCidrError || !!wizardDhcpScopeError || !wizardNet.cidr" />
        <Button v-if="wizardStep === 3" label="Skip Import" severity="secondary"
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

  <!-- Delete Folder Dialog -->
  <Dialog v-model:visible="showDeleteFolderDialog" header="Delete Folder" modal :style="{ width: '28rem' }" data-track="dialog-folder-delete">
    <p>Delete folder <strong>{{ deletingFolder?.name }}</strong>?</p>
    <p v-if="deletingFolder?.subnet_count > 0" style="font-size: 0.85rem; color: var(--p-text-muted-color);">
      {{ deletingFolder.subnet_count }} network(s) will be moved to ungrouped.
    </p>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showDeleteFolderDialog = false" />
      <Button label="Delete" severity="danger" @click="executeDeleteFolder" :loading="saving" />
    </template>
  </Dialog>

  <!-- Create Network Dialog -->
  <Dialog v-model:visible="showSubnetDialog" :header="quickAddMode ? 'Add Network' : 'Create Network'" modal :style="{ width: '28rem' }" data-track="dialog-network-create">
    <div class="form-grid">
      <div class="field">
        <label>CIDR *</label>
        <InputText v-model="supernetForm.cidr" placeholder="10.0.0.0/8" class="w-full" />
        <small v-if="supernetValidationError" class="field-error">{{ supernetValidationError }}</small>
      </div>
      <template v-if="!quickAddMode">
        <div class="field">
          <label>Name</label>
          <InputText v-model="supernetForm.name" :placeholder="supernetAutoName || 'Optional, defaults to template'" class="w-full" />
        </div>
        <div class="field">
          <label>Folder (optional)</label>
          <Select v-model="supernetForm.folder_id" :options="folderOptions" optionLabel="name" optionValue="id"
                  placeholder="None (ungrouped)" class="w-full" showClear />
        </div>
      </template>
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

  <!-- Lossy-IP confirmation dialog (shown when divide would place host data
       on a new subnet's network/broadcast/outside-selection) -->
  <Dialog v-model:visible="showLossyConfirm" header="Some host data will be lost"
          modal :style="{ width: '40rem' }" data-track="dialog-divide-lossy">
    <Message severity="warn" :closable="false">
      After dividing, the IP addresses below will land on a new subnet's
      <strong>network</strong>, <strong>broadcast</strong>, or
      <strong>outside the selected children</strong> and will no longer be
      usable. The division will still run, but these hosts will be stripped
      from the database or lose routing.
    </Message>

    <div class="lossy-list">
      <div v-for="row in lossyIps" :key="row.ip + '-' + row.carries" class="lossy-row">
        <div class="lossy-primary">
          <code>{{ row.ip }}</code>
          <span class="lossy-reason">{{ lossyReasonLabel(row) }}</span>
        </div>
        <div class="lossy-meta">
          <span class="lossy-carries">{{ lossyCarriesLabel(row.carries) }}</span>
          <template v-if="row.hostname"><span>·</span><span>{{ row.hostname }}</span></template>
          <template v-if="row.mac"><span>·</span><code>{{ row.mac }}</code></template>
        </div>
      </div>
    </div>

    <template #footer>
      <Button label="Cancel" severity="secondary" @click="cancelLossyDivide" />
      <Button label="Divide Anyway" severity="danger" @click="confirmLossyDivide" :loading="saving" />
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
      </template>

      <div class="field">
        <label>Folder (optional)</label>
        <div style="display: flex; gap: 0.25rem; align-items: center">
          <Select v-model="networkForm.folder_id" :options="selectableFolderOptions" optionLabel="name" optionValue="id"
                  placeholder="None (ungrouped)" class="w-full" showClear
                  :filter="selectableFolderOptions.length > 6" filterPlaceholder="Search folders…" />
          <Button icon="pi pi-plus" text rounded size="small"
                  title="Create folder" @click="openCreateFolderFromEdit" />
        </div>
      </div>
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
        <div class="gateway-row">
          <SelectButton v-model="gatewayPosition" :options="gatewayPositionOptions"
                        optionLabel="label" optionValue="value" size="small" />
        </div>
        <InputText v-model="networkForm.gateway_address"
                   :placeholder="gatewayPlaceholder"
                   :disabled="gatewayPosition !== 'custom' && gatewayPosition !== 'none'"
                   class="w-full" />
      </div>
      <div class="field">
        <label>Domain Name</label>
        <div style="display: flex; gap: 0.25rem; align-items: center">
          <AutoComplete v-model="editDomainSelection" :suggestions="domainSuggestions"
                        @complete="searchDomains" optionLabel="name"
                        placeholder="e.g. office.example.com" class="w-full"
                        @item-select="onDomainSelect" @clear="onDomainClear"
                        @change="onDomainChange"
                        :forceSelection="false" dropdown />
          <Button icon="pi pi-plus" text rounded size="small"
                  title="Create DNS zone" @click="openCreateDomainFromEdit" />
        </div>
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
          Inherits from global default: scanning is {{ resolvedGlobalScanEnabled ? 'enabled' : 'disabled' }} for this network
        </small>
        <small class="field-help" v-else-if="networkForm.scan_enabled === true">Scanning is enabled for this network</small>
        <small class="field-help" v-else>Scanning is disabled for this network</small>
      </div>
      <template v-if="networkDialogMode === 'configure' || networkDialogMode === 'create'">
        <div class="field">
          <label class="toggle-label">
            <input type="checkbox" v-model="networkForm.create_reverse_dns" />
            Create reverse DNS zone
          </label>
        </div>
        <div class="field" v-if="effectivePrefixLength <= 29">
          <label class="toggle-label">
            <input type="checkbox" v-model="networkForm.create_dhcp_scope" />
            Create DHCP scope
          </label>
        </div>
        <template v-if="networkForm.create_dhcp_scope">
          <Message v-if="editDhcpRiskySize" severity="warn" :closable="false" class="mt-1">
            A /{{ effectivePrefixLength }} is larger than CIDRella will auto-size a DHCP pool for.
            RAM is the primary concern: every IP in an allocated subnet gets a row in
            <code>ip_addresses</code>, and CIDRella's target hosts have only 1–2&nbsp;GB.
            See <code>docs/SIZING.md</code> in the repo for the sizing table. You can continue,
            just enter Start IP and End IP manually.
          </Message>
          <div class="field">
            <label>Start IP *</label>
            <InputText v-model="networkForm.dhcp_start_ip" class="w-full" />
          </div>
          <div class="field">
            <label>End IP *</label>
            <InputText v-model="networkForm.dhcp_end_ip" class="w-full" />
          </div>
        </template>
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

  <!-- Create DNS Zone (domain) from Edit Dialog -->
  <Dialog v-model:visible="showCreateDomainFromEdit" header="Create Forward DNS Zone" modal :style="{ width: '24rem' }">
    <div class="form-grid">
      <div class="field">
        <label>Domain Name *</label>
        <InputText v-model="newDomainForm.name" placeholder="e.g. office.example.com" class="w-full" autofocus />
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="showCreateDomainFromEdit = false" />
      <Button label="Save" @click="createDomainFromEdit" :loading="savingDomain"
              :disabled="!newDomainForm.name?.trim()" />
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
    <p>Allocate <strong>{{ groupDropIds.length }}</strong> networks to this folder?</p>
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
import { useToast } from '../ui/useToast.js';
import { usePiholeImport } from '../composables/usePiholeImport.js';
import Button from '../ui/Button.js';
import SelectButton from '../ui/SelectButton.js';
import Dialog from '../ui/Dialog.js';
import InputText from '../ui/InputText.js';
import InputNumber from '../ui/InputNumber.js';
import Select from '../ui/Select.js';
import Message from '../ui/Message.js';
import AutoComplete from '../ui/AutoComplete.js';
import ToggleSwitch from '../ui/ToggleSwitch.js';
import Tag from '../ui/Tag.js';
import Tabs from '../ui/Tabs.js';
import TabList from '../ui/TabList.js';
import Tab from '../ui/Tab.js';
import TabPanels from '../ui/TabPanels.js';
import TabPanel from '../ui/TabPanel.js';
import { useSubnetStore } from '../stores/subnets.js';
import api from '../api/client.js';
import { apiError } from '../utils/format.js';
import { isValidCidr, isValidIpv4, normalizeCidr, dhcpPoolError, cidrValidationError, applyNameTemplate, calculateSubnets, subtractCidr, isSubnetOf, parseCidr, dhcpRangeDefaults, gatewayIpFromPosition, DHCP_DEFAULT_MIN_PREFIX, DHCP_DEFAULT_MAX_PREFIX } from '../utils/ip.js';

const props = defineProps({
  selectedNode: { type: Object, default: null },
  nameTemplate: { type: String, default: '%1.%2.%3.%4/%bitmask' },
  mergeSelectedIds: { type: Array, default: () => [] },
  folders: { type: Array, default: () => [] },
});

const emit = defineEmits([
  'folder-created', 'folder-updated', 'folder-deleted',
  'network-created', 'network-configured', 'network-updated',
  'network-divided', 'network-deleted', 'networks-merged',
  'group-configured',
]);

const store = useSubnetStore();
const toast = useToast();
const saving = ref(false);

// ── Folder dialogs ──
const showFolderDialog = ref(false);
const showDeleteFolderDialog = ref(false);
const editingFolder = ref(null);
const deletingFolder = ref(null);
const folderForm = ref({ name: '', description: '' });

// ── Guided Setup Wizard ──
const showWizard = ref(false);
const wizardStep = ref(1);
const wizardNet = ref({
  cidr: '', name: '', description: '', vlan_id: null,
  gateway_position: 'first', gateway_address: '', domain_name: '',
  create_dhcp_scope: false, create_reverse_dns: false,
  dhcp_start_ip: '', dhcp_end_ip: '',
  scan_enabled: true,
});
// Gateway position options live here but watchers that reference `networkForm`
// must wait until `networkForm` itself is declared, installed further below.
const gatewayPositionOptions = [
  { label: 'First IP', value: 'first' },
  { label: 'Last IP', value: 'last' },
  { label: 'None', value: 'none' },
  { label: 'Custom', value: 'custom' },
];
const gatewayPosition = ref('custom');

function inferGatewayPosition(cidr, address) {
  const addr = (address || '').trim();
  if (!addr) return 'none';
  if (!cidr || !isValidCidr(cidr)) return 'custom';
  if (addr === gatewayIpFromPosition(cidr, 'first')) return 'first';
  if (addr === gatewayIpFromPosition(cidr, 'last'))  return 'last';
  return 'custom';
}

const domainWarningShown = ref(false);
const wizardVlanSelection = ref(null);
const showWizardCreateVlan = ref(false);
const wizardNewVlanForm = ref({ vlan_id: null, name: '' });
const wizardNewVlanNameManual = ref(false);
// Track created resources for cleanup on cancel
const wizardCreatedVlanId = ref(null);

// ── Wizard Step 1: Interfaces ──
const wizardIfaces = ref([]);
const wizardIfaceLoading = ref(false);
const wizardIfaceSaving = ref(false);
const wizardHasSelectedIface = computed(() => wizardIfaces.value.some(i => i.dns));
const wizardDnsListenPort = ref(53);

// Used in the non-53 port warning, first DNS-enabled interface's IPv4, or a
// placeholder if none picked yet.
const resolverIpForHint = computed(() => {
  const picked = wizardIfaces.value.find(i => i.dns);
  // isValidIpv4 rather than a bare shape regex: the inline one accepted
  // "1234.1.1.1" and any out-of-range octet. See audit #51.
  const ip = picked?.addresses?.find(a => isValidIpv4(a.address))?.address;
  return ip || 'server';
});

async function loadWizardInterfaces() {
  wizardIfaceLoading.value = true;
  try {
    const res = await api.get('/interfaces');
    wizardIfaces.value = res.data.map(iface => ({
      ...iface,
      dns: false,
    }));
  } catch {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Failed to load interfaces', life: 3000 });
  } finally {
    wizardIfaceLoading.value = false;
  }
}

async function wizardSaveInterfaces() {
  wizardIfaceSaving.value = true;
  try {
    const interfaces = {};
    for (const iface of wizardIfaces.value) {
      if (iface.dns) {
        interfaces[iface.name] = { dns: true, dhcp: false };
      }
    }
    await api.put('/interfaces/config', {
      interfaces,
      dns_enabled: true,
      dhcp_enabled: false,
      dns_listen_port: Number(wizardDnsListenPort.value) || 53,
    });
    wizardStep.value = 2;
  } catch {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Failed to save interface config', life: 3000 });
  } finally {
    wizardIfaceSaving.value = false;
  }
}

const wizardCidrError = computed(() => {
  // Runs the reserved-range rule too, which this used to skip. 10.0.0.0/7 was
  // caught inline by the supernet dialog and eaten as a server 400 here
  // (duplicate-logic audit #54).
  return cidrValidationError(wizardNet.value.cidr, { supernet: true });
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

// True when the wizard CIDR is outside the auto-fill sweet spot, either too
// small (/30–/32, no sensible pool) or too large (/15 and up, RAM-dangerous
// on modest hosts). UI shows a warning. See docs/SIZING.md for the numbers.
const wizardDhcpRiskySize = computed(() => {
  const p = wizardPrefixLength.value;
  return p < DHCP_DEFAULT_MIN_PREFIX || p > DHCP_DEFAULT_MAX_PREFIX;
});

const wizardDhcpDefaults = computed(() => {
  const cidr = (wizardNet.value.cidr || '').trim();
  if (!cidr || !isValidCidr(cidr)) return { start: '', end: '' };
  const p = parseCidr(cidr);
  // Use the effective gateway (handles 'custom' and 'none') so the default
  // DHCP range correctly excludes a user-typed gateway address too.
  const gw = wizardEffectiveGateway(cidr);
  return dhcpRangeDefaults(p, gw);
});

const wizardDhcpScopeError = computed(() => {
  if (!wizardNet.value.create_dhcp_scope || wizardPrefixLength.value > 29) return null;
  const cidr = (wizardNet.value.cidr || '').trim();
  if (!cidr || !isValidCidr(cidr)) return null;

  const startIp = (wizardNet.value.dhcp_start_ip || wizardDhcpDefaults.value.start || '').trim();
  const endIp = (wizardNet.value.dhcp_end_ip || wizardDhcpDefaults.value.end || '').trim();
  return dhcpPoolError(startIp, endIp, cidr, { label: 'DHCP Scope' });
});

watch(() => wizardNet.value.gateway_position, () => {
  if (wizardNet.value.create_dhcp_scope) {
    const d = wizardDhcpDefaults.value;
    wizardNet.value.dhcp_start_ip = d.start || '';
    wizardNet.value.dhcp_end_ip = d.end || '';
  }
});

// Wizard gateway: mirror the Edit-dialog sync. Position → address (First/Last/None
// auto-fills; Custom leaves editable). Address → position (user-typed value flips
// the toggle). CIDR change re-applies First/Last against the new range.
const wizardGatewayPlaceholder = computed(() => {
  const pos = wizardNet.value.gateway_position;
  if (pos === 'none') return 'No gateway';
  if (pos === 'first' || pos === 'last') return 'Auto-computed';
  return '10.0.0.1';
});
function wizardEffectiveGateway(cidr) {
  const pos = wizardNet.value.gateway_position;
  if (pos === 'none') return null;
  if (pos === 'custom') return (wizardNet.value.gateway_address || '').trim() || null;
  return gatewayIpFromPosition(cidr, pos) || null;
}
watch(() => wizardNet.value.gateway_position, (pos) => {
  if (pos === 'custom') return;
  const cidr = (wizardNet.value.cidr || '').trim();
  if (pos === 'none') {
    if (wizardNet.value.gateway_address !== '') wizardNet.value.gateway_address = '';
    return;
  }
  if (!cidr || !isValidCidr(cidr)) return;
  const target = gatewayIpFromPosition(cidr, pos) || '';
  if (wizardNet.value.gateway_address !== target) wizardNet.value.gateway_address = target;
});
watch(() => wizardNet.value.gateway_address, (addr) => {
  const inferred = inferGatewayPosition(wizardNet.value.cidr, addr);
  if (wizardNet.value.gateway_position !== inferred) wizardNet.value.gateway_position = inferred;
});
watch(() => wizardNet.value.cidr, (cidr) => {
  const pos = wizardNet.value.gateway_position;
  if (pos === 'first' || pos === 'last') {
    if (cidr && isValidCidr(cidr)) {
      const target = gatewayIpFromPosition(cidr, pos) || '';
      if (wizardNet.value.gateway_address !== target) wizardNet.value.gateway_address = target;
    }
  }
});

// Auto-populate DHCP Start/End IPs when "Create DHCP scope" is toggled on. Mirrors
// the Edit dialog. Only fills blank fields so the user's own input is never overwritten.
function applyWizardDhcpDefaults() {
  if (!wizardNet.value.create_dhcp_scope) return;
  const d = wizardDhcpDefaults.value;
  if (!d.start || !d.end) return;
  if (!wizardNet.value.dhcp_start_ip) wizardNet.value.dhcp_start_ip = d.start;
  if (!wizardNet.value.dhcp_end_ip)   wizardNet.value.dhcp_end_ip   = d.end;
}
watch(() => wizardNet.value.create_dhcp_scope, applyWizardDhcpDefaults);
// Also fire when the CIDR arrives AFTER the checkbox was already ticked, e.g.
// user enables DHCP before typing the CIDR, common in guided-setup flows.
watch(() => wizardNet.value.cidr, applyWizardDhcpDefaults);

function searchWizardVlans(event) {
  // Reuse the existing vlan search but scoped, wizard has no folder yet so search all
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

async function createVlan(form, onSuccess) {
  saving.value = true;
  try {
    const res = await api.post('/vlans', {
      vlan_id: form.value.vlan_id,
      name: form.value.name,
    });
    onSuccess(res.data);
    toast.add({ severity: 'success', summary: 'VLAN created', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally { saving.value = false; }
}

function createVlanFromWizard() {
  return createVlan(wizardNewVlanForm, (created) => {
    wizardNet.value.vlan_id = created.vlan_id;
    wizardVlanSelection.value = { ...created, display: `VLAN ${created.vlan_id} — ${created.name}` };
    wizardCreatedVlanId.value = created.id;
    showWizardCreateVlan.value = false;
    wizardNewVlanForm.value = { vlan_id: null, name: '' };
    wizardNewVlanNameManual.value = false;
  });
}

async function wizardSkip() {
  // Mark wizard as completed and close
  try {
    await store.updateSetting('setup_wizard_completed', '1');
  } catch { /* best effort */ }
  showWizard.value = false;
}

async function wizardCreateAndContinue() {
  if (wizardDhcpScopeError.value) {
    toast.add({ severity: 'error', summary: 'Invalid DHCP scope', detail: wizardDhcpScopeError.value, life: 5000 });
    return;
  }
  if (!wizardNet.value.domain_name && !domainWarningShown.value) {
    domainWarningShown.value = true;
    return;
  }
  saving.value = true;
  try {
    const cidr = wizardNet.value.cidr.trim();
    const created = await store.createSupernet({
      cidr,
      name: wizardNet.value.name || undefined,
    });

    const payload = {
      name: wizardNet.value.name || wizardAutoName.value || cidr,
      description: wizardNet.value.description || undefined,
      vlan_id: wizardNet.value.vlan_id || undefined,
      gateway_address: wizardEffectiveGateway(cidr) || undefined,
      domain_name: wizardNet.value.domain_name || undefined,
      create_dhcp_scope: wizardNet.value.create_dhcp_scope,
      create_reverse_dns: wizardNet.value.create_reverse_dns,
    };
    if (payload.create_dhcp_scope) {
      payload.dhcp_start_ip = wizardNet.value.dhcp_start_ip || wizardDhcpDefaults.value.start;
      payload.dhcp_end_ip = wizardNet.value.dhcp_end_ip || wizardDhcpDefaults.value.end;
    }
    const configured = await store.configureSubnet(created.id, payload);
    surfaceVlanWarning(configured);

    wizardCreatedSubnetId.value = created.id;
    toast.add({ severity: 'success', summary: 'Network created', life: 3000 });
    wizardStep.value = 3;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally { saving.value = false; }
}

async function wizardFinish() {
  wizardCreatedVlanId.value = null;
  try {
    await store.updateSetting('setup_wizard_completed', '1');
  } catch { /* best effort */ }
  showWizard.value = false;
  emit('network-created');
}

// ── Pi-hole Import (Step 3) ──
const wizardCreatedSubnetId = ref(null);

// The Pi-hole import flow lives in composables/usePiholeImport.js. It used to be
// duplicated here in full, about 120 lines of script identical to
// PiholeImportPanel.vue apart from ONE line: the zone fallback below. That one
// contextual difference is now a parameter instead of a reason to keep a second
// copy of everything around it. Names are aliased to the prefixed ones this
// wizard's template already binds, so no template changed.
// See REVIEW.md, duplicate-logic audit #47.
const {
  tab: piholeTab, url: piholeUrl, password: piholePassword,
  probeStatus: piholeProbeStatus, probeError: piholeProbeError,
  needsPassword: piholeNeedsPassword,
  fetching: piholeFetching, parsing: piholeParsing, importing: piholeImporting,
  preview: piholePreview, importResults: piholeImportResults,
  fileContent: piholeFileContent, fileInput: piholeFileInput,
  fetchConfig: fetchPiholeConfig, onFileSelect: onPiholeFileSelect,
  parseFile: parsePiholeFile, executeImport: executePiholeImport,
  resetState: resetPiholeImportState,
} = usePiholeImport({
  toast,
  // Step 2 asked for a domain. If the pihole.toml does not declare one, that is
  // the zone to import into. Settings > Integrations has no equivalent, which is
  // exactly why this is a parameter.
  fallbackZoneName: () => wizardNet.value?.domain_name || null,
});

function resetPiholeState() {
  resetPiholeImportState();
  wizardCreatedSubnetId.value = null;
}

async function onWizardClose() {
  // Clean up eagerly-created resources if user cancelled
  if (wizardCreatedVlanId.value) {
    try { await api.delete(`/vlans/${wizardCreatedVlanId.value}`); } catch { /* best effort */ }
  }
  // Reset wizard state
  wizardStep.value = 1;
  wizardIfaces.value = [];
  wizardNet.value = {
    cidr: '', name: '', description: '', vlan_id: null,
    gateway_position: 'first', gateway_address: '', domain_name: '',
    create_dhcp_scope: false, create_reverse_dns: false,
    dhcp_start_ip: '', dhcp_end_ip: '',
  };
  domainWarningShown.value = false;
  wizardVlanSelection.value = null;
  wizardCreatedVlanId.value = null;
  resetPiholeState();
}

function openWizard() {
  onWizardClose(); // reset
  showWizard.value = true;
  loadWizardInterfaces();
}

async function saveFolder() {
  saving.value = true;
  try {
    if (editingFolder.value) {
      await store.updateFolder(editingFolder.value.id, folderForm.value);
      toast.add({ severity: 'success', summary: 'Folder updated', life: 3000 });
      emit('folder-updated');
    } else {
      const created = await store.createFolder(folderForm.value);
      toast.add({ severity: 'success', summary: 'Folder created', life: 3000 });
      emit('folder-created');
      // If we opened this dialog from inside the Edit/Configure Network dialog,
      // auto-select the new folder so the user doesn't have to re-pick.
      if (folderCreateFromEdit.value && created?.id) {
        networkForm.value.folder_id = created.id;
      }
    }
    showFolderDialog.value = false;
    editingFolder.value = null;
    folderCreateFromEdit.value = false;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally { saving.value = false; }
}

async function executeDeleteFolder() {
  saving.value = true;
  try {
    await store.deleteFolder(deletingFolder.value.id);
    showDeleteFolderDialog.value = false;
    toast.add({ severity: 'success', summary: 'Folder deleted', life: 3000 });
    emit('folder-deleted', deletingFolder.value.id);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally { saving.value = false; }
}

// ── Create Network dialog ──
const showSubnetDialog = ref(false);
const quickAddMode = ref(false);
const supernetForm = ref({ cidr: '', name: '', folder_id: null });
const folderOptions = computed(() => store.folders);
// Exclude the virtual "Ungrouped" folder (id === null) from the Select so users
// pick "None (ungrouped)" via the showClear button rather than a duplicate row.
const selectableFolderOptions = computed(() =>
  store.folders
    .filter(f => f.id !== null && f.id !== undefined)
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
);

// Track whether the folder-create dialog was opened from inside the Edit Network
// dialog so we can auto-select the new folder on save instead of the usual flow.
const folderCreateFromEdit = ref(false);
function openCreateFolderFromEdit() {
  folderCreateFromEdit.value = true;
  editingFolder.value = null;
  folderForm.value = { name: '', description: '' };
  showFolderDialog.value = true;
}

const supernetValidationError = computed(() => {
  return cidrValidationError(supernetForm.value.cidr, { supernet: true });
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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

// Lossy-divide confirmation dialog state. When the server returns 409 with
// `can_force_lossy: true`, we capture the divide params here and open the
// confirm dialog; on "Divide Anyway" we retry the same request with
// `force_lossy: true`.
const showLossyConfirm = ref(false);
const lossyIps = ref([]);
const pendingLossyDivide = ref(null);  // { mode: 'equal'|'carve', params, nodeId }

function lossyReasonLabel(row) {
  if (row.reason === 'network') return `becomes network of ${row.child_cidr}`;
  if (row.reason === 'broadcast') return `becomes broadcast of ${row.child_cidr}`;
  if (row.reason === 'outside_selection') return `outside the selected children`;
  return row.reason;
}
function lossyCarriesLabel(carries) {
  if (carries === 'dhcp_reservation') return 'DHCP reservation';
  if (carries === 'ip_address') return 'IP record';
  if (carries === 'dns_record') return 'DNS A record';
  return carries;
}

async function executeDivide() {
  const nodeId = props.selectedNode.data.id;
  const isAllocated = props.selectedNode.data.status === 'allocated';
  const params = { new_prefix: divideTargetPrefix.value, force: isAllocated };
  await runDivide(nodeId, 'equal', params);
}

async function executeCarve() {
  const nodeId = props.selectedNode.data.id;
  const isAllocated = props.selectedNode.data.status === 'allocated';
  const params = { cidr: normalizeCidr(carveCidr.value), force: isAllocated };
  await runDivide(nodeId, 'carve', params);
}

// Per-child pool adjustments surfaced from the server, shown as warn
// toasts so the user knows which gateways we pulled out of which pools.
function surfacePoolAdjustments(resp) {
  const adjustments = resp?.pool_adjustments;
  if (!Array.isArray(adjustments) || adjustments.length === 0) return;
  for (const a of adjustments) {
    const poolBefore = `${a.pool_was.start_ip}–${a.pool_was.end_ip}`;
    const poolAfter = a.pool_now
      ? `${a.pool_now.start_ip}–${a.pool_now.end_ip}`
      : 'empty (whole pool was the gateway)';
    toast.add({
      severity: 'warn',
      summary: 'DHCP pool adjusted for gateway',
      detail: `The default gateway ${a.gateway} for ${a.child_cidr} conflicted with a DHCP pool and was removed from the pool (${poolBefore} → ${poolAfter}).`,
      life: 9000
    });
  }
}

// When divide runs with force_lossy, the server deletes DHCP reservations,
// DNS A records, ip_addresses rows, and dhcp_leases for IPs that landed on
// new boundaries. Surface the totals so the user knows what was cleaned up.
function surfaceLossyCleanup(resp) {
  const c = resp?.lossy_cleanup;
  if (!c || !c.ips || c.ips.length === 0) return;
  const r = c.removed || {};
  const parts = [];
  if (r.reservations) parts.push(`${r.reservations} reservation${r.reservations === 1 ? '' : 's'}`);
  if (r.dns_records)  parts.push(`${r.dns_records} DNS A record${r.dns_records === 1 ? '' : 's'}`);
  if (r.leases)       parts.push(`${r.leases} DHCP lease${r.leases === 1 ? '' : 's'}`);
  if (r.ip_addresses) parts.push(`${r.ip_addresses} IP record${r.ip_addresses === 1 ? '' : 's'}`);
  if (parts.length === 0) return;
  const ipList = c.ips.slice(0, 5).join(', ') + (c.ips.length > 5 ? `, +${c.ips.length - 5} more` : '');
  toast.add({
    severity: 'warn',
    summary: 'Removed lossy host data',
    detail: `Deleted ${parts.join(', ')} on ${ipList}. Any active DHCP leases on these IPs will rebind to a valid address at next renewal.`,
    life: 10000
  });
}

// Shared handler for both divide modes, intercepts the lossy-IP 409 and
// opens the confirm dialog instead of showing an opaque toast.
async function runDivide(nodeId, mode, params) {
  saving.value = true;
  try {
    const resp = await store.divideSubnet(nodeId, params);
    showDivide.value = false;
    toast.add({
      severity: 'success',
      summary: mode === 'equal' ? 'Network divided' : 'Network created',
      life: 3000
    });
    surfacePoolAdjustments(resp);
    surfaceLossyCleanup(resp);
    emit('network-divided', nodeId);
  } catch (err) {
    const body = err?.response?.data;
    if (err?.response?.status === 409 && body?.can_force_lossy && Array.isArray(body.lossy)) {
      // Surface the exact IPs; let the user confirm or cancel.
      lossyIps.value = body.lossy;
      pendingLossyDivide.value = { mode, params, nodeId };
      showLossyConfirm.value = true;
    } else {
      toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
    }
  } finally { saving.value = false; }
}

async function confirmLossyDivide() {
  const p = pendingLossyDivide.value;
  if (!p) { showLossyConfirm.value = false; return; }
  saving.value = true;
  try {
    const resp = await store.divideSubnet(p.nodeId, { ...p.params, force_lossy: true });
    showLossyConfirm.value = false;
    showDivide.value = false;
    pendingLossyDivide.value = null;
    lossyIps.value = [];
    toast.add({
      severity: 'success',
      summary: p.mode === 'equal' ? 'Network divided' : 'Network created',
      life: 3000
    });
    surfacePoolAdjustments(resp);
    surfaceLossyCleanup(resp);
    emit('network-divided', p.nodeId);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally { saving.value = false; }
}

function cancelLossyDivide() {
  showLossyConfirm.value = false;
  pendingLossyDivide.value = null;
  lossyIps.value = [];
}

// ── Unified Configure / Edit dialog ──
const showNetworkDialog = ref(false);
const networkDialogMode = ref('edit'); // 'create', 'configure', or 'edit'
const networkForm = ref({ name: '', description: '', vlan_id: null, gateway_address: '', domain_name: '', create_dhcp_scope: false, create_reverse_dns: false, dhcp_start_ip: '', dhcp_end_ip: '', scan_enabled: null });
const resolvedGlobalScanEnabled = ref(true); // fetched from settings when dialog opens
const resolvedOrgScanEnabled = resolvedGlobalScanEnabled; // backward compat for template refs
const dropTargetFolderIdForConfigure = ref(null);

// Gateway-position watchers + placeholder (live here because they reference
// networkForm, declaring them earlier would hit a TDZ on the `networkForm`
// const during watch() initial-dep tracking.)
const gatewayPlaceholder = computed(() => {
  if (gatewayPosition.value === 'none') return 'No gateway';
  if (gatewayPosition.value === 'first' || gatewayPosition.value === 'last') return 'Auto-computed';
  return '10.0.0.1';
});
// Position → address (when user picks first/last/none, compute and set).
watch(gatewayPosition, (pos) => {
  if (pos === 'custom') return;
  const cidr = (networkForm.value.cidr || '').trim();
  if (pos === 'none') {
    if (networkForm.value.gateway_address !== '') networkForm.value.gateway_address = '';
    return;
  }
  if (!cidr || !isValidCidr(cidr)) return;
  const target = gatewayIpFromPosition(cidr, pos) || '';
  if (networkForm.value.gateway_address !== target) networkForm.value.gateway_address = target;
});
// Address → position (user types a custom IP → toggle reflects state).
watch(() => networkForm.value.gateway_address, (addr) => {
  const inferred = inferGatewayPosition(networkForm.value.cidr, addr);
  if (gatewayPosition.value !== inferred) gatewayPosition.value = inferred;
});
// CIDR changes in create mode: re-apply first/last position if set.
watch(() => networkForm.value.cidr, (cidr) => {
  const pos = gatewayPosition.value;
  if (pos === 'first' || pos === 'last') {
    if (cidr && isValidCidr(cidr)) {
      const target = gatewayIpFromPosition(cidr, pos) || '';
      if (networkForm.value.gateway_address !== target) networkForm.value.gateway_address = target;
    }
  }
});

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

// Mirror of wizardDhcpRiskySize for the Edit/Create Network dialog. See
// docs/SIZING.md. Flags either too-small (/30–/32) or too-large (/15 and up)
// subnets so the user gets a RAM-sanity warning before saving.
const editDhcpRiskySize = computed(() => {
  const p = effectivePrefixLength.value;
  return p < DHCP_DEFAULT_MIN_PREFIX || p > DHCP_DEFAULT_MAX_PREFIX;
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

watch(showNetworkDialog, async (val) => {
  if (!val) {
    dropTargetFolderIdForConfigure.value = null;
  } else {
    try {
      const settings = await store.getSettings();
      resolvedGlobalScanEnabled.value = settings.default_scan_enabled !== '0';
    } catch { /* best effort, keep default true */ }
  }
});
watch(() => networkForm.value.create_dhcp_scope, (checked) => {
  if (checked && !networkForm.value.dhcp_start_ip && !networkForm.value.dhcp_end_ip) {
    const d = dhcpDefaults.value;
    if (d.start) networkForm.value.dhcp_start_ip = d.start;
    if (d.end) networkForm.value.dhcp_end_ip = d.end;
  }
});
const editVlanSelection = ref(null);
const vlanSuggestions = ref([]);
const showVlanWarning = ref(false);
const pendingVlanSelection = ref(null);
const showCreateVlanFromEdit = ref(false);
const newVlanForm = ref({ vlan_id: null, name: '' });
const newVlanNameManual = ref(false);

// ── Domain (forward DNS zone) AutoComplete state ──
// Allows the user to pick an existing forward zone as the network's domain_name,
// free-text a new value, or create a zone inline via the "+" button.
const editDomainSelection = ref(null);   // string or zone object
const domainSuggestions = ref([]);
const forwardZones = ref([]);            // cached forward zones for suggestions
const showCreateDomainFromEdit = ref(false);
const newDomainForm = ref({ name: '' });
const savingDomain = ref(false);

async function loadForwardZones() {
  try {
    const { useDnsStore } = await import('../stores/dns.js');
    const dnsStore = useDnsStore();
    if (!dnsStore.zones?.length) await dnsStore.fetchZones();
    // Alphabetical: shortest path for a user skimming a long zone list.
    forwardZones.value = dnsStore.zones
      .filter(z => z.type === 'forward')
      .slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } catch { /* non-fatal, field still works as free-text */ }
}

function searchDomains(event) {
  const q = (event.query || '').toLowerCase().trim();
  if (!q) { domainSuggestions.value = forwardZones.value.slice(0, 50); return; }
  domainSuggestions.value = forwardZones.value
    .filter(z => z.name.toLowerCase().includes(q))
    .slice(0, 50);
}

function onDomainSelect(event) {
  const zone = event.value;
  networkForm.value.domain_name = zone?.name || null;
}
function onDomainClear() {
  networkForm.value.domain_name = null;
}
// Free-text mode: AutoComplete emits @change with a string when forceSelection=false
function onDomainChange(event) {
  const v = event?.value;
  if (typeof v === 'string') networkForm.value.domain_name = v.trim() || null;
}

function openCreateDomainFromEdit() {
  newDomainForm.value = { name: '' };
  showCreateDomainFromEdit.value = true;
}

async function createDomainFromEdit() {
  const name = newDomainForm.value.name.trim();
  if (!name) return;
  savingDomain.value = true;
  try {
    const { useDnsStore } = await import('../stores/dns.js');
    const dnsStore = useDnsStore();
    const created = await dnsStore.createZone({ name, type: 'forward' });
    forwardZones.value = dnsStore.zones.filter(z => z.type === 'forward');
    networkForm.value.domain_name = created?.name || name;
    editDomainSelection.value = created || { name };
    toast.add({ severity: 'success', summary: 'Zone created', detail: name, life: 3000 });
    showCreateDomainFromEdit.value = false;
    newDomainForm.value = { name: '' };
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Zone create failed', detail: apiError(err), life: 5000 });
  } finally {
    savingDomain.value = false;
  }
}

function onNewVlanIdInput(val) {
  if (!newVlanNameManual.value) {
    newVlanForm.value.name = val ? `VLAN${val}` : '';
  }
}

async function searchVlans(event) {
  try {
    const res = await api.get('/vlans/search', { params: { q: event.query } });
    vlanSuggestions.value = res.data.map(v => ({ ...v, display: `VLAN ${v.vlan_id} — ${v.name}` }));
  } catch (err) {
    vlanSuggestions.value = [];
    const detail = apiError(err);
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

function createVlanFromEdit() {
  return createVlan(newVlanForm, (created) => {
    networkForm.value.vlan_id = created.vlan_id;
    if (!networkForm.value.name) networkForm.value.name = created.name;
    editVlanSelection.value = { ...created, display: `VLAN ${created.vlan_id} — ${created.name}` };
    showCreateVlanFromEdit.value = false;
    newVlanForm.value = { vlan_id: null, name: '' };
    newVlanNameManual.value = false;
  });
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

// When a subnet mutation returns `vlan_warning`, show a non-blocking warn
// toast so the user notices that the VLAN they just assigned is already in
// use on another subnet. Same VLAN on multiple L3 subnets is legal but
// almost always a mistake.
function surfaceVlanWarning(resp) {
  const w = resp?.vlan_warning;
  if (!w || !Array.isArray(w.peers) || w.peers.length === 0) return;
  const peerList = w.peers.slice(0, 3).map(p => p.cidr).join(', ')
    + (w.peers.length > 3 ? `, +${w.peers.length - 3} more` : '');
  toast.add({
    severity: 'warn',
    summary: `VLAN ${w.vlan_id} is already in use`,
    detail: `Also assigned to ${peerList}. Same VLAN on different networks is occasionally intentional but usually a misconfiguration.`,
    life: 8000
  });
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
        vlan_id: networkForm.value.vlan_id || undefined,
      });
      surfaceVlanWarning(created);
      // Now configure it with full options
      const payload = { ...networkForm.value };
      payload.name = payload.name || createAutoName.value || cidr;
      delete payload.cidr;
      delete payload.folder_id;
      if (payload.create_dhcp_scope) {
        payload.dhcp_start_ip = payload.dhcp_start_ip || dhcpDefaults.value.start;
        payload.dhcp_end_ip = payload.dhcp_end_ip || dhcpDefaults.value.end;
      }
      const configured = await store.configureSubnet(created.id, payload);
      surfaceVlanWarning(configured);
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
      const configured = await store.configureSubnet(id, payload);
      surfaceVlanWarning(configured);
      showNetworkDialog.value = false;
      toast.add({ severity: 'success', summary: 'Network configured', life: 3000 });
      emit('network-configured', id);
    } else {
      const id = props.selectedNode.data.id;
      const editPayload = { ...networkForm.value };
      delete editPayload.create_dhcp_scope;
      delete editPayload.create_reverse_dns;
      const updated = await store.updateSubnet(id, editPayload);
      surfaceVlanWarning(updated);
      showNetworkDialog.value = false;
      toast.add({ severity: 'success', summary: 'Network updated', life: 3000 });
      emit('network-updated', id);
    }
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
      await store.configureSubnet(id, {
        name: autoName, description: '', vlan_id: null,
        gateway_address: '', create_dhcp_scope: false,
        create_reverse_dns: false, dhcp_start_ip: '', dhcp_end_ip: '',
        folder_id: groupDropFolderId.value,
      }, { refresh: false });
    }
    await store.fetchTree();
    showGroupConfigure.value = false;
    groupDropIds.value = [];
    groupDropFolderId.value = null;
    toast.add({ severity: 'success', summary: `${count} networks allocated`, life: 3000 });
    emit('group-configured');
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally { saving.value = false; }
}

// ── Exposed methods ──
function openCreateFolder() {
  editingFolder.value = null;
  folderForm.value = { name: '', description: '' };
  showFolderDialog.value = true;
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
  quickAddMode.value = false;
  supernetForm.value = { cidr: '', name: '', folder_id: folderId || store.folders[0]?.id || null };
  showSubnetDialog.value = true;
}

function openQuickAddNetwork() {
  quickAddMode.value = true;
  supernetForm.value = { cidr: '', name: '', folder_id: null };
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
  editDomainSelection.value = null;
  // Default to first-address gateway for new allocations, most common pattern.
  gatewayPosition.value = 'first';
  loadForwardZones();
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
    cidr: d.cidr || '',
    name: d.name || autoName || '',
    description: d.description || '',
    vlan_id: d.vlan_id || null,
    folder_id: d.folder_id ?? folderId ?? null,
    gateway_address: d.gateway_address || '',
    domain_name: d.domain_name || '',
    create_dhcp_scope: false,
    create_reverse_dns: false,
    dhcp_start_ip: '',
    dhcp_end_ip: '',
    scan_enabled: d.scan_enabled === null || d.scan_enabled === undefined ? null : !!d.scan_enabled,
  };
  // Seed the SelectButton from the stored address so it reflects reality on open.
  gatewayPosition.value = inferGatewayPosition(d.cidr, d.gateway_address);
  // Seed the domain autocomplete + load zones for suggestions.
  editDomainSelection.value = d.domain_name || null;
  loadForwardZones();

  if (folderId) dropTargetFolderIdForConfigure.value = folderId;

  // Load VLAN display if one is set
  if (d.vlan_id) {
    api.get('/vlans/search', { params: { q: String(d.vlan_id) } }).then(res => {
      const match = res.data.find(v => v.vlan_id === d.vlan_id);
      if (match) editVlanSelection.value = { ...match, display: `VLAN ${match.vlan_id} — ${match.name}` };
      else editVlanSelection.value = `VLAN ${d.vlan_id}`;
    }).catch((err) => {
      editVlanSelection.value = `VLAN ${d.vlan_id}`;
      const detail = apiError(err);
      toast.add({ severity: 'error', summary: 'VLAN lookup failed', detail, life: 5000 });
    });
  } else {
    editVlanSelection.value = null;
  }
  showNetworkDialog.value = true;
}

function openDelete(_node) {
  showDelete.value = true;
}

function openDeallocate(_node) {
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
    mergeError.value = apiError(err);
    showMerge.value = true;
  }
}

function openGroupConfigure(leafIds, folderId) {
  groupDropIds.value = leafIds;
  groupDropFolderId.value = folderId;
  showGroupConfigure.value = true;
}

defineExpose({
  openWizard, openCreateFolder, openEditFolder, openDeleteFolder,
  openSubnetDialog, openQuickAddNetwork, openCreateNetwork, openDivide, openConfigure,
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
.wizard-network-grid {
  gap: 0.5rem;
}
.wizard-network-grid .field {
  gap: 0.18rem;
}
.wizard-network-grid :deep(.p-inputtext),
.wizard-network-grid :deep(.p-autocomplete-input) {
  padding-top: 0.4rem;
  padding-bottom: 0.4rem;
}
.wizard-network-grid :deep(.p-button.p-button-sm) {
  padding-top: 0.25rem;
  padding-bottom: 0.25rem;
}
.wizard-toggle-stack {
  gap: 0.35rem;
  padding-top: 0.1rem;
}
.wizard-dhcp-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
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
  color: var(--p-red-500);
  font-size: 0.75rem;
}
.warn-text {
  color: var(--p-red-500);
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
.gateway-row {
  margin-bottom: 4px;
}
/* Wizard DNS listen-port plain <input>: match PrimeVue input styling so it
   sits alongside sibling InputTexts without looking out of place. */
.port-input-plain {
  font-size: var(--app-fs-base);
  font-family: inherit;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  background: var(--p-surface-card);
  color: var(--p-text-color);
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.port-input-plain:focus {
  border-color: var(--p-primary-color);
  box-shadow: 0 0 0 1px var(--p-primary-color);
}
.divide-mode-toggle {
  margin-bottom: 0.75rem;
}
.divide-count-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}
.divide-slider {
  flex: 1;
  min-width: 0;
}
.divide-count-input {
  width: 4rem;
  max-width: 4rem;
  flex-shrink: 0;
}
.divide-count-input :deep(input) {
  width: 100%;
  text-align: center;
  padding: 0.3rem;
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
  background: color-mix(in srgb, var(--p-red-500) 10%, transparent);
  color: var(--p-red-500);
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
  color: var(--p-surface-0);
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

/* Wizard interface table */
.wizard-iface-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}
.wizard-iface-table th {
  text-align: left;
  font-weight: 600;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid var(--p-surface-border);
}
.wizard-iface-table td {
  padding: 0.5rem;
  border-bottom: 1px solid var(--p-surface-50);
}
.wizard-iface-table .iface-name {
  font-weight: 600;
  font-family: var(--font-mono, monospace);
}
.wizard-iface-table .muted {
  color: var(--p-text-muted-color);
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
/* Resolved (inherited) indicator, subtle highlight */
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

/* Lossy-divide confirmation list */
.lossy-list {
  margin-top: 1rem;
  max-height: 18rem;
  overflow-y: auto;
  border: 1px solid var(--p-surface-border);
  border-radius: 4px;
}
.lossy-row {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--p-surface-border);
}
.lossy-row:last-child { border-bottom: 0; }
.lossy-primary {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  font-size: var(--app-fs-sm);
}
.lossy-primary code {
  font-family: var(--font-mono, monospace);
  font-size: var(--app-fs-md);
  font-weight: 600;
}
.lossy-reason {
  color: var(--p-surface-content-muted, var(--p-text-muted-color));
  font-size: var(--app-fs-xs);
}
.lossy-meta {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.2rem;
  font-size: var(--app-fs-xs);
  color: var(--p-surface-content-muted, var(--p-text-muted-color));
}
.lossy-meta code { font-family: var(--font-mono, monospace); }
.lossy-carries { text-transform: uppercase; letter-spacing: 0.06em; }
</style>
