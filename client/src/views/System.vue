<template>
  <div class="system-page">
    <Menubar ref="menubarRef" :model="visibleMenuItems">
      <template #start>
        <Button label="IP Management" icon="pi pi-arrow-left" size="small" text data-track="sys-back-to-ipam" @click="$router.push('/')" />
      </template>
      <template #item="{ item, props: itemProps }">
        <a v-bind="itemProps.action" :class="{ 'active-menuitem': item.tabIndex === activeTab }" :data-track="item.dataTrack">
          <span :class="item.icon" />
          <span class="ml-1">{{ item.label }}</span>
        </a>
      </template>
      <template #end>
        <div class="sys-toolbar-actions">
          <Button v-if="overflowItems.length > 0" icon="pi pi-angle-double-right" size="small" text
                  class="overflow-trigger" @click="toggleOverflow" aria-label="More tabs" />
          <Menu ref="overflowMenuRef" :model="overflowItems" :popup="true" />
          <Button v-if="activeTab === 0" label="Add Type" icon="pi pi-plus" size="small" text data-track="sys-add-range-type" @click="showRangeTypeDialog = true" />
          <Button v-if="activeTab === 1" label="Add VLAN" icon="pi pi-plus" size="small" text data-track="sys-add-vlan" @click="openVlanDialog()" />
          <Button v-if="activeTab === 3" label="Create Backup Now" icon="pi pi-download" size="small" text data-track="sys-create-backup" @click="doCreateBackup" :loading="creatingBackup" />
          <Button v-if="activeTab === 4" label="Upload Certificate" icon="pi pi-upload" size="small" text data-track="sys-upload-cert" @click="doUploadCert" :loading="uploadingCert"
                  :disabled="!certUpload.cert || !certUpload.key || certValidation.cert === false || certValidation.key === false" />
          <Button v-if="activeTab === 6" label="Apply Config" icon="pi pi-refresh" size="small" text data-track="sys-apply-dhcp-config" @click="dhcpPanelRef?.applyConfig()" />
          <Button v-if="activeTab === 9" label="Add User" icon="pi pi-plus" size="small" text data-track="sys-add-user" @click="usersPanelRef?.openCreateDialog()" />
        </div>
      </template>
    </Menubar>

    <div class="sys-content">
      <div v-if="activeTab === 0">
        <div v-if="loadingSettings" class="muted">Loading settings...</div>
        <template v-else>
          <div class="content-card settings-form">
            <h3>Network Naming</h3>
            <div class="field">
              <label>Name Template</label>
              <InputText v-model="settings.subnet_name_template" class="w-full" />
              <small class="field-help">
                Variables: %1, %2, %3, %4 (octets), %bitmask (prefix length)
              </small>
              <div v-if="templatePreview" class="template-preview">
                Preview: <strong>{{ templatePreview }}</strong>
              </div>
            </div>
          </div>

          <div class="content-card settings-form">
            <h3>Network Defaults</h3>
            <div class="field">
              <label>Default Gateway Position</label>
              <div class="radio-group">
                <label class="radio-label">
                  <input type="radio" v-model="settings.default_gateway_position" value="first" />
                  First usable IP
                </label>
                <label class="radio-label">
                  <input type="radio" v-model="settings.default_gateway_position" value="last" />
                  Last usable IP
                </label>
              </div>
            </div>
          </div>

          <div class="content-card settings-form">
            <h3>Network Scanning</h3>
            <p class="field-help" style="margin-bottom: 0.75rem;">
              Configure automatic network scanning for allocated networks. Scans send ARP probes to detect online hosts.
            </p>
            <div class="field">
              <label>Default Scan Interval</label>
              <Select v-model="settings.default_scan_interval" :options="scanIntervalOptions" optionLabel="label" optionValue="value"
                      class="w-full" style="max-width: 16rem;" />
              <small class="field-help">Applied to newly configured networks.</small>
            </div>
            <div class="field">
              <label>On-Demand Scan</label>
              <div class="scan-row">
                <Select v-model="scanSubnetId" :options="allocatedSubnets" optionLabel="label" optionValue="value"
                        placeholder="Select network" class="w-full" style="max-width: 20rem;" />
                <Button label="Scan Now" icon="pi pi-search" size="small" @click="doStartScan"
                        :loading="startingScan" :disabled="!scanSubnetId" />
              </div>
              <small class="field-help">Send ARP probes to all usable IPs in the selected network.</small>
            </div>
            <div class="settings-actions">
              <Button label="Save Settings" icon="pi pi-save" @click="saveSettings" :loading="savingSettings" />
            </div>
          </div>

          <div class="content-card">
            <h3>Address Types</h3>
            <div class="range-types-section">
                <DataTable :value="rangeTypes" :loading="loadingRangeTypes" stripedRows emptyMessage="No address types found." size="small"
                           :paginator="rangeTypes.length > 256" :rows="256"
                           :rowsPerPageOptions="[64, 128, 256, 512]"
                           scrollable scrollHeight="flex">
                  <Column header="Color" style="width: 4rem">
                    <template #body="{ data }">
                      <span class="color-swatch" :style="{ background: data.color }"></span>
                    </template>
                  </Column>
                  <Column field="name" header="Name" sortable />
                  <Column field="description" header="Description">
                    <template #body="{ data }">{{ data.description ?? '—' }}</template>
                  </Column>
                  <Column header="Type" style="width: 7rem">
                    <template #body="{ data }">
                      <span :class="data.is_system ? 'badge-system' : 'badge-custom'">
                        {{ data.is_system ? 'System' : 'Custom' }}
                      </span>
                    </template>
                  </Column>
                  <Column header="" style="width: 5rem">
                    <template #body="{ data }">
                      <div class="action-buttons" v-if="!data.is_system">
                        <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                                @click="editRangeType(data)" />
                        <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                                @click="confirmDeleteRangeType(data)" />
                      </div>
                    </template>
                  </Column>
                </DataTable>
            </div>
          </div>
        </template>

        <!-- Address Type Dialog -->
        <Dialog v-model:visible="showRangeTypeDialog" :header="editingRangeType ? 'Edit Address Type' : 'Add Address Type'"
                modal :style="{ width: '24rem' }">
          <div class="form-grid">
            <div class="field">
              <label>Name *</label>
              <InputText v-model="rangeTypeForm.name" class="w-full" />
            </div>
            <div class="field">
              <label>Color</label>
              <div class="color-picker-row">
                <input type="color" v-model="rangeTypeForm.color" />
                <InputText v-model="rangeTypeForm.color" style="width: 8rem; font-family: monospace;" />
              </div>
            </div>
            <div class="field">
              <label>Description</label>
              <InputText v-model="rangeTypeForm.description" class="w-full" />
            </div>
          </div>
          <template #footer>
            <Button label="Cancel" severity="secondary" @click="closeRangeTypeDialog" />
            <Button :label="editingRangeType ? 'Save' : 'Create'" @click="saveRangeType" :loading="savingRangeType" />
          </template>
        </Dialog>

        <!-- Delete Address Type Dialog -->
        <Dialog v-model:visible="showDeleteRangeTypeDialog" header="Delete Address Type" modal :style="{ width: '24rem' }">
          <p>Delete address type <strong>{{ deletingRangeType?.name }}</strong>?</p>
          <template #footer>
            <Button label="Cancel" severity="secondary" @click="showDeleteRangeTypeDialog = false" />
            <Button label="Delete" severity="danger" @click="doDeleteRangeType" :loading="savingRangeType" />
          </template>
        </Dialog>
      </div>
      <div v-if="activeTab === 1">
        <div class="range-types-section">
          <div class="section-header">
            <Select v-model="vlanOrgFilter" :options="orgOptions" optionLabel="label" optionValue="value"
                    placeholder="All Organizations" showClear class="audit-filter" @change="loadVlans" />
          </div>
          <DataTable :value="vlans" :loading="loadingVlans" stripedRows emptyMessage="No VLANs found." size="small"
                     :paginator="vlans.length > 256" :rows="256"
                     :rowsPerPageOptions="[64, 128, 256, 512]"
                     scrollable scrollHeight="flex">
            <Column field="vlan_id" header="VLAN ID" sortable style="width: 6rem" />
            <Column field="name" header="Name" sortable />
            <Column field="folder_name" header="Organization" sortable />
            <Column field="subnet_count" header="Networks" style="width: 5rem">
              <template #body="{ data }">{{ data.subnet_count || 0 }}</template>
            </Column>
            <Column header="" style="width: 5rem">
              <template #body="{ data }">
                <div class="action-buttons">
                  <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                          @click="editVlan(data)" />
                  <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                          @click="confirmDeleteVlan(data)" />
                </div>
              </template>
            </Column>
          </DataTable>
        </div>

        <!-- VLAN Dialog -->
        <Dialog v-model:visible="showVlanDialog" :header="editingVlan ? 'Edit VLAN' : 'Add VLAN'"
                modal :style="{ width: '24rem' }">
          <div class="form-grid">
            <div class="field" v-if="!editingVlan">
              <label>Organization *</label>
              <Select v-model="vlanForm.folder_id" :options="orgOptions.filter(o => o.value)" optionLabel="label" optionValue="value"
                      placeholder="Select organization" class="w-full" />
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
                    :disabled="!vlanForm.folder_id || !vlanForm.vlan_id || !vlanForm.name" />
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
      <div v-if="activeTab === 2">
        <SubnetCalculator />
      </div>
      <div v-if="activeTab === 3" class="content-card">
        <div class="backup-section">
          <div class="setting-group">
            <h3>Manual Backup</h3>
            <p class="field-help" style="margin-bottom: 0.75rem;">Creates a backup of the database, certificates, and DNSmasq configuration.</p>
          </div>

          <div class="setting-group">
            <h3>Schedule</h3>
            <div class="field">
              <label>Automatic Backups</label>
              <Select v-model="backupSchedule" :options="scheduleOptions" optionLabel="label" optionValue="value"
                      class="w-full" style="max-width: 16rem;" @change="saveBackupSettings" />
            </div>
            <div class="field">
              <label>Retention (max backups to keep)</label>
              <InputText v-model.number="backupRetention" type="number" min="1" max="100"
                         style="width: 8rem;" @change="saveBackupSettings" />
            </div>
          </div>

          <div class="setting-group">
            <h3>Existing Backups</h3>
            <DataTable :value="opsStore.backups" :loading="opsStore.loading" stripedRows size="small"
                       emptyMessage="No backups found."
                       :paginator="opsStore.backups.length > 256" :rows="256"
                       :rowsPerPageOptions="[64, 128, 256, 512]"
                       scrollable scrollHeight="flex">
              <Column field="filename" header="Filename" />
              <Column header="Size" style="width: 8rem">
                <template #body="{ data }">{{ formatSize(data.size_bytes) }}</template>
              </Column>
              <Column header="Created" style="width: 12rem">
                <template #body="{ data }">{{ formatDate(data.created_at) }}</template>
              </Column>
              <Column header="" style="width: 6rem">
                <template #body="{ data }">
                  <div class="action-buttons">
                    <Button icon="pi pi-download" severity="secondary" text rounded size="small"
                            @click="opsStore.downloadBackup(data.id, data.filename)" />
                    <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                            @click="confirmDeleteBackup(data)" />
                  </div>
                </template>
              </Column>
            </DataTable>
          </div>

          <div class="setting-group">
            <h3>Restore from Backup</h3>
            <p class="field-help restore-warning">Warning: Restoring will replace all current data. A server restart will be required.</p>
            <div class="restore-row">
              <input type="file" ref="restoreFileInput" accept=".tar.gz,.tgz" @change="onRestoreFileSelected" />
              <Button label="Restore" icon="pi pi-upload" severity="danger" @click="showRestoreDialog = true"
                      :disabled="!restoreFile" />
            </div>
          </div>

          <div class="setting-group" v-if="authStore.user?.role === 'admin'">
            <h3 style="color: var(--p-red-500);">Database Reset</h3>
            <p class="field-help" style="margin-bottom: 0.75rem;">
              Reset the application to a fresh state. This will delete all networks, DNS zones, DHCP scopes,
              users, audit logs, settings, and VLANs. TLS certificates, backup files, and blocklist files on disk are preserved.
            </p>
            <Button label="Reset Database" icon="pi pi-exclamation-triangle" severity="danger"
                    @click="showResetDbDialog = true" />
          </div>
        </div>

        <!-- Delete Backup Dialog -->
        <Dialog v-model:visible="showDeleteBackupDialog" header="Delete Backup" modal :style="{ width: '24rem' }">
          <p>Delete backup <strong>{{ deletingBackup?.filename }}</strong>?</p>
          <template #footer>
            <Button label="Cancel" severity="secondary" @click="showDeleteBackupDialog = false" />
            <Button label="Delete" severity="danger" @click="doDeleteBackup" :loading="deletingBackupLoading" />
          </template>
        </Dialog>

        <!-- Database Reset Confirmation Dialog -->
        <Dialog v-model:visible="showResetDbDialog" header="Reset Database" modal :style="{ width: '28rem' }">
          <p style="color: var(--p-red-500); font-weight: 600;">This action cannot be undone.</p>
          <p>All application data will be permanently deleted and the database will be reinitialized.
             You will be logged out and a new admin account will be generated.</p>
          <p>Type <strong>RESET</strong> to confirm:</p>
          <InputText v-model="resetConfirmText" class="w-full" placeholder="Type RESET" />
          <template #footer>
            <Button label="Cancel" severity="secondary" @click="showResetDbDialog = false; resetConfirmText = ''" />
            <Button label="Reset Database" severity="danger" @click="doResetDatabase"
                    :loading="resettingDb" :disabled="resetConfirmText !== 'RESET'" />
          </template>
        </Dialog>

        <!-- Restore Confirmation Dialog -->
        <Dialog v-model:visible="showRestoreDialog" header="Confirm Restore" modal :style="{ width: '28rem' }">
          <p>This will <strong>replace all current data</strong> with the contents of the backup file. The server will need to be restarted after restore.</p>
          <p>Are you sure you want to proceed?</p>
          <template #footer>
            <Button label="Cancel" severity="secondary" @click="showRestoreDialog = false" />
            <Button label="Restore Now" severity="danger" @click="doRestore" :loading="restoring" />
          </template>
        </Dialog>
      </div>
      <div v-if="activeTab === 4" class="content-card">
        <div class="cert-section">
          <div class="setting-group">
            <h3>Current Certificate</h3>
            <div v-if="certInfo" class="cert-info-card">
              <div class="cert-row"><span class="cert-key">Subject:</span> {{ certInfo.subject || 'N/A' }}</div>
              <div class="cert-row"><span class="cert-key">Issuer:</span> {{ certInfo.issuer || 'N/A' }}</div>
              <div class="cert-row"><span class="cert-key">Valid From:</span> {{ certInfo.notbefore || 'N/A' }}</div>
              <div class="cert-row"><span class="cert-key">Valid Until:</span> {{ certInfo.notafter || 'N/A' }}</div>
              <div class="cert-row">
                <span class="cert-key">Type:</span>
                <span :class="certInfo.self_signed ? 'badge-warning' : 'badge-success'">
                  {{ certInfo.self_signed ? 'Self-Signed' : 'Custom' }}
                </span>
              </div>
            </div>
            <div v-else class="muted">Loading certificate info...</div>
          </div>

          <div class="setting-group">
            <h3>Upload Custom Certificate</h3>
            <p class="field-help" style="margin-bottom: 0.75rem;">Upload PEM-encoded certificate and private key files. Server restart required after upload.</p>
            <div class="cert-upload-form">
              <div class="cert-fields-row">
                <div class="field cert-field">
                  <label>Certificate (.pem, .crt)</label>
                  <div class="cert-drop-zone" :class="{ 'drop-active': certDragOver === 'cert' }"
                       @dragover.prevent="certDragOver = 'cert'" @dragleave="certDragOver = null"
                       @drop.prevent="onCertDrop($event, 'cert')">
                    <textarea v-model="certUpload.cert" placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----&#10;&#10;Drop a .pem or .crt file here"
                              class="cert-textarea" :class="{ 'cert-valid': certValidation.cert === true, 'cert-invalid': certValidation.cert === false }"></textarea>
                    <div v-if="certDragOver === 'cert'" class="drop-overlay">Drop certificate file</div>
                  </div>
                  <small v-if="certValidation.cert === true" class="cert-status cert-status-ok"><i class="pi pi-check-circle"></i> Valid PEM certificate</small>
                  <small v-else-if="certValidation.cert === false" class="cert-status cert-status-err"><i class="pi pi-times-circle"></i> {{ certValidation.certError }}</small>
                </div>
                <div class="field cert-field">
                  <label>Private Key (.pem, .key)</label>
                  <div class="cert-drop-zone" :class="{ 'drop-active': certDragOver === 'key' }"
                       @dragover.prevent="certDragOver = 'key'" @dragleave="certDragOver = null"
                       @drop.prevent="onCertDrop($event, 'key')">
                    <textarea v-model="certUpload.key" placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----&#10;&#10;Drop a .pem or .key file here"
                              class="cert-textarea" :class="{ 'cert-valid': certValidation.key === true, 'cert-invalid': certValidation.key === false }"></textarea>
                    <div v-if="certDragOver === 'key'" class="drop-overlay">Drop key file</div>
                  </div>
                  <small v-if="certValidation.key === true" class="cert-status cert-status-ok"><i class="pi pi-check-circle"></i> Valid PEM private key</small>
                  <small v-else-if="certValidation.key === false" class="cert-status cert-status-err"><i class="pi pi-times-circle"></i> {{ certValidation.keyError }}</small>
                </div>
              </div>
            </div>
          </div>

          <div class="setting-group">
            <h3>Reset to Self-Signed</h3>
            <p class="field-help" style="margin-bottom: 0.75rem;">Generate a new self-signed certificate. Server restart required.</p>
            <Button label="Reset to Self-Signed" icon="pi pi-refresh" severity="secondary" @click="confirmResetCert" :loading="resettingCert" />
          </div>
        </div>
      </div>
      <div v-if="activeTab === 5" class="content-card">
        <DnsPanel ref="dnsPanelRef" />
      </div>
      <div v-if="activeTab === 6" class="content-card">
        <DhcpPanel ref="dhcpPanelRef" />
      </div>
      <div v-if="activeTab === 7">
        <BlocklistsPanel />
      </div>
      <div v-if="activeTab === 8">
        <GeoipPanel />
      </div>
      <div v-if="activeTab === 9" class="content-card">
        <UsersPanel ref="usersPanelRef" />
      </div>
      <div v-if="activeTab === 10" class="content-card">
        <div class="themes-page">
          <p class="field-help" style="margin-bottom: 1.25rem">Choose a color theme. The active theme is highlighted.</p>

          <div class="theme-group">
            <h3>Dark Themes</h3>
            <div class="theme-card-grid">
              <div v-for="t in darkThemes" :key="t.id"
                   class="theme-card" :class="{ 'theme-active': themeStore.currentThemeId === t.id }"
                   @click="themeStore.applyTheme(t.id)">
                <span class="theme-swatch-dot" :style="{ background: getThemeSwatch(t) }"></span>
                <div class="theme-card-info">
                  <span class="theme-card-name">{{ t.name }}</span>
                  <span class="theme-card-desc">{{ getThemeDesc(t) }}</span>
                </div>
                <i v-if="themeStore.currentThemeId === t.id" class="pi pi-check theme-check"></i>
              </div>
            </div>
          </div>

          <div class="theme-group">
            <h3>Light Themes</h3>
            <div class="theme-card-grid">
              <div v-for="t in lightThemes" :key="t.id"
                   class="theme-card" :class="{ 'theme-active': themeStore.currentThemeId === t.id }"
                   @click="themeStore.applyTheme(t.id)">
                <span class="theme-swatch-dot" :style="{ background: getThemeSwatch(t) }"></span>
                <div class="theme-card-info">
                  <span class="theme-card-name">{{ t.name }}</span>
                  <span class="theme-card-desc">{{ getThemeDesc(t) }}</span>
                </div>
                <i v-if="themeStore.currentThemeId === t.id" class="pi pi-check theme-check"></i>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-if="activeTab === 11">
        <TabView class="logging-subtabs">
          <TabPanel header="DNSmasq">
            <LogViewer />
          </TabPanel>
          <TabPanel header="Audit Log">
            <div class="audit-section">
              <div class="audit-filters">
                <MultiSelect v-model="auditFilters.action" :options="auditActionOptions" optionLabel="label" optionValue="value"
                        placeholder="All Actions" :maxSelectedLabels="2" class="audit-filter" display="chip" />
                <MultiSelect v-model="auditFilters.entity_type" :options="auditEntityOptions" optionLabel="label" optionValue="value"
                        placeholder="All Entities" :maxSelectedLabels="2" class="audit-filter" display="chip" />
                <Button icon="pi pi-refresh" severity="secondary" text rounded @click="loadAuditLog" />
              </div>
              <DataTable :value="auditLog.items" :loading="loadingAudit" stripedRows size="small"
                         emptyMessage="No audit entries found."
                         :paginator="auditLog.items.length > 256" :rows="256"
                         :rowsPerPageOptions="[64, 128, 256, 512]"
                         scrollable scrollHeight="flex">
                <Column field="created_at" header="Time" style="width: 11rem">
                  <template #body="{ data }">{{ formatDate(data.created_at) }}</template>
                </Column>
                <Column field="username" header="User" style="width: 8rem">
                  <template #body="{ data }">{{ data.username || 'system' }}</template>
                </Column>
                <Column field="action" header="Action" style="width: 8rem">
                  <template #body="{ data }">
                    <span class="audit-action" :class="'action-' + actionColor(data.action)">{{ data.action }}</span>
                  </template>
                </Column>
                <Column field="entity_type" header="Entity" style="width: 8rem" />
                <Column field="entity_id" header="ID" style="width: 4rem" />
                <Column header="Details">
                  <template #body="{ data }">
                    <span class="audit-details">{{ formatDetails(data.details) }}</span>
                  </template>
                </Column>
              </DataTable>
              <div class="audit-pagination" v-if="auditLog.total > auditFilters.limit">
                <Button label="Previous" severity="secondary" size="small" :disabled="auditFilters.page <= 1"
                        @click="auditFilters.page--; loadAuditLog()" />
                <span class="page-info">Page {{ auditFilters.page }} of {{ Math.ceil(auditLog.total / auditFilters.limit) }}</span>
                <Button label="Next" severity="secondary" size="small"
                        :disabled="auditFilters.page >= Math.ceil(auditLog.total / auditFilters.limit)"
                        @click="auditFilters.page++; loadAuditLog()" />
              </div>
            </div>
          </TabPanel>
        </TabView>
      </div>
    </div>

    <Toast />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick, defineAsyncComponent } from 'vue';
