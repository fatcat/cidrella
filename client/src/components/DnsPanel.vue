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
              <div class="sidebar-search">
                <i class="pi pi-search search-icon"></i>
                <input type="text" v-model="zoneFilterText" placeholder="Filter zones..." class="sidebar-filter" data-track="dns-sidebar-filter" />
              </div>
              <div class="zone-list" v-if="!store.loading">
                <div v-for="zone in filteredForwardZones" :key="zone.id"
                     class="zone-item"
                     :class="{ active: selectedZone?.id === zone.id }"
                     @click="selectZone(zone)">
                  <div class="zone-info">
                    <div class="zone-name">
                      <i class="pi pi-globe" />
                      {{ zone.name }}
                    </div>
                    <div class="zone-meta">
                      <span class="record-count">{{ zone.record_count }} records</span>
                      <span v-if="!zone.enabled" class="badge-sm badge-red-light">disabled</span>
                    </div>
                  </div>
                  <div class="zone-actions">
                    <Button icon="pi pi-pencil" severity="secondary" text rounded size="small"
                            @click.stop="openZoneDialog(zone)" />
                    <Button icon="pi pi-trash" severity="danger" text rounded size="small"
                            @click.stop="confirmDeleteZone(zone)" />
                  </div>
                </div>
                <div v-if="filteredForwardZones.length === 0" class="empty-state">
                  No forward zones configured.
                </div>
              </div>
              <div v-else class="loading-state">
                <i class="pi pi-spin pi-spinner" /> Loading zones...
              </div>
            </TabPanel>

            <!-- Reverse Zones Tab -->
            <TabPanel value="reverse">
              <div class="sidebar-search">
                <i class="pi pi-search search-icon"></i>
                <input type="text" v-model="zoneFilterText" placeholder="Filter zones..." class="sidebar-filter" data-track="dns-sidebar-filter-reverse" />
              </div>
              <div class="zone-list" v-if="!store.loading">
                <template v-for="entry in filteredGroupedReverseZones" :key="entry.key">
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
                        <span v-if="!entry.zone.enabled" class="badge-sm badge-red-light">disabled</span>
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
                            <span v-if="!zone.enabled" class="badge-sm badge-red-light">disabled</span>
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
                <div v-if="filteredGroupedReverseZones.length === 0" class="empty-state">
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
          <div class="info-bar">
            <span class="info-bar-name">{{ selectedZone.name }}</span>
            <span class="info-bar-sep"></span>
            <span class="info-bar-pair"><span class="info-bar-label">Type</span> <span class="info-bar-val">{{ selectedZone.type }}</span></span>
            <span class="info-bar-sep"></span>
            <span class="info-bar-pair"><span class="info-bar-label">Records</span> <span class="info-bar-val">{{ selectedZone.record_count ?? 0 }}</span></span>
            <span class="info-bar-sep"></span>
            <span class="info-bar-pair"><span class="info-bar-label">Status</span> <span class="info-bar-val">{{ selectedZone.enabled ? 'enabled' : 'disabled' }}</span></span>
          </div>

          <div class="search-bar">
            <IconField>
              <InputIcon class="pi pi-search" />
              <InputText v-model="dnsSearch" placeholder="Search by name, type, value…" size="small" class="search-input" />
            </IconField>
            <Button v-if="dnsSearch" icon="pi pi-times" severity="secondary" text rounded size="small" @click="dnsSearch = ''" />
            <ColumnChooserButton
              tableName="DNS"
              :allColumns="dnsTableColumns"
              :visibleColumns="visibleDnsColumns"
              @update:visibleColumns="setVisibleDnsColumns"
              @reset="resetDnsColumns"
            />
          </div>

          <DataTable :key="'records-' + selectedZone?.type" :value="filteredRecords" :loading="loadingRecords" stripedRows
                     size="small"
                     scrollable scrollHeight="flex"
                     :sortField="selectedZone?.type === 'reverse' ? 'name' : 'value'" :sortOrder="1"
                     removableSort
                     paginator :rows="dnsRows" paginatorPosition="bottom"
                     :rowsPerPageOptions="[50, 100, 250, 500]"
                     @page="onDnsPage"
                     @row-dblclick="onRecordDoubleClick"
                     @row-contextmenu="onRecordRightClick"
                     :contextMenu="true">
            <template #empty>
              <EmptyState icon="pi-book" title="No records in this zone" description="Add A, CNAME, MX, TXT, or SRV records to serve them for this zone." />
            </template>
            <Column
              v-for="col in visibleDnsColumns"
              :key="col.key"
              :field="col.field"
              :sortable="col.sortable"
              :sortField="col.sortField || col.field"
              :style="col.style"
            >
              <template #header>
                <ColumnHeaderTooltip :column="col" />
              </template>
              <template #body="{ data }">
                <template v-if="col.key === 'hostname'">{{ displayDnsName(data) }}</template>
                <template v-else-if="col.key === 'ptr_hostname'">{{ displayCell(data.value) }}</template>
                <span v-else-if="col.key === 'ip_address' && data.value" class="ip-mono">{{ displayCell(ptrRecordIp(data)) }}</span>
                <span v-else-if="col.key === 'ip_address'" class="cell-muted">—</span>
                <span v-else-if="col.key === 'name'" class="ip-mono cell-muted">{{ data.name }}.{{ selectedZone.name }}</span>
                <span v-else-if="col.key === 'record_type'" class="type-badge">{{ data.record_type }}</span>
                <span v-else-if="col.key === 'value' && data.record_type === 'A'" class="ip-mono">{{ displayCell(data.value) }}</span>
                <template v-else-if="col.key === 'value'">{{ displayCell(data.value) }}</template>
                <template v-else-if="col.key === 'priority'">{{ data.priority ?? EMPTY_CELL }}</template>
                <template v-else-if="col.key === 'port'">{{ data.port ?? EMPTY_CELL }}</template>
                <template v-else-if="col.key === 'ttl'">
                  <template v-if="data.ttl != null">{{ data.ttl }}</template>
                  <span v-else class="cell-muted">{{ selectedZone?.soa_minimum_ttl ?? EMPTY_CELL }}</span>
                </template>
                <StatusText
                  v-else-if="col.key === 'enabled'"
                  :label="data.enabled ? 'Yes' : 'No'"
                  :className="data.enabled ? 'state-ok' : 'state-muted'"
                />
                <span v-else-if="col.key === 'source'" class="type-badge">{{ dnsSourceLabel(data.dns_source) }}</span>
                <template v-else-if="col.key === 'online'">
                  <OnlineStatusCell
                    v-if="data.record_type === 'A' && data.is_online !== null && data.is_online !== undefined"
                    :value="data.is_online"
                  />
                  <span v-else class="cell-muted">—</span>
                </template>
              </template>
            </Column>
          </DataTable>
          <ContextMenu ref="recordContextMenu" :model="recordContextMenuItems" />
        </template>
        <EmptyState v-else-if="store.zones.length === 0"
          icon="pi-globe"
          title="No DNS zones yet"
          description="Add a forward or reverse zone to start managing DNS records for your networks."
          :actions="[
            { label: 'Add Zone', icon: 'pi-plus', severity: 'primary', dataTrack: 'empty-add-zone', onClick: () => openZoneDialog() }
          ]" />
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
              <label>Refresh (s) <span v-tooltip.top="'How often secondaries check for zone updates'" class="soa-help">?</span></label>
              <InputNumber v-model="zoneForm.soa_refresh" class="w-full" :min="0" />
            </div>
            <div class="field">
              <label>Retry (s) <span v-tooltip.top="'How long secondaries wait before retrying a failed refresh'" class="soa-help">?</span></label>
              <InputNumber v-model="zoneForm.soa_retry" class="w-full" :min="0" />
            </div>
            <div class="field">
              <label>Expire (s) <span v-tooltip.top="'How long secondaries serve the zone without a successful refresh'" class="soa-help">?</span></label>
              <InputNumber v-model="zoneForm.soa_expire" class="w-full" :min="0" />
            </div>
            <div class="field">
              <label>Minimum TTL (s) <span v-tooltip.top="'Default negative-cache TTL: how long resolvers cache NXDOMAIN responses'" class="soa-help">?</span></label>
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
      <p>Delete {{ deletingRecord?.record_type }} record <strong>{{ deletingRecord?.name }}</strong>?</p>
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
import { useToast } from '../ui/useToast.js';
import Button from '../ui/Button.js';
import DataTable from '../ui/DataTable.js';
import Column from '../ui/Column.js';
import Dialog from '../ui/Dialog.js';
import InputText from '../ui/InputText.js';
import InputNumber from '../ui/InputNumber.js';
import IconField from '../ui/IconField.js';
import InputIcon from '../ui/InputIcon.js';
import Select from '../ui/Select.js';
import ToggleSwitch from '../ui/ToggleSwitch.js';
import Tabs from '../ui/Tabs.js';
import TabList from '../ui/TabList.js';
import Tab from '../ui/Tab.js';
import TabPanels from '../ui/TabPanels.js';
import TabPanel from '../ui/TabPanel.js';

