<template>
  <div
    class="workspace-preview"
    data-track="networks-workspace-preview"
    :style="{ '--workspace-font-bump': `${fontBump * 1.333}px` }"
  >
    <header class="preview-banner">
      <div>
        <h1>Network operations, in context</h1>
      </div>
      <div class="preview-banner-actions">
        <div class="font-sizer" aria-label="Small text size">
          <span><i class="pi pi-font" /> Small text</span>
          <button
            :disabled="fontBump === 0"
            aria-label="Decrease small text size"
            data-track="workspace-font-decrease"
            @click="resizeSmallText(-1)"
          >
            −
          </button>
          <output>{{ fontBump ? `+${fontBump} pt` : 'Default' }}</output>
          <button
            :disabled="fontBump === 2"
            aria-label="Increase small text size"
            data-track="workspace-font-increase"
            @click="resizeSmallText(1)"
          >
            +
          </button>
        </div>
        <span class="sample-pill live"
          ><i class="pi pi-circle-fill" /> 0.5.0 preview · live data</span
        >
        <router-link to="/networks" class="quiet-link" data-track="preview-back-to-networks">
          <i class="pi pi-arrow-left" /> Current interface
        </router-link>
      </div>
    </header>

    <section class="workspace-frame">
      <ResourceExplorer
        v-model:query="resourceQuery"
        :context-kind="contextKind"
        :folders="filteredFolders"
        :expanded-folders="expandedFolders"
        :selected-folder-id="selectedFolder?.id ?? null"
        :selected-network-id="selectedNetwork?.id ?? null"
        :network-count="allNetworks.length"
        :zone-count="dnsZones.length"
        :scope-count="dhcpScopes.length"
        :loading="loading"
        :can-create="canAnyCreate"
        :can-manage-folders="can('subnets:write')"
        :can-manage-defaults="can('subnets:write')"
        @create="toggleMenu('create')"
        @select-estate="selectEstate"
        @select-unallocated="selectUnallocated"
        @select-folder="selectFolder"
        @select-network="selectNetwork"
        @select-unallocated-network="selectUnallocatedNetwork"
        @toggle-folder="toggleFolder"
        @notify="notify"
      />

      <main class="work-surface" :aria-busy="loadingContext">
        <div v-if="loadError" class="workspace-error" role="alert">
          <i class="pi pi-exclamation-circle" />
          <span><strong>Could not load workspace data</strong>{{ loadError }}</span>
          <button @click="loadWorkspace">Retry</button>
        </div>
        <WorkspaceContextHeader
          :context-kind="contextKind"
          :context-icon="contextIcon"
          :context-title="contextTitle"
          :context-subtitle="contextSubtitle"
          :selected-folder="selectedFolder"
          :selected-network="selectedNetwork"
          :stats="contextStats"
          :can-scan="contextKind === 'network' && can('subnets:write')"
          :has-actions="permittedActionMenuItems.length > 0"
          :can-create="canAnyCreate"
          :views="availableViews"
          :active-view="activeView"
          :show-summary="showViewSummary"
          :view-meta="viewMeta"
          :summary-zones="summaryZones"
          :summary-scopes="summaryScopes"
          :address-overview="addressOverview"
          @select-estate="selectEstate"
          @select-folder="selectFolderById"
          @switch-view="switchView"
          @open-menu="toggleMenu"
          @filter-zone="filterToZone"
          @filter-scope="filterToScope"
          @notify="notify"
        />
        <section class="table-card">
          <div v-if="loadingContext" class="loading-bar" data-track="workspace-loading">
            <i class="pi pi-spin pi-spinner" /> Loading live data…
          </div>
          <div v-else-if="visibleResourceError" class="workspace-error" role="alert">
            <i class="pi pi-exclamation-circle" />
            <span><strong>Could not load this inventory</strong>{{ visibleResourceError }}</span>
            <button @click="retryVisibleResource">Retry</button>
          </div>
          <WorkspaceToolbar
            v-model:table-query="tableQuery"
            v-model:filters="filters"
            v-model:show-available="showAvailable"
            v-model:presentation="addressPresentation"
            v-model:selected-rows="selectedRows"
            :active-view="activeView"
            :context-kind="contextKind"
            :view-meta="viewMeta"
            :filter-options="filterOptions"
            :column-table-name="columnTableName"
            :column-catalog="columnCatalog"
            :columns="columns"
            :can-create="canCreateCurrent"
            :can-set-range="activeView === 'addresses' && can('subnets:write')"
            :can-reserve="activeView === 'addresses' && can('subnets:write')"
            :filter-chips="activeFilterChips"
            @update:visible-columns="setVisibleColumns"
            @reset-columns="resetVisibleColumns"
            @clear-filter="clearFilter"
            @clear-filters="clearFilters"
            @notify="notify"
          />

          <AddressGrid
            v-if="activeView === 'addresses' && addressPresentation !== 'table'"
            :cells="gridCells"
            :density="addressPresentation === 'compact-grid' ? 'compact' : 'spacious'"
            @open="openGridCell"
          />
          <WorkspaceTable
            v-else
            :columns="columns"
            :rows="filteredRows"
            :show-checkboxes="activeView === 'addresses'"
            :selected-row-id="selectedRow?.id ?? null"
            :selected-rows="selectedRows"
            :sort-key="sortKey"
            :sort-order="sortOrder"
            @sort="sortBy"
            @select="selectRow"
            @toggle-row="toggleRow"
            @toggle-all="toggleAllRows"
            @row-menu="openRowMenu"
          />
          <footer class="table-footer">
            <span>Showing {{ filteredRows.length }} of {{ rowTotal }}</span>
            <div class="pagination">
              <button
                :disabled="currentPage <= 1 || !serverPagedView"
                aria-label="Previous page"
                @click="changePage(currentPage - 1)"
              >
                <i class="pi pi-chevron-left" />
              </button>
              <button class="active" aria-current="page">{{ currentPage }}</button>
              <span v-if="serverPagedView">of {{ totalPages }}</span>
              <button
                :disabled="currentPage >= totalPages || !serverPagedView"
                aria-label="Next page"
                @click="changePage(currentPage + 1)"
              >
                <i class="pi pi-chevron-right" />
              </button>
            </div>
            <label v-if="serverPagedView" class="page-size-control">
              <span>Per page</span>
              <select v-model.number="pageSize" aria-label="Rows per page">
                <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
              </select>
            </label>
            <span v-else>Live results</span>
          </footer>
        </section>
      </main>

      <WorkspaceDetailsHost
        :row="selectedRow"
        :row-view="selectedRowView"
        :row-context="selectedRowContext"
        :can-write="can('subnets:write')"
        :network="selectedNetwork"
        :dns-count="selectedAddressDnsCount"
        :dhcp-count="selectedAddressDhcpCount"
        :title="detailTitle"
        :heading="detailHeading"
        :subheading="detailSubheading"
        :icon="detailIcon"
        :items="detailItems"
        :related="relatedResources"
        :actions="rowActions"
        @close="selectedRow = null"
        @navigate="openRelatedResource"
        @changed="handleAddressChanged"
        @notify="handleDetailsAction"
      />
    </section>

    <div v-if="openMenuName" class="menu-scrim" @click="openMenuName = null" />
    <div v-if="openMenuName === 'create'" class="floating-menu create-menu">
      <span>CREATE RESOURCE</span>
      <button
        v-for="item in permittedCreateActions"
        :key="item.label"
        @click="chooseMenuAction(item.label)"
      >
        <i :class="item.icon" /><span
          ><strong>{{ item.label }}</strong
          ><small>{{ item.note }}</small></span
        >
      </button>
    </div>
    <div v-if="openMenuName === 'actions'" class="floating-menu actions-menu">
      <span>{{ actionMenuTitle }}</span>
      <button
        v-for="item in permittedActionMenuItems"
        :key="item.label"
        :class="{ danger: item.danger }"
        @click="chooseMenuAction(item.label)"
      >
        <i :class="item.icon" /><span
          ><strong>{{ item.label }}</strong
          ><small>{{ item.note }}</small></span
        >
      </button>
    </div>
    <div v-if="openMenuName === 'row'" class="floating-menu row-menu">
      <span>{{ activeView.toUpperCase() }} ACTIONS</span>
      <button v-for="action in rowActions" :key="action" @click="chooseMenuAction(action)">
        <i class="pi pi-angle-right" /><strong>{{ action }}</strong>
      </button>
    </div>

    <Transition name="notice">
      <div v-if="notice" class="prototype-notice">
        <i class="pi pi-sparkles" /><span><strong>Workspace preview</strong>{{ notice }}</span>
        <button v-if="noticeRetry" type="button" @click="retryNoticeRefresh">Retry</button>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import api from '../../api/client.js';
import { useAutoRefresh } from '../../composables/useAutoRefresh.js';
import { usePermissions } from '../../composables/usePermissions.js';
import { apiError, countOf, formatNumber } from '../../utils/format.js';
import { loadJson, saveJson } from '../../utils/storage.js';
import AddressGrid from './AddressGrid.vue';
import ResourceExplorer from './ResourceExplorer.vue';
import WorkspaceContextHeader from './WorkspaceContextHeader.vue';
import WorkspaceDetailsHost from './WorkspaceDetailsHost.vue';
import WorkspaceTable from './WorkspaceTable.vue';
import WorkspaceToolbar from './WorkspaceToolbar.vue';
import { useWorkspaceContext } from './composables/useWorkspaceContext.js';
import { useWorkspaceResources } from './composables/useWorkspaceResources.js';
import {
  defaultWorkspaceColumnKeys,
  restoreWorkspaceColumnKeys,
  workspaceColumnCatalog,
} from './workspace-columns.js';
import {
  buildExplorerFolders,
  gridKind,
  mapAddressRows,
  mapDhcpScopeRows,
  mapDhcpRows,
  mapDnsRows,
  mapDnsZoneRows,
  mapNetworkRows,
  mapRangeRows,
  sumScopeAddresses,
} from '../networks-workspace-data.js';