import { useToast } from 'primevue/usetoast';
import Menubar from 'primevue/menubar';
import Menu from 'primevue/menu';
import TabView from 'primevue/tabview';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import MultiSelect from 'primevue/multiselect';
import InputNumber from 'primevue/inputnumber';
import Toast from 'primevue/toast';
import SubnetCalculator from './SubnetCalculator.vue';
import { useSubnetStore } from '../stores/subnets.js';
import { useOperationsStore } from '../stores/operations.js';
import { applyNameTemplate } from '../utils/ip.js';
import api from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';
import { useThemeStore, themes, colorSwatches } from '../stores/theme.js';

const DnsPanel = defineAsyncComponent(() => import('./DNS.vue'));
const DhcpPanel = defineAsyncComponent(() => import('./DHCP.vue'));
const BlocklistsPanel = defineAsyncComponent(() => import('./Blocklists.vue'));
const GeoipPanel = defineAsyncComponent(() => import('./GeoIP.vue'));
const UsersPanel = defineAsyncComponent(() => import('./Users.vue'));
const LogViewer = defineAsyncComponent(() => import('../components/LogViewer.vue'));

const dnsPanelRef = ref(null);
const dhcpPanelRef = ref(null);
const usersPanelRef = ref(null);

const store = useSubnetStore();
const opsStore = useOperationsStore();
const authStore = useAuthStore();
const themeStore = useThemeStore();
const toast = useToast();

