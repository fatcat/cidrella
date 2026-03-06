<template>
  <div class="system-page">
    <h2>System</h2>

    <TabView v-model:activeIndex="activeTab">
      <TabPanel header="Settings">
        <div v-if="loadingSettings" class="muted">Loading settings...</div>
        <div v-else class="settings-form">
          <div class="setting-group">
            <h3>Subnet Naming</h3>
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

          <div class="setting-group">
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

          <div class="setting-group">
            <h3>DNS</h3>
            <div class="field">
              <label>Upstream Forwarders</label>
              <div class="forwarders-list">
                <div v-for="(server, idx) in forwarders" :key="idx" class="forwarder-row">
                  <InputText v-model="forwarders[idx]" placeholder="e.g. 8.8.8.8" style="flex: 1;" />
                  <Button icon="pi pi-times" severity="danger" text rounded size="small"
                          @click="forwarders.splice(idx, 1)" :disabled="forwarders.length <= 1" />
                </div>
                <Button label="Add Server" icon="pi pi-plus" severity="secondary" size="small" text
                        @click="forwarders.push('')" />
              </div>
              <small class="field-help">DNS servers used for upstream resolution (e.g., 8.8.8.8, 1.1.1.1)</small>
            </div>
          </div>

          <div class="setting-group">
            <h3>Network Scanning</h3>
            <p class="field-help" style="margin-bottom: 0.75rem;">
              Configure automatic network scanning for allocated subnets. Scans send ARP probes to detect online hosts.
            </p>
            <div class="field">
              <label>Default Scan Interval</label>
              <Select v-model="settings.default_scan_interval" :options="scanIntervalOptions" optionLabel="label" optionValue="value"
                      class="w-full" style="max-width: 16rem;" />
              <small class="field-help">Applied to newly configured subnets.</small>
            </div>
            <div class="field">
              <label>On-Demand Scan</label>
              <div class="scan-row">
                <Select v-model="scanSubnetId" :options="allocatedSubnets" optionLabel="label" optionValue="value"
                        placeholder="Select subnet" class="w-full" style="max-width: 20rem;" />
                <Button label="Scan Now" icon="pi pi-search" size="small" @click="doStartScan"
                        :loading="startingScan" :disabled="!scanSubnetId" />
              </div>
              <small class="field-help">Send ARP probes to all usable IPs in the selected subnet.</small>
            </div>
          </div>

          <div class="settings-actions">
            <Button label="Save Settings" icon="pi pi-save" @click="saveSettings" :loading="savingSettings" />
          </div>
        </div>
      </TabPanel>
      <TabPanel header="Range Types">
        <div class="range-types-section">
          <div class="section-header">
            <Button label="Add Type" icon="pi pi-plus" size="small" @click="showRangeTypeDialog = true" />
          </div>
          <DataTable :value="rangeTypes" :loading="loadingRangeTypes" stripedRows emptyMessage="No range types found." size="small">
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

        <!-- Range Type Dialog -->
        <Dialog v-model:visible="showRangeTypeDialog" :header="editingRangeType ? 'Edit Range Type' : 'Add Range Type'"
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

        <!-- Delete Range Type Dialog -->
        <Dialog v-model:visible="showDeleteRangeTypeDialog" header="Delete Range Type" modal :style="{ width: '24rem' }">
          <p>Delete range type <strong>{{ deletingRangeType?.name }}</strong>?</p>
          <template #footer>
            <Button label="Cancel" severity="secondary" @click="showDeleteRangeTypeDialog = false" />
            <Button label="Delete" severity="danger" @click="doDeleteRangeType" :loading="savingRangeType" />
          </template>
        </Dialog>
      </TabPanel>
      <TabPanel header="VLANs">
        <div class="range-types-section">
          <div class="section-header">
            <Select v-model="vlanOrgFilter" :options="orgOptions" optionLabel="label" optionValue="value"
                    placeholder="All Organizations" showClear class="audit-filter" @change="loadVlans" />
            <Button label="Add VLAN" icon="pi pi-plus" size="small" @click="openVlanDialog()" />
          </div>
          <DataTable :value="vlans" :loading="loadingVlans" stripedRows emptyMessage="No VLANs found." size="small">
            <Column field="vlan_id" header="VLAN ID" sortable style="width: 6rem" />
            <Column field="name" header="Name" sortable />
            <Column field="folder_name" header="Organization" sortable />
            <Column field="subnet_count" header="Subnets" style="width: 5rem">
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
              <InputNumber v-model="vlanForm.vlan_id" :min="1" :max="4094" class="w-full" />
            </div>
            <div class="field">
              <label>Name *</label>
              <InputText v-model="vlanForm.name" class="w-full" />
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
      </TabPanel>
      <TabPanel header="Subnet Calculator">
        <SubnetCalculator />
      </TabPanel>
      <TabPanel header="Audit Log">
        <div class="audit-section">
          <div class="audit-filters">
            <Select v-model="auditFilters.action" :options="auditActionOptions" optionLabel="label" optionValue="value"
                    placeholder="All Actions" showClear class="audit-filter" />
            <Select v-model="auditFilters.entity_type" :options="auditEntityOptions" optionLabel="label" optionValue="value"
                    placeholder="All Entities" showClear class="audit-filter" />
            <Button icon="pi pi-refresh" severity="secondary" text rounded @click="loadAuditLog" />
          </div>
          <DataTable :value="auditLog.items" :loading="loadingAudit" stripedRows size="small"
                     emptyMessage="No audit entries found.">
            <Column field="created_at" header="Time" style="width: 11rem">
              <template #body="{ data }">{{ formatDate(data.created_at) }}</template>
            </Column>
            <Column field="username" header="User" style="width: 8rem">
              <template #body="{ data }">{{ data.username || 'system' }}</template>
            </Column>
            <Column field="action" header="Action" style="width: 8rem">
              <template #body="{ data }">
                <span class="audit-action" :class="'action-' + data.action">{{ data.action }}</span>
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
      <TabPanel header="Backup & Restore">
        <div class="backup-section">
          <div class="setting-group">
            <h3>Manual Backup</h3>
            <p class="field-help" style="margin-bottom: 0.75rem;">Creates a backup of the database, certificates, and DNSmasq configuration.</p>
            <Button label="Create Backup Now" icon="pi pi-download" @click="doCreateBackup" :loading="creatingBackup" />
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
                       emptyMessage="No backups found.">
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
        </div>

        <!-- Delete Backup Dialog -->
        <Dialog v-model:visible="showDeleteBackupDialog" header="Delete Backup" modal :style="{ width: '24rem' }">
          <p>Delete backup <strong>{{ deletingBackup?.filename }}</strong>?</p>
          <template #footer>
            <Button label="Cancel" severity="secondary" @click="showDeleteBackupDialog = false" />
            <Button label="Delete" severity="danger" @click="doDeleteBackup" :loading="deletingBackupLoading" />
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
      </TabPanel>
      <TabPanel header="Certificates">
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
              <div class="field">
                <label>Certificate (.pem, .crt)</label>
                <textarea v-model="certUpload.cert" placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                          class="cert-textarea"></textarea>
              </div>
              <div class="field">
                <label>Private Key (.pem, .key)</label>
                <textarea v-model="certUpload.key" placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                          class="cert-textarea"></textarea>
              </div>
              <Button label="Upload Certificate" icon="pi pi-upload" @click="doUploadCert" :loading="uploadingCert"
                      :disabled="!certUpload.cert || !certUpload.key" />
            </div>
          </div>

          <div class="setting-group">
            <h3>Reset to Self-Signed</h3>
            <p class="field-help" style="margin-bottom: 0.75rem;">Generate a new self-signed certificate. Server restart required.</p>
            <Button label="Reset to Self-Signed" icon="pi pi-refresh" severity="secondary" @click="doResetCert" :loading="resettingCert" />
          </div>
        </div>
      </TabPanel>
      <TabPanel header="DNS">
        <DnsPanel />
      </TabPanel>
      <TabPanel header="DHCP">
        <DhcpPanel />
      </TabPanel>
      <TabPanel header="Blocklists">
        <BlocklistsPanel />
      </TabPanel>
      <TabPanel header="GeoIP">
        <GeoipPanel />
      </TabPanel>
      <TabPanel header="Users">
        <UsersPanel />
      </TabPanel>
    </TabView>

    <Toast />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch, defineAsyncComponent } from 'vue';