const networkViews = [
  { key: 'addresses', label: 'Addresses', icon: 'pi pi-list' },
  { key: 'dns', label: 'DNS', icon: 'pi pi-globe' },
  { key: 'dhcp', label: 'DHCP', icon: 'pi pi-server' },
  { key: 'ranges', label: 'Ranges', icon: 'pi pi-clone' },
];
const aggregateViews = [
  { key: 'networks', label: 'Networks', icon: 'pi pi-sitemap' },
  { key: 'dns', label: 'DNS', icon: 'pi pi-globe' },
  { key: 'dhcp', label: 'DHCP', icon: 'pi pi-server' },
];

const folders = ref([]);
const unallocatedFolders = ref([]);
const dnsZones = ref([]);
const allDnsRows = ref([]);
const networkDnsRowsData = ref([]);
const dhcpScopes = ref([]);
const allDhcpRows = ref([]);
const addressRows = ref([]);
const networkDhcpRows = ref([]);
const rangeRows = ref([]);
const matchedNetworkIds = ref(null);
const resourceQuery = ref('');
const tableQuery = ref('');
const selectedNetwork = ref({
  id: null,
  folder: 'Infrastructure',
  name: 'Loading networks…',
  cidr: '',
  vlan: null,
  domain: null,
  status: 'allocated',
  total_addresses: 0,
  used_count: 0,
  used: 0,
});
const selectedFolder = ref(null);
const contextKind = ref('estate');
const activeView = ref('networks');
const expandedFolders = ref(new Set());
const addressPresentation = ref('table');
const showAvailable = ref(true);
const filters = ref({ status: '', type: '', online: '', scan: '', range: '', protocol: '' });
const selectedRow = ref(null);
const selectedRows = ref([]);
const selectedRowView = ref('addresses');
const selectedRowContext = ref('network');
const selectedZoneFilter = ref(null);
const selectedScopeFilter = ref(null);
const openMenuName = ref(null);
const notice = ref('');
const noticeRetry = ref(null);
const loading = ref(true);
const loadingContext = ref(false);
const loadError = ref('');
const currentPage = ref(1);
const PAGE_SIZES = [25, 50, 100, 256];
const pageSize = ref(256);
const totalPages = ref(1);
const addressTotal = ref(0);
const addressFilteredTotal = ref(0);
const dnsTotal = ref(0);
const dhcpTotal = ref(0);
const sortKey = ref(null);
const sortOrder = ref(1);
const fontBump = ref(
  Math.min(2, Math.max(0, Number(loadJson('cidrella_workspace_font_bump', 1)) || 0)),
);
let noticeTimer = null;
let searchTimer = null;
let contextRequest = 0;
let restoringRoute = false;
let pendingRouteWrites = 0;
let backgroundRefreshRunning = false;

const { can, user, refreshCapabilities } = usePermissions();
async function handleForbidden() {
  await refreshCapabilities();
  showLiveNotice(
    'Your access changed. Permissions were refreshed and other workspace data was preserved.',
  );
}
const workspaceResources = useWorkspaceResources({ can, onForbidden: handleForbidden });
const { state: routeState, navigate: navigateWorkspace } = useWorkspaceContext({
  storageKey: `cidrella_workspace_v1_${user.value?.username || 'anonymous'}`,
});
resourceQuery.value = routeState.value.q;
tableQuery.value = routeState.value.tableQ;

const viewDefinitions = {
  networks: {
    search: 'Search network, CIDR, folder, VLAN, or domain…',
    addLabel: 'Allocate network',
    addAction: 'Allocate network',
  },
  addresses: {
    search: 'Search IP, hostname, MAC, type…',
    addLabel: 'Reserve address',
    addAction: 'Create IP Reservation',
  },
  dns: {
    search: 'Search name, zone, record type, or value…',
    addLabel: 'Add record',
    addAction: 'Add DNS record',
  },
  dhcp: {
    search: 'Search IP, MAC, hostname, network, or lease…',
    addLabel: 'Add reservation',
    addAction: 'Add DHCP Reservation',
  },
  ranges: {
    search: 'Search range, type, or description…',
    addLabel: 'Add range',
    addAction: 'Add Network Range Type range',
  },
};

const visibleColumnKeys = ref({});
const columnKind = computed(() => {
  if (contextKind.value !== 'network' && activeView.value === 'dns' && !selectedZoneFilter.value)
    return 'dnsZones';
  if (contextKind.value !== 'network' && activeView.value === 'dhcp' && !selectedScopeFilter.value)
    return 'dhcpScopes';
  return activeView.value;
});
const columnStorageKey = computed(
  () =>
    `cidrella_workspace_columns_v1_${user.value?.username || 'anonymous'}_${contextKind.value}_${columnKind.value}`,
);
const columnCatalog = computed(() =>
  workspaceColumnCatalog(columnKind.value).map((column) => ({
    ...column,
    label: column.label || column.header,
    className:
      column.className ||
      (['ip_address', 'mac_address', 'value', 'dns_hostname'].includes(column.key) ? 'mono' : ''),
  })),
);
const columnTableName = computed(
  () =>
    `${contextKind.value === 'estate' ? 'All Networks' : contextTitle.value} ${activeView.value}`,
);

const createActions = [
  {
    label: 'Allocate network',
    note: 'Add address space to IPAM',
    icon: 'pi pi-sitemap',
    permission: 'subnets:write',
  },
  {
    label: 'Create folder',
    note: 'Organize related networks',
    icon: 'pi pi-folder-plus',
    permission: 'subnets:write',
  },
  {
    label: 'Add DNS zone',
    note: 'Forward or reverse authority',
    icon: 'pi pi-globe',
    permission: 'dns:write',
  },
  {
    label: 'Add DHCP scope',
    note: 'Create a dynamic address pool',
    icon: 'pi pi-server',
    permission: 'dhcp:write',
  },
  {
    label: 'Add DHCP Reservation',
    note: 'Bind a client to an address',
    icon: 'pi pi-bookmark',
    permission: 'dhcp:write',
  },
];

const networkActions = [
  {
    label: 'Edit network',
    note: 'Name, gateway, VLAN, domain, and scanning',
    icon: 'pi pi-pencil',
  },
  {
    label: 'Divide network',
    note: 'Preview child networks and dependencies',
    icon: 'pi pi-share-alt',
  },
  { label: 'Merge networks', note: 'Select an adjacent sibling', icon: 'pi pi-sitemap' },
  {
    label: 'Move to folder',
    note: 'Change organization without changing CIDR',
    icon: 'pi pi-folder',
  },
  { label: 'Apply defaults', note: 'Review template-managed settings', icon: 'pi pi-sync' },
  {
    label: 'Deallocate network',
    note: 'Return this block to its parent',
    icon: 'pi pi-undo',
    danger: true,
  },
  {
    label: 'Delete network',
    note: 'Remove this network and its dependencies',
    icon: 'pi pi-trash',
    danger: true,
  },
];
const dnsActions = [
  {
    label: 'Edit selected zone',
    note: 'Authority, SOA, description, and state',
    icon: 'pi pi-pencil',
  },
  { label: 'Switch forward / reverse', note: 'Browse the other side of DNS', icon: 'pi pi-replay' },
  { label: 'Add DNS zone', note: 'Create forward or reverse authority', icon: 'pi pi-plus' },
  {
    label: 'Delete selected zone',
    note: 'Review dependent records first',
    icon: 'pi pi-trash',
    danger: true,
  },
];
const dhcpActions = [
  {
    label: 'Edit selected scope',
    note: 'Pool, lease policy, options, and state',
    icon: 'pi pi-pencil',
  },
  { label: 'Sync leases now', note: 'Refresh dnsmasq lease state', icon: 'pi pi-sync' },
  { label: 'Add DHCP scope', note: 'Create a dynamic address pool', icon: 'pi pi-plus' },
  {
    label: 'Delete selected scope',
    note: 'Keep the underlying range',
    icon: 'pi pi-trash',
    danger: true,
  },
];

for (const item of networkActions) item.permission = 'subnets:write';
for (const item of dnsActions) item.permission = 'dns:write';
for (const item of dhcpActions) item.permission = 'dhcp:write';
const permittedCreateActions = computed(() => createActions.filter((item) => can(item.permission)));
const canAnyCreate = computed(() => permittedCreateActions.value.length > 0);
const canCreateCurrent = computed(() =>
  can(
    activeView.value === 'dns'
      ? 'dns:write'
      : activeView.value === 'dhcp'
        ? 'dhcp:write'
        : 'subnets:write',
  ),
);