import ContextMenu from '../ui/ContextMenu.js';
import Toast from '../ui/Toast.js';
import { useDnsStore } from '../stores/dns.js';
import { useDhcpStore } from '../stores/dhcp.js';
import { apiError, displayCell, displayHostnameCell, EMPTY_CELL } from '../utils/format.js';
import { ipToLong, isValidIpv4 } from '../utils/ip.js';
import { isEditableDnsRecord, managedDnsRecordMenuItem } from '../utils/rowContextMenu.js';
import { loadJson, saveJson } from '../utils/storage.js';
import EmptyState from './EmptyState.vue';
import ColumnChooserButton from './table/ColumnChooserButton.vue';
import ColumnHeaderTooltip from './table/ColumnHeaderTooltip.vue';
import OnlineStatusCell from './table/OnlineStatusCell.vue';
import StatusText from './table/StatusText.vue';
import { useColumnPreferences } from '../composables/useColumnPreferences.js';
import { useRowsPreference } from '../composables/useRowsPreference.js';

// No props needed, shows all zones globally

const store = useDnsStore();
const dhcpStore = useDhcpStore();
const toast = useToast();
const { rows: dnsRows, onPage: onDnsPage } = useRowsPreference('cidrella_dns_table_rows', 100);

function dnsSourceLabel(source) {
  if (source === 'dns') return 'Static DNS';
  if (source === 'dhcp') return 'DHCP lease';
  if (source === 'reservation') return 'DHCP Reservation';
  if (source === 'placeholder') return 'Placeholder';
  return 'Manual';
}