const darkThemes = themes.filter(t => t.group === 'dark');
const lightThemes = themes.filter(t => t.group === 'light');

function getThemeSwatch(t) {
  if (t.primary) return colorSwatches[t.primary];
  return colorSwatches[t.name.toLowerCase()] || t.customPrimary?.[300] || '#888';
}

function getThemeDesc(t) {
  if (t.primary) return `${t.primary} primary, ${t.surface} surface`;
  return 'custom palette';
}

// Persist active tab across refreshes
const LOGGING_TAB_INDEX = 11;
const activeTab = ref(parseInt(localStorage.getItem('ipam_system_tab') || '0', 10));
watch(activeTab, (val) => {
  localStorage.setItem('ipam_system_tab', String(val));
  if (val === LOGGING_TAB_INDEX) { loadAuditFilterOptions(); loadAuditLog(); }
});

const allMenuItems = [
  { tabIndex: 0, label: 'Network', icon: 'pi pi-cog', dataTrack: 'sys-tab-settings', command: () => { activeTab.value = 0; } },
  { tabIndex: 1, label: 'VLANs', icon: 'pi pi-list', dataTrack: 'sys-tab-vlans', command: () => { activeTab.value = 1; } },
  { tabIndex: 2, label: 'Calculator', icon: 'pi pi-calculator', dataTrack: 'sys-tab-calculator', command: () => { activeTab.value = 2; } },
  { tabIndex: 3, label: 'Backup', icon: 'pi pi-database', dataTrack: 'sys-tab-backups', command: () => { activeTab.value = 3; } },
  { tabIndex: 4, label: 'Certificates', icon: 'pi pi-lock', dataTrack: 'sys-tab-certificates', command: () => { activeTab.value = 4; } },
  { tabIndex: 5, label: 'DNS', icon: 'pi pi-globe', dataTrack: 'sys-tab-dns', command: () => { activeTab.value = 5; } },
  { tabIndex: 6, label: 'DHCP', icon: 'pi pi-server', dataTrack: 'sys-tab-dhcp', command: () => { activeTab.value = 6; } },
  { tabIndex: 7, label: 'Blocklists', icon: 'pi pi-ban', dataTrack: 'sys-tab-blocklists', command: () => { activeTab.value = 7; } },
  { tabIndex: 8, label: 'GeoIP', icon: 'pi pi-map', dataTrack: 'sys-tab-geoip', command: () => { activeTab.value = 8; } },
  { tabIndex: 9, label: 'Users', icon: 'pi pi-users', dataTrack: 'sys-tab-users', command: () => { activeTab.value = 9; } },
  { tabIndex: 10, label: 'Themes', icon: 'pi pi-palette', dataTrack: 'sys-tab-themes', command: () => { activeTab.value = 10; } },
  { tabIndex: 11, label: 'Logging', icon: 'pi pi-file', dataTrack: 'sys-tab-logging', command: () => { activeTab.value = 11; } },
];