const filteredFolders = computed(() => {
  const query = resourceQuery.value.trim().toLowerCase();
  const source = contextKind.value === 'unallocated' ? unallocatedFolders.value : folders.value;
  if (!query) return source;
  const filterNodes = (nodes) =>
    nodes.flatMap((network) => {
      const children = filterNodes(network.children || []);
      const matches =
        matchedNetworkIds.value?.has(Number(network.id)) ||
        `${network.name} ${network.cidr} ${network.vlan}`.toLowerCase().includes(query);
      return matches || children.length ? [{ ...network, children }] : [];
    });
  return source
    .map((folder) => ({
      ...folder,
      networks: folder.name.toLowerCase().includes(query)
        ? folder.networks
        : filterNodes(folder.networks),
    }))
    .filter((folder) => folder.name.toLowerCase().includes(query) || folder.networks.length);
});

const allNetworks = computed(() => folders.value.flatMap((folder) => folder.networks));
const scopedNetworks = computed(() => {
  if (contextKind.value === 'network')
    return selectedNetwork.value.id ? [selectedNetwork.value] : [];
  if (contextKind.value === 'folder') return selectedFolder.value?.networks || [];
  if (contextKind.value === 'unallocated')
    return unallocatedFolders.value.flatMap((folder) => flattenAllocatable(folder.networks));
  return allNetworks.value;
});
const scopedNetworkIds = computed(
  () => new Set(scopedNetworks.value.map((network) => Number(network.id))),
);
const dnsZoneNetworkIds = computed(() => {
  return new Map(
    dnsZones.value.map((zone) => [
      Number(zone.id),
      new Set((zone.related_subnet_ids || []).map(Number)),
    ]),
  );
});
const dnsZoneNetworkLabels = computed(
  () =>
    new Map(
      dnsZones.value.map((zone) => {
        const names = [...(dnsZoneNetworkIds.value.get(Number(zone.id)) || [])]
          .map((id) => allNetworks.value.find((network) => Number(network.id) === id)?.name)
          .filter(Boolean);
        return [
          Number(zone.id),
          names.length > 2 ? `${names.length} networks` : names.join(', ') || 'Unlinked',
        ];
      }),
    ),
);
const scopedZones = computed(() =>
  contextKind.value === 'estate'
    ? dnsZones.value
    : dnsZones.value.filter((zone) =>
        [...(dnsZoneNetworkIds.value.get(Number(zone.id)) || [])].some((id) =>
          scopedNetworkIds.value.has(id),
        ),
      ),
);
const scopedScopes = computed(() =>
  contextKind.value === 'estate'
    ? dhcpScopes.value
    : dhcpScopes.value.filter((scope) => scopedNetworkIds.value.has(Number(scope.subnet_id))),
);
const scopedDhcpRows = computed(() =>
  contextKind.value === 'estate'
    ? allDhcpRows.value
    : allDhcpRows.value.filter((row) => scopedNetworkIds.value.has(Number(row.raw.subnet_id))),
);
const networkInventoryRows = computed(() => mapNetworkRows(scopedNetworks.value));
const dnsZoneRows = computed(() => mapDnsZoneRows(scopedZones.value, dnsZoneNetworkLabels.value));
const dhcpScopeRows = computed(() => mapDhcpScopeRows(scopedScopes.value));

const contextTitle = computed(() => {
  if (contextKind.value === 'estate') return 'All Networks';
  if (contextKind.value === 'unallocated') return 'Unallocated Networks';
  if (contextKind.value === 'folder') return selectedFolder.value?.name || 'Folder';
  return selectedNetwork.value.name;
});
const contextSubtitle = computed(() => {
  if (contextKind.value === 'network')
    return [
      selectedNetwork.value.cidr,
      selectedNetwork.value.vlan != null ? `VLAN ${selectedNetwork.value.vlan}` : null,
      selectedNetwork.value.domain,
    ]
      .filter(Boolean)
      .join(' · ');
  if (contextKind.value === 'folder')
    return `${countOf(scopedNetworks.value.length, 'managed network')} in this folder`;
  if (contextKind.value === 'unallocated')
    return `${countOf(scopedNetworks.value.length, 'available network')} ready to allocate`;
  return `${countOf(allNetworks.value.length, 'managed network')} across all folders`;
});
const contextIcon = computed(() =>
  contextKind.value === 'estate'
    ? 'pi pi-building'
    : contextKind.value === 'folder'
      ? 'pi pi-folder'
      : contextKind.value === 'unallocated'
        ? 'pi pi-inbox'
        : 'pi pi-sitemap',
);
const linkedZones = computed(() =>
  dnsZones.value.filter((zone) =>
    dnsZoneNetworkIds.value.get(Number(zone.id))?.has(Number(selectedNetwork.value.id)),
  ),
);
const networkDnsRows = computed(() => networkDnsRowsData.value);
const networkScopes = computed(() =>
  dhcpScopes.value.filter((scope) => Number(scope.subnet_id) === Number(selectedNetwork.value.id)),
);
const summaryZones = computed(() =>
  contextKind.value === 'network' ? linkedZones.value : scopedZones.value,
);
const summaryScopes = computed(() =>
  contextKind.value === 'network' ? networkScopes.value : scopedScopes.value,
);
const scopedActiveLeaseCount = computed(
  () => scopedDhcpRows.value.filter((row) => row.leaseStatus === 'active').length,
);
const availableViews = computed(() =>
  contextKind.value === 'network'
    ? networkViews.map((view) => ({
        ...view,
        count: String(
          view.key === 'addresses'
            ? addressTotal.value
            : view.key === 'dns'
              ? workspaceResources.resources.dnsTotal.data
              : view.key === 'dhcp'
                ? workspaceResources.resources.dhcpTotal.data
                : rangeRows.value.length,
        ),
      }))
    : aggregateViews.map((view) => ({
        ...view,
        count: String(
          view.key === 'networks'
            ? scopedNetworks.value.length
            : view.key === 'dns'
              ? scopedZones.value.length
              : scopedScopes.value.length,
        ),
      })),
);
// "1 managed networks" reads as a bug even when the number is right. Every
// count in this view is a plain English noun, so the "s" rule is enough.
function mapWorkspaceDnsRows(records) {
  const zonesById = new Map(dnsZones.value.map((zone) => [Number(zone.id), zone]));
  const grouped = new Map();
  for (const sourceRecord of records || []) {
    const relatedNames = (sourceRecord.related_subnet_ids || [])
      .map((id) => allNetworks.value.find((network) => Number(network.id) === Number(id))?.name)
      .filter(Boolean);
    const record = {
      ...sourceRecord,
      subnet_name: sourceRecord.subnet_name || relatedNames.join(', ') || null,
    };
    const zone = zonesById.get(Number(record.zone_id)) || {
      id: record.zone_id,
      name: record.zone_name || 'Unknown zone',
      type: record.zone_type,
    };
    const entry = grouped.get(Number(zone.id)) || { zone, records: [] };
    entry.records.push(record);
    grouped.set(Number(zone.id), entry);
  }
  return mapDnsRows([...grouped.values()]);
}

function workspaceQueryState() {
  return {
    context: contextKind.value === 'estate' ? 'all' : contextKind.value,
    folder: contextKind.value === 'folder' ? selectedFolder.value?.id : null,
    network: contextKind.value === 'network' ? selectedNetwork.value.id : null,
    view: activeView.value,
    zone: selectedZoneFilter.value?.id || null,
    scope: selectedScopeFilter.value?.id || null,
    ip:
      selectedRowView.value === 'addresses' && selectedRowContext.value === 'network'
        ? selectedRow.value?.address || null
        : null,
    presentation:
      addressPresentation.value === 'compact-grid' ? 'compact' : addressPresentation.value,
    q: resourceQuery.value,
    tableQ: tableQuery.value,
    page: currentPage.value,
    pageSize: pageSize.value,
    ...filters.value,
  };
}

async function updateWorkspaceRoute({ replace = false } = {}) {
  if (restoringRoute) return Promise.resolve();
  restoringRoute = true;
  try {
    pendingRouteWrites += 1;
    await navigateWorkspace(workspaceQueryState(), { replace });
  } finally {
    restoringRoute = false;
  }
}

async function restorePinnedAddress(ip) {
  await loadNetworkContext();
  if (!ip || contextKind.value !== 'network') return;
  const detail = await workspaceResources.loadAddressDetail(selectedNetwork.value.id, ip);
  if (!detail) {
    loadError.value = 'The requested address no longer exists.';
    return;
  }
  selectedRow.value = mapAddressRows([detail])[0];
  selectedRowView.value = 'addresses';
  selectedRowContext.value = 'network';
}

