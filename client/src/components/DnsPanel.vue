<template>
  <div class="dns-panel" style="display: flex; flex-direction: column; height: 100%;">
    <div class="dns-layout">
      <!-- Zone List -->
      <div class="zone-panel">
        <Tabs v-model:value="zoneTab">
          <TabList>
            <Tab value="forward" data-track="dns-tab-forward"><i class="pi pi-globe" style="margin-right: 0.3rem" />Forward</Tab>
            <Tab value="reverse" data-track="dns-tab-reverse"><i class="pi pi-replay" style="margin-right: 0.3rem" />Reverse</Tab>
          </TabList>
          <TabPanels>
            <!-- Forward Zones Tab -->
            <TabPanel value="forward">
              <div class="zone-list" v-if="!store.loading">
                <div v-for="zone in forwardZones" :key="zone.id"
                     class="zone-item"
                     :class="{ active: selectedZone?.id === zone.id }"
                     @click="selectZone(zone)">
                  <div class="zone-info">
                    <div class="zone-name">
                      <i class="pi pi-globe" />
                      {{ zone.name }}
                    </div>
                    <div class="zone-meta">
                      <span v-if="zone.folder_name" class="folder-badge">{{ zone.folder_name }}</span>
                      <span class="record-count">{{ zone.record_count }} records</span>
                      <span v-if="!zone.enabled" class="badge-disabled">disabled</span>
                    </div>
                  </div>
                  <div class="zone-actions">
                    <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                            @click.stop="openZoneDialog(zone)" />
                    <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                            @click.stop="confirmDeleteZone(zone)" />
                  </div>
                </div>
                <div v-if="forwardZones.length === 0" class="empty-state">
                  No forward zones configured.
                </div>
              </div>
              <div v-else class="loading-state">
                <i class="pi pi-spin pi-spinner" /> Loading zones...
              </div>
            </TabPanel>

            <!-- Reverse Zones Tab -->
            <TabPanel value="reverse">
              <div class="zone-list" v-if="!store.loading">
                <template v-for="entry in groupedReverseZones" :key="entry.key">
                  <!-- Standalone reverse zone -->
                  <div v-if="!entry.isGroup" class="zone-item"
                       :class="{ active: selectedZone?.id === entry.zone.id }"
                       @click="selectZone(entry.zone)">
                    <div class="zone-info">
                      <div class="zone-name">
                        <i class="pi pi-replay" />
                        {{ entry.zone.name }}
                      </div>
                      <div class="zone-meta">
                        <span class="record-count">{{ entry.zone.record_count }} records</span>
                        <span v-if="!entry.zone.enabled" class="badge-disabled">disabled</span>
                      </div>
                    </div>
                    <div class="zone-actions">
                      <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                              @click.stop="openZoneDialog(entry.zone)" />
                      <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                              @click.stop="confirmDeleteZone(entry.zone)" />
                    </div>
                  </div>
                  <!-- Grouped reverse zones -->
                  <template v-else>
                    <div class="zone-group-header" @click="toggleGroup(entry.key)">
                      <i class="pi" :class="expandedGroups[entry.key] ? 'pi-chevron-down' : 'pi-chevron-right'" style="font-size: 0.6rem" />
                      <i class="pi pi-replay" />
                      <span>{{ entry.description }}</span>
                      <span class="record-count">{{ entry.zones.length }} zones</span>
                    </div>
                    <template v-if="expandedGroups[entry.key]">
                      <div v-for="zone in entry.zones" :key="zone.id"
                           class="zone-item zone-child"
                           :class="{ active: selectedZone?.id === zone.id }"
                           @click="selectZone(zone)">
                        <div class="zone-info">
                          <div class="zone-name">
                            <i class="pi pi-replay" />
                            {{ zone.name }}
                          </div>
                          <div class="zone-meta">
                            <span class="record-count">{{ zone.record_count }} records</span>
                            <span v-if="!zone.enabled" class="badge-disabled">disabled</span>
                          </div>
                        </div>
                        <div class="zone-actions">
                          <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                                  @click.stop="openZoneDialog(zone)" />
                          <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                                  @click.stop="confirmDeleteZone(zone)" />
                        </div>
                      </div>
                    </template>
                  </template>
                </template>
                <div v-if="groupedReverseZones.length === 0" class="empty-state">
                  No reverse zones configured.
                </div>
              </div>
              <div v-else class="loading-state">
                <i class="pi pi-spin pi-spinner" /> Loading zones...
              </div>
            </TabPanel>
          </TabPanels>
        </Tabs>
      </div>

      <!-- Records Panel -->
      <div class="records-panel">
        <div class="dns-toolbar">
          <Button label="Add Zone" icon="pi pi-plus" size="small" text data-track="dns-add-zone" @click="openZoneDialog()" />
          <template v-if="selectedZone">
            <span class="toolbar-divider"></span>
            <Button label="Add Record" icon="pi pi-plus" size="small" text data-track="dns-add-record" @click="openRecordDialog()" />
          </template>
        </div>
        <template v-if="selectedZone">
          <div class="panel-header">
            <h3>{{ selectedZone.name }} — Records</h3>
          </div>

          <DataTable :key="'records-' + selectedZone?.type" :value="records" :loading="loadingRecords" stripedRows
                     emptyMessage="No records in this zone." size="small"
                     :sortField="selectedZone?.type === 'reverse' ? 'name' : 'value'" :sortOrder="1"
                     :paginator="records.length > 256" :rows="256"
                     :rowsPerPageOptions="[64, 128, 256, 512]"
                     v-model:filters="dnsFilters" filterDisplay="row"
                     scrollable scrollHeight="flex">
            <Column field="name" :header="isReverse ? 'Name' : 'Name'" sortable style="min-width: 8rem" :showFilterMenu="false">
              <template #filter="{ filterModel, filterCallback }">
                <InputText v-model="filterModel.value" @input="filterCallback()" placeholder="Filter" size="small" style="max-width: 10rem" />
              </template>
              <template #body="{ data }">
                {{ isReverse ? `${data.name}.${selectedZone.name}` : data.name }}
              </template>
            </Column>
            <Column field="type" header="Type" sortable style="width: 7rem" :showFilterMenu="false" v-if="!isReverse">
              <template #filter="{ filterModel, filterCallback }">
                <Select v-model="filterModel.value" @change="filterCallback()" :options="allRecordTypes" placeholder="All" size="small" showClear style="max-width: 6rem" />
              </template>
              <template #body="{ data }">
                <span class="type-badge">{{ data.type }}</span>
              </template>
            </Column>
            <Column field="value" :header="isReverse ? 'Hostname' : 'Value'" sortable style="min-width: 10rem" :showFilterMenu="false">
              <template #filter="{ filterModel, filterCallback }">
                <InputText v-model="filterModel.value" @input="filterCallback()" placeholder="Filter" size="small" style="max-width: 10rem" />
              </template>
            </Column>
            <Column header="Priority" style="width: 5rem" v-if="!isReverse">
              <template #body="{ data }">{{ data.priority ?? '—' }}</template>
            </Column>
            <Column header="Port" style="width: 4rem" v-if="!isReverse">
              <template #body="{ data }">{{ data.port ?? '—' }}</template>
            </Column>
            <Column header="TTL" style="width: 4rem">
              <template #body="{ data }">{{ data.ttl ?? '—' }}</template>
            </Column>
            <Column header="Enabled" style="width: 5rem">
              <template #body="{ data }">
                <span :class="data.enabled ? 'badge-enabled' : 'badge-disabled'">
                  {{ data.enabled ? 'Yes' : 'No' }}
                </span>
              </template>
            </Column>
            <Column header="Source" style="width: 5rem">
              <template #body="{ data }">
                <Tag v-if="data.source === 'dhcp'" value="DHCP" severity="warn" />
                <Tag v-else value="Manual" severity="secondary" />
              </template>
            </Column>
            <Column header="" style="width: 5rem" v-if="!isReverse">
              <template #body="{ data }">
                <div class="action-buttons" v-if="data.source !== 'dhcp'">
                  <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                          @click="openRecordDialog(data)" />
                  <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                          @click="confirmDeleteRecord(data)" />
                </div>
              </template>
            </Column>
          </DataTable>
        </template>
        <div v-else class="empty-state centered">
          <i class="pi pi-arrow-left" style="font-size: 2rem; opacity: 0.3;" />
          <p>Select a zone to view its records</p>
        </div>
      </div>
    </div>

    <!-- Zone Dialog -->
    <Dialog v-model:visible="showZoneDialog" :header="editingZone ? 'Edit Zone' : 'Add Zone'"
            modal :style="{ width: '32rem' }" data-track="dialog-dns-zone">
      <div class="form-grid">
        <div class="field">
          <label>Zone Name *</label>
          <InputText v-model="zoneForm.name" class="w-full" placeholder="e.g. example.com" />
        </div>
        <div class="field" v-if="!editingZone">
          <label>Type *</label>
          <Select v-model="zoneForm.type" :options="zoneTypes" optionLabel="label" optionValue="value"
                    class="w-full" />
        </div>
        <div class="field">
          <label>Organization *</label>
          <Select v-model="zoneForm.folder_id" :options="folders" optionLabel="name" optionValue="id"
                    class="w-full" placeholder="Select organization" />
        </div>
        <div class="field">
          <label>Description</label>
          <InputText v-model="zoneForm.description" class="w-full" />
        </div>
        <div class="field" v-if="editingZone">
          <label>Enabled</label>
          <ToggleSwitch v-model="zoneForm.enabled" />
        </div>

        <!-- SOA Fields -->
        <div class="soa-section">
          <h4>SOA Record</h4>
          <div class="field">
            <label>Primary Nameserver</label>
            <InputText v-model="zoneForm.soa_primary_ns" class="w-full" placeholder="ns1.example.com" />
          </div>
          <div class="field">
            <label>Admin Email</label>
            <InputText v-model="zoneForm.soa_admin_email" class="w-full" placeholder="admin.example.com" />
            <small class="field-help">Use dotted notation (admin.example.com = admin@example.com)</small>
          </div>
          <div class="soa-grid">
            <div class="field">
              <label>Refresh (s)</label>
              <InputNumber v-model="zoneForm.soa_refresh" class="w-full" :min="0" />
            </div>
            <div class="field">
              <label>Retry (s)</label>
              <InputNumber v-model="zoneForm.soa_retry" class="w-full" :min="0" />
            </div>
            <div class="field">
              <label>Expire (s)</label>
              <InputNumber v-model="zoneForm.soa_expire" class="w-full" :min="0" />
            </div>
            <div class="field">
              <label>Minimum TTL (s)</label>
              <InputNumber v-model="zoneForm.soa_minimum_ttl" class="w-full" :min="0" />
            </div>
          </div>
          <div v-if="editingZone" class="field">
            <label>Serial</label>
            <span class="soa-serial">{{ editingZone.soa_serial || 1 }}</span>
            <small class="field-help">Auto-incremented on changes</small>
          </div>
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showZoneDialog = false" />
        <Button :label="editingZone ? 'Save' : 'Create'" @click="saveZone" :loading="savingZone" />
      </template>
    </Dialog>

    <!-- Record Dialog -->
    <Dialog v-model:visible="showRecordDialog" :header="editingRecord ? 'Edit Record' : 'Add Record'"
            modal :style="{ width: '28rem' }" data-track="dialog-dns-record">
      <div class="form-grid">
        <div v-if="recordForm.type === 'PTR' && selectedZone" class="field ptr-preview">
          <label>Record Name</label>
          <span class="ptr-preview-value">{{ recordForm.name ? `${recordForm.name}.${selectedZone.name}` : selectedZone.name }}</span>
        </div>
        <div class="field">
          <label>{{ recordForm.type === 'PTR' ? 'Last Octet *' : 'Name *' }}</label>
          <InputText v-model="recordForm.name" class="w-full"
                     :placeholder="recordForm.type === 'PTR' ? 'e.g. 5' : 'e.g. www or @'" />
          <small v-if="recordForm.type === 'PTR'" class="field-help">Host portion of the IP address</small>
        </div>
        <div class="field" v-if="!isReverse">
          <label>Type *</label>
          <Select v-model="recordForm.type" :options="availableRecordTypes" class="w-full" :disabled="!!editingRecord" />
        </div>
        <div class="field">
          <label>{{ recordForm.type === 'PTR' ? 'Hostname *' : 'Value *' }}</label>
          <InputText v-model="recordForm.value" class="w-full" :placeholder="valuePlaceholder" />
          <small v-if="recordForm.type === 'PTR'" class="field-help">The FQDN this IP resolves to (e.g., web.example.com)</small>
        </div>
        <div class="field" v-if="['MX', 'SRV'].includes(recordForm.type)">
          <label>Priority *</label>
          <InputNumber v-model="recordForm.priority" class="w-full" :min="0" :max="65535" />
        </div>
        <div class="field" v-if="recordForm.type === 'SRV'">
          <label>Weight</label>
          <InputNumber v-model="recordForm.weight" class="w-full" :min="0" :max="65535" />
        </div>
        <div class="field" v-if="recordForm.type === 'SRV'">
          <label>Port *</label>
          <InputNumber v-model="recordForm.port" class="w-full" :min="0" :max="65535" />
        </div>
        <div class="field">
          <label>TTL (seconds)</label>
          <InputNumber v-model="recordForm.ttl" class="w-full" :min="0" placeholder="Default" />
          <small class="field-help">Leave empty to use zone default</small>
        </div>
        <div class="field">
          <label>Enabled</label>
          <ToggleSwitch v-model="recordForm.enabled" />
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showRecordDialog = false" />
        <Button :label="editingRecord ? 'Save' : 'Create'" @click="saveRecord" :loading="savingRecord" />
      </template>
    </Dialog>

    <!-- Delete Zone Dialog -->
    <Dialog v-model:visible="showDeleteZoneDialog" header="Delete Zone" modal :style="{ width: '28rem' }" data-track="dialog-dns-delete-zone"
            @hide="zoneDeleteConfirmText = ''">
      <p>Delete zone <strong>{{ deletingZone?.name }}</strong>?</p>
      <template v-if="deletingZone?.record_count > 0">
        <p class="warn-text">
          This will permanently delete {{ deletingZone.record_count }} DNS record(s).
        </p>
        <p class="warn-text" style="margin-top: 0.5rem;">Type <strong>DELETE</strong> to confirm:</p>
        <InputText v-model="zoneDeleteConfirmText" placeholder="DELETE" style="width: 100%" />
      </template>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteZoneDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteZone" :loading="savingZone"
                :disabled="deletingZone?.record_count > 0 && zoneDeleteConfirmText !== 'DELETE'" />
      </template>
    </Dialog>

    <!-- Delete Record Dialog -->
    <Dialog v-model:visible="showDeleteRecordDialog" header="Delete Record" modal :style="{ width: '24rem' }" data-track="dialog-dns-delete-record">
      <p>Delete {{ deletingRecord?.type }} record <strong>{{ deletingRecord?.name }}</strong>?</p>
      <template #footer>
        <Button label="Cancel" severity="secondary" @click="showDeleteRecordDialog = false" />
        <Button label="Delete" severity="danger" @click="doDeleteRecord" :loading="savingRecord" />
      </template>
    </Dialog>

    <Toast />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useToast } from 'primevue/usetoast';