// Overflow menu logic
const menubarRef = ref(null);
const overflowMenuRef = ref(null);
const visibleCount = ref(allMenuItems.length);

const visibleMenuItems = computed(() => allMenuItems.slice(0, visibleCount.value));
const overflowItems = computed(() => allMenuItems.slice(visibleCount.value));

function toggleOverflow(event) {
  overflowMenuRef.value.toggle(event);
}

let _resizeObserver = null;
function measureOverflow() {
  const el = menubarRef.value?.$el;
  if (!el) return;
  const rootList = el.querySelector('.p-menubar-root-list');
  if (!rootList) return;

  // Temporarily show all items to measure
  const items = rootList.querySelectorAll(':scope > .p-menubar-item');
  if (items.length === 0) return;

  // Get the available width (rootList container)
  const listRect = rootList.getBoundingClientRect();
  let count = 0;
  for (const item of items) {
    const itemRect = item.getBoundingClientRect();
    // Item is visible if its right edge fits within the list
    if (itemRect.right <= listRect.right + 2) {
      count++;
    } else {
      break;
    }
  }
  // If not all fit, show one fewer to make room for the >> button
  if (count < allMenuItems.length && count > 0) {
    visibleCount.value = count;
  } else {
    visibleCount.value = allMenuItems.length;
  }
}