function restoreContextFromRoute(availableNetworks) {
  restoringRoute = true;
  const state = routeState.value;
  let repairedRoute = false;
  resourceQuery.value = state.q;
  tableQuery.value = state.tableQ;
  pageSize.value = PAGE_SIZES.includes(state.pageSize) ? state.pageSize : 256;
  currentPage.value = state.page;
  filters.value = {
    status: state.status,
    type: state.type,
    online: state.online,
    scan: state.scan,
    range: state.range,
    protocol: state.protocol,
  };
  addressPresentation.value =
    state.presentation === 'compact' ? 'compact-grid' : state.presentation;
  if (state.context === 'network') {
    const network = availableNetworks.find((item) => Number(item.id) === Number(state.network));
    if (network) {
      selectedNetwork.value = network;
      selectedFolder.value =
        folders.value.find((folder) => Number(folder.id) === Number(network.folderId)) || null;
      contextKind.value = 'network';
      activeView.value = networkViews.some((view) => view.key === state.view)
        ? state.view
        : 'addresses';
    } else {
      contextKind.value = 'estate';
      activeView.value = 'networks';
      loadError.value = 'The requested network no longer exists.';
      repairedRoute = true;
    }
  } else if (state.context === 'folder') {
    const folder = folders.value.find((item) => Number(item.id) === Number(state.folder));
    if (folder) {
      selectedFolder.value = folder;
      contextKind.value = 'folder';
      activeView.value = aggregateViews.some((view) => view.key === state.view)
        ? state.view
        : 'networks';
    } else {
      contextKind.value = 'estate';
      activeView.value = 'networks';
      loadError.value = 'The requested folder no longer exists.';
      repairedRoute = true;
    }
  } else if (state.context === 'unallocated') {
    contextKind.value = 'unallocated';
    activeView.value = 'networks';
  } else {
    contextKind.value = 'estate';
    activeView.value = aggregateViews.some((view) => view.key === state.view)
      ? state.view
      : 'networks';
  }
  selectedZoneFilter.value = state.zone
    ? dnsZones.value.find((zone) => Number(zone.id) === Number(state.zone)) || null
    : null;
  selectedScopeFilter.value = state.scope
    ? dhcpScopes.value.find((scope) => Number(scope.id) === Number(state.scope)) || null
    : null;
  if (state.zone && !selectedZoneFilter.value) {
    loadError.value = 'The requested DNS zone no longer exists.';
    repairedRoute = true;
  }
  if (state.scope && !selectedScopeFilter.value) {
    loadError.value = 'The requested DHCP scope no longer exists.';
    repairedRoute = true;
  }
  restoringRoute = false;
  if (repairedRoute) void updateWorkspaceRoute({ replace: true });
  if (contextKind.value === 'network') restorePinnedAddress(state.ip);
}

const viewMeta = computed(() => {
  const base = viewDefinitions[activeView.value];
  if (contextKind.value !== 'network') {
    if (activeView.value === 'networks')
      // Nothing to say here that the tab badge does not already say, so the
      // whole band is hidden for this one.
      return { ...base, title: '' };
    if (activeView.value === 'dns')
      return { ...base, title: countOf(scopedZones.value.length, 'authoritative zone') };
    if (activeView.value === 'dhcp')
      return { ...base, title: countOf(scopedScopes.value.length, 'configured scope') };
  }
  if (activeView.value === 'addresses')
    return { ...base, title: `${formatNumber(addressTotal.value)} managed addresses` };
  if (activeView.value === 'dns')
    return {
      ...base,
      title:
        selectedZoneFilter.value?.name ||
        selectedNetwork.value.domain ||
        `${networkDnsRows.value.length} linked records`,
    };
  if (activeView.value === 'dhcp')
    return {
      ...base,
      title: selectedScopeFilter.value
        ? `${selectedScopeFilter.value.start_ip} – ${selectedScopeFilter.value.end_ip}`
        : networkScopes.value.length === 1
          ? `${selectedNetwork.value.name} scope`
          : `${networkScopes.value.length} scopes for ${selectedNetwork.value.name}`,
    };
  return { ...base, title: countOf(rangeRows.value.length, 'managed range') };
});
const columns = computed(() => {
  const stored =
    visibleColumnKeys.value[columnStorageKey.value] ?? loadJson(columnStorageKey.value, null);
  const keys = restoreWorkspaceColumnKeys(columnKind.value, stored);
  const byKey = new Map(columnCatalog.value.map((column) => [column.key, column]));
  return keys.map((key) => byKey.get(key)).filter(Boolean);
});
const serverPagedView = computed(
  () =>
    activeView.value === 'addresses' ||
    (activeView.value === 'dns' &&
      (contextKind.value === 'network' || Boolean(selectedZoneFilter.value))) ||
    (activeView.value === 'dhcp' &&
      (contextKind.value === 'network' || Boolean(selectedScopeFilter.value))),
);
const visibleResourceError = computed(() => {
  if (activeView.value === 'addresses') return workspaceResources.resources.addresses.error;
  if (activeView.value === 'dns') return workspaceResources.resources.dns.error;
  if (activeView.value === 'dhcp') return workspaceResources.resources.dhcp.error;
  if (activeView.value === 'networks') return workspaceResources.resources.networks.error;
  return '';
});
const currentRows = computed(() => {
  let rows;
  if (activeView.value === 'networks') rows = networkInventoryRows.value;
  else if (activeView.value === 'addresses') rows = addressRows.value;
  else if (activeView.value === 'dns')
    rows =
      contextKind.value === 'network' || selectedZoneFilter.value
        ? contextKind.value === 'network'
          ? networkDnsRows.value
          : allDnsRows.value
        : dnsZoneRows.value;
  else if (activeView.value === 'dhcp')
    rows =
      contextKind.value === 'network' || selectedScopeFilter.value
        ? contextKind.value === 'network'
          ? networkDhcpRows.value
          : allDhcpRows.value
        : dhcpScopeRows.value;
  else rows = rangeRows.value;
  if (activeView.value === 'dns' && selectedZoneFilter.value)
    rows = rows.filter((row) => Number(row.raw.zone_id) === Number(selectedZoneFilter.value.id));
  if (activeView.value === 'dhcp' && selectedScopeFilter.value)
    rows = rows.filter(
      (row) =>
        Number(row.raw.scope_id || row.raw.dhcp_scope_id) === Number(selectedScopeFilter.value.id),
    );
  if (!sortKey.value || activeView.value === 'addresses') return rows;
  return [...rows].sort(
    (a, b) =>
      String(a[sortKey.value] ?? '').localeCompare(String(b[sortKey.value] ?? ''), undefined, {
        numeric: true,
      }) * sortOrder.value,
  );
});
const distinct = (values) => [...new Set(values.filter(Boolean).map(String))].sort();
const filterOptions = computed(() => ({
  status: distinct(
    currentRows.value.map((row) =>
      activeView.value === 'dhcp'
        ? row.leaseStatus
        : row.status || (row.enabled ? 'enabled' : 'disabled'),
    ),
  ),
  type: distinct(
    currentRows.value.map((row) =>
      activeView.value === 'dns'
        ? row.raw?.record_type || row.zoneType
        : activeView.value === 'dhcp'
          ? row.raw?.dhcp_assignment_type
          : row.type,
    ),
  ),
  range:
    activeView.value === 'addresses'
      ? (workspaceResources.resources.addresses.data.ranges || [])
          .filter((range) => !range.range_type_is_system)
          .map((range) => ({
            value: String(range.range_type_id || range.id),
            label: range.range_type_name || range.name,
          }))
      : [],
  protocol:
    activeView.value === 'dns'
      ? distinct(currentRows.value.map((row) => row.raw?.dns_source))
      : activeView.value === 'dhcp'
        ? distinct(currentRows.value.map((row) => row.raw?.dhcp_assignment_type))
        : distinct(currentRows.value.map((row) => row.raw?.allocation_source_type)),
}));
const activeFilterChips = computed(() =>
  Object.entries(filters.value)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => ({ key, label: `${key}: ${value}` })),
);
const actionMenuTitle = computed(() =>
  activeView.value === 'dns'
    ? 'DNS ACTIONS'
    : activeView.value === 'dhcp'
      ? 'DHCP ACTIONS'
      : 'NETWORK ACTIONS',
);
const actionMenuItems = computed(() =>
  activeView.value === 'dns'
    ? dnsActions
    : activeView.value === 'dhcp'
      ? dhcpActions
      : networkActions,
);
const permittedActionMenuItems = computed(() =>
  actionMenuItems.value.filter((item) => can(item.permission)),
);

function buildUnallocatedFolders(sourceFolders) {
  const mapNode = (network, folder) => {
    const sourceChildren = network.children || [];
    const children = sourceChildren.map((child) => mapNode(child, folder)).filter(Boolean);
    const allocatable = network.status === 'unallocated' && sourceChildren.length === 0;
    if (!allocatable && !children.length) return null;
    return {
      ...network,
      name: network.name || network.cidr,
      folder: folder.name,
      folderId: folder.id,
      vlan: network.vlan_id,
      domain: network.domain_name || null,
      gateway: network.gateway_address || null,
      used: 0,
      state: allocatable ? 'unallocated' : 'container',
      allocatable,
      children,
    };
  };
  return (sourceFolders || [])
    .map((folder) => ({
      id: folder.id,
      name: folder.name,
      networks: (folder.subnets || []).map((network) => mapNode(network, folder)).filter(Boolean),
    }))
    .filter((folder) => folder.networks.length);
}

function flattenAllocatable(nodes) {
  return (nodes || []).flatMap((node) => [
    ...(node.allocatable ? [node] : []),
    ...flattenAllocatable(node.children),
  ]);
}

function preserveEmptyFolders(allocated, sourceFolders) {
  const byId = new Map(allocated.map((folder) => [Number(folder.id), folder]));
  return (sourceFolders || []).map(
    (folder) => byId.get(Number(folder.id)) || { id: folder.id, name: folder.name, networks: [] },
  );
}