import { FilterMatchMode } from '@primevue/core/api';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Tag from 'primevue/tag';
import Toast from 'primevue/toast';
import { useDnsStore } from '../stores/dns.js';
import api from '../api/client.js';

const props = defineProps({
  orgId: { type: [Number, null], default: null }
});

const store = useDnsStore();
const toast = useToast();
const folders = ref([]);

// Persistence helper
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

// Zone state
const selectedZone = ref(null);
const isReverse = computed(() => selectedZone.value?.type === 'reverse');
const records = ref([]);
const loadingRecords = ref(false);
const expandedGroups = ref({});
const zoneTab = ref(loadJson('ipam_dns_zone_tab', 'forward'));

// Filtered zones by org
function filterByOrg(zones) {
  if (props.orgId == null) return zones;
  return zones.filter(z => z.folder_id === props.orgId);
}

// Forward zones (simple list)
const forwardZones = computed(() =>
  filterByOrg(store.zones.filter(z => z.type === 'forward')).sort((a, b) => a.name.localeCompare(b.name))
);

// Group reverse zones that share a subnet_id (multiple /24 zones for one supernet)
const groupedReverseZones = computed(() => {
  const result = [];
  const bySubnet = new Map();
  const reverseZones = filterByOrg(store.zones.filter(z => z.type === 'reverse')).sort((a, b) => {
    const octetsA = a.name.replace('.in-addr.arpa', '').split('.').reverse().map(Number);
    const octetsB = b.name.replace('.in-addr.arpa', '').split('.').reverse().map(Number);
    for (let i = 0; i < Math.max(octetsA.length, octetsB.length); i++) {
      const diff = (octetsA[i] || 0) - (octetsB[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });

  for (const zone of reverseZones) {
    if (zone.subnet_id) {
      if (!bySubnet.has(zone.subnet_id)) bySubnet.set(zone.subnet_id, []);
      bySubnet.get(zone.subnet_id).push(zone);
    }
  }

  const grouped = new Set();
  for (const zone of reverseZones) {
    if (grouped.has(zone.id)) continue;

    if (zone.subnet_id && bySubnet.get(zone.subnet_id).length > 1) {
      const zones = bySubnet.get(zone.subnet_id);
      zones.forEach(z => grouped.add(z.id));
      result.push({
        isGroup: true,
        key: `subnet-${zone.subnet_id}`,
        description: zones[0].description?.replace(/^Reverse zone for /, '') || `Subnet ${zone.subnet_id}`,
        zones
      });
    } else {
      result.push({ isGroup: false, key: `zone-${zone.id}`, zone });
    }
  }
  return result;
});

function toggleGroup(key) {
  expandedGroups.value = { ...expandedGroups.value, [key]: !expandedGroups.value[key] };
}

// Zone dialog
const showZoneDialog = ref(false);
const editingZone = ref(null);
const savingZone = ref(false);
const zoneForm = ref({
  name: '', type: 'forward', folder_id: null, description: '', enabled: true,
  soa_primary_ns: 'ns1.localhost', soa_admin_email: 'admin.localhost',
  soa_refresh: 3600, soa_retry: 900, soa_expire: 604800, soa_minimum_ttl: 86400
});
const zoneTypes = [
  { label: 'Forward', value: 'forward' },
  { label: 'Reverse', value: 'reverse' }
];

// Record dialog
const showRecordDialog = ref(false);
const editingRecord = ref(null);
const savingRecord = ref(false);
const recordForm = ref({ name: '', type: 'A', value: '', priority: null, weight: null, port: null, ttl: null, enabled: true });
const allRecordTypes = ['A', 'CNAME', 'MX', 'TXT', 'SRV', 'PTR'];

const dnsFilters = ref({
  name: { value: null, matchMode: FilterMatchMode.CONTAINS },
  type: { value: null, matchMode: FilterMatchMode.EQUALS },
  value: { value: null, matchMode: FilterMatchMode.CONTAINS },
});
const availableRecordTypes = computed(() => {
  if (selectedZone.value?.type === 'reverse') return ['PTR'];
  return allRecordTypes;
});

// Delete dialogs
const showDeleteZoneDialog = ref(false);
const deletingZone = ref(null);
const zoneDeleteConfirmText = ref('');
const showDeleteRecordDialog = ref(false);
const deletingRecord = ref(null);

const valuePlaceholder = computed(() => {
  switch (recordForm.value.type) {
    case 'A': return '192.168.1.10';
    case 'CNAME': return 'target.example.com';
    case 'MX': return 'mail.example.com';
    case 'TXT': return 'v=spf1 include:...';
    case 'SRV': return 'server.example.com';
    case 'PTR': return 'host.example.com';
    default: return '';
  }
});

// Persist zone tab selection
watch(zoneTab, (val) => {
  try { localStorage.setItem('ipam_dns_zone_tab', JSON.stringify(val)); } catch {}
});

// Clear selection if org filter changes and selected zone is no longer visible
watch(() => props.orgId, () => {
  if (selectedZone.value) {
    const allFiltered = [...forwardZones.value, ...groupedReverseZones.value.flatMap(e => e.isGroup ? e.zones : [e.zone])];
    if (!allFiltered.find(z => z.id === selectedZone.value.id)) {
      selectedZone.value = null;
      records.value = [];
    }
  }
});

async function selectZone(zone) {
  selectedZone.value = zone;
  try { localStorage.setItem('ipam_dns_selected_zone_id', JSON.stringify(zone?.id || null)); } catch {}
  loadingRecords.value = true;
  try {
    const fetched = await store.getRecords(zone.id);
    if (zone.type === 'reverse') {
      fetched.sort((a, b) => (a.value || '').localeCompare(b.value || '', undefined, { numeric: true }));
    }
    records.value = fetched;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    loadingRecords.value = false;
  }
}

// Zone CRUD
function openZoneDialog(zone = null) {
  editingZone.value = zone;
  if (zone) {
    zoneForm.value = {
      name: zone.name, type: zone.type, folder_id: zone.folder_id || null,
      description: zone.description || '', enabled: !!zone.enabled,
      soa_primary_ns: zone.soa_primary_ns || 'ns1.localhost',
      soa_admin_email: zone.soa_admin_email || 'admin.localhost',
      soa_refresh: zone.soa_refresh ?? 3600, soa_retry: zone.soa_retry ?? 900,
      soa_expire: zone.soa_expire ?? 604800, soa_minimum_ttl: zone.soa_minimum_ttl ?? 86400
    };
  } else {
    zoneForm.value = {
      name: '', type: zoneTab.value || 'forward',
      folder_id: folders.value.length === 1 ? folders.value[0].id : null,
      description: '', enabled: true,
      soa_primary_ns: 'ns1.localhost', soa_admin_email: 'admin.localhost',
      soa_refresh: 3600, soa_retry: 900, soa_expire: 604800, soa_minimum_ttl: 86400
    };
  }
  showZoneDialog.value = true;
}

async function saveZone() {
  savingZone.value = true;
  try {
    if (editingZone.value) {
      await store.updateZone(editingZone.value.id, zoneForm.value);
      toast.add({ severity: 'success', summary: 'Zone updated', life: 3000 });
      if (selectedZone.value?.id === editingZone.value.id) {
        selectedZone.value = store.zones.find(z => z.id === editingZone.value.id) || null;
      }
    } else {
      const zone = await store.createZone(zoneForm.value);
      toast.add({ severity: 'success', summary: 'Zone created', life: 3000 });
      selectZone(store.zones.find(z => z.id === zone.id) || zone);
    }
    showZoneDialog.value = false;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingZone.value = false;
  }
}

function confirmDeleteZone(zone) {
  deletingZone.value = zone;
  showDeleteZoneDialog.value = true;
}

async function doDeleteZone() {
  savingZone.value = true;
  try {
    await store.deleteZone(deletingZone.value.id);
    if (selectedZone.value?.id === deletingZone.value.id) {
      selectedZone.value = null;
      records.value = [];
    }
    showDeleteZoneDialog.value = false;
    toast.add({ severity: 'success', summary: 'Zone deleted', life: 3000 });
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingZone.value = false;
  }
}

// Record CRUD
function openRecordDialog(record = null) {
  editingRecord.value = record;
  if (record) {
    recordForm.value = {
      name: record.name, type: record.type, value: record.value,
      priority: record.priority, weight: record.weight, port: record.port,
      ttl: record.ttl, enabled: !!record.enabled
    };
  } else {
    const defaultType = selectedZone.value?.type === 'reverse' ? 'PTR' : 'A';
    recordForm.value = { name: '', type: defaultType, value: '', priority: null, weight: null, port: null, ttl: null, enabled: true };
  }
  showRecordDialog.value = true;
}

async function saveRecord() {
  savingRecord.value = true;
  try {
    if (editingRecord.value) {
      await store.updateRecord(selectedZone.value.id, editingRecord.value.id, recordForm.value);
      toast.add({ severity: 'success', summary: 'Record updated', life: 3000 });
    } else {
      await store.createRecord(selectedZone.value.id, recordForm.value);
      toast.add({ severity: 'success', summary: 'Record created', life: 3000 });
    }
    showRecordDialog.value = false;
    records.value = await store.getRecords(selectedZone.value.id);
    await store.fetchZones(); // refresh record counts
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingRecord.value = false;
  }
}

function confirmDeleteRecord(record) {
  deletingRecord.value = record;
  showDeleteRecordDialog.value = true;
}

async function doDeleteRecord() {
  savingRecord.value = true;
  try {
    await store.deleteRecord(selectedZone.value.id, deletingRecord.value.id);
    showDeleteRecordDialog.value = false;
    toast.add({ severity: 'success', summary: 'Record deleted', life: 3000 });
    records.value = await store.getRecords(selectedZone.value.id);
    await store.fetchZones();
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: err.response?.data?.error || err.message, life: 5000 });
  } finally {
    savingRecord.value = false;
  }
}

onMounted(async () => {
  await Promise.all([
    store.fetchZones(),
    api.get('/folders').then(r => folders.value = r.data).catch(() => {})
  ]);
  // Restore previously selected zone
  const savedZoneId = loadJson('ipam_dns_selected_zone_id', null);
  if (savedZoneId) {
    const zone = store.zones.find(z => z.id === savedZoneId);
    if (zone) {
      zoneTab.value = zone.type === 'reverse' ? 'reverse' : 'forward';
      // Auto-expand the group containing this reverse zone
      if (zone.type === 'reverse') {
        for (const entry of groupedReverseZones.value) {
          if (entry.isGroup && entry.zones.some(z => z.id === savedZoneId)) {
            expandedGroups.value = { ...expandedGroups.value, [entry.key]: true };
            break;
          }
        }
      }
      selectZone(zone);
    }
  }
});

defineExpose({ openZoneDialog });
</script>

<style scoped>
.dns-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 1.5rem;
  flex: 1;
  min-height: 0;
}