// Find the first DHCP scope whose pool contains `ip`. Returns { scope, cidr }
// or null. Used to warn when a user points a DNS A record at an IP inside a
// dynamic DHCP pool, DHCP may hand that IP to a different host tomorrow.
function findDhcpScopeForIp(ip) {
  if (!ip) return null;
  let ipLong;
  try { ipLong = ipToLong(ip); } catch { return null; }
  for (const s of (dhcpStore.scopes || [])) {
    if (!s.start_ip || !s.end_ip) continue;
    // Guard per-scope IP conversion: a malformed start/end in the store
    // (import or migration edge case) would otherwise throw mid-loop,
    // bubble up to saveRecord's catch, and fire an error toast AFTER the
    // DNS A record has already been created, user thinks the save
    // failed and retries, creating a duplicate record.
    let startLong, endLong;
    try { startLong = ipToLong(s.start_ip); endLong = ipToLong(s.end_ip); } catch { continue; }
    if (ipLong >= startLong && ipLong <= endLong) {
      return { scope: s, cidr: s.subnet_cidr };
    }
  }
  return null;
}


// Zone state
const zoneFilterText = ref('');
const selectedZone = ref(null);
const isReverse = computed(() => selectedZone.value?.type === 'reverse');

const dnsForwardColumns = [
  { key: 'hostname', header: 'Hostname', description: 'DNS record owner name, shown relative to the selected forward zone.', field: 'name', sortable: true, style: 'width: 12rem' },
  { key: 'record_type', header: 'Record Type', description: 'DNS resource record type, such as A, CNAME, MX, TXT, or SRV.', field: 'record_type', sortable: true, style: 'width: 7rem' },
  { key: 'value', header: 'Value', description: 'Record target value, such as an IP address, alias target, mail exchanger, or text payload.', field: 'value', sortable: true, style: 'width: 14rem' },
  { key: 'priority', header: 'Priority', description: 'Priority value used by MX and SRV records.', field: 'priority', sortable: true, style: 'width: 5rem' },
  { key: 'port', header: 'Port', description: 'Service port used by SRV records.', field: 'port', sortable: true, style: 'width: 4rem' },
  { key: 'ttl', header: 'TTL', description: 'Record time-to-live in seconds, or the zone default when no record TTL is set.', field: 'ttl', sortable: true, style: 'width: 6rem' },
  { key: 'enabled', header: 'Enabled', description: 'Whether this DNS record is written to the generated DNS service configuration.', field: 'enabled', sortable: true, style: 'width: 5rem' },
  { key: 'source', header: 'Source', description: 'How the DNS row was created: manually, from static DNS, from DHCP, or as a generated placeholder.', field: 'dns_source', sortable: true, style: 'width: 9rem' },
  { key: 'online', header: 'Online', description: 'Current liveness state for A records with a known IP address.', field: 'is_online', sortable: true, style: 'width: 5rem' },
];