import { useToast } from 'primevue/usetoast';
import TabView from 'primevue/tabview';
import TabPanel from 'primevue/tabpanel';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import InputNumber from 'primevue/inputnumber';
import Toast from 'primevue/toast';
import SubnetCalculator from './SubnetCalculator.vue';
import { useSubnetStore } from '../stores/subnets.js';
import { useDnsStore } from '../stores/dns.js';
import { useOperationsStore } from '../stores/operations.js';
import { applyNameTemplate } from '../utils/ip.js';
import api from '../api/client.js';

const DnsPanel = defineAsyncComponent(() => import('./DNS.vue'));
const DhcpPanel = defineAsyncComponent(() => import('./DHCP.vue'));
const BlocklistsPanel = defineAsyncComponent(() => import('./Blocklists.vue'));
const GeoipPanel = defineAsyncComponent(() => import('./GeoIP.vue'));
const UsersPanel = defineAsyncComponent(() => import('./Users.vue'));

const store = useSubnetStore();
const dnsStore = useDnsStore();
const opsStore = useOperationsStore();
const toast = useToast();

// Persist active tab across refreshes
const activeTab = ref(parseInt(localStorage.getItem('ipam_system_tab') || '0', 10));
watch(activeTab, (val) => localStorage.setItem('ipam_system_tab', String(val)));