const contextStats = computed(() =>
  contextKind.value === 'network'
    ? [
        {
          label: 'UTILIZATION',
          value: `${Math.round(((workspaceResources.resources.summary.data?.assigned_count || 0) / Math.max(1, workspaceResources.resources.summary.data?.total_addresses || 0)) * 100)}%`,
          note: `${formatNumber(workspaceResources.resources.summary.data?.assigned_count || 0)} assigned`,
          tone: 'neutral',
        },
        {
          label: 'ONLINE NOW',
          value: formatNumber(workspaceResources.resources.summary.data?.online_count || 0),
          note: 'across this network',
          tone: 'good',
          dot: true,
        },
        {
          label: 'DNS',
          value: `${workspaceResources.resources.dnsTotal.data} records`,
          note: `${linkedZones.value.length} linked zones`,
          tone: 'neutral',
          view: 'dns',
        },
        {
          label: 'DHCP POOL',
          value: formatNumber(sumScopeAddresses(networkScopes.value)),
          note: `${networkScopes.value.filter((scope) => scope.enabled).length} active scopes`,
          tone: 'good',
          dot: true,
          view: 'dhcp',
        },
        {
          label: 'ATTENTION',
          value: `${workspaceResources.resources.summary.data?.rogue_count || 0} rogue`,
          note: 'currently detected',
          tone: 'warning',
          dot: true,
        },
      ]
    : [
        {
          label: 'POOL ADDRESSES',
          value: formatNumber(sumScopeAddresses(scopedScopes.value)),
          note: `across ${countOf(scopedScopes.value.length, 'DHCP scope')}`,
          tone: 'good',
          dot: true,
        },
        {
          label: 'ACTIVE LEASES',
          value: formatNumber(scopedActiveLeaseCount.value),
          tone: 'neutral',
        },
        {
          label: 'ATTENTION',
          value: scopedNetworks.value.filter((network) => network.state === 'warning').length,
          note: 'high-utilization networks',
          tone: 'warning',
          dot: true,
        },
      ],
);

// The right half of the band carries real content on these views (the address
// breakdown, the zone and scope filter cards, the range legend). On the
// all-networks view it carries nothing, and with the eyebrow and description
// gone there is no left half either, so the band hides rather than sitting
// there as an empty strip.
const viewsWithAside = ['addresses', 'dns', 'dhcp', 'ranges'];
const showViewSummary = computed(
  () => Boolean(viewMeta.value.title) || viewsWithAside.includes(activeView.value),
);

// Network-scoped, and every figure is one the server already owns.
//
// This used to count addressRows, which is the loaded page, so it read
// "Assigned 1" while the UTILIZATION tile above read "3 assigned" and its
// three numbers summed to the page size under a heading saying 1,024.
//
// "Available" is deliberately gone rather than network-scoped. There is no
// exact source for it: ip_display_status is not a column, it folds
// allocation_state together with dynamic-pool membership and the rogue/online
// promotion, and pool membership is decided in routes/subnets.js while the
// rest of the rule lives in models/ip-view.js. Deriving it here as
// total - assigned - pool would double-subtract every active lease, which is
// an address that is both assigned and inside the pool range. Per AGENTS.md
// the client must not reconstruct that, so the third figure is now
// "Unassigned", the exact complement of the server's own used_count. It
// overlaps the pool on purpose: these three do not partition the space and
// are not presented as if they do.
const addressOverview = computed(() => {
  const total = Math.max(1, addressTotal.value);
  const assigned = Number(workspaceResources.resources.summary.data?.assigned_count) || 0;
  const pool = sumScopeAddresses(networkScopes.value);
  const unassigned = Math.max(0, total - assigned);
  const pct = (n) => `${Math.round((n / total) * 100)}%`;
  return {
    assigned,
    pool,
    unassigned,
    assignedPercent: pct(assigned),
    poolPercent: pct(pool),
    unassignedPercent: pct(unassigned),
  };
});

const filteredRows = computed(() => {
  const globalQuery = resourceQuery.value.trim().toLowerCase();
  const localQueries =
    activeView.value === 'ranges'
      ? [globalQuery, tableQuery.value.trim().toLowerCase()].filter(Boolean)
      : [];
  return currentRows.value.filter((row) => {
    if (!showAvailable.value && (row.status === 'available' || row.leaseStatus === 'available'))
      return false;
    const status = activeView.value === 'dhcp' ? row.leaseStatus : row.status;
    const type =
      activeView.value === 'dns'
        ? row.raw?.record_type || row.zoneType
        : activeView.value === 'dhcp'
          ? row.raw?.dhcp_assignment_type
          : row.type;
    const protocol =
      activeView.value === 'dns'
        ? row.raw?.dns_source
        : activeView.value === 'dhcp'
          ? row.raw?.dhcp_assignment_type
          : row.raw?.allocation_source_type;
    if (filters.value.status && String(status) !== filters.value.status) return false;
    if (filters.value.type && String(type) !== filters.value.type) return false;
    if (
      filters.value.online &&
      String(row.raw?.is_online === 1 || row.online === 'online') !== filters.value.online
    )
      return false;
    if (filters.value.scan && String(Boolean(row.raw?.scanning_enabled)) !== filters.value.scan)
      return false;
    if (filters.value.protocol && String(protocol) !== filters.value.protocol) return false;
    if (
      (globalQuery || tableQuery.value.trim()) &&
      activeView.value === 'networks' &&
      !matchedNetworkIds.value?.has(Number(row.raw.id))
    )
      return false;
    return localQueries.every((query) =>
      Object.entries(row).some(
        ([key, value]) =>
          key !== 'raw' &&
          String(value ?? '')
            .toLowerCase()
            .includes(query),
      ),
    );
  });
});

const detailTitle = computed(() => {
  if (selectedRowView.value === 'networks') return 'Network';
  if (selectedRowView.value === 'dns')
    return selectedRowContext.value === 'network' ? 'DNS record' : 'DNS zone';
  if (selectedRowView.value === 'dhcp')
    return selectedRowContext.value === 'network' ? 'DHCP address' : 'DHCP scope';
  return selectedRowView.value === 'ranges' ? 'Managed range' : 'IP address';
});
const detailHeading = computed(
  () =>
    selectedRow.value?.address || selectedRow.value?.name || selectedRow.value?.range || 'Resource',
);
const detailSubheading = computed(
  () =>
    selectedRow.value?.hostname ||
    selectedRow.value?.value ||
    selectedRow.value?.description ||
    contextTitle.value,
);
const detailIcon = computed(() =>
  selectedRowView.value === 'dns'
    ? 'pi pi-globe'
    : selectedRowView.value === 'dhcp'
      ? 'pi pi-server'
      : selectedRowView.value === 'ranges'
        ? 'pi pi-clone'
        : 'pi pi-desktop',
);
const detailItems = computed(() =>
  Object.entries(selectedRow.value || {})
    .filter(([key]) => !['id', 'online', 'enabled', 'raw'].includes(key))
    .slice(0, 8)
    .map(([key, value]) => ({
      label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase()),
      value,
    })),
);
const relatedResources = computed(() =>
  selectedRowContext.value !== 'network'
    ? []
    : selectedRowView.value === 'addresses'
      ? [
          {
            view: 'dns',
            label: 'DNS records',
            note: `${networkDnsRows.value.filter((row) => row.value === selectedRow.value?.address).length} records reference this address`,
            icon: 'pi pi-globe',
          },
          {
            view: 'dhcp',
            label: 'DHCP identity',
            note: `${networkDhcpRows.value.filter((row) => row.address === selectedRow.value?.address).length} related rows`,
            icon: 'pi pi-server',
          },
        ]
      : [
          {
            view: 'addresses',
            label: 'Canonical IP record',
            note: 'Allocation and liveness details',
            icon: 'pi pi-list',
          },
          {
            view: selectedRowView.value === 'dns' ? 'dhcp' : 'dns',
            label: selectedRowView.value === 'dns' ? 'DHCP identity' : 'DNS records',
            note: 'Related service facts',
            icon: selectedRowView.value === 'dns' ? 'pi pi-server' : 'pi pi-globe',
          },
        ],
);
const selectedAddressDnsCount = computed(
  () =>
    networkDnsRows.value.filter(
      (row) =>
        row.value === selectedRow.value?.address ||
        row.raw.ip_address === selectedRow.value?.address,
    ).length,
);
const selectedAddressDhcpCount = computed(
  () => networkDhcpRows.value.filter((row) => row.address === selectedRow.value?.address).length,
);
const rowActions = computed(() => {
  const row = selectedRow.value;
  if (selectedRowView.value === 'networks')
    return can('subnets:write')
      ? ['Open network context', 'Edit network', 'Scan network']
      : ['Open network context'];
  if (selectedRowContext.value !== 'network' && selectedRowView.value === 'dns')
    return can('dns:write')
      ? ['Open zone', 'Edit zone', 'Add DNS record', 'Delete zone']
      : ['Open zone'];
  if (selectedRowContext.value !== 'network' && selectedRowView.value === 'dhcp')
    return can('dhcp:write')
      ? [
          'Open scope',
          'Open network DHCP',
          'Edit DHCP scope',
          'Add DHCP Reservation',
          'Sync leases now',
          'Delete DHCP scope',
        ]
      : ['Open scope', 'Open network DHCP'];
  if (selectedRowView.value === 'dns')
    return can('dns:write')
      ? ['Open IP details', 'Open whole zone', 'Edit record', 'Add CNAME', 'Delete record']
      : ['Open IP details', 'Open whole zone'];
  if (selectedRowView.value === 'dhcp') {
    if (!can('dhcp:write')) return ['Open IP details', 'Open scope'];
    if (row?.assignment === 'Reserved')
      return [
        'Open IP details',
        'Open scope',
        'Edit DHCP Reservation',
        ...(can('subnets:write') ? ['Probe now'] : []),
        'Delete DHCP Reservation',
      ];
    return [
      'Open IP details',
      'Open scope',
      'Add DHCP Reservation',
      ...(can('subnets:write') ? ['Probe now'] : []),
    ];
  }
  if (selectedRowView.value === 'ranges') {
    if (row?.rangeType === 'DHCP Scope')
      return can('dhcp:write')
        ? ['Edit DHCP scope', 'Remove addresses from scope', 'Delete DHCP scope']
        : [];
    return [
      ...(can('subnets:write') ? ['Edit range'] : []),
      ...(can('dhcp:write') ? ['Create DHCP scope'] : []),
      ...(can('subnets:write') ? ['Delete range'] : []),
    ];
  }

  if (!can('subnets:write')) return ['Open full details'];
  const actions = ['Open full details'];
  if (row?.type === 'gateway') actions.push('Edit gateway', 'Delete gateway', 'Create DHCP scope');
  else if (row?.status === 'DHCP Scope')
    actions.push('Edit DHCP scope', 'Remove this IP from scope', 'Delete DHCP scope');
  if (row?.type === 'IP Reservation') actions.push('Release IP Reservation');
  else if (!['system', 'gateway'].includes(row?.type)) actions.push('Create IP Reservation');
  if (row?.type === 'dynamic DHCP' || row?.status === 'DHCP Scope')
    actions.push('Create DHCP Reservation');
  actions.push('Set range type', 'Change scan setting', 'Probe now');
  return actions;
});