.zone-panel {
  background: var(--p-content-background);
  border: 1px solid var(--p-surface-border);
  border-radius: 8px;
  overflow: hidden;
  color: var(--p-text-color);
}
.zone-panel :deep(.p-tabpanels) {
  padding: 0;
}
.zone-panel :deep(.p-tablist) {
  background: var(--p-surface-ground);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--p-surface-border);
  background: var(--p-surface-ground);
  color: var(--p-text-color);
}
.panel-header h3 { margin: 0; font-size: 0.9rem; color: var(--p-text-color); }

.zone-list { max-height: 500px; overflow-y: auto; }

.zone-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.6rem 1rem;
  cursor: pointer;
  border-bottom: 1px solid var(--p-surface-border);
  transition: background 0.15s;
}
.zone-item:hover { background: var(--p-highlight-background); }
.zone-item.active { background: var(--p-highlight-background); border-left: 3px solid var(--p-primary-color); }

.zone-info { flex: 1; min-width: 0; }
.zone-name {
  font-weight: 600;
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--p-text-color);
}
.zone-meta { display: flex; gap: 0.4rem; margin-top: 0.2rem; align-items: center; }

.record-count { font-size: 0.75rem; color: var(--p-surface-500); }
.folder-badge {
  font-size: 0.65rem;
  background: color-mix(in srgb, var(--p-primary-color) 15%, transparent);
  color: var(--p-primary-color);
  padding: 0.05rem 0.35rem;
  border-radius: 3px;
  white-space: nowrap;
}

