<template>
  <div
    class="workspace"
    data-track="networks-workspace"
    :style="{ '--workspace-font-bump': fontBumpStyle }"
  >
    <section
      class="workspace-frame"
      :class="{
        'details-open': selectedRow,
        'grid-open': activeView === 'addresses' && effectivePresentation !== 'table',
      }"
    >
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
        :can-move-networks="can('subnets:write')"
        @create="toggleMenu('create')"
        @select-estate="selectEstate"
        @select-unallocated="selectUnallocated"
        @select-folder="selectFolder"
        @select-network="selectNetwork"
        @select-unallocated-network="selectUnallocatedNetwork"
        @toggle-folder="toggleFolder"
        @folder-menu="openFolderMenu"
        @network-menu="openNetworkMenu"
        @move-network="moveNetworkToFolder"
        @action="runContextAction"
      />

      <section class="work-surface" aria-label="Work surface" :aria-busy="loadingContext">
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
          :has-actions="actionMenuItems.length > 0"
          :can-create="canAnyCreate"
          :views="availableViews"
          :active-view="activeView"
          :show-summary="showViewSummary"
          :view-meta="viewMeta"
          :summary-zones="summaryZones"
          :summary-scopes="summaryScopes"
          :selected-zone="selectedZoneFilter"
          :selected-scope="selectedScopeFilter"
          :address-overview="addressOverview"
          @select-estate="selectEstate"
          @select-folder="selectFolderById"
          @switch-view="switchView"
          @open-menu="toggleMenu"
          @filter-zone="filterToZone"
          @filter-scope="filterToScope"
          @zone-menu="(zone, invoker, event) => openLinkedMenu('zone', zone, invoker, event)"
          @scope-menu="(scope, invoker, event) => openLinkedMenu('scope', scope, invoker, event)"
          @action="runContextAction"
        />
        <section class="table-card" :class="{ 'is-loading': loadingContext }">
          <!-- Loading sits over the table as a popover and dims what is under
               it, instead of pushing the toolbar down with a bar. -->
          <div
            v-if="loadingContext"
            class="loading-overlay"
            role="status"
            aria-live="polite"
            data-track="workspace-loading"
          >
            <div class="loading-popover">
              <i class="pi pi-spin pi-spinner" /> Loading live data…
            </div>
          </div>
          <div v-if="visibleResourceError && !loadingContext" class="workspace-error" role="alert">
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
            :allow-grid="!isV6Network"
            :active-view="activeView"
            :context-kind="contextKind"
            :view-meta="viewMeta"
            :filter-options="filterOptions"
            :column-table-name="columnTableName"
            :column-catalog="columnCatalog"
            :columns="columns"
            :can-create="canCreateCurrent"
            :selection-actions="selectionActions"
            :filter-chips="activeFilterChips"
            @update:visible-columns="setVisibleColumns"
            @reset-columns="resetVisibleColumns"
            @clear-filter="clearFilter"
            @clear-filters="clearFilters"
            @add="runViewAdd"
            @selection-action="runSelectionAction"
          />

          <AddressGrid
            v-if="activeView === 'addresses' && effectivePresentation !== 'table'"
            :cells="gridCells"
            :density="effectivePresentation === 'compact-grid' ? 'compact' : 'spacious'"
            :selected-rows="selectedRows"
            @open="openGridCell"
            @toggle="toggleRow"
            @range-toggle="selectGridRange"
            @drag-select="selectGridDrag"
            @row-menu="openRowMenu"
          />
          <WorkspaceTable
            v-else
            :columns="columns"
            :rows="pagedRows"
            :show-checkboxes="['addresses', 'networks'].includes(activeView)"
            :selected-row-id="selectedRow?.id ?? null"
            :selected-rows="selectedRows"
            :sort-key="sortKey"
            :sort-order="sortOrder"
            :draggable-rows="activeView === 'networks' && can('subnets:write')"
            @sort="sortBy"
            @select="selectRow"
            @toggle-row="toggleRow"
            @toggle-all="toggleAllRows"
            @row-menu="openRowMenu"
            @row-dragstart="startNetworkDrag"
          />
          <footer class="table-footer">
            <span>{{ resultCountLabel }}</span>
            <!-- The same paginator the current interface's tables use. Server
                 paged views page through the API; the aggregate lists page the
                 loaded rows in the browser. -->
            <Paginator
              v-if="!gridMode || paginatorTotal > addressPageSize"
              :first="(activePage - 1) * addressPageSize"
              :rows="addressPageSize"
              :total-records="paginatorTotal"
              :rows-per-page-options="gridMode ? undefined : PAGE_SIZES"
              data-track="workspace-paginator"
              @page="onPaginatorPage"
            />
          </footer>
        </section>
      </section>

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
        :actions="rowMenuItems"
        @close="clearDetail"
        @navigate="openRelatedResource"
        @changed="refreshAfterMutation('address', $event)"
        @action="runRowAction"
      />
      <ApplyStatusBanner
        ref="applyStatus"
        :can-read="can('analytics:read')"
        :can-dns-write="can('dns:write')"
        :can-dhcp-write="can('dhcp:write')"
        :is-admin="user?.role === 'admin'"
        @changed="refreshAfterMutation('apply', $event)"
      />
    </section>

    <BulkActionDialog
      v-if="selectedNetwork.id"
      v-model:visible="bulkActionVisible"
      :subnet-id="selectedNetwork.id"
      :runs="selectionRuns"
      :mode="bulkActionMode"
      @complete="handleBulkComplete"
      @partial="handleBulkPartial"
    />
    <BulkRangeTypeDialog
      v-if="selectedNetwork.id"
      v-model:visible="bulkRangeVisible"
      :subnet-id="selectedNetwork.id"
      :selected-runs="selectionRuns"
      :range-types="rangeTypes"
      @saved="handleRangeTypeSaved"
    />
    <IpReservationEditor
      v-if="selectedNetwork.id && reservationTarget"
      v-model:visible="reservationEditorVisible"
      :subnet-id="selectedNetwork.id"
      :address="reservationTarget.address"
      :mode="reservationEditorMode"
      @saved="handleReservationSaved"
    />
    <RangeEditor
      v-if="selectedNetwork.id"
      v-model:visible="rangeEditorVisible"
      :subnet-id="selectedNetwork.id"
      :range="rangeEditorTarget"
      :range-types="rangeTypes"
      @type-created="addRangeTypes($event)"
      @saved="handleRangeChanged('Network range saved')"
      @deleted="handleRangeChanged('Network range deleted', { deleted: true })"
    />
    <AddressScanDialog
      v-if="selectedNetwork.id && scanTarget"
      v-model:visible="scanDialogVisible"
      :subnet-id="selectedNetwork.id"
      :address="scanTarget.address"
      :address-family="Number(scanTarget.raw?.address_family || 4)"
      :current-override="scanTarget.raw?.scan_enabled"
      :mode="scanDialogMode"
      @changed="refreshAfterMutation('address', $event)"
    />
    <FolderManagerDialog
      v-model:visible="folderManagerVisible"
      :folders="folders"
      @create="openFolderDialog('create')"
      @edit="openFolderDialog('edit', $event)"
      @delete="openFolderDialog('delete', $event)"
    />
    <NetworkDialogs
      v-if="networkDialogsMounted"
      ref="networkDialogs"
      :selected-node="networkDialogNode"
      :folders="folders"
      @folder-created="refreshAfterMutation('network')"
      @folder-updated="refreshAfterMutation('network')"
      @folder-deleted="refreshAfterMutation('network')"
      @network-created="refreshAfterMutation('network')"
      @network-configured="refreshAfterMutation('network')"
      @network-updated="refreshAfterMutation('network')"
      @network-divided="refreshAfterMutation('network')"
      @network-deleted="refreshAfterMutation('network')"
      @networks-merged="refreshAfterMutation('network')"
      @group-configured="refreshAfterMutation('network')"
    />
    <div v-if="protocolDialogsMounted" class="protocol-dialog-providers">
      <DnsPanel ref="dnsDialogs" dialogs-only @changed="refreshAfterMutation('dns', $event)" />
      <DhcpPanel ref="dhcpDialogs" dialogs-only @changed="refreshAfterMutation('dhcp', $event)" />
    </div>

    <div v-if="openMenuName" class="menu-scrim" @click="closeMenu" />
    <div
      v-if="openMenuName === 'create'"
      class="floating-menu create-menu"
      :style="menuStyle"
      role="menu"
      @keydown="handleMenuKeydown"
    >
      <span>CREATE RESOURCE</span>
      <button
        v-for="item in createMenuItems"
        :key="item.id"
        role="menuitem"
        @click="runMenuAction(item)"
      >
        <i :class="item.icon" /><span
          ><strong>{{ item.label }}</strong
          ><small>{{ item.note }}</small></span
        >
      </button>
    </div>
    <div
      v-if="openMenuName === 'actions'"
      class="floating-menu actions-menu"
      :style="menuStyle"
      role="menu"
      @keydown="handleMenuKeydown"
    >
      <span>{{ actionMenuTitle }}</span>
      <button
        v-for="item in actionMenuItems"
        :key="item.id"
        role="menuitem"
        :class="{ danger: item.danger }"
        @click="runMenuAction(item)"
      >
        <i :class="item.icon" /><span
          ><strong>{{ item.label }}</strong
          ><small>{{ item.note }}</small></span
        >
      </button>
    </div>
    <div
      v-if="openMenuName === 'row'"
      class="floating-menu row-menu"
      :style="menuStyle"
      role="menu"
      @keydown="handleMenuKeydown"
    >
      <span>{{ rowMenuTitle }}</span>
      <template v-for="item in rowMenuItems" :key="item.id">
        <hr v-if="item.separatorBefore" class="menu-separator" role="separator" />
        <button role="menuitem" :class="{ danger: item.danger }" @click="runRowAction(item)">
          <i class="pi pi-angle-right" /><strong>{{ item.label }}</strong>
        </button>
      </template>
    </div>

    <Transition name="notice">
      <div v-if="notice" class="prototype-notice" role="status" aria-live="polite">
        <i class="pi pi-info-circle" /><span><strong>Workspace</strong>{{ notice }}</span>
        <button v-if="noticeRetry" type="button" @click="retryNoticeRefresh">Retry</button>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAutoRefresh } from '../../composables/useAutoRefresh.js';