const dnsReverseColumns = [
  { key: 'ptr_hostname', header: 'Hostname', description: 'Hostname returned by this PTR record.', field: 'value', sortable: true, style: 'width: 16rem' },
  { key: 'ip_address', header: 'IP Address', description: 'IPv4 address reconstructed from the PTR record name and selected reverse zone.', field: '_ip_long', sortable: true, sortField: '_ip_long', style: 'width: 10rem' },
  { key: 'name', header: 'Name', description: 'PTR record owner name inside the selected reverse zone.', field: 'name', sortable: true, style: 'width: 14rem' },
  { key: 'record_type', header: 'Record Type', description: 'DNS resource record type for the reverse-zone row.', field: 'record_type', sortable: true, style: 'width: 7rem' },
  { key: 'ttl', header: 'TTL', description: 'Record time-to-live in seconds, or the zone default when no record TTL is set.', field: 'ttl', sortable: true, style: 'width: 6rem' },
  { key: 'enabled', header: 'Enabled', description: 'Whether a real PTR hostname is eligible for generated DNS configuration. IP placeholders remain display-only.', field: 'enabled', sortable: true, style: 'width: 5rem' },
  { key: 'source', header: 'Source', description: 'How the DNS row was created: manually, from static DNS, from DHCP, or as a generated placeholder.', field: 'dns_source', sortable: true, style: 'width: 9rem' },
];

const {
  visibleColumns: visibleDnsForwardColumns,
  setVisibleColumns: setVisibleDnsForwardColumns,
  resetColumns: resetDnsForwardColumns
} = useColumnPreferences('cidrella_columns_dns_forward', dnsForwardColumns);
const {
  visibleColumns: visibleDnsReverseColumns,
  setVisibleColumns: setVisibleDnsReverseColumns,
  resetColumns: resetDnsReverseColumns
} = useColumnPreferences('cidrella_columns_dns_reverse', dnsReverseColumns);

const dnsTableColumns = computed(() => isReverse.value ? dnsReverseColumns : dnsForwardColumns);
const visibleDnsColumns = computed(() => isReverse.value ? visibleDnsReverseColumns.value : visibleDnsForwardColumns.value);

function setVisibleDnsColumns(columns) {
  if (isReverse.value) setVisibleDnsReverseColumns(columns);
  else setVisibleDnsForwardColumns(columns);
}

function resetDnsColumns() {
  if (isReverse.value) resetDnsReverseColumns();
  else resetDnsForwardColumns();
}