.zone-actions { display: flex; gap: 0.15rem; flex-shrink: 0; }

.records-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.dns-toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  background: var(--ipam-card);
  border-bottom: 1px solid var(--p-surface-border);
  flex-shrink: 0;
}
.dns-toolbar .toolbar-divider {
  width: 1px;
  height: 1.2rem;
  background: var(--p-surface-border);
}

.type-badge {
  font-size: 0.75rem;
  font-weight: 600;
  background: var(--p-surface-ground);
  color: var(--p-text-color);
  padding: 0.15rem 0.4rem;
  border-radius: 3px;
  font-family: monospace;
}

.badge-enabled { font-size: 0.75rem; color: var(--p-green-500); }
.badge-disabled { font-size: 0.75rem; color: var(--p-red-500); background: color-mix(in srgb, var(--p-red-500) 15%, transparent); padding: 0.1rem 0.4rem; border-radius: 3px; }

.action-buttons { display: flex; gap: 0.25rem; }

.empty-state {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--p-surface-400);
  font-size: 0.9rem;
}
.empty-state.centered {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 4rem 2rem;
}
.loading-state {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--p-surface-400);
}

.form-grid {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.field label {
  display: block;
  margin-bottom: 0.35rem;
  font-size: 0.85rem;
  font-weight: 600;
}

.soa-section {
  border-top: 1px solid var(--p-surface-border);
  padding-top: 0.75rem;
  margin-top: 0.25rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.soa-section h4 {
  margin: 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color);
  text-transform: uppercase;
}
.soa-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
}
.soa-serial {
  font-family: monospace;
  font-weight: 600;
  font-size: 0.9rem;
}
.field-help {
  display: block;
  margin-top: 0.4rem;
  font-size: 0.75rem;
  color: var(--p-text-muted-color);
}

.zone-group-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--p-text-color);
  background: var(--p-surface-ground);
  border-bottom: 1px solid var(--p-surface-border);
  transition: background 0.15s;
}
.zone-group-header:hover {
  background: color-mix(in srgb, var(--p-surface-ground) 80%, var(--p-highlight-background));
}
.zone-group-header .record-count {
  margin-left: auto;
}

.zone-child {
  padding-left: 2rem;
}

.warn-text {
  color: var(--p-red-500);
  font-weight: 500;
}

.ptr-preview {
  background: var(--p-surface-ground);
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  border: 1px solid var(--p-surface-border);
}
.ptr-preview-value {
  font-family: monospace;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--p-text-color);
}

@media (max-width: 900px) {
  .dns-layout {
    grid-template-columns: 1fr;
  }
}
</style>