import { usePermissions } from '../../composables/usePermissions.js';
import { useWorkspaceFontBump } from '../../composables/useWorkspaceUi.js';
import { useSubnetStore } from '../../stores/subnets.js';
import NetworkDialogs from '../../components/NetworkDialogs.vue';
import DnsPanel from '../../components/DnsPanel.vue';
import DhcpPanel from '../../components/DhcpPanel.vue';
import Paginator from '../../ui/Paginator.js';
import { apiError, countOf, formatNumber } from '../../utils/format.js';
import { loadJson, saveJson } from '../../utils/storage.js';
import AddressGrid from './AddressGrid.vue';
import ApplyStatusBanner from './ApplyStatusBanner.vue';
import ResourceExplorer from './ResourceExplorer.vue';
import WorkspaceContextHeader from './WorkspaceContextHeader.vue';
import WorkspaceDetailsHost from './WorkspaceDetailsHost.vue';
import WorkspaceTable from './WorkspaceTable.vue';
import WorkspaceToolbar from './WorkspaceToolbar.vue';
import BulkActionDialog from './dialogs/BulkActionDialog.vue';
import BulkRangeTypeDialog from './dialogs/BulkRangeTypeDialog.vue';
import IpReservationEditor from './dialogs/IpReservationEditor.vue';
import RangeEditor from './dialogs/RangeEditor.vue';
import AddressScanDialog from './dialogs/AddressScanDialog.vue';
import FolderManagerDialog from './dialogs/FolderManagerDialog.vue';
import { useWorkspaceContext } from './composables/useWorkspaceContext.js';
import { useWorkspaceResources } from './composables/useWorkspaceResources.js';
import { contiguousAddressRuns } from './composables/useWorkspaceSelection.js';
import { useRangeActions } from './composables/useRangeActions.js';
import { useWorkspaceActions } from './composables/useWorkspaceActions.js';
import { NETWORK_DRAG_TYPE, menuActions, targetForRow } from './workspace-actions.js';
import {
  defaultWorkspaceColumnKeys,
  restoreWorkspaceColumnKeys,
  workspaceColumnCatalog,
} from './workspace-columns.js';
import {
  buildExplorerFolders,
  gridKind,
  mapAddressRows,
  addressCountLabel,
  mapDhcpScopeRows,
  mapDhcpRows,
  mapDnsRows,
  mapDnsZoneRows,
  mapNetworkRows,
  mapRangeRows,
  sumScopeAddresses,
} from '../networks-workspace-data.js';
import { DHCP_V6_MODE_LABELS } from '../../utils/ip.js';

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
// An IPv6 network is shown as a table whatever the saved presentation says:
// its address space cannot be enumerated, so a grid would draw scattered
// rows as if they were contiguous. The saved choice is kept for the next
// IPv4 network.
const isV6Network = computed(
  () =>
    contextKind.value === 'network' &&
    Number(
      selectedNetwork.value?.address_family ?? selectedNetwork.value?.raw?.address_family ?? 4,
    ) === 6,
);
const effectivePresentation = computed(() =>
  isV6Network.value ? 'table' : addressPresentation.value,
);
// The grid draws the whole network at once, up to a /20; the table keeps
// its 32 to 512 rows a page. A /19 or larger pages the grid in /20 chunks.
// Measured 2026-09-22: a /20 draws in 200 ms and answers a click in 250 ms,
// a /22 in 60 and 85. Only the address read uses this size; the DNS and
// DHCP reads on the same page keep the table's.
const GRID_PAGE_SIZE = 4096;
const gridMode = computed(
  () => activeView.value === 'addresses' && effectivePresentation.value !== 'table',
);
const addressPageSize = computed(() => (gridMode.value ? GRID_PAGE_SIZE : pageSize.value));
const addressSparse = ref(false);
const showAvailable = ref(true);
const filters = ref({ status: '', type: '', online: '', scan: '', range: '', protocol: '' });
// Details identity (W-06). The panel is pinned to a resource, not to a page
// row: `detailIdentity` says what is open, `detailFallback` is the last row
// read for it, and `selectedRow` prefers the live page row when the same
// resource is on the current page. Paging, filtering or a refresh that drops
// the row from the page keeps the panel open; resolveDetail() re-reads the
// resource and only closes the panel when the server says it is gone.
const detailIdentity = ref(null);
const detailFallback = ref(null);
const selectedRows = ref([]);
const bulkActionVisible = ref(false);
const bulkActionMode = ref('reserve');
const bulkRangeVisible = ref(false);
const rangeTypes = ref([]);
const reservationEditorVisible = ref(false);
const reservationEditorMode = ref('reserve');
const reservationTarget = ref(null);
const rangeEditorVisible = ref(false);
const rangeEditorTarget = ref(null);
const scanDialogVisible = ref(false);
const scanDialogMode = ref('policy');
const scanTarget = ref(null);
const networkDialogs = ref(null);
const networkDialogsMounted = ref(false);
const protocolDialogsMounted = ref(false);
const dnsDialogs = ref(null);
const dhcpDialogs = ref(null);
const applyStatus = ref(null);
const folderManagerVisible = ref(false);
const selectedZoneFilter = ref(null);
const selectedScopeFilter = ref(null);
const openMenuName = ref(null);
const notice = ref('');
const noticeRetry = ref(null);
const loading = ref(true);
const loadingContext = ref(false);
const loadError = ref('');
const currentPage = ref(1);
const PAGE_SIZES = [32, 64, 128, 256, 512];
const pageSize = ref(256);
const totalPages = ref(1);
const addressTotal = ref(0);
const addressFilteredTotal = ref(0);
const dnsTotal = ref(0);
const dhcpTotal = ref(0);
const sortKey = ref(null);
const sortOrder = ref(1);
// Small-text size is set from the header's user menu (useWorkspaceUi).
const { styleValue: fontBumpStyle } = useWorkspaceFontBump();
let noticeTimer = null;
let searchTimer = null;
let contextRequest = 0;
let aggregateRequest = 0;
let restoringRoute = false;
let pendingRouteWrites = 0;
let backgroundRefreshRunning = false;
let menuInvoker = null;