// Reconstruct the IPv4 address a PTR record points at, by concatenating the
// record's host label(s) with the zone's arpa prefix and reversing. For zone
// "0.10.in-addr.arpa" + record name "5.1" → "10.0.1.5".
function ptrRecordIp(record) {
  if (!selectedZone.value || selectedZone.value.type !== 'reverse') return record.name;
  const zoneLabel = (selectedZone.value.name || '').replace(/\.?in-addr\.arpa\.?$/, '');
  const recordLabel = record.name || '';
  const combined = [recordLabel, zoneLabel].filter(Boolean).join('.');
  // combined is reverse-octet order, e.g. "5.1.0.10"
  return combined.split('.').reverse().join('.');
}
function displayDnsName(record) {
  if (!record?.name) return EMPTY_CELL;
  if (record.name === '@') return selectedZone.value?.name || '@';
  return displayHostnameCell(`${record.name}.${selectedZone.value?.name || ''}`, selectedZone.value?.name);
}
const records = ref([]);
const loadingRecords = ref(false);
const expandedGroups = ref({});
const zoneTab = ref(loadJson('cidrella_dns_zone_tab', 'forward'));

// Forward zones (simple list)
const forwardZones = computed(() =>
  store.zones.filter(z => z.type === 'forward').sort((a, b) => a.name.localeCompare(b.name))
);

const filteredForwardZones = computed(() => {
  const q = zoneFilterText.value.trim().toLowerCase();
  if (!q) return forwardZones.value;
  return forwardZones.value.filter(z => z.name.toLowerCase().includes(q));
});