const loadingSettings = ref(true);
const savingSettings = ref(false);
const settings = ref({
  subnet_name_template: '%1.%2.%3.%4/%bitmask',
  default_gateway_position: 'first',
  default_scan_interval: ''
});
const forwarders = ref(['8.8.8.8', '1.1.1.1']);

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
    const [data, servers] = await Promise.all([
      store.getSettings(),
      dnsStore.getForwarders().catch(() => ['8.8.8.8', '1.1.1.1']),
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
    forwarders.value = servers;
  } catch { /* use defaults */ }
  loadingSettings.value = false;
});

// Range Types
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
const vlanOrgFilter = ref(null);

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
  vlanForm.value = { folder_id: vlanOrgFilter.value || (store.folders[0]?.id || null), vlan_id: null, name: '' };
  showVlanDialog.value = true;
}

function editVlan(vlan) {
  editingVlan.value = vlan;
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
const auditFilters = ref({ page: 1, limit: 50, action: null, entity_type: null });

const auditActionOptions = [
  { label: 'Create', value: 'create' },
  { label: 'Update', value: 'update' },
  { label: 'Delete', value: 'delete' },
  { label: 'Login', value: 'login' },
  { label: 'Login Failed', value: 'login_failed' },
  { label: 'Password Change', value: 'password_change' },
  { label: 'Configure', value: 'configure' },
  { label: 'Divide', value: 'divide' },
  { label: 'Merge', value: 'merge' }
];

const auditEntityOptions = [
  { label: 'Subnet', value: 'subnet' },
  { label: 'DNS Zone', value: 'dns_zone' },
  { label: 'DNS Record', value: 'dns_record' },
  { label: 'DHCP Scope', value: 'dhcp_scope' },
  { label: 'DHCP Reservation', value: 'dhcp_reservation' },
  { label: 'User', value: 'user' },
  { label: 'Range', value: 'range' },
  { label: 'Setting', value: 'setting' }
];

async function loadAuditLog() {
  loadingAudit.value = true;
  try {
    const params = { page: auditFilters.value.page, limit: auditFilters.value.limit };
    if (auditFilters.value.action) params.action = auditFilters.value.action;
    if (auditFilters.value.entity_type) params.entity_type = auditFilters.value.entity_type;
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
    const validForwarders = forwarders.value.filter(s => s.trim());
    await Promise.all([
      store.updateSetting('subnet_name_template', settings.value.subnet_name_template),
      store.updateSetting('default_gateway_position', settings.value.default_gateway_position),
      store.updateSetting('default_scan_interval', settings.value.default_scan_interval || ''),
      validForwarders.length > 0 ? dnsStore.updateForwarders(validForwarders) : Promise.resolve()
    ]);
    if (validForwarders.length > 0) {
      forwarders.value = validForwarders;
    }
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
const uploadingCert = ref(false);
const resettingCert = ref(false);

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
  padding: 1.5rem 2rem;
}
.system-page h2 {
  margin: 0 0 1.5rem 0;
}
.muted {
  color: var(--p-text-muted-color);
}
.settings-form {
  max-width: 32rem;
}
.setting-group {
  margin-bottom: 1.5rem;
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
.forwarders-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.forwarder-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
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
  background: var(--p-surface-200);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}
.badge-custom {
  font-size: 0.75rem;
  background: var(--p-primary-100);
  color: var(--p-primary-700);
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
}
.audit-filters {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}
.audit-filter {
  width: 12rem;
}
.audit-action {
  font-size: 0.75rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 600;
}
.action-create { background: #dcfce7; color: #166534; }
.action-update { background: #dbeafe; color: #1e40af; }
.action-delete { background: #fee2e2; color: #991b1b; }
.action-login { background: #e0e7ff; color: #3730a3; }
.action-login_failed { background: #fee2e2; color: #991b1b; }
.action-password_change { background: #fef3c7; color: #92400e; }
.action-configure { background: #f3e8ff; color: #6b21a8; }
.action-divide { background: #fef3c7; color: #92400e; }
.action-merge { background: #fef3c7; color: #92400e; }
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
.backup-section, .cert-section {
  max-width: 48rem;
}
.restore-warning {
  color: #991b1b;
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
.cert-textarea {
  width: 100%;
  min-height: 6rem;
  font-family: monospace;
  font-size: 0.8rem;
  padding: 0.5rem;
  border: 1px solid var(--p-surface-border);
  border-radius: 6px;
  resize: vertical;
}
.badge-warning {
  font-size: 0.75rem;
  background: #fef3c7;
  color: #92400e;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 600;
}
.badge-success {
  font-size: 0.75rem;
  background: #dcfce7;
  color: #166534;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 600;
}
</style>