const { can, user, refreshCapabilities } = usePermissions();
const router = useRouter();
const { listRangeTypes } = useRangeActions();
const subnetStore = useSubnetStore();
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
// The route already names the context before any data arrives. Seed the kind
// and view from it so the first paint shows the right tab set; without this
// the page opened as the estate ("Networks" and its siblings) and swapped to
// the network tabs half a second later once the tree had loaded. The full
// restore still runs after the load, when the network itself is known.
{
  const initial = routeState.value;
  if (
    initial.context === 'network' ||
    initial.context === 'folder' ||
    initial.context === 'unallocated'
  ) {
    contextKind.value = initial.context;
  }
  const views = initial.context === 'network' ? networkViews : aggregateViews;
  if (views.some((view) => view.key === initial.view)) activeView.value = initial.view;
  else if (initial.context === 'network') activeView.value = 'addresses';
}

const viewDefinitions = {
  networks: {
    search: 'Search network, CIDR, folder, VLAN, or domain…',
    addLabel: 'Allocate network',
  },
  addresses: {
    search: 'Search IP, hostname, MAC, type…',
  },
  dns: {
    search: 'Search name, zone, record type, or value…',
    addLabel: 'Add record',
  },
  dhcp: {
    search: 'Search IP, MAC, hostname, network, or lease…',
  },
  ranges: {
    search: 'Search range, type, or description…',
    addLabel: 'Add range',
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

const canAnyCreate = computed(() => createMenuItems.value.length > 0);
const canCreateCurrent = computed(() => viewAddAction.value?.available === true);

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
// Which linked zone the DNS view opens, both when the DNS tab is chosen and
// when the operator moves to another network: the side (forward or reverse)
// of the zone they last chose, or every record of the network when they last
// cleared the zone. Forward until they choose otherwise, since that is the
// zone an admin nearly always wants. Remembered per browser, so it also holds
// across reloads.
const DNS_ZONE_SIDE_KEY = 'cidrella_workspace_dns_zone_side';
const dnsZoneSide = ref(
  ['forward', 'reverse', ''].includes(loadJson(DNS_ZONE_SIDE_KEY, 'forward'))
    ? loadJson(DNS_ZONE_SIDE_KEY, 'forward')
    : 'forward',
);
function rememberDnsZoneSide(zone) {
  dnsZoneSide.value = !zone ? '' : zone.type === 'reverse' ? 'reverse' : 'forward';
  saveJson(DNS_ZONE_SIDE_KEY, dnsZoneSide.value);
}
function linkedZoneOfSide(networkId, side) {
  if (!side) return null;
  return (
    dnsZones.value.find(
      (zone) =>
        zone.type === side && dnsZoneNetworkIds.value.get(Number(zone.id))?.has(Number(networkId)),
    ) || null
  );
}
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
      soa_minimum_ttl: record.zone_soa_minimum_ttl ?? null,
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
  pinDetail(mapAddressRows([detail])[0], { view: 'addresses', context: 'network' });
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
// The DHCP status filter selects a pool slot by what holds it, which is the
// server's lease_status vocabulary, not the Lease column's. Said in words.
const DHCP_STATUS_LABELS = {
  available: 'Free in pool',
  active: 'Leased',
  offline: 'No active lease',
  unavailable: 'Held outside DHCP',
};
const filterOptions = computed(() => ({
  status:
    activeView.value === 'dhcp'
      ? distinct(currentRows.value.map((row) => row.leaseStatus)).map((value) => ({
          value,
          label: DHCP_STATUS_LABELS[value] || value,
        }))
      : distinct(
          currentRows.value.map((row) => row.status || (row.enabled ? 'enabled' : 'disabled')),
        ).map((value) => ({ value, label: value })),
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
      : contextKind.value === 'folder'
        ? 'FOLDER ACTIONS'
        : 'NETWORK ACTIONS',
);
const rowMenuTitle = computed(() =>
  menuTarget.value?.kind === 'folder'
    ? 'FOLDER ACTIONS'
    : menuTarget.value?.kind === 'network'
      ? 'NETWORK ACTIONS'
      : `${activeView.value.toUpperCase()} ACTIONS`,
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
    (folder) =>
      byId.get(Number(folder.id)) || {
        id: folder.id,
        name: folder.name,
        description: folder.description || '',
        networks: [],
      },
  );
}

const contextStats = computed(() =>
  contextKind.value === 'network'
    ? [
        isV6Network.value
          ? {
              label: 'ASSIGNED',
              value: formatNumber(workspaceResources.resources.summary.data?.assigned_count || 0),
              note: 'addresses with an allocation',
              tone: 'neutral',
            }
          : {
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
          label: isV6Network.value ? 'DHCPV6' : 'DHCP POOL',
          value: isV6Network.value
            ? dhcpV6ModeLabel(networkScopes.value)
            : formatNumber(sumScopeAddresses(networkScopes.value)),
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
// The mode of the first enabled DHCPv6 scope, for the context tile.
function dhcpV6ModeLabel(scopes) {
  const scope = scopes.find((item) => item.enabled) || scopes[0];
  const mode = scope?.raw?.v6_mode || scope?.v6_mode;
  return mode ? DHCP_V6_MODE_LABELS[mode] || mode : 'None';
}

const addressOverview = computed(() => {
  if (isV6Network.value) return null;
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

const selectedRow = computed(() => {
  const identity = detailIdentity.value;
  if (!identity) return null;
  const onPage =
    identity.view === activeView.value
      ? currentRows.value.find((row) => row.id === identity.id)
      : null;
  return onPage || detailFallback.value;
});
const selectedRowView = computed(() => detailIdentity.value?.view ?? 'addresses');
const selectedRowContext = computed(() => detailIdentity.value?.context ?? 'network');

function identityForRow(row, view, context) {
  const kind = String(row.id).split(':')[0];
  return {
    id: row.id,
    kind,
    view,
    context,
    subnetId: context === 'network' ? selectedNetwork.value.id : (row.raw?.subnet_id ?? null),
    address: row.address || null,
    zoneId: row.raw?.zone_id ?? (kind === 'zone' ? row.raw?.id : null) ?? null,
    scopeId: row.raw?.scope_id ?? row.raw?.dhcp_scope_id ?? null,
    name: row.name || null,
    recordId: kind === 'dns' ? row.raw?.id : null,
  };
}
function pinDetail(row, { view = activeView.value, context = contextKind.value } = {}) {
  detailIdentity.value = identityForRow(row, view, context);
  detailFallback.value = row;
  // Under 1024px the panel renders after the work surface (W-07); bring it
  // into view so a row tap does not appear to do nothing.
  if (globalThis.matchMedia?.('(max-width: 1023px)').matches) {
    nextTick(() => {
      document
        .querySelector('.workspace-address-panel, .details-panel')
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }
}
function clearDetail() {
  detailIdentity.value = null;
  detailFallback.value = null;
  workspaceResources.invalidate('detail');
}
// A press anywhere outside the open details panel closes it. Presses on
// things that open details themselves (table rows, grid cells) fall through
// to their own handlers so the panel swaps content without closing and
// reopening, and layered UI (dialogs, menus, popovers, toasts) is not
// "outside" the page.
const DETAIL_KEEP_SELECTORS = [
  '.workspace-address-panel',
  '.details-panel',
  'tbody tr',
  '.address-grid-view button',
  '.compact-grid-view button',
  '[role="dialog"]',
  '.floating-menu',
  '.menu-scrim',
  '.p-popover',
  '.p-overlay',
  '[data-pc-section="overlay"]',
  '.p-toast',
].join(', ');
function handleDetailOutsidePress(event) {
  if (!detailIdentity.value) return;
  const target = event.target;
  if (!(target instanceof Element) || target.closest(DETAIL_KEEP_SELECTORS)) return;
  clearDetail();
  void updateWorkspaceRoute();
}
// Re-reads the pinned resource after the page it came from was replaced.
// `request` is the caller's context generation; a resolve that finishes after
// a newer load started is dropped along with the load it belonged to.
async function resolveDetail(request, isCurrent) {
  const identity = detailIdentity.value;
  if (!identity) return;
  if (identity.view === activeView.value) {
    const onPage = currentRows.value.find((row) => row.id === identity.id);
    if (onPage) {
      detailFallback.value = onPage;
      return;
    }
  }
  let fresh = null;
  let known = true;
  if (identity.kind === 'address' && identity.subnetId) {
    const detail = await workspaceResources.loadAddressDetail(identity.subnetId, identity.address);
    if (!isCurrent(request)) return;
    fresh = detail ? mapAddressRows([detail])[0] : null;
  } else if (identity.kind === 'dns') {
    const detail = await workspaceResources.loadDnsRecordDetail({
      zoneId: identity.zoneId,
      subnetId: identity.context === 'network' ? identity.subnetId : undefined,
      name: identity.name === '@' ? undefined : identity.name,
      recordId: identity.recordId,
    });
    if (!isCurrent(request)) return;
    fresh = detail ? mapWorkspaceDnsRows([detail])[0] : null;
  } else if (identity.kind === 'dhcp') {
    const detail = await workspaceResources.loadDhcpAddressDetail({
      subnetId: identity.context === 'network' ? identity.subnetId : undefined,
      scopeId: identity.context === 'network' ? undefined : identity.scopeId,
      ip: identity.address,
    });
    if (!isCurrent(request)) return;
    fresh = detail ? mapDhcpRows([detail])[0] : null;
  } else if (identity.kind === 'zone') {
    const zone = dnsZones.value.find((item) => `zone:${item.id}` === identity.id);
    fresh = zone ? mapDnsZoneRows([zone])[0] : null;
  } else if (identity.kind === 'scope') {
    const scope = dhcpScopes.value.find((item) => `scope:${item.id}` === identity.id);
    fresh = scope ? mapDhcpScopeRows([scope])[0] : null;
  } else if (identity.kind === 'network') {
    const network = allNetworks.value.find((item) => `network:${item.id}` === identity.id);
    fresh = network ? mapNetworkRows([network])[0] : null;
    // Unallocated leaves are not in allNetworks; keep the pinned copy.
    if (!network && identity.context === 'unallocated') known = false;
  } else if (identity.kind === 'range') {
    fresh = rangeRows.value.find((row) => row.id === identity.id) || null;
  } else {
    known = false;
  }
  if (!known) return;
  if (fresh) detailFallback.value = fresh;
  else {
    clearDetail();
    showLiveNotice('The selected resource is no longer available.');
  }
}
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
const selectedAddressRows = computed(() => {
  const selected = new Set(selectedRows.value);
  return addressRows.value.filter((row) => selected.has(row.id));
});
const selectionRuns = computed(() => contiguousAddressRuns(selectedRows.value));
const selectedAllocationStates = computed(() =>
  selectedAddressRows.value.map((row) => row.raw?.allocation_state),
);

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
// The address a pinned row is about, whichever protocol view it came from.
const pinnedAddress = computed(
  () =>
    selectedRow.value?.raw?.ip_address ||
    selectedRow.value?.address ||
    (selectedRowView.value === 'dns' ? selectedRow.value?.value : null) ||
    null,
);
// Rows that reference an address. For the pinned address they come from an
// exact-address read of both protocol inventories (the loaded page is only
// one page of them); other addresses fall back to the loaded page. Generated
// PTR placeholders and bare pool addresses are not "something to show".
const pinnedRelated = ref({ address: null, dns: [], dhcp: [] });
function meaningfulDnsRow(row) {
  return row.raw?.dns_source !== 'placeholder';
}
function meaningfulDhcpRow(row) {
  return Boolean(row.raw?.dhcp_assignment_type);
}
function relatedRowsFor(view, address) {
  if (!address) return [];
  const fetched = pinnedRelated.value.address === address ? pinnedRelated.value : null;
  if (view === 'dns')
    return (
      fetched?.dns ||
      networkDnsRows.value.filter((row) => row.value === address || row.raw?.ip_address === address)
    ).filter(meaningfulDnsRow);
  if (view === 'dhcp')
    return (fetched?.dhcp || networkDhcpRows.value.filter((row) => row.address === address)).filter(
      meaningfulDhcpRow,
    );
  return [];
}
async function loadPinnedRelated() {
  const address = pinnedAddress.value;
  const networkId = selectedNetwork.value?.id;
  if (!address || !networkId || selectedRowContext.value !== 'network') {
    pinnedRelated.value = { address: null, dns: [], dhcp: [] };
    return;
  }
  const [dns, dhcp] = await Promise.all([
    workspaceResources.loadRelatedDns(networkId, address),
    workspaceResources.loadRelatedDhcp(networkId, address),
  ]);
  // A newer pin replaced this one while the reads were in flight.
  if (pinnedAddress.value !== address) return;
  pinnedRelated.value = {
    address,
    dns: mapWorkspaceDnsRows(dns || []),
    dhcp: mapDhcpRows(dhcp || []),
  };
}
watch([pinnedAddress, () => selectedNetwork.value?.id], () => {
  void loadPinnedRelated();
});
// Related resources open inside the details panel, never by switching the
// main view. Entries without a row are resolved against the pinned address
// when clicked; sibling protocol rows for the same address carry their row.
const relatedResources = computed(() => {
  if (selectedRowContext.value !== 'network') return [];
  const address = pinnedAddress.value;
  const dnsRows = relatedRowsFor('dns', address);
  const dhcpRows = relatedRowsFor('dhcp', address);
  const dnsEntry = dnsRows.length
    ? {
        view: 'dns',
        label: 'DNS records',
        note: `${countOf(dnsRows.length, 'record')} reference this address`,
        icon: 'pi pi-globe',
      }
    : null;
  const dhcpEntry = dhcpRows.length
    ? {
        view: 'dhcp',
        label: 'DHCP identity',
        note: `${countOf(dhcpRows.length, 'related row')}`,
        icon: 'pi pi-server',
      }
    : null;
  if (selectedRowView.value === 'addresses') return [dnsEntry, dhcpEntry].filter(Boolean);
  const siblings = (selectedRowView.value === 'dns' ? dnsRows : dhcpRows)
    .filter((row) => row.id !== selectedRow.value?.id)
    .map((row) => ({
      key: row.id,
      view: selectedRowView.value,
      row,
      label: row.name || row.hostname || row.address,
      note:
        selectedRowView.value === 'dns'
          ? `${row.type || row.recordType || 'DNS'} record for the same address`
          : `${row.assignment || 'DHCP'} row for the same address`,
      icon: selectedRowView.value === 'dns' ? 'pi pi-globe' : 'pi pi-server',
    }));
  return [
    address
      ? {
          view: 'addresses',
          label: 'Canonical IP record',
          note: 'Allocation and liveness details',
          icon: 'pi pi-list',
        }
      : null,
    ...siblings,
    selectedRowView.value === 'dns' ? dhcpEntry : dnsEntry,
  ].filter(Boolean);
});
const selectedAddressDnsCount = computed(
  () => relatedRowsFor('dns', selectedRow.value?.address).length,
);
const selectedAddressDhcpCount = computed(
  () => relatedRowsFor('dhcp', selectedRow.value?.address).length,
);
const networkDialogNode = computed(() => {
  const network =
    selectedRowView.value === 'networks' ? selectedRow.value?.raw : selectedNetwork.value;
  return network?.id ? { key: `subnet-${network.id}`, data: network } : null;
});

// Action registry targets (W-05). Every menu, quick action and toolbar button
// resolves to a registry entry plus one of these targets, and the invocation
// goes through useWorkspaceActions with that same target. Nothing dispatches
// on a label.
const selectedRowTarget = computed(() => targetForRow(selectedRow.value));
const networkTarget = computed(() =>
  selectedRowTarget.value?.kind === 'network'
    ? selectedRowTarget.value
    : workspaceActions.currentNetworkTarget(),
);
const workspaceTarget = computed(() => {
  const rowTarget = selectedRowTarget.value;
  const zone =
    rowTarget?.kind === 'dns-zone'
      ? rowTarget.raw
      : rowTarget?.kind === 'dns-record'
        ? dnsZones.value.find((item) => Number(item.id) === Number(rowTarget.zone_id)) || null
        : selectedZoneFilter.value;
  const scope =
    rowTarget?.kind === 'dhcp-scope'
      ? rowTarget.raw
      : rowTarget?.kind === 'dhcp-address'
        ? dhcpScopes.value.find((item) => Number(item.id) === Number(rowTarget.scope_id)) || null
        : selectedScopeFilter.value;
  return { kind: 'workspace', zone, scope };
});
const selectionTarget = computed(() => {
  if (activeView.value === 'networks') {
    const ids = selectedRows.value
      .filter((id) => String(id).startsWith('network:'))
      .map((id) => Number(String(id).slice('network:'.length)));
    // What the merge rules need to know about each checked network.
    const networks = ids
      .map((id) => scopedNetworks.value.find((network) => Number(network.id) === id))
      .filter(Boolean)
      .map((network) => ({
        id: Number(network.id),
        cidr: network.cidr,
        status: network.status,
        parent_id: network.parent_id ?? null,
        hasChildren: Boolean(network.children?.length),
      }));
    return { kind: 'network-selection', ids, count: ids.length, networks };
  }
  return {
    kind: 'address-selection',
    count: selectedAddressRows.value.length,
    allocationStates: selectedAllocationStates.value,
  };
});
// The selection bar. Reserve and Release share one slot: a selection is all
// unassigned, all reserved, or mixed, and the mixed case keeps one disabled
// button whose title says what to deselect.
const selectionActions = computed(() => {
  if (!selectedRows.value.length) return [];
  const items = menuActions({
    menu: 'selection',
    target: selectionTarget.value,
    view: activeView.value,
    can,
    includeUnavailable: true,
  });
  const reserve = items.find((item) => item.id === 'ip.bulk-reserve');
  const release = items.find((item) => item.id === 'ip.bulk-release');
  if (!reserve || !release) return items;
  const rest = items.filter((item) => item !== reserve && item !== release);
  if (release.available) return [...rest, release];
  if (reserve.available) return [...rest, reserve];
  return [
    ...rest,
    {
      ...reserve,
      reason: 'Select only unassigned addresses to reserve, or only IP Reservations to release.',
    },
  ];
});
// The folder context and explorer folder rows are action targets of their
// own; Ungrouped (id null) is the server's bucket, not a folder.
const folderTarget = computed(() =>
  contextKind.value === 'folder' && selectedFolder.value
    ? {
        kind: 'folder',
        id: selectedFolder.value.id,
        name: selectedFolder.value.name,
        raw: selectedFolder.value,
      }
    : null,
);
// A row menu opened from the explorer (a folder or a network row) targets
// that resource rather than the pinned details row.
const menuTarget = ref(null);
const withTarget = (items, target) => items.map((item) => ({ ...item, target }));
const createMenuItems = computed(() =>
  withTarget(
    menuActions({ menu: 'create', target: workspaceTarget.value, can }),
    workspaceTarget.value,
  ),
);
const actionMenuItems = computed(() => {
  const target = ['dns', 'dhcp'].includes(activeView.value)
    ? workspaceTarget.value
    : networkTarget.value || folderTarget.value;
  if (!target) return [];
  return withTarget(menuActions({ menu: 'actions', target, view: activeView.value, can }), target);
});
const rowMenuItems = computed(() => {
  const target = menuTarget.value || selectedRowTarget.value;
  if (!target) return [];
  return withTarget(menuActions({ menu: 'row', target, view: activeView.value, can }), target);
});
// Addresses and DHCP have no toolbar button: reservations come from the row
// menu and the Create menu.
const VIEW_ADD_ACTIONS = {
  networks: ['network.allocate', workspaceTarget],
  dns: ['dns.record.create', workspaceTarget],
  ranges: ['range.create', networkTarget],
};
const viewAddAction = computed(() => {
  const [id, targetRef] = VIEW_ADD_ACTIONS[activeView.value] || [];
  if (!id || !targetRef.value) return null;
  return {
    id,
    target: targetRef.value,
    ...workspaceActions.registry.availability(id, targetRef.value),
  };
});
function runMenuAction(item) {
  closeMenu();
  return workspaceActions.invoke(item.id, item.target);
}
function runRowAction(item) {
  closeMenu();
  return workspaceActions.invoke(item.id, item.target || selectedRowTarget.value);
}
function runContextAction(actionId) {
  const target = actionId === 'network.scan' ? networkTarget.value : workspaceTarget.value;
  return workspaceActions.invoke(actionId, target);
}
function runSelectionAction(actionId) {
  return workspaceActions.invoke(actionId, selectionTarget.value);
}
function runViewAdd() {
  const action = viewAddAction.value;
  if (!action) return;
  return workspaceActions.invoke(action.id, action.target);
}

const gridCells = computed(() =>
  addressRows.value.map((row) => ({
    ip: row.address,
    last: row.address.includes(':')
      ? row.address.split(':').at(-1) || '0'
      : row.address.split('.').at(-1),
    kind: gridKind(row),
    label: row.type || row.status || 'Available',
    row,
  })),
);

// Aggregate lists (networks, zones, scopes) are paged in the browser with
// the same paginator the API-paged views use.
const clientPage = ref(1);
const activePage = computed(() => (serverPagedView.value ? currentPage.value : clientPage.value));
const paginatorTotal = computed(() =>
  serverPagedView.value ? rowTotal.value : filteredRows.value.length,
);
const pagedRows = computed(() => {
  if (serverPagedView.value) return filteredRows.value;
  const start = (clientPage.value - 1) * pageSize.value;
  return filteredRows.value.slice(start, start + pageSize.value);
});
watch([filteredRows, pageSize], () => {
  const pages = Math.max(1, Math.ceil(filteredRows.value.length / pageSize.value));
  if (clientPage.value > pages) clientPage.value = pages;
});
async function onPaginatorPage({ page, rows }) {
  if (!gridMode.value && rows !== pageSize.value) {
    clientPage.value = 1;
    pageSize.value = rows;
    return;
  }
  if (serverPagedView.value) await changePage(page + 1);
  else clientPage.value = page + 1;
}
const rowTotal = computed(() => {
  if (activeView.value === 'addresses') return addressFilteredTotal.value;
  if (activeView.value === 'dns' && (contextKind.value === 'network' || selectedZoneFilter.value))
    return dnsTotal.value;
  if (activeView.value === 'dhcp' && (contextKind.value === 'network' || selectedScopeFilter.value))
    return dhcpTotal.value;
  return currentRows.value.length;
});

const resultCountLabel = computed(() => {
  if (activeView.value === 'addresses' && contextKind.value === 'network') {
    return addressCountLabel({
      shown: filteredRows.value.length,
      matching: addressFilteredTotal.value,
      total: addressTotal.value,
      sparse: addressSparse.value,
      paged: !gridMode.value || addressFilteredTotal.value > addressPageSize.value,
    });
  }
  return `Showing ${filteredRows.value.length} of ${rowTotal.value}`;
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
  // On the DNS view the operator's last zone choice and record filters carry
  // over to the next network instead of resetting to the mixed record list.
  const keepDnsChoice = activeView.value === 'dns';
  if (!keepDnsChoice) clearFilters();
  selectedZoneFilter.value = keepDnsChoice ? linkedZoneOfSide(network.id, dnsZoneSide.value) : null;
  selectedScopeFilter.value = null;
  clearDetail();
  tableQuery.value = '';
  await updateWorkspaceRoute();
  await loadNetworkContext();
}
function selectUnallocatedNetwork(network) {
  pinDetail(mapNetworkRows([network])[0], { view: 'networks', context: 'unallocated' });
}
function resetContextNavigation() {
  currentPage.value = 1;
  clientPage.value = 1;
  sortKey.value = null;
  clearFilters();
  selectedZoneFilter.value = null;
  selectedScopeFilter.value = null;
  clearDetail();
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
  // The DNS tab opens on the zone side the operator last chose, not on the
  // mixed record list, which sorts every PTR record ahead of the forward ones.
  selectedZoneFilter.value =
    view === 'dns' && contextKind.value === 'network'
      ? linkedZoneOfSide(selectedNetwork.value?.id, dnsZoneSide.value)
      : null;
  selectedScopeFilter.value = null;
  clearDetail();
  selectedRows.value = [];
  tableQuery.value = '';
  await updateWorkspaceRoute();
  if (contextKind.value === 'network') await loadNetworkContext();
  else await refreshAggregateTable();
}
// A related resource replaces what the details panel shows; the main view,
// its tab and its filters stay put. `resource` is a related entry (or a bare
// view name from the address panel, with the address's stable identity).
async function openRelatedResource(resource, identity = null) {
  const target = typeof resource === 'string' ? { view: resource } : resource;
  if (target.row) {
    pinDetail(target.row, { view: target.view, context: 'network' });
    await updateWorkspaceRoute();
    return;
  }
  const address = identity?.ip_address || pinnedAddress.value;
  if (target.view === 'addresses') {
    await openCanonicalAddress(address);
    return;
  }
  const rows = relatedRowsFor(target.view, address);
  if (!rows.length) {
    showLiveNotice(
      `No ${target.view === 'dns' ? 'DNS records' : 'DHCP rows'} reference ${address || 'this address'}.`,
    );
    return;
  }
  pinDetail(rows[0], { view: target.view, context: 'network' });
  await updateWorkspaceRoute();
}
// Floating menus open where they were asked for: at the pointer for a
// right-click, under the button or row otherwise, and never off screen.
const menuAnchor = ref(null);
const menuStyle = computed(() =>
  menuAnchor.value
    ? { top: `${menuAnchor.value.top}px`, left: `${menuAnchor.value.left}px`, right: 'auto' }
    : null,
);
function placeMenu(invoker, event = null) {
  if (event && Number.isFinite(event.clientX) && (event.clientX || event.clientY)) {
    menuAnchor.value = { top: event.clientY, left: event.clientX };
  } else if (invoker?.getBoundingClientRect) {
    const rect = invoker.getBoundingClientRect();
    menuAnchor.value = { top: rect.bottom + 4, left: rect.left };
  } else {
    menuAnchor.value = null;
  }
  nextTick(clampMenu);
}
function clampMenu() {
  const menu = document.querySelector('.floating-menu');
  if (!menu || !menuAnchor.value) return;
  const { width, height } = menu.getBoundingClientRect();
  const margin = 8;
  const maxLeft = Math.max(margin, globalThis.innerWidth - margin - width);
  const maxTop = Math.max(margin, globalThis.innerHeight - margin - height);
  menuAnchor.value = {
    top: Math.min(menuAnchor.value.top, maxTop),
    left: Math.min(menuAnchor.value.left, maxLeft),
  };
}
function toggleMenu(name, invoker = null, event = null) {
  if (invoker) menuInvoker = invoker;
  const opening = openMenuName.value !== name;
  openMenuName.value = opening ? name : null;
  if (opening) placeMenu(invoker, event);
}
function closeMenu() {
  openMenuName.value = null;
  menuTarget.value = null;
  menuAnchor.value = null;
  menuInvoker?.focus();
}
function openTargetMenu(target, invoker = null, event = null) {
  menuTarget.value = target;
  if (invoker) menuInvoker = invoker;
  openMenuName.value = 'row';
  placeMenu(invoker, event);
}
// A linked zone or scope card in the context header opens the same menu its
// inventory row would: edit, delete, and the rest.
function openLinkedMenu(kind, item, invoker = null, event = null) {
  openTargetMenu(targetForRow({ id: `${kind}:${item.id}`, raw: item }), invoker, event);
}
// N-08: a network dragged from the table or the explorer and dropped on an
// explorer folder moves there through the same PUT the row menu's editor
// uses, then the network refresh contract runs. Ungrouped is folder_id null.
function startNetworkDrag(row, event) {
  const target = targetForRow(row);
  if (target?.kind !== 'network' || !event.dataTransfer) return;
  event.dataTransfer.setData(NETWORK_DRAG_TYPE, String(target.id));
  event.dataTransfer.setData('text/plain', row.cidr || '');
  event.dataTransfer.effectAllowed = 'move';
}
async function moveNetworkToFolder({ networkId, folder }) {
  const network = allNetworks.value.find((entry) => Number(entry.id) === Number(networkId));
  if (!network) return;
  const folderId = folder.id ?? null;
  if ((network.folderId ?? null) === folderId) return;
  try {
    await subnetStore.updateSubnet(network.id, { folder_id: folderId });
  } catch (error) {
    showLiveNotice(`Could not move ${network.cidr} to ${folder.name}: ${apiError(error)}`);
    return;
  }
  await refreshAfterMutation('network', `${network.cidr} moved to ${folder.name}`);
}
function openFolderMenu(folder, invoker = null, event = null) {
  openTargetMenu({ kind: 'folder', id: folder.id, name: folder.name, raw: folder }, invoker, event);
}
function openNetworkMenu(network, invoker = null, event = null) {
  openTargetMenu(targetForRow(mapNetworkRows([network])[0]), invoker, event);
}
function handleWorkspaceKeydown(event) {
  if (event.key !== 'Escape' || !openMenuName.value) return;
  event.preventDefault();
  closeMenu();
}
// Arrow keys walk the open menu; focus lands on the first item when a menu
// opens (see the openMenuName watcher) and goes back to the invoker on close.
function handleMenuKeydown(event) {
  const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]')];
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  let next = null;
  if (event.key === 'ArrowDown') next = (current + 1) % items.length;
  else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  if (next == null) return;
  event.preventDefault();
  items[next].focus();
}
watch(openMenuName, async (name) => {
  if (!name) return;
  await nextTick();
  document.querySelector(`.floating-menu.${name}-menu [role="menuitem"]`)?.focus();
});

async function openFolderDialog(mode, folder = null) {
  folderManagerVisible.value = false;
  if (!networkDialogsMounted.value) {
    networkDialogsMounted.value = true;
    await nextTick();
  }
  if (mode === 'edit') networkDialogs.value.openEditFolder(folder);
  else if (mode === 'delete') networkDialogs.value.openDeleteFolder(folder);
  else networkDialogs.value.openCreateFolder();
}

// Types the range editor made. Merged by id: the editor refetches the list
// on every open, so a type can arrive twice.
function addRangeTypes(types) {
  const byId = new Map(rangeTypes.value.map((type) => [type.id, type]));
  for (const type of types) byId.set(type.id, type);
  rangeTypes.value = [...byId.values()];
}

async function openRangeEditor(range) {
  if (!selectedNetwork.value.id || !can('subnets:write')) return;
  try {
    const result = await listRangeTypes();
    rangeTypes.value = Array.isArray(result) ? result : result?.range_types || [];
    rangeEditorTarget.value = range ? { ...range } : null;
    rangeEditorVisible.value = true;
  } catch (error) {
    showLiveNotice(`Could not load Network Range Types: ${apiError(error)}`);
  }
}
// A row menu targets the row without pinning it: right-click and the row
// button must not open the details panel (operator's rule).
function openRowMenu(row, invoker = null, event = null) {
  openTargetMenu(targetForRow(row), invoker, event);
}
function selectRow(row) {
  pinDetail(row);
  updateWorkspaceRoute();
}

async function openCanonicalAddress(address = selectedRow.value?.address) {
  if (!address || !selectedNetwork.value.id) {
    showLiveNotice('This protocol row is not linked to a canonical IP address.');
    return;
  }
  const detail = await workspaceResources.loadAddressDetail(selectedNetwork.value.id, address);
  if (!detail) {
    showLiveNotice(
      workspaceResources.resources.detail.error || 'Could not load canonical IP details.',
    );
    return;
  }
  pinDetail(mapAddressRows([detail])[0], { view: 'addresses', context: 'network' });
  await updateWorkspaceRoute();
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
function selectGridRange(row) {
  const visibleIds = filteredRows.value.map((item) => item.id);
  const anchorId = selectedRows.value.at(-1);
  const start = visibleIds.indexOf(anchorId);
  const end = visibleIds.indexOf(row.id);
  if (start < 0 || end < 0) {
    toggleRow(row.id);
    return;
  }
  selectedRows.value = [
    ...new Set([
      ...selectedRows.value,
      ...visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1),
    ]),
  ];
}
function selectGridDrag({ ids, additive }) {
  selectedRows.value = additive ? [...new Set([...selectedRows.value, ...ids])] : ids;
}
async function openBulkRangeType() {
  if (!selectedRows.value.length || !can('subnets:write')) return;
  try {
    const result = await listRangeTypes();
    rangeTypes.value = Array.isArray(result) ? result : result?.range_types || [];
    bulkRangeVisible.value = true;
  } catch (error) {
    showLiveNotice(`Could not load Network Range Types: ${apiError(error)}`);
  }
}
const workspaceActions = useWorkspaceActions({
  can,
  router,
  state: {
    selectedRow,
    selectedNetwork,
    selectedFolder,
    selectedRows,
    selectedZoneFilter,
    selectedScopeFilter,
    dnsZones,
    dhcpScopes,
    allNetworks,
    filters,
    currentPage,
    activeView,
    contextKind,
  },
  dialogs: {
    networkDialogs,
    networkDialogsMounted,
    dnsDialogs,
    dhcpDialogs,
    protocolDialogsMounted,
    folderManagerVisible,
    reservationTarget,
    reservationEditorMode,
    reservationEditorVisible,
    scanTarget,
    scanDialogMode,
    scanDialogVisible,
    bulkActionMode,
    bulkActionVisible,
  },
  selectNetwork,
  updateWorkspaceRoute,
  loadNetworkContext,
  refreshAggregateTable,
  showLiveNotice,
  openCanonicalAddress,
  openRangeEditor,
  openBulkRangeType,
  refreshAfterMutation,
  rememberDnsZoneSide,
});
async function handleBulkComplete(ledger) {
  bulkActionVisible.value = false;
  selectedRows.value = [];
  await refreshAfterMutation(
    'address',
    `${ledger.updated} address${ledger.updated === 1 ? '' : 'es'} updated; ${ledger.skipped} skipped`,
  );
}
async function handleReservationSaved(result) {
  await refreshAfterMutation('address', result.message);
}
async function handleRangeChanged(message, { deleted = false } = {}) {
  rangeEditorVisible.value = false;
  // A deleted range would otherwise close the panel with its own "no longer
  // available" notice on top of the save message.
  if (deleted) clearDetail();
  await refreshAfterMutation('range', message);
}
function handleBulkPartial(ledger) {
  showLiveNotice(
    `${ledger.updated} updated and ${ledger.skipped} skipped. ${ledger.remaining.length} run(s) remain after the failure.`,
  );
}
async function handleRangeTypeSaved() {
  bulkRangeVisible.value = false;
  selectedRows.value = [];
  await refreshAfterMutation('address', 'Network Range Type updated');
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
  rememberDnsZoneSide(selectedZoneFilter.value);
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

// `silent` is the auto-refresh: the rows update in place under the reader
// with no "Loading live data" popover dimming the table once a minute.
async function loadNetworkContext({ silent = false } = {}) {
  if (!selectedNetwork.value.id) return;
  const request = ++contextRequest;
  if (!silent) loadingContext.value = true;
  loadError.value = '';
  try {
    const params = {
      page: activeView.value === 'addresses' ? currentPage.value : 1,
      pageSize: addressPageSize.value,
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
    if (detail) rangeRows.value = mapRangeRows(detail.ranges, networkScopes.value);
    addressFilteredTotal.value = detail?.filteredTotal || 0;
    addressSparse.value = detail?.sparse === true;
    // A sparse network has no total; its count is the addresses it holds
    // an allocation for, which the summary already knows.
    addressTotal.value = addressSparse.value
      ? Number(workspaceResources.resources.summary.data?.assigned_count ?? detail?.total ?? 0)
      : Number(workspaceResources.resources.summary.data?.total_addresses ?? detail?.total ?? 0);
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
    await resolveDetail(request, (generation) => generation === contextRequest);
  } catch (error) {
    if (request === contextRequest) loadError.value = apiError(error);
  } finally {
    if (request === contextRequest && !silent) loadingContext.value = false;
  }
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
      clearDetail();
      message = `The selected network no longer exists. Showing ${folder?.name || 'All Networks'}.`;
    } else selectedNetwork.value = network;
  }
  if (
    selectedZoneFilter.value &&
    !dnsZones.value.some((zone) => Number(zone.id) === Number(selectedZoneFilter.value.id))
  ) {
    selectedZoneFilter.value = null;
    clearDetail();
    message = 'The selected DNS zone no longer exists. Showing the zone inventory.';
  }
  if (
    selectedScopeFilter.value &&
    !dhcpScopes.value.some((scope) => Number(scope.id) === Number(selectedScopeFilter.value.id))
  ) {
    selectedScopeFilter.value = null;
    clearDetail();
    message = 'The selected DHCP scope no longer exists. Showing the scope inventory.';
  }
  if (message) {
    showLiveNotice(message);
    await updateWorkspaceRoute({ replace: true });
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
  const request = ++aggregateRequest;
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
  if (request === aggregateRequest)
    await resolveDetail(request, (generation) => generation === aggregateRequest);
}

function retryVisibleResource() {
  if (contextKind.value === 'network') return loadNetworkContext();
  return refreshAggregateTable();
}

// Section 7 mutation and refresh contract. Every write lands in
// refreshAfterMutation with the kind of resource it touched; the table says
// which shared reads that kind makes stale. The visible context (address
// page, DNS/DHCP rows, summary, pinned details) is always re-read afterwards,
// the old interface's subnet cache is dropped so the two UIs cannot disagree
// after a save, and the header stats listener is told. `refresh` is the
// auto-refresh plan: everything shared, no cache or status side effects.
const MUTATION_REFRESH = {
  network: { tree: true, networks: true, zones: true, scopes: true, applyStatus: true },
  address: { tree: true, scopes: true },
  range: { scopes: true },
  dns: { tree: true, zones: true, applyStatus: true },
  dhcp: { tree: true, scopes: true, applyStatus: true },
  apply: { tree: true, zones: true, scopes: true },
  refresh: { tree: true, zones: true, scopes: true },
};

async function reloadSharedReads(kind) {
  const plan = MUTATION_REFRESH[kind];
  const query = resourceQuery.value.trim() || tableQuery.value.trim();
  const [tree, zones, scopes] = await Promise.all([
    plan.tree ? workspaceResources.loadTree() : null,
    plan.zones ? workspaceResources.loadZones() : null,
    plan.scopes ? workspaceResources.loadScopes() : null,
    plan.networks && query
      ? workspaceResources.loadNetworks({ q: resourceQuery.value.trim() || undefined })
      : null,
  ]);
  if (plan.tree && !tree)
    throw new Error(workspaceResources.resources.tree.error || 'Network tree unavailable');
  if (tree) {
    folders.value = preserveEmptyFolders(buildExplorerFolders(tree.folders), tree.folders);
    unallocatedFolders.value = buildUnallocatedFolders(tree.folders);
    // Merged or deleted networks leave the selection; the rest stays checked.
    const known = new Set(allNetworks.value.map((network) => `network:${network.id}`));
    selectedRows.value = selectedRows.value.filter(
      (id) => !String(id).startsWith('network:') || known.has(id),
    );
  }
  if (zones) dnsZones.value = zones;
  if (scopes) dhcpScopes.value = scopes;
  await revalidateWorkspaceContext();
  if (contextKind.value === 'network') await loadNetworkContext({ silent: kind === 'refresh' });
  else await refreshAggregateTable();
  if (plan.applyStatus) await applyStatus.value?.refresh();
}

async function refreshAfterMutation(kind, message = '') {
  if (kind !== 'apply') {
    subnetStore.invalidateDetailCache(
      ['address', 'range'].includes(kind) ? selectedNetwork.value.id : undefined,
    );
    globalThis.window?.dispatchEvent(new Event('ipam:stats-changed'));
  }
  if (message) showLiveNotice(message);
  const saved = message ? `${message}. ` : '';
  try {
    await reloadSharedReads(kind);
    await loadPinnedRelated();
  } catch (error) {
    clearTimeout(noticeTimer);
    notice.value = `${saved}Saved; refresh failed: ${apiError(error)}`;
    const retry = async () => {
      try {
        await reloadSharedReads(kind);
        showLiveNotice('Live data refreshed.');
      } catch (retryError) {
        clearTimeout(noticeTimer);
        notice.value = `Saved; refresh still failed: ${apiError(retryError)}`;
        noticeRetry.value = retry;
      }
    };
    noticeRetry.value = retry;
  }
}

async function refreshCurrentContext() {
  if (backgroundRefreshRunning || loading.value || loadingContext.value) return;
  backgroundRefreshRunning = true;
  try {
    await reloadSharedReads('refresh');
  } catch {
    // Auto-refresh is silent; the next tick tries again and the visible
    // resource keeps its own error and retry control.
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
// Table and grid read different page sizes, so a switch between them
// starts at page one and loads that presentation's page.
watch(effectivePresentation, (next, previous) => {
  if ((next === 'table') === (previous === 'table')) return;
  if (contextKind.value !== 'network' || activeView.value !== 'addresses') return;
  currentPage.value = 1;
  loadNetworkContext();
});

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
onMounted(() => {
  loadWorkspace();
  globalThis.window?.addEventListener('keydown', handleWorkspaceKeydown);
  globalThis.document?.addEventListener('pointerdown', handleDetailOutsidePress);
});
onUnmounted(() => {
  globalThis.window?.removeEventListener('keydown', handleWorkspaceKeydown);
  globalThis.document?.removeEventListener('pointerdown', handleDetailOutsidePress);
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