// Group reverse zones that share a subnet_id (multiple /24 zones for one supernet)
const groupedReverseZones = computed(() => {
  const result = [];
  const bySubnet = new Map();
  const reverseZones = store.zones.filter(z => z.type === 'reverse').sort((a, b) => {
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

const filteredGroupedReverseZones = computed(() => {
  const q = zoneFilterText.value.trim().toLowerCase();
  if (!q) return groupedReverseZones.value;
  return groupedReverseZones.value.filter(entry => {
    if (entry.isGroup) {
      return entry.description.toLowerCase().includes(q) ||
        entry.zones.some(z => z.name.toLowerCase().includes(q));
    }
    return entry.zone.name.toLowerCase().includes(q);
  });
});

function toggleGroup(key) {
  expandedGroups.value = { ...expandedGroups.value, [key]: !expandedGroups.value[key] };
}

// Zone dialog
const showZoneDialog = ref(false);
const editingZone = ref(null);
const savingZone = ref(false);
// SOA fields start empty and are filled from the server in openZoneDialog. No
// literals here: they were a second, drifting copy of the server's defaults
// (audit #38).
const zoneForm = ref({
  name: '', type: 'forward', description: '', enabled: true,
  soa_primary_ns: '', soa_admin_email: '',
  soa_refresh: null, soa_retry: null, soa_expire: null, soa_minimum_ttl: null
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

const dnsSearch = ref(loadJson('cidrella_dns_search', ''));
watch(dnsSearch, (val) => {
  saveJson('cidrella_dns_search', val)
});
const filteredRecords = computed(() => {
  let base = [...records.value];
  // For reverse zones, inject a numeric sort key so the IP Address and Name
  // columns can maintain independent sort state. PrimeVue keys per-column
  // sort on `sortField`; if two columns share the same field, they share a
  // toggle. `_ip_long` gives IP Address its own.
  if (isReverse.value) {
    base = base.map(r => {
      const ip = ptrRecordIp(r);
      // utils/ip.js is already imported by this file. The inline copy that used
      // to live here returned null for unparseable input where ipToLong returns
      // 0, so a malformed reverse-zone row sorted to the opposite end of the
      // table depending on which code path produced it (audit #52). Guard with
      // the shared validator and use the shared conversion.
      const ipLong = isValidIpv4(ip) ? ipToLong(ip) : null;
      return { ...r, _ip_long: ipLong };
    });
  }
  const q = dnsSearch.value.trim().toLowerCase();
  if (!q) return base;
  return base.filter(r =>
    (r.name && r.name.toLowerCase().includes(q)) ||
    (r.record_type && r.record_type.toLowerCase().includes(q)) ||
    (r.value && r.value.toLowerCase().includes(q))
  );
});
const availableRecordTypes = computed(() => {
  if (selectedZone.value?.type === 'reverse') return ['PTR'];
  return allRecordTypes;
});

// Record context menu
const recordContextMenu = ref();
const selectedRecord = ref(null);
const recordContextMenuItems = computed(() => {
  const r = selectedRecord.value;
  if (!r) return [];
  const managedItem = managedDnsRecordMenuItem(r);
  if (managedItem) return [managedItem];
  return [
    { label: 'Edit Record', icon: 'pi pi-pencil', command: () => openRecordDialog(r) },
    { label: 'Delete Record', icon: 'pi pi-trash', command: () => confirmDeleteRecord(r) }
  ];
});
function onRecordRightClick(event) {
  selectedRecord.value = event.data;
  if (recordContextMenuItems.value.length) {
    recordContextMenu.value.show(event.originalEvent);
  }
}
function onRecordDoubleClick(event) {
  if (isEditableDnsRecord(event.data)) openRecordDialog(event.data);
}

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
  saveJson('cidrella_dns_zone_tab', val)
});

async function selectZone(zone) {
  selectedZone.value = zone;
  saveJson('cidrella_dns_selected_zone_id', zone?.id || null)
  loadingRecords.value = true;
  try {
    const fetched = await store.getRecords(zone.id);
    if (zone.type === 'reverse') {
      fetched.sort((a, b) => (a.value || '').localeCompare(b.value || '', undefined, { numeric: true }));
    }
    records.value = fetched;
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    loadingRecords.value = false;
  }
}

// Zone CRUD
async function openZoneDialog(zone = null) {
  editingZone.value = zone;

  // SOA defaults come from the server and are NOT mirrored here.
  //
  // There used to be a literal fallback for when this fetch failed, and it had
  // drifted: soa_minimum_ttl was 900 here against 1800 in the server's config
  // (duplicate-logic audit #38). Nobody reviews the sad path, which is exactly
  // where a stale copy survives. docs/CROSS-TIER-DUPLICATION.md is explicit
  // about this: if the fetch fails the UI refuses to offer the control rather
  // than inventing a value, because a zone created from invented defaults is
  // worse than a zone not created.
  let soaDefaults;
  try {
    soaDefaults = await store.getSoaDefaults();
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not load SOA defaults',
      detail: `${apiError(err)}. The zone editor needs them, so it has not been opened.`,
      life: 6000
    });
    return;
  }

  if (zone) {
    zoneForm.value = {
      name: zone.name, type: zone.type,
      description: zone.description || '', enabled: !!zone.enabled,
      // A stored zone can hold NULL in these columns. Fall back to the SERVER's
      // defaults, not to a second set of numbers written down over here.
      soa_primary_ns: zone.soa_primary_ns || soaDefaults.soa_primary_ns,
      soa_admin_email: zone.soa_admin_email || soaDefaults.soa_admin_email,
      soa_refresh: zone.soa_refresh ?? soaDefaults.soa_refresh,
      soa_retry: zone.soa_retry ?? soaDefaults.soa_retry,
      soa_expire: zone.soa_expire ?? soaDefaults.soa_expire,
      soa_minimum_ttl: zone.soa_minimum_ttl ?? soaDefaults.soa_minimum_ttl
    };
  } else {
    zoneForm.value = {
      name: '', type: zoneTab.value || 'forward',
      description: '', enabled: true,
      ...soaDefaults
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingZone.value = false;
  }
}

// Record CRUD
function openRecordDialog(record = null) {
  editingRecord.value = record;
  if (record) {
    recordForm.value = {
      name: record.name, type: record.record_type, value: record.value,
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

    // Warn (but don't block) when an A record points at an IP that sits
    // inside a DHCP dynamic pool. The DHCP server may hand that IP to a
    // different host, breaking the A record until the next renewal. A
    // DHCP Reservation would be the right tool if the user wants a stable
    // hostname for that MAC.
    if (recordForm.value.type === 'A' && recordForm.value.value) {
      const hit = findDhcpScopeForIp(recordForm.value.value);
      if (hit) {
        toast.add({
          severity: 'warn',
          summary: 'IP is inside a DHCP pool',
          detail: `${recordForm.value.value} is inside the DHCP range on ${hit.cidr || 'a subnet'} (${hit.scope.start_ip}–${hit.scope.end_ip}). DHCP may reassign this address. Consider a DHCP Reservation instead.`,
          life: 8000
        });
      }
    }

    showRecordDialog.value = false;
    records.value = await store.getRecords(selectedZone.value.id);
    await store.fetchZones(); // refresh record counts
  } catch (err) {
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
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
    toast.add({ severity: 'error', summary: 'Error', detail: apiError(err), life: 5000 });
  } finally {
    savingRecord.value = false;
  }
}

onMounted(async () => {
  await store.fetchZones();
  // Load DHCP scopes so we can warn when a new A record points at an IP
  // inside a DHCP pool. Fire-and-forget, the panel is usable immediately.
  if (!dhcpStore.scopes || dhcpStore.scopes.length === 0) {
    dhcpStore.fetchScopes().catch(() => {});
  }
  // Restore previously selected zone
  const savedZoneId = loadJson('cidrella_dns_selected_zone_id', null);
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
  grid-template-rows: 1fr;
  gap: 1.5rem;
  flex: 1;
  min-height: 0;
  overflow: hidden;
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
.panel-header h3 { margin: 0; font-size: var(--app-fs-md); color: var(--p-text-color); }

.info-bar {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  border-bottom: 1px solid var(--p-surface-border);
  padding: 0 0.75rem;
  gap: 0.6rem;
  height: 2.4rem;
  box-sizing: border-box;
}
.info-bar-name { font-weight: 700; font-size: var(--app-fs-md); color: var(--p-primary-color); font-family: monospace; white-space: nowrap; }
.info-bar-sep { width: 1px; height: 1rem; background: var(--p-surface-border); flex-shrink: 0; }
.info-bar-pair { display: flex; align-items: baseline; gap: 4px; white-space: nowrap; }
.info-bar-label { font-size: var(--app-fs-xs); text-transform: uppercase; color: var(--p-text-muted-color); letter-spacing: 0.08em; }
.info-bar-val { font-size: var(--app-fs-sm); font-weight: 600; font-family: monospace; }

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
  font-size: var(--app-fs-md);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--p-text-color);
  font-family: monospace;
}
.zone-meta { display: flex; gap: 0.4rem; margin-top: 0.2rem; align-items: center; }

.record-count { font-size: var(--app-fs-xs); color: var(--p-text-muted-color); }

.zone-actions { display: flex; gap: 0.15rem; flex-shrink: 0; }

.records-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.records-panel > :deep(.p-datatable) {
  flex: 1;
  min-height: 0;
  padding-right: 0.5rem;
  box-sizing: border-box;
}

.dns-toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--p-surface-border);
  flex-shrink: 0;
}
.dns-toolbar .toolbar-divider {
  width: 1px;
  height: 1.2rem;
  background: var(--p-surface-border);
}

.type-badge {
  font-size: var(--app-fs-xs);
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
  letter-spacing: 0.02em;
}

.badge-enabled { font-size: var(--app-fs-xs); color: var(--p-green-500); }

.action-buttons { display: flex; gap: 0.25rem; }

.search-bar { display: flex; align-items: center; gap: 0.25rem; padding: 0.4rem 0; flex-shrink: 0; }
.search-input { width: 22rem; }

.empty-state {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--p-surface-400);
  font-size: var(--app-fs-base);
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
  margin-bottom: 0.4rem;
  font-size: var(--app-fs-sm);
  font-weight: 500;
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
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.soa-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
}
.soa-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  border-radius: 50%;
  background: var(--p-surface-200);
  color: var(--p-text-muted-color);
  font-size: var(--app-fs-xs);
  font-weight: 700;
  cursor: help;
  margin-left: 0.25rem;
  vertical-align: middle;
}
.soa-serial {
  font-family: monospace;
  font-weight: 600;
  font-size: var(--app-fs-md);
}
.field-help {
  display: block;
  margin-top: 0.4rem;
  font-size: var(--app-fs-xs);
  color: var(--p-text-muted-color);
}

.zone-group-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-weight: 600;
  font-size: var(--app-fs-md);
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
  font-size: var(--app-fs-md);
  font-weight: 600;
  color: var(--p-text-color);
}

@media (max-width: 900px) {
  .dns-layout {
    grid-template-columns: 1fr;
  }
}
</style>