onMounted(() => {
  nextTick(() => {
    // First measure with all items
    visibleCount.value = allMenuItems.length;
    nextTick(measureOverflow);
  });
  _resizeObserver = new ResizeObserver(() => {
    // Reset to full to get accurate measurement
    visibleCount.value = allMenuItems.length;
    nextTick(measureOverflow);
  });
  const el = menubarRef.value?.$el;
  if (el) _resizeObserver.observe(el);
});

onBeforeUnmount(() => {
  _resizeObserver?.disconnect();
});

const loadingSettings = ref(true);
const savingSettings = ref(false);
const settings = ref({
  subnet_name_template: '%1.%2.%3.%4/%bitmask',
  default_gateway_position: 'first',
  default_scan_interval: ''
});
const scanIntervalOptions = [
  { label: 'Off', value: '' },
  { label: 'Every 5 minutes', value: '5m' },
  { label: 'Every 15 minutes', value: '15m' },
  { label: 'Every 30 minutes', value: '30m' },
  { label: 'Every 1 hour', value: '1h' },
  { label: 'Every 4 hours', value: '4h' },
];

// On-demand scan
const scanSubnetId = ref(null);
const startingScan = ref(false);

const allocatedSubnets = computed(() => {
  const result = [];
  for (const f of store.folders) {
    if (!f.subnets) continue;
    function collect(nodes) {
      for (const s of nodes) {
        if (s.status === 'allocated') {
          result.push({ label: `${s.cidr} — ${s.name}`, value: s.id });
        }
        if (s.children) collect(s.children);
      }
    }
    collect(f.subnets);
  }
  return result;
});