const gridCells = computed(() =>
  addressRows.value.map((row) => ({
    ip: row.address,
    last: row.address.split('.').at(-1),
    kind: gridKind(row),
    label: row.type || row.status || 'Available',
    row,
  })),
);

const rowTotal = computed(() => {
  if (activeView.value === 'addresses') return addressFilteredTotal.value;
  if (activeView.value === 'dns' && (contextKind.value === 'network' || selectedZoneFilter.value))
    return dnsTotal.value;
  if (activeView.value === 'dhcp' && (contextKind.value === 'network' || selectedScopeFilter.value))
    return dhcpTotal.value;
  return currentRows.value.length;
});

function toggleFolder(id) {
  const next = new Set(expandedFolders.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedFolders.value = next;
}
async function selectNetwork(network) {
  selectedNetwork.value = network;
  selectedFolder.value =
    folders.value.find((folder) => Number(folder.id) === Number(network.folderId)) || null;
  contextKind.value = 'network';
  if (!networkViews.some((view) => view.key === activeView.value)) activeView.value = 'addresses';
  currentPage.value = 1;
  sortKey.value = null;
  clearFilters();
  selectedZoneFilter.value = null;
  selectedScopeFilter.value = null;
  selectedRow.value = null;
  tableQuery.value = '';
  await updateWorkspaceRoute();
  await loadNetworkContext();
}
function selectUnallocatedNetwork(network) {
  selectedRow.value = mapNetworkRows([network])[0];
  selectedRowView.value = 'networks';
  selectedRowContext.value = 'unallocated';
}
function resetContextNavigation() {
  currentPage.value = 1;
  sortKey.value = null;
  clearFilters();
  selectedZoneFilter.value = null;
  selectedScopeFilter.value = null;
  selectedRow.value = null;
  selectedRows.value = [];
  tableQuery.value = '';
}
function selectEstate() {
  contextKind.value = 'estate';
  selectedFolder.value = null;
  if (!aggregateViews.some((view) => view.key === activeView.value)) activeView.value = 'networks';
  resetContextNavigation();
  updateWorkspaceRoute();
}
function selectFolder(folder) {
  contextKind.value = 'folder';
  selectedFolder.value = folder;
  if (!expandedFolders.value.has(folder.id)) toggleFolder(folder.id);
  if (!aggregateViews.some((view) => view.key === activeView.value)) activeView.value = 'networks';
  resetContextNavigation();
  updateWorkspaceRoute();
}
function selectUnallocated() {
  contextKind.value = 'unallocated';
  selectedFolder.value = null;
  activeView.value = 'networks';
  resetContextNavigation();
  updateWorkspaceRoute();
}
function selectFolderById(folderId) {
  const folder = folders.value.find((item) => Number(item.id) === Number(folderId));
  if (folder) selectFolder(folder);
}
async function switchView(view) {
  activeView.value = view;
  currentPage.value = 1;
  sortKey.value = null;
  clearFilters();
  selectedZoneFilter.value = null;
  selectedScopeFilter.value = null;
  selectedRow.value = null;
  selectedRows.value = [];
  tableQuery.value = '';
  await updateWorkspaceRoute();
  if (contextKind.value === 'network') await loadNetworkContext();
  else await refreshAggregateTable();
}
async function openRelatedResource(view) {
  activeView.value = view;
  currentPage.value = 1;
  sortKey.value = null;
  clearFilters();
  selectedZoneFilter.value = null;
  selectedScopeFilter.value = null;
  selectedRows.value = [];
  tableQuery.value = '';
  await updateWorkspaceRoute();
  if (contextKind.value === 'network') await loadNetworkContext();
}
function toggleMenu(name) {
  openMenuName.value = openMenuName.value === name ? null : name;
}
function chooseMenuAction(label) {
  openMenuName.value = null;
  notify(label);
}
function openRowMenu(row) {
  selectRow(row);
  openMenuName.value = 'row';
}
function selectRow(row) {
  selectedRow.value = row;
  selectedRowView.value = activeView.value;
  selectedRowContext.value = contextKind.value;
  updateWorkspaceRoute();
}
function notify(message) {
  notice.value = `${message}. Data is live, but this action is still available in the Current interface while workspace mutations are connected.`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = '';
  }, 2600);
}
async function handleDetailsAction(action) {
  if (action === 'Open whole zone' && selectedRow.value?.raw?.zone_id) {
    const zone = dnsZones.value.find(
      (item) => Number(item.id) === Number(selectedRow.value.raw.zone_id),
    );
    if (zone) {
      selectedZoneFilter.value = zone;
      selectedScopeFilter.value = null;
      selectedRow.value = null;
      currentPage.value = 1;
      await updateWorkspaceRoute();
      await loadNetworkContext();
      return;
    }
  }
  if (
    action === 'Open scope' &&
    selectedRowContext.value === 'network' &&
    selectedRow.value?.raw?.scope_id
  ) {
    const scope = dhcpScopes.value.find(
      (item) => Number(item.id) === Number(selectedRow.value.raw.scope_id),
    );
    if (scope) {
      selectedScopeFilter.value = scope;
      selectedZoneFilter.value = null;
      selectedRow.value = null;
      currentPage.value = 1;
      await updateWorkspaceRoute();
      await loadNetworkContext();
      return;
    }
  }
  if (action === 'Open zone' && selectedRow.value?.raw) {
    const zone = selectedRow.value.raw;
    selectedZoneFilter.value = zone;
    selectedScopeFilter.value = null;
    selectedRow.value = null;
    currentPage.value = 1;
    await updateWorkspaceRoute();
    await refreshAggregateTable();
    return;
  }
  if (action === 'Open scope' && selectedRow.value?.raw) {
    selectedScopeFilter.value = selectedRow.value.raw;
    selectedZoneFilter.value = null;
    selectedRow.value = null;
    currentPage.value = 1;
    await updateWorkspaceRoute();
    await refreshAggregateTable();
    return;
  }
  if (action === 'Open network DHCP' && selectedRow.value?.raw?.subnet_id) {
    const network = allNetworks.value.find(
      (item) => Number(item.id) === Number(selectedRow.value.raw.subnet_id),
    );
    if (network) {
      activeView.value = 'dhcp';
      await selectNetwork(network);
      return;
    }
  }
  notify(action);
}
function showLiveNotice(message) {
  notice.value = message;
  noticeRetry.value = null;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = '';
  }, 3200);
}
async function retryNoticeRefresh() {
  const retry = noticeRetry.value;
  if (!retry) return;
  noticeRetry.value = null;
  await retry();
}
function clearFilter(key) {
  filters.value = { ...filters.value, [key]: '' };
}
function clearFilters() {
  filters.value = { status: '', type: '', online: '', scan: '', range: '', protocol: '' };
}
function toggleRow(id) {
  selectedRows.value = selectedRows.value.includes(id)
    ? selectedRows.value.filter((rowId) => rowId !== id)
    : [...selectedRows.value, id];
}
function toggleAllRows(event) {
  selectedRows.value = event.target.checked ? filteredRows.value.map((row) => row.id) : [];
}
function openGridCell(cell) {
  selectRow(cell.row);
}
function resizeSmallText(delta) {
  fontBump.value = Math.min(2, Math.max(0, fontBump.value + delta));
  saveJson('cidrella_workspace_font_bump', fontBump.value);
}
function setVisibleColumns(nextColumns) {
  const keys = restoreWorkspaceColumnKeys(
    columnKind.value,
    nextColumns.map((column) => column.key),
  );
  visibleColumnKeys.value = { ...visibleColumnKeys.value, [columnStorageKey.value]: keys };
  saveJson(columnStorageKey.value, keys);
}
function resetVisibleColumns() {
  const keys = defaultWorkspaceColumnKeys(columnKind.value);
  visibleColumnKeys.value = { ...visibleColumnKeys.value, [columnStorageKey.value]: keys };
  saveJson(columnStorageKey.value, keys);
}
async function filterToZone(zone) {
  selectedZoneFilter.value = selectedZoneFilter.value?.id === zone.id ? null : zone;
  selectedScopeFilter.value = null;
  tableQuery.value = '';
  await updateWorkspaceRoute();
  if (contextKind.value === 'network') await loadNetworkContext();
  else await refreshAggregateTable();
}
async function filterToScope(scope) {
  selectedScopeFilter.value = selectedScopeFilter.value?.id === scope.id ? null : scope;
  selectedZoneFilter.value = null;
  tableQuery.value = '';
  await updateWorkspaceRoute();
  if (contextKind.value === 'network') await loadNetworkContext();
  else await refreshAggregateTable();
}