async function doStartScan() {
  if (!scanSubnetId.value) return;
  startingScan.value = true;
  try {
    await store.startScan(scanSubnetId.value);
    toast.add({ severity: 'success', summary: 'Scan started', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Scan Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    startingScan.value = false;
  }
}

const templatePreview = computed(() => {
  try {
    return applyNameTemplate(settings.value.subnet_name_template, '192.168.1.0/24');
  } catch { return ''; }
});

onMounted(async () => {
  try {
    const [data] = await Promise.all([
      store.getSettings(),
      loadRangeTypes(),
      loadVlans(),
      opsStore.fetchBackups(),
      opsStore.fetchCertInfo().then(c => certInfo.value = c).catch(() => {}),
      loadBackupSettings(),
      store.folders.length === 0 ? store.fetchTree() : Promise.resolve()
    ]);
    settings.value = {
      subnet_name_template: data.subnet_name_template || '%1.%2.%3.%4/%bitmask',
      default_gateway_position: data.default_gateway_position || 'first',
      default_scan_interval: data.default_scan_interval || ''
    };
  } catch { /* use defaults */ }
  loadingSettings.value = false;
  if (activeTab.value === LOGGING_TAB_INDEX) { loadAuditFilterOptions(); loadAuditLog(); }
});

// Address Types
const rangeTypes = ref([]);
const loadingRangeTypes = ref(false);
const savingRangeType = ref(false);
const showRangeTypeDialog = ref(false);
const showDeleteRangeTypeDialog = ref(false);
const editingRangeType = ref(null);
const deletingRangeType = ref(null);
const rangeTypeForm = ref({ name: '', color: '#6b7280', description: '' });

async function loadRangeTypes() {
  loadingRangeTypes.value = true;
  try { rangeTypes.value = await store.getRangeTypes(); }
  finally { loadingRangeTypes.value = false; }
}

function editRangeType(type) {
  editingRangeType.value = type;
  rangeTypeForm.value = { name: type.name, color: type.color, description: type.description || '' };
  showRangeTypeDialog.value = true;
}

function closeRangeTypeDialog() {
  showRangeTypeDialog.value = false;
  editingRangeType.value = null;
  rangeTypeForm.value = { name: '', color: '#6b7280', description: '' };
}

async function saveRangeType() {
  savingRangeType.value = true;
  try {
    if (editingRangeType.value) {
      await store.updateRangeType(editingRangeType.value.id, rangeTypeForm.value);
      toast.add({ severity: 'success', summary: 'Range type updated', life: 3000 });
    } else {
      await store.createRangeType(rangeTypeForm.value);
      toast.add({ severity: 'success', summary: 'Range type created', life: 3000 });
    }
    closeRangeTypeDialog();
    await loadRangeTypes();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { savingRangeType.value = false; }
}

function confirmDeleteRangeType(type) {
  deletingRangeType.value = type;
  showDeleteRangeTypeDialog.value = true;
}

async function doDeleteRangeType() {
  savingRangeType.value = true;
  try {
    await store.deleteRangeType(deletingRangeType.value.id);
    showDeleteRangeTypeDialog.value = false;
    toast.add({ severity: 'success', summary: 'Range type deleted', life: 3000 });
    await loadRangeTypes();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { savingRangeType.value = false; }
}

// VLANs
const vlans = ref([]);
const loadingVlans = ref(false);
const savingVlan = ref(false);
const showVlanDialog = ref(false);
const showDeleteVlanDialog = ref(false);
const editingVlan = ref(null);
const deletingVlan = ref(null);
const vlanForm = ref({ folder_id: null, vlan_id: null, name: '' });
const vlanNameManual = ref(false);
const vlanOrgFilter = ref(null);

function onVlanIdInput(e) {
  const val = e.value;
  if (!vlanNameManual.value) {
    vlanForm.value.name = val ? `VLAN${val}` : '';
  }
}

const orgOptions = computed(() => {
  return store.folders.map(f => ({ label: f.name, value: f.id }));
});

async function loadVlans() {
  loadingVlans.value = true;
  try {
    const params = vlanOrgFilter.value ? `?folder_id=${vlanOrgFilter.value}` : '';
    const res = await api.get(`/vlans${params}`);
    vlans.value = res.data;
  } finally { loadingVlans.value = false; }
}

function openVlanDialog() {
  editingVlan.value = null;
  vlanNameManual.value = false;
  vlanForm.value = { folder_id: vlanOrgFilter.value || (store.folders[0]?.id || null), vlan_id: null, name: '' };
  showVlanDialog.value = true;
}

function editVlan(vlan) {
  editingVlan.value = vlan;
  vlanNameManual.value = vlan.name !== `VLAN${vlan.vlan_id}`;
  vlanForm.value = { folder_id: vlan.folder_id, vlan_id: vlan.vlan_id, name: vlan.name };
  showVlanDialog.value = true;
}

function closeVlanDialog() {
  showVlanDialog.value = false;
  editingVlan.value = null;
  vlanForm.value = { folder_id: null, vlan_id: null, name: '' };
}

async function saveVlan() {
  savingVlan.value = true;
  try {
    if (editingVlan.value) {
      await api.put(`/vlans/${editingVlan.value.id}`, { vlan_id: vlanForm.value.vlan_id, name: vlanForm.value.name });
      toast.add({ severity: 'success', summary: 'VLAN updated', life: 3000 });
    } else {
      await api.post('/vlans', vlanForm.value);
      toast.add({ severity: 'success', summary: 'VLAN created', life: 3000 });
    }
    closeVlanDialog();
    await loadVlans();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally { savingVlan.value = false; }
}

// Audit Log
const loadingAudit = ref(false);
const auditLog = ref({ items: [], total: 0 });
const auditFilters = ref({ page: 1, limit: 200, action: [], entity_type: [] });

const auditActionOptions = ref([]);
const auditEntityOptions = ref([]);

async function loadAuditFilterOptions() {
  try {
    const [actionsRes, entitiesRes] = await Promise.all([
      api.get('/audit/actions'),
      api.get('/audit/entities')
    ]);
    auditActionOptions.value = actionsRes.data.map(a => ({ label: a, value: a }));
    auditEntityOptions.value = entitiesRes.data.map(e => ({ label: e, value: e }));
  } catch { /* ignore — filters will just be empty */ }
}

// Auto-refresh when filters change
watch(() => auditFilters.value.action, () => { auditFilters.value.page = 1; loadAuditLog(); }, { deep: true });
watch(() => auditFilters.value.entity_type, () => { auditFilters.value.page = 1; loadAuditLog(); }, { deep: true });

async function loadAuditLog() {
  loadingAudit.value = true;
  try {
    const params = { page: auditFilters.value.page, limit: auditFilters.value.limit };
    if (auditFilters.value.action?.length > 0) params.action = auditFilters.value.action.join(',');
    if (auditFilters.value.entity_type?.length > 0) params.entity_type = auditFilters.value.entity_type.join(',');
    const res = await api.get('/audit', { params });
    auditLog.value = res.data;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    loadingAudit.value = false;
  }
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'Z');
  return d.toLocaleString();
}

function actionColor(action) {
  // Direct matches
  const direct = { create: 'create', update: 'update', delete: 'delete', restore: 'restore',
    login: 'login', login_failed: 'login_failed', password_change: 'password_change',
    configure: 'configure', divide: 'divide', merge: 'merge' };
  if (direct[action]) return action;
  // Map compound actions by verb suffix
  if (action.endsWith('_created')) return 'create';
  if (action.endsWith('_updated')) return 'update';
  if (action.endsWith('_deleted')) return 'delete';
  if (action.endsWith('_configured') || action.endsWith('_applied')) return 'configure';
  if (action.endsWith('_divided')) return 'divide';
  if (action.endsWith('_merged')) return 'merge';
  if (action.endsWith('_started')) return 'login'; // indigo for "started" actions like scans
  if (action.endsWith('_reset')) return 'password_change';
  if (action.endsWith('_changed')) return 'update';
  return 'update'; // fallback — at least show a badge
}

function formatDetails(details) {
  if (!details) return '—';
  try {
    const obj = typeof details === 'string' ? JSON.parse(details) : details;
    const parts = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && v !== undefined) parts.push(`${k}: ${v}`);
    }
    return parts.join(', ') || '—';
  } catch { return String(details); }
}

async function saveSettings() {
  savingSettings.value = true;
  try {
    await Promise.all([
      store.updateSetting('subnet_name_template', settings.value.subnet_name_template),
      store.updateSetting('default_gateway_position', settings.value.default_gateway_position),
      store.updateSetting('default_scan_interval', settings.value.default_scan_interval || '')
    ]);
    toast.add({ severity: 'success', summary: 'Settings saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingSettings.value = false;
  }
}

// Backup & Restore
const creatingBackup = ref(false);
const deletingBackup = ref(null);
const deletingBackupLoading = ref(false);
const showDeleteBackupDialog = ref(false);
const showResetDbDialog = ref(false);
const resetConfirmText = ref('');
const resettingDb = ref(false);
const showRestoreDialog = ref(false);
const restoreFile = ref(null);
const restoreFileInput = ref(null);
const restoring = ref(false);
const backupSchedule = ref('off');
const backupRetention = ref(7);

const scheduleOptions = [
  { label: 'Off', value: 'off' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' }
];

async function loadBackupSettings() {
  try {
    const data = await store.getSettings();
    backupSchedule.value = data.backup_schedule || 'off';
    backupRetention.value = parseInt(data.backup_retention_count || '7', 10);
  } catch {}
}

async function saveBackupSettings() {
  try {
    await Promise.all([
      store.updateSetting('backup_schedule', backupSchedule.value),
      store.updateSetting('backup_retention_count', String(backupRetention.value))
    ]);
    toast.add({ severity: 'success', summary: 'Backup settings saved', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  }
}

async function doCreateBackup() {
  creatingBackup.value = true;
  try {
    const backup = await opsStore.createBackup();
    toast.add({ severity: 'success', summary: `Backup created: ${backup.filename}`, life: 5000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Backup failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    creatingBackup.value = false;
  }
}

function confirmDeleteBackup(backup) {
  deletingBackup.value = backup;
  showDeleteBackupDialog.value = true;
}

async function doDeleteBackup() {
  deletingBackupLoading.value = true;
  try {
    await opsStore.deleteBackup(deletingBackup.value.id);
    showDeleteBackupDialog.value = false;
    toast.add({ severity: 'success', summary: 'Backup deleted', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    deletingBackupLoading.value = false;
  }
}

function onRestoreFileSelected(e) {
  restoreFile.value = e.target.files[0] || null;
}

async function doRestore() {
  if (!restoreFile.value) return;
  restoring.value = true;
  try {
    const result = await opsStore.restoreBackup(restoreFile.value);
    showRestoreDialog.value = false;
    toast.add({ severity: 'warn', summary: 'Restore complete', detail: result.message, life: 10000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Restore failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    restoring.value = false;
  }
}

async function doResetDatabase() {
  resettingDb.value = true;
  try {
    await api.post('/operations/reset-database');
    authStore.logout();
    window.location.href = '/login';
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Reset failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    resettingDb.value = false;
    showResetDbDialog.value = false;
    resetConfirmText.value = '';
  }
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

// Certificates
const certInfo = ref(null);
const certUpload = ref({ cert: '', key: '' });
const certDragOver = ref(null);
const uploadingCert = ref(false);
const resettingCert = ref(false);

const certValidation = computed(() => {
  const result = { cert: null, certError: '', key: null, keyError: '' };
  const certText = certUpload.value.cert.trim();
  const keyText = certUpload.value.key.trim();
  if (certText) {
    if (!certText.startsWith('-----BEGIN CERTIFICATE-----')) {
      result.cert = false;
      result.certError = 'Must start with -----BEGIN CERTIFICATE-----';
    } else if (!certText.includes('-----END CERTIFICATE-----')) {
      result.cert = false;
      result.certError = 'Missing -----END CERTIFICATE-----';
    } else {
      const body = certText.replace(/-----BEGIN CERTIFICATE-----/g, '').replace(/-----END CERTIFICATE-----/g, '').replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/=]+$/.test(body) || body.length < 100) {
        result.cert = false;
        result.certError = 'Invalid base64 content';
      } else {
        result.cert = true;
      }
    }
  }
  if (keyText) {
    const keyHeaders = ['-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----'];
    const keyFooters = ['-----END PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----', '-----END EC PRIVATE KEY-----'];
    const hasHeader = keyHeaders.some(h => keyText.startsWith(h));
    const hasFooter = keyFooters.some(f => keyText.includes(f));
    if (!hasHeader) {
      result.key = false;
      result.keyError = 'Must start with -----BEGIN PRIVATE KEY----- (or RSA/EC variant)';
    } else if (!hasFooter) {
      result.key = false;
      result.keyError = 'Missing -----END PRIVATE KEY-----';
    } else {
      const body = keyText.replace(/-----BEGIN [A-Z ]+-----/g, '').replace(/-----END [A-Z ]+-----/g, '').replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/=]+$/.test(body) || body.length < 50) {
        result.key = false;
        result.keyError = 'Invalid base64 content';
      } else {
        result.key = true;
      }
    }
  }
  return result;
});

function confirmResetCert() {
  if (!confirm('Are you sure you want to reset to a self-signed certificate? The current certificate will be replaced and a server restart will be required.')) return;
  doResetCert();
}

function onCertDrop(event, field) {
  certDragOver.value = null;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { certUpload.value[field] = reader.result; };
  reader.readAsText(file);
}

async function doUploadCert() {
  uploadingCert.value = true;
  try {
    const result = await opsStore.uploadCert(certUpload.value.key, certUpload.value.cert);
    certUpload.value = { cert: '', key: '' };
    toast.add({ severity: 'warn', summary: 'Certificate installed', detail: result.message, life: 10000 });
    await opsStore.fetchCertInfo().then(c => certInfo.value = c);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Upload failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    uploadingCert.value = false;
  }
}

async function doResetCert() {
  resettingCert.value = true;
  try {
    const result = await opsStore.resetCert();
    toast.add({ severity: 'warn', summary: 'Certificate reset', detail: result.message, life: 10000 });
    await opsStore.fetchCertInfo().then(c => certInfo.value = c);
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Reset failed', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    resettingCert.value = false;
  }
}
</script>

<style scoped>
.system-page {
  padding: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
/* Inner TabView (Logging subtabs) */
.system-page :deep(.logging-subtabs) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.system-page :deep(.logging-subtabs .p-tabview-panels) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.system-page :deep(.logging-subtabs .p-tabview-panel) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.sys-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.sys-content {
  flex: 1;
  overflow: auto;
  padding: 1rem;
}
:deep(.p-menubar-root-list) {
  flex-wrap: nowrap !important;
  overflow: hidden !important;
}
:deep(.p-menubar-item-content) {
  padding: 0.45rem 0.65rem !important;
}
:deep(.active-menuitem) {
  background: color-mix(in srgb, var(--p-primary-color) 15%, transparent) !important;
  color: var(--p-primary-color) !important;
  font-weight: 600;
}
.overflow-trigger {
  opacity: 0.7;
  transition: opacity 0.15s;
}
.overflow-trigger:hover {
  opacity: 1;
}
.muted {
  color: var(--p-text-muted-color);
}
.content-card {
  margin: 3% 7% 0;
  padding: 1.25rem;
  background: var(--p-surface-card);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
}
.content-card h3 {
  margin: 0 0 0.75rem 0;
}
.content-card + .content-card {
  margin-top: 0.75rem;
}
.settings-form {
  max-width: 32rem;
}
.setting-group {
  margin-bottom: 1.5rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--p-surface-border);
}
.setting-group:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.scan-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.setting-group h3 {
  margin: 0 0 0.75rem 0;
  font-size: 1rem;
  color: var(--p-text-color);
}
.field {
  margin-bottom: 1rem;
}
.field label {
  display: block;
  margin-bottom: 0.35rem;
  font-size: 0.85rem;
  font-weight: 600;
}
.field-help {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
}
.template-preview {
  margin-top: 0.5rem;
  padding: 0.4rem 0.75rem;
  background: var(--p-surface-ground);
  border: 1px solid var(--p-surface-border);
  border-radius: 4px;
  font-family: monospace;
  font-size: 0.85rem;
  color: var(--p-text-color);
}
.radio-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.radio-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.9rem;
}
.settings-actions {
  margin-top: 1rem;
}
.section-header {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0.75rem;
}
.color-swatch {
  display: inline-block;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid rgba(0,0,0,0.1);
}
.badge-system {
  font-size: 0.75rem;
  background: var(--p-surface-ground);
  color: var(--p-text-muted-color);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}
.badge-custom {
  font-size: 0.75rem;
  background: color-mix(in srgb, var(--p-primary-color) 20%, transparent);
  color: var(--p-primary-color);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}
.action-buttons {
  display: flex;
  gap: 0.25rem;
}
.form-grid {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.color-picker-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.color-picker-row input[type="color"] {
  width: 36px;
  height: 36px;
  border: none;
  padding: 0;
  cursor: pointer;
}
.audit-section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  flex: 1;
  min-height: 0;
}
.audit-filters {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}
.audit-filter {
  min-width: 14rem;
  max-width: 22rem;
}
.audit-action {
  font-size: 0.75rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 600;
}
.action-create { background: color-mix(in srgb, var(--p-green-500) 20%, transparent); color: var(--p-green-500); }
.action-update { background: color-mix(in srgb, var(--p-blue-500) 20%, transparent); color: var(--p-blue-500); }
.action-delete { background: color-mix(in srgb, var(--p-red-500) 20%, transparent); color: var(--p-red-500); }
.action-login { background: color-mix(in srgb, var(--p-indigo-500) 20%, transparent); color: var(--p-indigo-500); }
.action-login_failed { background: color-mix(in srgb, var(--p-red-500) 20%, transparent); color: var(--p-red-500); }
.action-password_change { background: color-mix(in srgb, var(--p-yellow-500) 20%, transparent); color: var(--p-yellow-500); }
.action-configure { background: color-mix(in srgb, var(--p-purple-500) 20%, transparent); color: var(--p-purple-500); }
.action-divide { background: color-mix(in srgb, var(--p-yellow-500) 20%, transparent); color: var(--p-yellow-500); }
.action-merge { background: color-mix(in srgb, var(--p-orange-500) 20%, transparent); color: var(--p-orange-500); }
.action-restore { background: color-mix(in srgb, var(--p-indigo-500) 20%, transparent); color: var(--p-indigo-500); }
.audit-details {
  font-size: 0.8rem;
  color: var(--p-text-muted-color);
  max-width: 30rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
}
.audit-pagination {
  display: flex;
  align-items: center;
  gap: 1rem;
  justify-content: center;
  margin-top: 0.5rem;
}
.page-info {
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
}
.range-types-section {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.backup-section, .cert-section {
  max-width: 48rem;
}
.restore-warning {
  color: var(--p-red-500);
  font-weight: 600;
}
.restore-row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}
.cert-info-card {
  background: var(--p-surface-ground);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  padding: 1rem;
  font-size: 0.85rem;
}
.cert-row {
  padding: 0.25rem 0;
}
.cert-key {
  font-weight: 600;
  display: inline-block;
  width: 7rem;
}
.cert-upload-form {
  max-width: 32rem;
}
.cert-fields-row {
  display: flex;
  gap: 1rem;
}
.cert-field {
  flex: 1;
  min-width: 0;
}
.cert-drop-zone {
  position: relative;
}
.cert-drop-zone.drop-active .cert-textarea {
  border-color: var(--p-primary-color);
  border-style: dashed;
}
.drop-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--p-primary-color) 10%, transparent);
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--p-primary-color);
  pointer-events: none;
}
.cert-textarea {
  width: 100%;
  height: 24rem;
  font-family: monospace;
  font-size: 0.8rem;
  padding: 0.5rem;
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  resize: vertical;
  overflow-y: auto;
}
.cert-textarea.cert-valid {
  border-color: var(--p-green-500);
}
.cert-textarea.cert-invalid {
  border-color: #ef4444;
}
.cert-status {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.35rem;
  font-size: 0.75rem;
}
.cert-status-ok { color: var(--p-green-500); }
.cert-status-err { color: #ef4444; }
.badge-warning {
  font-size: 0.75rem;
  background: color-mix(in srgb, var(--p-yellow-500) 20%, transparent);
  color: var(--p-yellow-500);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 600;
}
.badge-success {
  font-size: 0.75rem;
  background: color-mix(in srgb, var(--p-green-500) 20%, transparent);
  color: var(--p-green-500);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 600;
}

/* ── Themes ── */
.themes-page h3 {
  margin: 0 0 0.75rem 0;
}
.theme-group {
  margin-bottom: 1.5rem;
}
.theme-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.5rem;
}
.theme-card {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.6rem 0.75rem;
  border: 2px solid var(--p-surface-border);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.theme-card:hover {
  background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
  border-color: color-mix(in srgb, var(--p-primary-color) 40%, transparent);
}
.theme-card.theme-active {
  border-color: var(--p-primary-color);
  background: color-mix(in srgb, var(--p-primary-color) 12%, transparent);
}
.theme-swatch-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  flex-shrink: 0;
  border: 2px solid rgba(255, 255, 255, 0.15);
}
.theme-card-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.theme-card-name {
  font-weight: 600;
  font-size: 0.85rem;
}
.theme-card-desc {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
}
.theme-check {
  color: var(--p-primary-color);
  font-size: 0.9rem;
  flex-shrink: 0;
}
</style>