async function loadNetworkContext() {
  if (!selectedNetwork.value.id) return;
  const request = ++contextRequest;
  loadingContext.value = true;
  loadError.value = '';
  try {
    const params = {
      page: activeView.value === 'addresses' ? currentPage.value : 1,
      pageSize: pageSize.value,
      showAvailable: showAvailable.value ? 'true' : 'false',
    };
    if (activeView.value === 'addresses') {
      params.search = resourceQuery.value.trim() || undefined;
      params.table_search = tableQuery.value.trim() || undefined;
      params.display_status = filters.value.status || undefined;
      params.address_type = filters.value.type || undefined;
      params.online = filters.value.online || undefined;
      params.scanning_enabled = filters.value.scan || undefined;
      params.network_range_type_id = filters.value.range || undefined;
      params.allocation_source_type = filters.value.protocol || undefined;
    }
    const addressSortColumn = workspaceColumnCatalog('addresses').find(
      (column) => column.key === sortKey.value,
    );
    if (addressSortColumn) {
      params.sortField = addressSortColumn.sortField || addressSortColumn.field;
      params.sortOrder = sortOrder.value === 1 ? 'asc' : 'desc';
    }
    const protocolParams = {
      subnet_id: selectedNetwork.value.id,
      q: resourceQuery.value.trim() || undefined,
      table_q: tableQuery.value.trim() || undefined,
      page: currentPage.value,
      page_size: pageSize.value,
      sort_order: sortOrder.value === 1 ? 'asc' : 'desc',
    };
    if (activeView.value === 'dns') {
      protocolParams.zone_id = selectedZoneFilter.value?.id || undefined;
      protocolParams.record_type = filters.value.type || undefined;
      protocolParams.dns_source = filters.value.protocol || undefined;
      if (filters.value.status) protocolParams.enabled = filters.value.status === 'enabled';
    }
    if (activeView.value === 'dhcp') {
      protocolParams.scope_id = selectedScopeFilter.value?.id || undefined;
      protocolParams.lease_status = filters.value.status || undefined;
      protocolParams.dhcp_assignment_type =
        filters.value.type || filters.value.protocol || undefined;
    }
    const activeColumn = columnCatalog.value.find((column) => column.key === sortKey.value);
    if (activeColumn?.sortField || activeColumn?.field) {
      protocolParams.sort_field = activeColumn.sortField || activeColumn.field;
    }
    const [detail, dns, dhcp] = await Promise.all([
      workspaceResources.loadAddresses(selectedNetwork.value.id, params),
      workspaceResources.loadDns(protocolParams),
      workspaceResources.loadDhcp(protocolParams),
      workspaceResources.loadSummary(selectedNetwork.value.id),
      workspaceResources.loadDnsTotal({ subnet_id: selectedNetwork.value.id }),
      workspaceResources.loadDhcpTotal({ subnet_id: selectedNetwork.value.id }),
    ]);
    if (request !== contextRequest) return;
    if (!detail && ['addresses', 'ranges'].includes(activeView.value))
      throw new Error(workspaceResources.resources.addresses.error || 'Address data unavailable');
    if (detail) addressRows.value = mapAddressRows(detail.items);
    if (
      selectedRow.value &&
      selectedRowView.value === 'addresses' &&
      selectedRowContext.value === 'network'
    ) {
      const visible = addressRows.value.find((row) => row.address === selectedRow.value.address);
      if (visible) selectedRow.value = visible;
      else {
        const pinned = await workspaceResources.loadAddressDetail(
          selectedNetwork.value.id,
          selectedRow.value.address,
        );
        if (request !== contextRequest) return;
        if (pinned) selectedRow.value = mapAddressRows([pinned])[0];
        else {
          selectedRow.value = null;
          showLiveNotice('The selected address is no longer available.');
        }
      }
    }
    if (detail) rangeRows.value = mapRangeRows(detail.ranges, networkScopes.value);
    addressFilteredTotal.value = detail?.filteredTotal || 0;
    addressTotal.value = Number(
      workspaceResources.resources.summary.data?.total_addresses ?? detail?.total ?? 0,
    );
    if (activeView.value === 'addresses') {
      totalPages.value = detail?.totalPages || 1;
      currentPage.value = detail?.page || 1;
    }
    if (dns) {
      networkDnsRowsData.value = mapWorkspaceDnsRows(dns.items);
      dnsTotal.value = dns.total;
      if (activeView.value === 'dns')
        totalPages.value = Math.max(1, Math.ceil(dns.total / pageSize.value));
    }
    if (dhcp) {
      networkDhcpRows.value = mapDhcpRows(dhcp.items);
      dhcpTotal.value = dhcp.total;
      if (activeView.value === 'dhcp')
        totalPages.value = Math.max(1, Math.ceil(dhcp.total / pageSize.value));
    }
  } catch (error) {
    if (request === contextRequest) loadError.value = apiError(error);
  } finally {
    if (request === contextRequest) loadingContext.value = false;
  }
}

async function refreshSelectedNetwork() {
  const selectedId = Number(selectedNetwork.value.id);
  const treeResponse = await api.get('/subnets');
  folders.value = preserveEmptyFolders(
    buildExplorerFolders(treeResponse.data.folders),
    treeResponse.data.folders,
  );
  unallocatedFolders.value = buildUnallocatedFolders(treeResponse.data.folders);
  const refreshed = folders.value
    .flatMap((folder) => folder.networks)
    .find((network) => Number(network.id) === selectedId);
  if (refreshed) {
    selectedNetwork.value = refreshed;
    selectedFolder.value =
      folders.value.find((folder) => Number(folder.id) === Number(refreshed.folderId)) ||
      selectedFolder.value;
  } else {
    const priorFolder = folders.value.find(
      (folder) => Number(folder.id) === Number(selectedFolder.value?.id),
    );
    contextKind.value = priorFolder ? 'folder' : 'estate';
    selectedFolder.value = priorFolder || null;
    activeView.value = 'networks';
    selectedRow.value = null;
    showLiveNotice(
      `The selected network no longer exists. Showing ${priorFolder?.name || 'All Networks'}.`,
    );
    await updateWorkspaceRoute({ replace: true });
    return;
  }
  await loadNetworkContext();
}

async function revalidateWorkspaceContext() {
  let message = '';
  if (contextKind.value === 'folder') {
    const folder = folders.value.find(
      (item) => Number(item.id) === Number(selectedFolder.value?.id),
    );
    if (!folder) {
      contextKind.value = 'estate';
      selectedFolder.value = null;
      activeView.value = 'networks';
      message = 'The selected folder no longer exists. Showing All Networks.';
    } else selectedFolder.value = folder;
  }
  if (contextKind.value === 'network') {
    const network = allNetworks.value.find(
      (item) => Number(item.id) === Number(selectedNetwork.value?.id),
    );
    if (!network) {
      const folder = folders.value.find(
        (item) => Number(item.id) === Number(selectedFolder.value?.id),
      );
      contextKind.value = folder ? 'folder' : 'estate';
      selectedFolder.value = folder || null;
      activeView.value = 'networks';
      selectedRow.value = null;
      message = `The selected network no longer exists. Showing ${folder?.name || 'All Networks'}.`;
    } else selectedNetwork.value = network;
  }
  if (
    selectedZoneFilter.value &&
    !dnsZones.value.some((zone) => Number(zone.id) === Number(selectedZoneFilter.value.id))
  ) {
    selectedZoneFilter.value = null;
    selectedRow.value = null;
    message = 'The selected DNS zone no longer exists. Showing the zone inventory.';
  }
  if (
    selectedScopeFilter.value &&
    !dhcpScopes.value.some((scope) => Number(scope.id) === Number(selectedScopeFilter.value.id))
  ) {
    selectedScopeFilter.value = null;
    selectedRow.value = null;
    message = 'The selected DHCP scope no longer exists. Showing the scope inventory.';
  }
  if (message) {
    showLiveNotice(message);
    await updateWorkspaceRoute({ replace: true });
  }
}

async function handleAddressChanged(message) {
  showLiveNotice(`${message}. Saved.`);
  try {
    await refreshSelectedNetwork();
  } catch (error) {
    clearTimeout(noticeTimer);
    notice.value = `${message}. Saved. Live data could not be refreshed: ${apiError(error)}`;
    const retry = async () => {
      try {
        await refreshSelectedNetwork();
        showLiveNotice('Live data refreshed.');
      } catch (retryError) {
        clearTimeout(noticeTimer);
        notice.value = `Saved. Live data still could not be refreshed: ${apiError(retryError)}`;
        noticeRetry.value = retry;
      }
    };
    noticeRetry.value = retry;
  }
}

async function loadWorkspace() {
  loading.value = true;
  loadingContext.value = true;
  loadError.value = '';
  try {
    const [tree, networks, zones, dns, scopes, dhcp] = await Promise.all([
      workspaceResources.loadTree(),
      workspaceResources.loadNetworks({ q: resourceQuery.value.trim() || undefined }),
      workspaceResources.loadZones(),
      workspaceResources.loadDns({ q: resourceQuery.value.trim() || undefined, page_size: 256 }),
      workspaceResources.loadScopes(),
      workspaceResources.loadDhcp({ q: resourceQuery.value.trim() || undefined, page_size: 256 }),
    ]);
    if (!tree)
      throw new Error(workspaceResources.resources.tree.error || 'Network tree unavailable');
    folders.value = preserveEmptyFolders(buildExplorerFolders(tree.folders), tree.folders);
    unallocatedFolders.value = buildUnallocatedFolders(tree.folders);
    dnsZones.value = zones || [];
    dhcpScopes.value = scopes || [];
    allDhcpRows.value = mapDhcpRows(dhcp?.items || []);
    allDnsRows.value = mapWorkspaceDnsRows(dns?.items || []);
    expandedFolders.value = new Set(
      [...folders.value, ...unallocatedFolders.value].map((folder) => folder.id),
    );
    const availableNetworks = folders.value.flatMap((folder) => folder.networks);
    const priorSelection = availableNetworks.find(
      (network) => Number(network.id) === Number(selectedNetwork.value.id),
    );
    if (priorSelection || availableNetworks[0]) {
      selectedNetwork.value = priorSelection || availableNetworks[0];
      selectedFolder.value =
        folders.value.find(
          (folder) => Number(folder.id) === Number(selectedNetwork.value.folderId),
        ) || null;
    }
    matchedNetworkIds.value =
      resourceQuery.value.trim() || tableQuery.value.trim()
        ? new Set((networks?.items || []).map((network) => Number(network.id)))
        : null;
    restoreContextFromRoute(availableNetworks);
    if (contextKind.value !== 'network' && (selectedZoneFilter.value || selectedScopeFilter.value))
      await refreshAggregateTable();
    loadingContext.value = false;
  } catch (error) {
    loadError.value = apiError(error);
    loadingContext.value = false;
  } finally {
    loading.value = false;
  }
}

async function changePage(page) {
  if (!serverPagedView.value || page < 1 || page > totalPages.value) return;
  currentPage.value = page;
  selectedRows.value = [];
  await updateWorkspaceRoute();
  if (contextKind.value === 'network') await loadNetworkContext();
  else await refreshAggregateTable();
}

async function sortBy(key) {
  sortOrder.value = sortKey.value === key ? sortOrder.value * -1 : 1;
  sortKey.value = key;
  if (serverPagedView.value) {
    currentPage.value = 1;
    if (contextKind.value === 'network') await loadNetworkContext();
    else await refreshAggregateTable();
  }
}

async function refreshAggregateTable() {
  const params = {
    folder_id: contextKind.value === 'folder' ? selectedFolder.value?.id : undefined,
    q: resourceQuery.value.trim() || undefined,
    table_q: tableQuery.value.trim() || undefined,
    page: currentPage.value,
    page_size: pageSize.value,
  };
  if (activeView.value === 'dns') {
    const zoneParams = {
      folder_id: params.folder_id,
      q: params.q,
      type: selectedZoneFilter.value ? undefined : filters.value.type || undefined,
      enabled: selectedZoneFilter.value
        ? undefined
        : filters.value.status
          ? filters.value.status === 'enabled'
          : undefined,
    };
    const recordParams = {
      ...params,
      zone_id: selectedZoneFilter.value?.id || undefined,
      record_type: filters.value.type || undefined,
      dns_source: filters.value.protocol || undefined,
      enabled: filters.value.status ? filters.value.status === 'enabled' : undefined,
    };
    const activeColumn = columnCatalog.value.find((column) => column.key === sortKey.value);
    if (activeColumn?.sortField || activeColumn?.field)
      recordParams.sort_field = activeColumn.sortField || activeColumn.field;
    recordParams.sort_order = sortOrder.value === 1 ? 'asc' : 'desc';
    const [zones, dns] = await Promise.all([
      workspaceResources.loadZones(zoneParams),
      workspaceResources.loadDns(recordParams),
    ]);
    if (zones) dnsZones.value = zones;
    if (dns) {
      allDnsRows.value = mapWorkspaceDnsRows(dns.items);
      dnsTotal.value = dns.total;
      if (selectedZoneFilter.value)
        totalPages.value = Math.max(1, Math.ceil(dns.total / pageSize.value));
    }
  } else if (activeView.value === 'dhcp') {
    const scopeParams = {
      folder_id: params.folder_id,
      q: params.q,
      enabled: selectedScopeFilter.value
        ? undefined
        : filters.value.status
          ? filters.value.status === 'enabled'
          : undefined,
    };
    const addressParams = {
      ...params,
      scope_id: selectedScopeFilter.value?.id || undefined,
      lease_status: filters.value.status || undefined,
      dhcp_assignment_type: filters.value.type || filters.value.protocol || undefined,
    };
    const activeColumn = columnCatalog.value.find((column) => column.key === sortKey.value);
    if (activeColumn?.sortField || activeColumn?.field)
      addressParams.sort_field = activeColumn.sortField || activeColumn.field;
    addressParams.sort_order = sortOrder.value === 1 ? 'asc' : 'desc';
    const [scopes, dhcp] = await Promise.all([
      workspaceResources.loadScopes(scopeParams),
      workspaceResources.loadDhcp(addressParams),
    ]);
    if (scopes) dhcpScopes.value = scopes;
    if (dhcp) {
      allDhcpRows.value = mapDhcpRows(dhcp.items);
      dhcpTotal.value = dhcp.total;
      if (selectedScopeFilter.value)
        totalPages.value = Math.max(1, Math.ceil(dhcp.total / pageSize.value));
    }
  } else {
    const networks = await workspaceResources.loadNetworks(params);
    matchedNetworkIds.value =
      resourceQuery.value.trim() || tableQuery.value.trim()
        ? new Set((networks?.items || []).map((network) => Number(network.id)))
        : null;
  }
}

function retryVisibleResource() {
  if (contextKind.value === 'network') return loadNetworkContext();
  return refreshAggregateTable();
}

async function refreshCurrentContext() {
  if (backgroundRefreshRunning || loading.value || loadingContext.value) return;
  backgroundRefreshRunning = true;
  try {
    const [tree, zones, scopes] = await Promise.all([
      workspaceResources.loadTree(),
      workspaceResources.loadZones(),
      workspaceResources.loadScopes(),
    ]);
    if (tree) {
      const selectedId = Number(selectedNetwork.value.id);
      folders.value = preserveEmptyFolders(buildExplorerFolders(tree.folders), tree.folders);
      unallocatedFolders.value = buildUnallocatedFolders(tree.folders);
      const refreshed = allNetworks.value.find((network) => Number(network.id) === selectedId);
      if (refreshed) selectedNetwork.value = refreshed;
    }
    if (zones) dnsZones.value = zones;
    if (scopes) dhcpScopes.value = scopes;
    await revalidateWorkspaceContext();
    if (contextKind.value === 'network') await loadNetworkContext();
    else await refreshAggregateTable();
  } finally {
    backgroundRefreshRunning = false;
  }
}

watch(showAvailable, () => {
  if (activeView.value !== 'addresses' || contextKind.value !== 'network') return;
  currentPage.value = 1;
  loadNetworkContext();
});

watch(tableQuery, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    currentPage.value = 1;
    updateWorkspaceRoute({ replace: true });
    if (contextKind.value === 'network') loadNetworkContext();
    else refreshAggregateTable();
  }, 300);
});

watch(resourceQuery, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    currentPage.value = 1;
    updateWorkspaceRoute({ replace: true });
    const query = resourceQuery.value.trim();
    workspaceResources.loadNetworks({ q: query || undefined }).then((networks) => {
      matchedNetworkIds.value = query
        ? new Set((networks?.items || []).map((network) => Number(network.id)))
        : null;
    });
    if (contextKind.value === 'network') loadNetworkContext();
    else refreshAggregateTable();
  }, 300);
});

watch(
  filters,
  () => {
    if (restoringRoute) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentPage.value = 1;
      updateWorkspaceRoute({ replace: true });
      if (contextKind.value === 'network') loadNetworkContext();
      else refreshAggregateTable();
    }, 100);
  },
  { deep: true },
);

watch(pageSize, () => {
  currentPage.value = 1;
  selectedRows.value = [];
  updateWorkspaceRoute({ replace: true });
  if (contextKind.value === 'network') loadNetworkContext();
  else refreshAggregateTable();
});

watch(addressPresentation, () => updateWorkspaceRoute({ replace: true }));

watch(
  routeState,
  () => {
    if (pendingRouteWrites) {
      pendingRouteWrites -= 1;
      return;
    }
    if (!loading.value) {
      restoreContextFromRoute(allNetworks.value);
      if (contextKind.value === 'network') {
        if (!routeState.value.ip) loadNetworkContext();
      } else {
        refreshAggregateTable();
      }
    }
  },
  { deep: true },
);

useAutoRefresh(refreshCurrentContext);
onMounted(loadWorkspace);
onUnmounted(() => {
  clearTimeout(searchTimer);
  clearTimeout(noticeTimer);
  workspaceResources.invalidate(
    'tree',
    'networks',
    'zones',
    'dns',
    'dnsTotal',
    'scopes',
    'dhcp',
    'dhcpTotal',
    'addresses',
    'summary',
    'detail',
  );
});
</script>

<style scoped src="./workspace.css"></style>
