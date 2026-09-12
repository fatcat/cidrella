<template>
  <div class="workspace-preview" data-track="networks-workspace-preview" :style="{ '--workspace-font-bump': `${fontBump * 1.333}px` }">
    <header class="preview-banner">
      <div>
        <div class="preview-kicker">0.5.0 workspace preview</div>
        <h1>Network operations, in context</h1>
        <p>One resource explorer, one work surface, and no lost context between IPAM, DNS, and DHCP.</p>
      </div>
      <div class="preview-banner-actions">
        <div class="font-sizer" aria-label="Small text size">
          <span><i class="pi pi-font" /> Small text</span>
          <button :disabled="fontBump === 0" aria-label="Decrease small text size" data-track="workspace-font-decrease" @click="resizeSmallText(-1)">−</button>
          <output>{{ fontBump ? `+${fontBump} pt` : 'Default' }}</output>
          <button :disabled="fontBump === 2" aria-label="Increase small text size" data-track="workspace-font-increase" @click="resizeSmallText(1)">+</button>
        </div>
        <span class="sample-pill live"><i class="pi pi-circle-fill" /> Live appliance data · preview actions</span>
        <router-link to="/networks" class="quiet-link" data-track="preview-back-to-networks">
          <i class="pi pi-arrow-left" /> Current interface
        </router-link>
      </div>
    </header>

    <section class="workspace-frame">
      <aside class="resource-explorer">
        <div class="explorer-heading">
          <div>
            <span class="eyebrow">RESOURCE EXPLORER</span>
            <strong>Infrastructure</strong>
          </div>
          <button class="icon-button" title="Create resource" aria-label="Create resource" @click="toggleMenu('create')">
            <i class="pi pi-plus" />
          </button>
        </div>

        <label class="explorer-search">
          <i class="pi pi-search" />
          <input v-model="resourceQuery" type="search" placeholder="Find networks, hostnames, or IPs" aria-label="Find networks, hostnames, or IPs" data-track="workspace-global-search" />
          <kbd>⌘ K</kbd>
        </label>

        <button class="estate-row" :class="{ active: contextKind === 'estate' }" data-track="workspace-estate-select" @click="selectEstate">
          <span class="estate-icon"><i class="pi pi-building" /></span>
          <span><strong>All Networks</strong><small>{{ allNetworks.length }} networks · {{ dnsZones.length }} zones · {{ dhcpScopes.length }} scopes</small></span>
          <i class="pi pi-chevron-right" />
        </button>

        <div class="explorer-section-head">
          <span>NETWORK SCOPE</span>
          <button @click="notify('Browse unallocated networks')">Browse unallocated</button>
        </div>

        <div class="network-tree">
          <section v-for="folder in filteredFolders" :key="folder.id ?? folder.name" class="network-group">
            <div class="folder-row" :class="{ active: contextKind === 'folder' && selectedFolder?.id === folder.id }">
              <button class="folder-toggle" :aria-label="`${expandedFolders.has(folder.name) ? 'Collapse' : 'Expand'} ${folder.name}`" @click="toggleFolder(folder.name)">
                <i class="pi" :class="expandedFolders.has(folder.name) ? 'pi-chevron-down' : 'pi-chevron-right'" />
              </button>
              <button class="folder-select" data-track="workspace-folder-select" @click="selectFolder(folder)">
                <i class="pi pi-folder" />
                <span>{{ folder.name }}</span>
                <small>{{ folder.networks.length }}</small>
              </button>
            </div>
            <div v-if="expandedFolders.has(folder.name)" class="folder-networks">
              <button v-for="network in folder.networks" :key="network.id"
                      class="network-row" :class="{ active: contextKind === 'network' && selectedNetwork.id === network.id }"
                      data-track="workspace-network-select" @click="selectNetwork(network)">
                <span class="network-state" :class="network.state" />
                <span class="network-copy">
                  <strong>{{ network.name }}</strong>
                  <small>{{ network.cidr }}<template v-if="network.vlan != null"> · VLAN {{ network.vlan }}</template></small>
                  <span class="mini-meter"><i :style="{ width: `${network.used}%` }" /></span>
                </span>
                <span class="network-percent">{{ network.used }}%</span>
              </button>
            </div>
          </section>
          <div v-if="!loading && !filteredFolders.length" class="explorer-empty">No allocated networks found.</div>
        </div>

        <div class="explorer-footer">
          <button @click="notify('Open folder management')"><i class="pi pi-folder-plus" /> Manage folders</button>
          <button @click="notify('Open network defaults')"><i class="pi pi-sliders-h" /> Defaults</button>
        </div>
      </aside>

      <main class="work-surface" :aria-busy="loadingContext">
        <div v-if="loadError" class="workspace-error" role="alert">
          <i class="pi pi-exclamation-circle" />
          <span><strong>Could not load workspace data</strong>{{ loadError }}</span>
          <button @click="loadWorkspace">Retry</button>
        </div>
        <header class="context-header">
          <div class="context-breadcrumb">
            <button data-track="workspace-breadcrumb-estate" @click="selectEstate">Infrastructure</button>
            <template v-if="contextKind === 'folder'">
              <i class="pi pi-chevron-right" />
              <span>{{ selectedFolder.name }}</span>
            </template>
            <template v-else-if="contextKind === 'network'">
              <i class="pi pi-chevron-right" />
              <button @click="selectFolderById(selectedNetwork.folderId)">{{ selectedNetwork.folder }}</button>
              <i class="pi pi-chevron-right" />
              <span>{{ contextTitle }}</span>
            </template>
          </div>
          <div class="context-overview">
            <div class="context-title-row">
              <div class="context-identity">
                <span class="context-icon" :class="contextKind"><i :class="contextIcon" /></span>
                <div>
                  <div class="title-line">
                    <h2>{{ contextTitle }}</h2>
                    <span v-if="contextKind === 'network'" class="state-chip"><i /> {{ selectedNetwork.status }}</span>
                  </div>
                  <p>{{ contextSubtitle }}</p>
                </div>
              </div>
            </div>

            <div class="health-strip">
              <button v-for="stat in contextStats" :key="stat.label" class="health-stat" :class="{ interactive: stat.view }"
                      :disabled="!stat.view" :data-track="stat.view ? `workspace-stat-${stat.view}` : null" @click="stat.view && switchView(stat.view)">
                <span>{{ stat.label }}</span>
                <strong>{{ stat.value }}</strong>
                <small :class="stat.tone"><i v-if="stat.dot" />{{ stat.note }}</small>
              </button>
            </div>

            <div class="context-actions">
              <button v-if="contextKind === 'network'" class="button secondary" @click="notify('Start network scan')">
                <i class="pi pi-search" /> Scan now
              </button>
              <button class="button secondary" @click="toggleMenu('actions')">
                Actions <i class="pi pi-chevron-down" />
              </button>
              <button class="button primary" @click="toggleMenu('create')">
                <i class="pi pi-plus" /> Create
              </button>
            </div>
          </div>
        </header>

        <nav class="view-tabs" aria-label="Network workspace views">
          <button v-for="view in availableViews" :key="view.key" :class="{ active: activeView === view.key }"
                  :data-track="`workspace-tab-${view.key}`" @click="switchView(view.key)">
            <i :class="view.icon" />
            {{ view.label }}
            <span>{{ view.count }}</span>
          </button>
        </nav>

        <section class="view-summary">
          <div>
            <span class="eyebrow">{{ viewMeta.eyebrow }}</span>
            <h3>{{ viewMeta.title }}</h3>
            <p>{{ viewMeta.description }}</p>
          </div>
          <div v-if="activeView === 'dns'" class="linked-resources">
            <button v-for="zone in summaryZones.slice(0, 2)" :key="zone.id" class="linked-card selected" @click="filterToZone(zone)">
              <i :class="zone.type === 'reverse' ? 'pi pi-replay' : 'pi pi-globe'" /><span><small>{{ zone.type }}</small><strong>{{ zone.name }}</strong></span><em>{{ zone.record_count || 0 }}</em>
            </button>
            <span v-if="!summaryZones.length" class="linked-empty">No linked zones</span>
          </div>
          <div v-else-if="activeView === 'dhcp'" class="linked-resources">
            <button v-for="scope in summaryScopes.slice(0, 2)" :key="scope.id" class="linked-card selected" @click="notify(`Scope ${scope.start_ip} to ${scope.end_ip}`)">
              <i class="pi pi-server" /><span><small>{{ scope.enabled ? 'ACTIVE SCOPE' : 'DISABLED SCOPE' }}</small><strong>{{ scope.start_ip }} – {{ scope.end_ip }}</strong></span><em>{{ formatDuration(scope.effective?.lease_time || scope.lease_time) }}</em>
            </button>
            <span v-if="!summaryScopes.length" class="linked-empty">No DHCP scope</span>
          </div>
          <div v-else-if="activeView === 'ranges'" class="range-legend">
            <span><i class="legend-dot scope" />DHCP Scope</span>
            <span><i class="legend-dot infra" />Infrastructure</span>
            <span><i class="legend-dot reserved" />IP Reservation</span>
            <span><i class="legend-dot system" />System</span>
          </div>
          <div v-else-if="activeView === 'addresses'" class="address-overview" aria-label="Address utilization">
            <div><span :style="{ '--value': addressOverview.assignedPercent }" /><small>Assigned</small><strong>{{ addressOverview.assigned }}</strong></div>
            <div><span :style="{ '--value': addressOverview.poolPercent }" /><small>DHCP pool</small><strong>{{ addressOverview.pool }}</strong></div>
            <div><span :style="{ '--value': addressOverview.availablePercent }" /><small>Available</small><strong>{{ addressOverview.available }}</strong></div>
          </div>
          <div v-else class="scope-summary">
            <i class="pi pi-sitemap" /> Select a network to work with its addresses, ranges, DNS, and DHCP configuration.
          </div>
        </section>

        <section class="table-card">
          <div v-if="loadingContext" class="loading-bar" data-track="workspace-loading">
            <i class="pi pi-spin pi-spinner" /> Loading live data…
          </div>
          <div class="table-toolbar">
            <label class="table-search">
              <i class="pi pi-search" />
              <input v-model="tableQuery" type="search" :placeholder="viewMeta.search" aria-label="Search current table" />
            </label>
            <button class="filter-button" :class="{ active: activeFilter !== 'all' }" @click="cycleFilter">
              <i class="pi pi-filter" /> {{ filterLabel }}
            </button>
            <label v-if="activeView === 'addresses' || (activeView === 'dhcp' && contextKind === 'network')" class="available-switch">
              <input v-model="showAvailable" type="checkbox" />
              <span /> Show available
            </label>
            <span class="toolbar-space" />
            <div v-if="activeView === 'addresses'" class="view-switcher" aria-label="Address presentation">
              <button :class="{ active: addressPresentation === 'table' }" aria-label="Table view" @click="addressPresentation = 'table'"><i class="pi pi-list" /></button>
              <button :class="{ active: addressPresentation === 'grid' }" aria-label="Grid view" @click="addressPresentation = 'grid'"><i class="pi pi-th-large" /></button>
              <button :class="{ active: addressPresentation === 'compact-grid' }" aria-label="Compact grid view" data-track="workspace-compact-grid" @click="addressPresentation = 'compact-grid'"><i class="pi pi-th-large compact-grid-icon" /></button>
            </div>
            <button class="icon-button bordered" title="Choose columns" aria-label="Choose columns" @click="notify('Column chooser will be added in the next workspace implementation pass')"><i class="pi pi-table" /></button>
            <button class="button primary compact" @click="notify(viewMeta.addAction)"><i class="pi pi-plus" /> {{ viewMeta.addLabel }}</button>
          </div>

          <div v-if="selectedRows.length" class="selection-bar">
            <strong>{{ selectedRows.length }} selected</strong>
            <button @click="notify(`Set range type for ${selectedRows.length} addresses`)">Set range type</button>
            <button @click="notify(`Create reservations for ${selectedRows.length} addresses`)">Reserve</button>
            <button @click="selectedRows = []">Clear</button>
          </div>

          <div v-if="activeView === 'addresses' && addressPresentation === 'grid'" class="address-grid-view">
            <div class="grid-ruler"><span>.0</span><span>.16</span><span>.32</span><span>.48</span><span>.64</span><span>.80</span><span>.96</span><span>.112</span></div>
            <div class="address-grid">
              <button v-for="cell in gridCells" :key="cell.ip" :class="cell.kind" :title="`${cell.ip} · ${cell.label}`"
                      @click="openGridCell(cell)"><span>{{ cell.last }}</span></button>
            </div>
            <div class="grid-key">
              <span><i class="system" />System</span><span><i class="gateway" />Gateway</span><span><i class="dhcp" />DHCP</span>
              <span><i class="dns" />Static DNS</span><span><i class="reserved" />Reserved</span><span><i class="rogue" />Rogue</span><span><i class="available" />Available</span>
            </div>
          </div>

          <div v-else-if="activeView === 'addresses' && addressPresentation === 'compact-grid'" class="compact-grid-view">
            <div class="compact-address-grid" aria-label="Compact address grid">
              <button v-for="(cell, index) in gridCells" :key="cell.ip" :class="[cell.kind, { section: (index + 1) % 16 === 0 }]"
                      :title="`${cell.ip} · ${cell.label}`" :aria-label="`${cell.ip}, ${cell.label}`" @click="openGridCell(cell)" />
            </div>
            <div class="grid-key">
              <span><i class="system" />System</span><span><i class="gateway" />Gateway</span><span><i class="dhcp" />DHCP</span>
              <span><i class="dns" />Static DNS</span><span><i class="reserved" />Reserved</span><span><i class="rogue" />Rogue</span><span><i class="available" />Available</span>
            </div>
          </div>

          <div v-else class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th v-if="activeView === 'addresses'" class="check-cell"><input type="checkbox" aria-label="Select all visible rows" @change="toggleAllRows" /></th>
                  <th v-for="column in columns" :key="column.key" :class="column.className">
                    <button @click="sortBy(column.key)">{{ column.label }} <i v-if="sortKey === column.key" :class="sortOrder === 1 ? 'pi pi-sort-amount-up-alt' : 'pi pi-sort-amount-down'" /></button>
                  </th>
                  <th class="action-cell"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in filteredRows" :key="row.id" :class="{ selected: selectedRow?.id === row.id }" @click="selectRow(row)">
                  <td v-if="activeView === 'addresses'" class="check-cell" @click.stop>
                    <input type="checkbox" :checked="selectedRows.includes(row.id)" :aria-label="`Select ${row.address}`" @change="toggleRow(row.id)" />
                  </td>
                  <td v-for="column in columns" :key="column.key" :class="column.className">
                    <template v-if="column.key === 'online'">
                      <span class="online-value" :class="row.online"><i />{{ row.online }}</span>
                    </template>
                    <template v-else-if="column.key === 'status' || column.key === 'leaseStatus'">
                      <span class="table-pill" :class="pillClass(row[column.key])">{{ row[column.key] }}</span>
                    </template>
                    <template v-else-if="column.key === 'type'">
                      <span v-if="row.type" class="type-value"><i :class="typeIcon(row.type)" />{{ row.type }}</span>
                      <span v-else class="muted">{{ EMPTY_CELL }}</span>
                    </template>
                    <template v-else-if="column.key === 'enabled'">
                      <span class="enabled-value" :class="{ off: !row.enabled }"><i />{{ row.enabled ? 'Enabled' : 'Disabled' }}</span>
                    </template>
                    <template v-else>{{ row[column.key] || EMPTY_CELL }}</template>
                  </td>
                  <td class="action-cell" @click.stop>
                    <button aria-label="Row actions" @click="openRowMenu(row)"><i class="pi pi-ellipsis-h" /></button>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-if="!filteredRows.length" class="no-results"><i class="pi pi-search" /><strong>No matching rows</strong><span>Try clearing the search or filters.</span></div>
          </div>

          <footer class="table-footer">
            <span>Showing {{ filteredRows.length }} of {{ rowTotal }}</span>
            <div class="pagination">
              <button :disabled="currentPage <= 1 || activeView !== 'addresses'" aria-label="Previous page" @click="changePage(currentPage - 1)"><i class="pi pi-chevron-left" /></button>
              <button class="active" aria-current="page">{{ currentPage }}</button>
              <span v-if="activeView === 'addresses'">of {{ totalPages }}</span>
              <button :disabled="currentPage >= totalPages || activeView !== 'addresses'" aria-label="Next page" @click="changePage(currentPage + 1)"><i class="pi pi-chevron-right" /></button>
            </div>
            <span>{{ activeView === 'addresses' ? `${pageSize} per page` : 'Live results' }}</span>
          </footer>
        </section>
      </main>

      <AddressDetailsPanel v-if="selectedRow && selectedRowView === 'addresses' && selectedRowContext === 'network'"
                           :row="selectedRow" :subnet-id="selectedNetwork.id" :network-name="selectedNetwork.name"
                           :dns-count="selectedAddressDnsCount" :dhcp-count="selectedAddressDhcpCount"
                           @close="selectedRow = null" @navigate="openRelatedResource" @changed="handleAddressChanged" />

      <aside v-else-if="selectedRow" class="details-panel">
        <div class="details-head">
          <div><span class="eyebrow">DETAILS</span><strong>{{ detailTitle }}</strong></div>
          <button class="icon-button" aria-label="Close details" @click="selectedRow = null"><i class="pi pi-times" /></button>
        </div>
        <div class="details-status">
          <span class="detail-orb" :class="selectedRow.online || 'unknown'"><i :class="detailIcon" /></span>
          <div><strong>{{ detailHeading }}</strong><small>{{ detailSubheading }}</small></div>
        </div>
        <dl>
          <template v-for="item in detailItems" :key="item.label">
            <dt>{{ item.label }}</dt><dd>{{ item.value || EMPTY_CELL }}</dd>
          </template>
        </dl>
        <div v-if="relatedResources.length" class="details-section">
          <span class="eyebrow">RELATED RESOURCES</span>
          <button v-for="resource in relatedResources" :key="resource.label" @click="openRelatedResource(resource.view)">
            <i :class="resource.icon" /><span><strong>{{ resource.label }}</strong><small>{{ resource.note }}</small></span><i class="pi pi-chevron-right" />
          </button>
        </div>
        <div class="details-section">
          <span class="eyebrow">QUICK ACTIONS</span>
          <div class="quick-actions">
            <button v-for="action in rowActions" :key="action" @click="notify(action)">{{ action }}</button>
          </div>
        </div>
        <button class="activity-link" @click="notify('Open full lifecycle and audit history')"><i class="pi pi-history" /> View lifecycle & audit history</button>
      </aside>
    </section>

    <div v-if="openMenuName" class="menu-scrim" @click="openMenuName = null" />
    <div v-if="openMenuName === 'create'" class="floating-menu create-menu">
      <span>CREATE RESOURCE</span>
      <button v-for="item in createActions" :key="item.label" @click="chooseMenuAction(item.label)">
        <i :class="item.icon" /><span><strong>{{ item.label }}</strong><small>{{ item.note }}</small></span>
      </button>
    </div>
    <div v-if="openMenuName === 'actions'" class="floating-menu actions-menu">
      <span>{{ actionMenuTitle }}</span>
      <button v-for="item in actionMenuItems" :key="item.label" :class="{ danger: item.danger }" @click="chooseMenuAction(item.label)">
        <i :class="item.icon" /><span><strong>{{ item.label }}</strong><small>{{ item.note }}</small></span>
      </button>
    </div>
    <div v-if="openMenuName === 'row'" class="floating-menu row-menu">
      <span>{{ activeView.toUpperCase() }} ACTIONS</span>
      <button v-for="action in rowActions" :key="action" @click="chooseMenuAction(action)"><i class="pi pi-angle-right" /><strong>{{ action }}</strong></button>
    </div>

    <Transition name="notice">
      <div v-if="notice" class="prototype-notice"><i class="pi pi-sparkles" /><span><strong>Workspace preview</strong>{{ notice }}</span></div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import api from '../api/client.js';
import { apiError, EMPTY_CELL, formatNumber } from '../utils/format.js';
import { ipToLong, isIpInSubnet, isValidIpv4, parseCidr } from '../utils/ip.js';
import { loadJson, saveJson } from '../utils/storage.js';
import AddressDetailsPanel from './networks-workspace/AddressDetailsPanel.vue';
import {
  buildExplorerFolders,
  countOnline,
  formatDuration,
  gridKind,
  isAttentionRow,
  isConfiguredRow,
  mapAddressRows,
  mapDhcpScopeRows,
  mapDhcpRows,
  mapDnsRows,
  mapDnsZoneRows,
  mapNetworkRows,
  mapRangeRows,
  sumScopeAddresses
} from './networks-workspace-data.js';

const networkViews = [
  { key: 'addresses', label: 'Addresses', icon: 'pi pi-list' },
  { key: 'dns', label: 'DNS', icon: 'pi pi-globe' },
  { key: 'dhcp', label: 'DHCP', icon: 'pi pi-server' },
  { key: 'ranges', label: 'Ranges', icon: 'pi pi-clone' }
];
const aggregateViews = [
  { key: 'networks', label: 'Networks', icon: 'pi pi-sitemap' },
  { key: 'dns', label: 'DNS', icon: 'pi pi-globe' },
  { key: 'dhcp', label: 'DHCP', icon: 'pi pi-server' }
];

const folders = ref([]);
const dnsZones = ref([]);
const allDnsRows = ref([]);
const dhcpScopes = ref([]);
const allDhcpRows = ref([]);
const addressRows = ref([]);
const networkDhcpRows = ref([]);
const rangeRows = ref([]);
const resourceQuery = ref('');
const tableQuery = ref('');
const selectedNetwork = ref({ id: null, folder: 'Infrastructure', name: 'Loading networks…', cidr: '', vlan: null, domain: null, status: 'allocated', total_addresses: 0, used_count: 0, used: 0 });
const selectedFolder = ref(null);
const contextKind = ref('estate');
const activeView = ref('networks');
const expandedFolders = ref(new Set());
const addressPresentation = ref('table');
const showAvailable = ref(true);
const activeFilter = ref('all');
const selectedRow = ref(null);
const selectedRows = ref([]);
const selectedRowView = ref('addresses');
const selectedRowContext = ref('network');
const selectedZoneFilter = ref(null);
const openMenuName = ref(null);
const notice = ref('');
const loading = ref(true);
const loadingContext = ref(false);
const loadError = ref('');
const currentPage = ref(1);
const pageSize = 256;
const totalPages = ref(1);
const addressTotal = ref(0);
const sortKey = ref(null);
const sortOrder = ref(1);
const fontBump = ref(Math.min(2, Math.max(0, Number(loadJson('cidrella_workspace_font_bump', 1)) || 0)));
let noticeTimer = null;
let searchTimer = null;
let contextRequest = 0;

const viewDefinitions = {
  networks: { eyebrow: 'MANAGED NETWORKS', description: 'Allocated address spaces in the current organizational scope.', search: 'Search network, CIDR, folder, VLAN, or domain…', addLabel: 'Allocate network', addAction: 'Allocate network' },
  addresses: { eyebrow: 'ADDRESS SPACE', description: 'Allocation, liveness, naming, and policy from the canonical IP read model.', search: 'Search IP, hostname, MAC, type…', addLabel: 'Reserve address', addAction: 'Create IP Reservation' },
  dns: { eyebrow: 'DNS FOR THIS NETWORK', description: 'Forward and reverse records linked to the selected address space.', search: 'Search name, zone, record type, or value…', addLabel: 'Add record', addAction: 'Add DNS record' },
  dhcp: { eyebrow: 'DHCP FOR THIS NETWORK', description: 'Leases, reservations, and pool availability without leaving the network.', search: 'Search IP, MAC, hostname, network, or lease…', addLabel: 'Add reservation', addAction: 'Add DHCP Reservation' },
  ranges: { eyebrow: 'ADDRESS POLICY', description: 'Functional scopes and organizational tags across the selected network.', search: 'Search range, type, or description…', addLabel: 'Add range', addAction: 'Add Network Range Type range' }
};

const columnDefinitions = {
  networks: [
    { key: 'name', label: 'Network', className: 'primary-cell wide-cell' }, { key: 'cidr', label: 'CIDR', className: 'mono' },
    { key: 'folder', label: 'Folder' }, { key: 'vlan', label: 'VLAN' }, { key: 'domain', label: 'Domain', className: 'mono wide-cell' },
    { key: 'gateway', label: 'Gateway', className: 'mono' }, { key: 'utilization', label: 'Utilization' }, { key: 'status', label: 'State' }
  ],
  addresses: [
    { key: 'address', label: 'IP address', className: 'mono primary-cell' }, { key: 'hostname', label: 'Hostname', className: 'wide-cell' },
    { key: 'status', label: 'Status' }, { key: 'type', label: 'Type' }, { key: 'online', label: 'Online' },
    { key: 'mac', label: 'MAC address', className: 'mono' }, { key: 'lastSeen', label: 'Last seen' }
  ],
  dns: [
    { key: 'name', label: 'Name', className: 'mono primary-cell' }, { key: 'recordType', label: 'Type' },
    { key: 'value', label: 'Value', className: 'mono wide-cell' }, { key: 'ttl', label: 'TTL' },
    { key: 'zone', label: 'Zone', className: 'mono' }, { key: 'source', label: 'Source' }, { key: 'enabled', label: 'State' }, { key: 'online', label: 'Target' }
  ],
  dnsZones: [
    { key: 'name', label: 'Zone', className: 'mono primary-cell wide-cell' }, { key: 'zoneType', label: 'Type' },
    { key: 'records', label: 'Records' }, { key: 'networks', label: 'Network scope', className: 'wide-cell' },
    { key: 'description', label: 'Description', className: 'wide-cell' }, { key: 'enabled', label: 'State' }
  ],
  dhcp: [
    { key: 'address', label: 'IP address', className: 'mono primary-cell' }, { key: 'hostname', label: 'Hostname', className: 'wide-cell' },
    { key: 'mac', label: 'MAC address', className: 'mono' }, { key: 'assignment', label: 'Assignment' },
    { key: 'leaseStatus', label: 'Lease status' }, { key: 'expires', label: 'Expires' }, { key: 'online', label: 'Online' }, { key: 'network', label: 'Network' }
  ],
  dhcpScopes: [
    { key: 'range', label: 'Scope', className: 'mono primary-cell wide-cell' }, { key: 'network', label: 'Network', className: 'wide-cell' },
    { key: 'poolSize', label: 'Pool size' }, { key: 'leaseTime', label: 'Lease time' },
    { key: 'description', label: 'Description', className: 'wide-cell' }, { key: 'enabled', label: 'State' }
  ],
  ranges: [
    { key: 'range', label: 'Address / range', className: 'mono primary-cell wide-cell' }, { key: 'rangeType', label: 'Range type' },
    { key: 'size', label: 'Size' }, { key: 'description', label: 'Description', className: 'wide-cell' },
    { key: 'policy', label: 'Behavior' }, { key: 'enabled', label: 'State' }
  ]
};

const createActions = [
  { label: 'Allocate network', note: 'Add address space to IPAM', icon: 'pi pi-sitemap' },
  { label: 'Create folder', note: 'Organize related networks', icon: 'pi pi-folder-plus' },
  { label: 'Add DNS zone', note: 'Forward or reverse authority', icon: 'pi pi-globe' },
  { label: 'Add DHCP scope', note: 'Create a dynamic address pool', icon: 'pi pi-server' },
  { label: 'Add DHCP Reservation', note: 'Bind a client to an address', icon: 'pi pi-bookmark' }
];

const networkActions = [
  { label: 'Edit network', note: 'Name, gateway, VLAN, domain, and scanning', icon: 'pi pi-pencil' },
  { label: 'Divide network', note: 'Preview child networks and dependencies', icon: 'pi pi-share-alt' },
  { label: 'Merge networks', note: 'Select an adjacent sibling', icon: 'pi pi-sitemap' },
  { label: 'Move to folder', note: 'Change organization without changing CIDR', icon: 'pi pi-folder' },
  { label: 'Apply defaults', note: 'Review template-managed settings', icon: 'pi pi-sync' },
  { label: 'Deallocate network', note: 'Return this block to its parent', icon: 'pi pi-undo', danger: true },
  { label: 'Delete network', note: 'Remove this network and its dependencies', icon: 'pi pi-trash', danger: true }
];
const dnsActions = [
  { label: 'Edit selected zone', note: 'Authority, SOA, description, and state', icon: 'pi pi-pencil' },
  { label: 'Switch forward / reverse', note: 'Browse the other side of DNS', icon: 'pi pi-replay' },
  { label: 'Add DNS zone', note: 'Create forward or reverse authority', icon: 'pi pi-plus' },
  { label: 'Delete selected zone', note: 'Review dependent records first', icon: 'pi pi-trash', danger: true }
];
const dhcpActions = [
  { label: 'Edit selected scope', note: 'Pool, lease policy, options, and state', icon: 'pi pi-pencil' },
  { label: 'Sync leases now', note: 'Refresh dnsmasq lease state', icon: 'pi pi-sync' },
  { label: 'Add DHCP scope', note: 'Create a dynamic address pool', icon: 'pi pi-plus' },
  { label: 'Delete selected scope', note: 'Keep the underlying range', icon: 'pi pi-trash', danger: true }
];

const filteredFolders = computed(() => {
  const query = resourceQuery.value.trim().toLowerCase();
  if (!query) return folders.value;
  return folders.value.map(folder => ({
    ...folder,
    networks: folder.name.toLowerCase().includes(query)
      ? folder.networks
      : folder.networks.filter(network => `${network.name} ${network.cidr} ${network.vlan}`.toLowerCase().includes(query))
  })).filter(folder => folder.name.toLowerCase().includes(query) || folder.networks.length);
});

const allNetworks = computed(() => folders.value.flatMap(folder => folder.networks));
const scopedNetworks = computed(() => {
  if (contextKind.value === 'network') return selectedNetwork.value.id ? [selectedNetwork.value] : [];
  if (contextKind.value === 'folder') return selectedFolder.value?.networks || [];
  return allNetworks.value;
});
const scopedNetworkIds = computed(() => new Set(scopedNetworks.value.map(network => Number(network.id))));
const dnsZoneNetworkIds = computed(() => {
  const result = new Map(dnsZones.value.map(zone => [Number(zone.id), new Set()]));
  for (const zone of dnsZones.value) {
    const ids = result.get(Number(zone.id));
    for (const network of allNetworks.value) {
      if (Number(zone.subnet_id) === Number(network.id)
          || (zone.type === 'forward' && network.domain && zone.name === network.domain)) ids.add(Number(network.id));
    }
  }
  for (const row of allDnsRows.value) {
    const zoneId = Number(row.raw.zone_id);
    const subnetId = Number(row.raw.subnet_id);
    if (result.has(zoneId) && Number.isFinite(subnetId)) result.get(zoneId).add(subnetId);
  }
  return result;
});
const dnsZoneNetworkLabels = computed(() => new Map(dnsZones.value.map(zone => {
  const names = [...(dnsZoneNetworkIds.value.get(Number(zone.id)) || [])]
    .map(id => allNetworks.value.find(network => Number(network.id) === id)?.name)
    .filter(Boolean);
  return [Number(zone.id), names.length > 2 ? `${names.length} networks` : names.join(', ') || 'Unlinked'];
})));
const scopedZones = computed(() => contextKind.value === 'estate' ? dnsZones.value : dnsZones.value.filter(zone =>
  [...(dnsZoneNetworkIds.value.get(Number(zone.id)) || [])].some(id => scopedNetworkIds.value.has(id))
));
const scopedScopes = computed(() => contextKind.value === 'estate' ? dhcpScopes.value : dhcpScopes.value.filter(scope =>
  scopedNetworkIds.value.has(Number(scope.subnet_id))
));
const scopedDhcpRows = computed(() => contextKind.value === 'estate' ? allDhcpRows.value : allDhcpRows.value.filter(row =>
  scopedNetworkIds.value.has(Number(row.raw.subnet_id))
));
const networkInventoryRows = computed(() => mapNetworkRows(scopedNetworks.value));
const dnsZoneRows = computed(() => mapDnsZoneRows(scopedZones.value, dnsZoneNetworkLabels.value));
const dhcpScopeRows = computed(() => mapDhcpScopeRows(scopedScopes.value));

const contextTitle = computed(() => {
  if (contextKind.value === 'estate') return 'All Networks';
  if (contextKind.value === 'folder') return selectedFolder.value?.name || 'Folder';
  return selectedNetwork.value.name;
});
const contextSubtitle = computed(() => {
  if (contextKind.value === 'network') return [selectedNetwork.value.cidr, selectedNetwork.value.vlan != null ? `VLAN ${selectedNetwork.value.vlan}` : null, selectedNetwork.value.domain].filter(Boolean).join(' · ');
  if (contextKind.value === 'folder') return `${scopedNetworks.value.length} managed networks in this folder`;
  return `${allNetworks.value.length} managed networks across all folders`;
});
const contextIcon = computed(() => contextKind.value === 'estate' ? 'pi pi-building' : contextKind.value === 'folder' ? 'pi pi-folder' : 'pi pi-sitemap');
const linkedZones = computed(() => dnsZones.value.filter(zone =>
  dnsZoneNetworkIds.value.get(Number(zone.id))?.has(Number(selectedNetwork.value.id))
));
const linkedZoneIds = computed(() => new Set(linkedZones.value.map(zone => Number(zone.id))));
const networkDnsRows = computed(() => allDnsRows.value.filter(row => linkedZoneIds.value.has(Number(row.raw.zone_id))));
const networkScopes = computed(() => dhcpScopes.value.filter(scope => Number(scope.subnet_id) === Number(selectedNetwork.value.id)));
const summaryZones = computed(() => contextKind.value === 'network' ? linkedZones.value : scopedZones.value);
const summaryScopes = computed(() => contextKind.value === 'network' ? networkScopes.value : scopedScopes.value);
const scopedActiveLeaseCount = computed(() => scopedDhcpRows.value.filter(row => row.leaseStatus === 'active').length);
const availableViews = computed(() => contextKind.value === 'network'
  ? networkViews.map(view => ({
      ...view,
      count: String(view.key === 'addresses' ? addressTotal.value : view.key === 'dns' ? networkDnsRows.value.length : view.key === 'dhcp' ? networkDhcpRows.value.length : rangeRows.value.length)
    }))
  : aggregateViews.map(view => ({
      ...view,
      count: String(view.key === 'networks' ? scopedNetworks.value.length : view.key === 'dns' ? scopedZones.value.length : scopedScopes.value.length)
    })));
const viewMeta = computed(() => {
  const base = viewDefinitions[activeView.value];
  if (contextKind.value !== 'network') {
    const scopeDescription = contextKind.value === 'folder' ? ` within ${selectedFolder.value?.name}` : ' across all managed networks';
    if (activeView.value === 'networks') return { ...base, title: `${scopedNetworks.value.length} managed networks`, description: `Allocated networks${scopeDescription}. Select one in the explorer to enter its working context.` };
    if (activeView.value === 'dns') return { ...base, eyebrow: 'DNS ZONE INVENTORY', title: `${scopedZones.value.length} authoritative zones`, description: `Forward and reverse zones${scopeDescription}.` };
    if (activeView.value === 'dhcp') return { ...base, eyebrow: 'DHCP SCOPE INVENTORY', title: `${scopedScopes.value.length} configured scopes`, description: `Dynamic address pools and lease policy${scopeDescription}.` };
  }
  if (activeView.value === 'addresses') return { ...base, title: `${formatNumber(addressTotal.value)} managed addresses` };
  if (activeView.value === 'dns') return { ...base, title: selectedZoneFilter.value?.name || selectedNetwork.value.domain || `${networkDnsRows.value.length} linked records` };
  if (activeView.value === 'dhcp') return { ...base, title: networkScopes.value.length === 1 ? `${selectedNetwork.value.name} scope` : `${networkScopes.value.length} scopes for ${selectedNetwork.value.name}` };
  return { ...base, title: `${rangeRows.value.length} managed ranges` };
});
const columns = computed(() => {
  if (contextKind.value !== 'network' && activeView.value === 'dns') return columnDefinitions.dnsZones;
  if (contextKind.value !== 'network' && activeView.value === 'dhcp') return columnDefinitions.dhcpScopes;
  return columnDefinitions[activeView.value];
});
const currentRows = computed(() => {
  let rows;
  if (activeView.value === 'networks') rows = networkInventoryRows.value;
  else if (activeView.value === 'addresses') rows = addressRows.value;
  else if (activeView.value === 'dns') rows = contextKind.value === 'network' ? networkDnsRows.value : dnsZoneRows.value;
  else if (activeView.value === 'dhcp') rows = contextKind.value === 'network' ? networkDhcpRows.value : dhcpScopeRows.value;
  else rows = rangeRows.value;
  if (activeView.value === 'dns' && selectedZoneFilter.value) rows = rows.filter(row =>
    Number(contextKind.value === 'network' ? row.raw.zone_id : row.raw.id) === Number(selectedZoneFilter.value.id)
  );
  if (!sortKey.value || activeView.value === 'addresses') return rows;
  return [...rows].sort((a, b) => String(a[sortKey.value] ?? '').localeCompare(String(b[sortKey.value] ?? ''), undefined, { numeric: true }) * sortOrder.value);
});
const filterLabel = computed(() => activeFilter.value === 'all' ? 'All states' : activeFilter.value === 'attention' ? 'Needs attention' : 'Configured only');
const actionMenuTitle = computed(() => activeView.value === 'dns' ? 'DNS ACTIONS' : activeView.value === 'dhcp' ? 'DHCP ACTIONS' : 'NETWORK ACTIONS');
const actionMenuItems = computed(() => activeView.value === 'dns' ? dnsActions : activeView.value === 'dhcp' ? dhcpActions : networkActions);

const contextStats = computed(() => contextKind.value === 'network' ? [
  { label: 'UTILIZATION', value: `${selectedNetwork.value.used}%`, note: `${formatNumber(selectedNetwork.value.used_count)} assigned`, tone: 'neutral' },
  { label: 'ONLINE NOW', value: formatNumber(countOnline(addressRows.value)), note: addressTotal.value > addressRows.value.length ? 'on this page' : 'across this network', tone: 'good', dot: true },
  { label: 'DNS', value: `${networkDnsRows.value.length} records`, note: `${linkedZones.value.length} linked zones`, tone: 'neutral', view: 'dns' },
  { label: 'DHCP POOL', value: formatNumber(sumScopeAddresses(networkScopes.value)), note: `${networkScopes.value.filter(scope => scope.enabled).length} active scopes`, tone: 'good', dot: true, view: 'dhcp' },
  { label: 'ATTENTION', value: `${addressRows.value.filter(row => row.type === 'rogue').length} rogue`, note: addressTotal.value > addressRows.value.length ? 'on this page' : 'currently detected', tone: 'warning', dot: true }
] : [
  { label: 'NETWORKS', value: formatNumber(scopedNetworks.value.length), note: contextKind.value === 'folder' ? 'in this folder' : 'across all folders', tone: 'good', dot: true, view: 'networks' },
  { label: 'DNS ZONES', value: formatNumber(scopedZones.value.length), note: 'forward and reverse', tone: 'neutral', view: 'dns' },
  { label: 'DHCP SCOPES', value: formatNumber(scopedScopes.value.length), note: `${formatNumber(sumScopeAddresses(scopedScopes.value))} pool addresses`, tone: 'good', dot: true, view: 'dhcp' },
  { label: 'ACTIVE LEASES', value: formatNumber(scopedActiveLeaseCount.value), note: 'live assignments', tone: 'neutral' },
  { label: 'ATTENTION', value: scopedNetworks.value.filter(network => network.state === 'warning').length, note: 'high-utilization networks', tone: 'warning', dot: true }
]);

const addressOverview = computed(() => {
  const total = Math.max(1, addressRows.value.length);
  const assigned = addressRows.value.filter(row => row.status === 'in use').length;
  const pool = addressRows.value.filter(row => row.status === 'DHCP Scope').length;
  const available = addressRows.value.filter(row => row.status === 'available').length;
  return {
    assigned, pool, available,
    assignedPercent: `${Math.round((assigned / total) * 100)}%`,
    poolPercent: `${Math.round((pool / total) * 100)}%`,
    availablePercent: `${Math.round((available / total) * 100)}%`
  };
});

const filteredRows = computed(() => {
  const queries = [resourceQuery.value, tableQuery.value]
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  return currentRows.value.filter(row => {
    if (!showAvailable.value && (row.status === 'available' || row.leaseStatus === 'available')) return false;
    if (activeFilter.value === 'attention' && !isAttentionRow(row)) return false;
    if (activeFilter.value === 'configured' && !isConfiguredRow(row)) return false;
    return queries.every(query => Object.entries(row).some(([key, value]) => key !== 'raw' && String(value ?? '').toLowerCase().includes(query)));
  });
});

const detailTitle = computed(() => {
  if (selectedRowView.value === 'networks') return 'Network';
  if (selectedRowView.value === 'dns') return selectedRowContext.value === 'network' ? 'DNS record' : 'DNS zone';
  if (selectedRowView.value === 'dhcp') return selectedRowContext.value === 'network' ? 'DHCP address' : 'DHCP scope';
  return selectedRowView.value === 'ranges' ? 'Managed range' : 'IP address';
});
const detailHeading = computed(() => selectedRow.value?.address || selectedRow.value?.name || selectedRow.value?.range || 'Resource');
const detailSubheading = computed(() => selectedRow.value?.hostname || selectedRow.value?.value || selectedRow.value?.description || contextTitle.value);
const detailIcon = computed(() => selectedRowView.value === 'dns' ? 'pi pi-globe' : selectedRowView.value === 'dhcp' ? 'pi pi-server' : selectedRowView.value === 'ranges' ? 'pi pi-clone' : 'pi pi-desktop');
const detailItems = computed(() => Object.entries(selectedRow.value || {}).filter(([key]) => !['id', 'online', 'enabled', 'raw'].includes(key)).slice(0, 8).map(([key, value]) => ({
  label: key.replace(/([A-Z])/g, ' $1').replace(/^./, char => char.toUpperCase()),
  value
})));
const relatedResources = computed(() => selectedRowContext.value !== 'network' ? [] : selectedRowView.value === 'addresses' ? [
  { view: 'dns', label: 'DNS records', note: `${networkDnsRows.value.filter(row => row.value === selectedRow.value?.address).length} records reference this address`, icon: 'pi pi-globe' },
  { view: 'dhcp', label: 'DHCP identity', note: `${networkDhcpRows.value.filter(row => row.address === selectedRow.value?.address).length} related rows`, icon: 'pi pi-server' }
] : [
  { view: 'addresses', label: 'Canonical IP record', note: 'Allocation and liveness details', icon: 'pi pi-list' },
  { view: selectedRowView.value === 'dns' ? 'dhcp' : 'dns', label: selectedRowView.value === 'dns' ? 'DHCP identity' : 'DNS records', note: 'Related service facts', icon: selectedRowView.value === 'dns' ? 'pi pi-server' : 'pi pi-globe' }
]);
const selectedAddressDnsCount = computed(() => networkDnsRows.value.filter(row => row.value === selectedRow.value?.address || row.raw.ip_address === selectedRow.value?.address).length);
const selectedAddressDhcpCount = computed(() => networkDhcpRows.value.filter(row => row.address === selectedRow.value?.address).length);
const rowActions = computed(() => {
  const row = selectedRow.value;
  if (selectedRowView.value === 'networks') return ['Open network context', 'Edit network', 'Scan network'];
  if (selectedRowContext.value !== 'network' && selectedRowView.value === 'dns') return ['Open zone', 'Edit zone', 'Add DNS record', 'Delete zone'];
  if (selectedRowContext.value !== 'network' && selectedRowView.value === 'dhcp') return ['Open network DHCP', 'Edit DHCP scope', 'Add DHCP Reservation', 'Sync leases now', 'Delete DHCP scope'];
  if (selectedRowView.value === 'dns') return ['Open IP details', 'Edit record', 'Add CNAME', 'Probe target now', 'Delete record'];
  if (selectedRowView.value === 'dhcp') {
    if (row?.assignment === 'Reserved') return ['Open IP details', 'Edit DHCP Reservation', 'Probe now', 'Delete DHCP Reservation'];
    return ['Open IP details', 'Add DHCP Reservation', 'Probe now'];
  }
  if (selectedRowView.value === 'ranges') {
    return row?.rangeType === 'DHCP Scope'
      ? ['Edit DHCP scope', 'Remove addresses from scope', 'Delete DHCP scope']
      : ['Edit range', 'Create DHCP scope', 'Delete range'];
  }

  const actions = ['Open full details'];
  if (row?.type === 'gateway') actions.push('Edit gateway', 'Delete gateway', 'Create DHCP scope');
  else if (row?.status === 'DHCP Scope') actions.push('Edit DHCP scope', 'Remove this IP from scope', 'Delete DHCP scope');
  if (row?.type === 'IP Reservation') actions.push('Release IP Reservation');
  else if (!['system', 'gateway'].includes(row?.type)) actions.push('Create IP Reservation');
  if (row?.type === 'dynamic DHCP' || row?.status === 'DHCP Scope') actions.push('Create DHCP Reservation');
  actions.push('Set range type', 'Change scan setting', 'Probe now');
  return actions;
});

const gridCells = computed(() => addressRows.value.map(row => ({
  ip: row.address,
  last: row.address.split('.').at(-1),
  kind: gridKind(row),
  label: row.type || row.status || 'Available',
  row
})));

const rowTotal = computed(() => activeView.value === 'addresses' ? addressTotal.value : currentRows.value.length);

function toggleFolder(name) {
  const next = new Set(expandedFolders.value);
  if (next.has(name)) next.delete(name); else next.add(name);
  expandedFolders.value = next;
}
async function selectNetwork(network) {
  selectedNetwork.value = network;
  selectedFolder.value = folders.value.find(folder => Number(folder.id) === Number(network.folderId)) || null;
  contextKind.value = 'network';
  if (!networkViews.some(view => view.key === activeView.value)) activeView.value = 'addresses';
  currentPage.value = 1;
  sortKey.value = null;
  activeFilter.value = 'all';
  selectedZoneFilter.value = null;
  selectedRow.value = null;
  tableQuery.value = '';
  await loadNetworkContext();
}
function resetContextNavigation() {
  currentPage.value = 1;
  sortKey.value = null;
  activeFilter.value = 'all';
  selectedZoneFilter.value = null;
  selectedRow.value = null;
  selectedRows.value = [];
  tableQuery.value = '';
}
function selectEstate() {
  contextKind.value = 'estate';
  selectedFolder.value = null;
  if (!aggregateViews.some(view => view.key === activeView.value)) activeView.value = 'networks';
  resetContextNavigation();
}
function selectFolder(folder) {
  contextKind.value = 'folder';
  selectedFolder.value = folder;
  if (!expandedFolders.value.has(folder.name)) toggleFolder(folder.name);
  if (!aggregateViews.some(view => view.key === activeView.value)) activeView.value = 'networks';
  resetContextNavigation();
}
function selectFolderById(folderId) {
  const folder = folders.value.find(item => Number(item.id) === Number(folderId));
  if (folder) selectFolder(folder);
}
function switchView(view) {
  activeView.value = view;
  currentPage.value = 1;
  sortKey.value = null;
  activeFilter.value = 'all';
  selectedZoneFilter.value = null;
  selectedRow.value = null;
  selectedRows.value = [];
  tableQuery.value = '';
}
function openRelatedResource(view) {
  activeView.value = view;
  currentPage.value = 1;
  sortKey.value = null;
  activeFilter.value = 'all';
  selectedZoneFilter.value = null;
  selectedRows.value = [];
  tableQuery.value = '';
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
}
function notify(message) {
  notice.value = `${message}. Data is live, but this action is still available in the Current interface while workspace mutations are connected.`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = ''; }, 2600);
}
function showLiveNotice(message) {
  notice.value = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = ''; }, 3200);
}
function cycleFilter() {
  activeFilter.value = activeFilter.value === 'all' ? 'attention' : activeFilter.value === 'attention' ? 'configured' : 'all';
}
function toggleRow(id) {
  selectedRows.value = selectedRows.value.includes(id) ? selectedRows.value.filter(rowId => rowId !== id) : [...selectedRows.value, id];
}
function toggleAllRows(event) {
  selectedRows.value = event.target.checked ? filteredRows.value.map(row => row.id) : [];
}
function openGridCell(cell) {
  selectRow(cell.row);
}
function resizeSmallText(delta) {
  fontBump.value = Math.min(2, Math.max(0, fontBump.value + delta));
  saveJson('cidrella_workspace_font_bump', fontBump.value);
}
function pillClass(value) {
  return String(value || '').toLowerCase().replaceAll(' ', '-');
}
function typeIcon(type) {
  if (type === 'gateway') return 'pi pi-directions';
  if (type?.includes('DHCP')) return 'pi pi-server';
  if (type === 'static DNS') return 'pi pi-globe';
  if (type === 'rogue') return 'pi pi-exclamation-triangle';
  return 'pi pi-shield';
}

function filterToZone(zone) {
  selectedZoneFilter.value = selectedZoneFilter.value?.id === zone.id ? null : zone;
  tableQuery.value = '';
}

function mergeNetworkDhcpRows(scopeRows) {
  const rows = [...scopeRows];
  const seen = new Set(rows.map(row => `${row.address}:${row.assignment || ''}`));
  for (const row of allDhcpRows.value.filter(item => Number(item.raw.subnet_id) === Number(selectedNetwork.value.id))) {
    const key = `${row.address}:${row.assignment || ''}`;
    if (!seen.has(key)) rows.push(row);
  }
  return rows;
}

const addressSortFields = {
  address: 'ip_address', hostname: 'hostname', status: 'ip_display_status', type: 'computed_type',
  online: 'is_online', mac: 'mac_address', lastSeen: 'last_seen_at'
};

async function loadNetworkContext() {
  if (!selectedNetwork.value.id) return;
  const request = ++contextRequest;
  loadingContext.value = true;
  loadError.value = '';
  try {
    const params = {
      page: currentPage.value,
      pageSize,
      showAvailable: showAvailable.value ? 'true' : 'false'
    };
    if (activeView.value === 'addresses' && (resourceQuery.value || tableQuery.value)) {
      const search = resourceQuery.value.trim() || tableQuery.value.trim();
      if (isValidIpv4(search) && isIpInSubnet(search, selectedNetwork.value.cidr)) {
        const network = parseCidr(selectedNetwork.value.cidr);
        params.page = Math.floor((ipToLong(search) - network.networkLong) / pageSize) + 1;
      } else {
        params.search = search;
      }
    }
    if (sortKey.value && addressSortFields[sortKey.value]) {
      params.sortField = addressSortFields[sortKey.value];
      params.sortOrder = sortOrder.value === 1 ? 'asc' : 'desc';
    }
    const [detail, scopeAddressResults] = await Promise.all([
      api.get(`/subnets/${selectedNetwork.value.id}/ips`, { params }),
      Promise.all(networkScopes.value.map(scope => api.get(`/dhcp/scopes/${scope.id}/addresses`).then(response => response.data)))
    ]);
    if (request !== contextRequest) return;
    addressRows.value = mapAddressRows(detail.data.ips);
    if (selectedRow.value && selectedRowView.value === 'addresses' && selectedRowContext.value === 'network') {
      selectedRow.value = addressRows.value.find(row => row.address === selectedRow.value.address) || selectedRow.value;
    }
    rangeRows.value = mapRangeRows(detail.data.ranges, networkScopes.value);
    addressTotal.value = detail.data.totalIps;
    totalPages.value = detail.data.totalPages || 1;
    currentPage.value = detail.data.page || 1;
    networkDhcpRows.value = mergeNetworkDhcpRows(mapDhcpRows(scopeAddressResults.flat()));
  } catch (error) {
    if (request === contextRequest) loadError.value = apiError(error);
  } finally {
    if (request === contextRequest) loadingContext.value = false;
  }
}

async function refreshSelectedNetwork() {
  const selectedId = Number(selectedNetwork.value.id);
  const treeResponse = await api.get('/subnets');
  folders.value = buildExplorerFolders(treeResponse.data.folders);
  const refreshed = folders.value.flatMap(folder => folder.networks).find(network => Number(network.id) === selectedId);
  if (refreshed) {
    selectedNetwork.value = refreshed;
    selectedFolder.value = folders.value.find(folder => Number(folder.id) === Number(refreshed.folderId)) || selectedFolder.value;
  }
  await loadNetworkContext();
}

async function handleAddressChanged(message) {
  showLiveNotice(message);
  await refreshSelectedNetwork();
}

async function loadWorkspace() {
  loading.value = true;
  loadingContext.value = true;
  loadError.value = '';
  try {
    const [treeResponse, zonesResponse, scopesResponse, leasesResponse] = await Promise.all([
      api.get('/subnets'), api.get('/dns/zones'), api.get('/dhcp/scopes'), api.get('/dhcp/leases')
    ]);
    folders.value = buildExplorerFolders(treeResponse.data.folders);
    dnsZones.value = zonesResponse.data;
    dhcpScopes.value = scopesResponse.data;
    allDhcpRows.value = mapDhcpRows(leasesResponse.data);
    const zoneRecords = await Promise.all(dnsZones.value.map(zone =>
      api.get(`/dns/zones/${zone.id}/records`).then(response => ({ zone, records: response.data }))
    ));
    allDnsRows.value = mapDnsRows(zoneRecords);
    expandedFolders.value = new Set(folders.value.map(folder => folder.name));
    const availableNetworks = folders.value.flatMap(folder => folder.networks);
    const priorSelection = availableNetworks.find(network => Number(network.id) === Number(selectedNetwork.value.id));
    if (priorSelection || availableNetworks[0]) {
      selectedNetwork.value = priorSelection || availableNetworks[0];
      selectedFolder.value = folders.value.find(folder => Number(folder.id) === Number(selectedNetwork.value.folderId)) || null;
    }
    contextKind.value = 'estate';
    activeView.value = 'networks';
    loadingContext.value = false;
  } catch (error) {
    loadError.value = apiError(error);
    loadingContext.value = false;
  } finally {
    loading.value = false;
  }
}

async function changePage(page) {
  if (activeView.value !== 'addresses' || page < 1 || page > totalPages.value) return;
  currentPage.value = page;
  selectedRows.value = [];
  selectedRow.value = null;
  await loadNetworkContext();
}

async function sortBy(key) {
  sortOrder.value = sortKey.value === key ? sortOrder.value * -1 : 1;
  sortKey.value = key;
  if (activeView.value === 'addresses') {
    currentPage.value = 1;
    await loadNetworkContext();
  }
}

watch(showAvailable, () => {
  if (activeView.value !== 'addresses' || contextKind.value !== 'network') return;
  currentPage.value = 1;
  loadNetworkContext();
});

watch(tableQuery, () => {
  if (activeView.value !== 'addresses' || contextKind.value !== 'network') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    currentPage.value = 1;
    loadNetworkContext();
  }, 300);
});

watch(resourceQuery, () => {
  if (activeView.value !== 'addresses' || contextKind.value !== 'network') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    currentPage.value = 1;
    loadNetworkContext();
  }, 300);
});

onMounted(loadWorkspace);
</script>

<style scoped>
.workspace-preview {
  --preview-accent: color-mix(in srgb, #14b8a6 78%, var(--p-text-color));
  --preview-dns: color-mix(in srgb, #f59e0b 82%, var(--p-text-color));
  --preview-dhcp: color-mix(in srgb, #8b5cf6 82%, var(--p-text-color));
  --preview-accent-soft: color-mix(in srgb, var(--preview-accent) 12%, transparent);
  --preview-line: color-mix(in srgb, var(--p-surface-border) 82%, transparent);
  --preview-muted: var(--p-text-muted-color);
  --workspace-font-micro: min(11pt, calc(0.58rem + var(--workspace-font-bump)));
  --workspace-font-small: min(11pt, calc(0.65rem + var(--workspace-font-bump)));
  --workspace-font-body: min(11pt, calc(var(--app-fs-sm) + var(--workspace-font-bump)));
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  min-height: 100%;
  padding: 1.1rem;
  box-sizing: border-box;
  color: var(--p-text-color);
  background:
    radial-gradient(circle at 78% 0%, color-mix(in srgb, var(--preview-dns) 8%, transparent), transparent 27rem),
    radial-gradient(circle at 7% 65%, color-mix(in srgb, var(--preview-accent) 8%, transparent), transparent 24rem),
    var(--p-surface-ground);
}
button, input { font: inherit; }
button { color: inherit; }
.preview-banner { display: flex; align-items: flex-end; justify-content: space-between; gap: 2rem; margin: 0 0 1rem; }
.preview-banner h1 { margin: 0.12rem 0 0.25rem; font-size: clamp(1.35rem, 2vw, 2rem); letter-spacing: -0.035em; }
.preview-banner p { margin: 0; color: var(--preview-muted); font-size: var(--app-fs-base); }
.preview-kicker, .eyebrow { color: var(--preview-accent); font-size: 0.65rem; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
.preview-banner-actions { display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.font-sizer { display: inline-flex; min-height: 1.85rem; align-items: center; gap: 0.12rem; padding: 0.14rem; border: 1px solid var(--preview-line); border-radius: 8px; color: var(--preview-muted); background: var(--p-surface-card); font-size: var(--workspace-font-body); }
.font-sizer > span { display: inline-flex; align-items: center; gap: 0.32rem; padding: 0 0.35rem; }.font-sizer > span i { color: var(--preview-accent); }.font-sizer button { width: 1.55rem; height: 1.55rem; border: 0; border-radius: 5px; color: var(--preview-accent); background: var(--preview-accent-soft); font-weight: 800; cursor: pointer; }.font-sizer button:disabled { opacity: .35; cursor: default; }.font-sizer output { min-width: 3.6rem; padding: 0 0.18rem; color: var(--p-text-color); text-align: center; font-weight: 750; }
.sample-pill, .quiet-link { display: inline-flex; align-items: center; gap: 0.4rem; border-radius: 999px; font-size: var(--app-fs-sm); }
.sample-pill { padding: 0.4rem 0.7rem; color: var(--preview-muted); background: var(--p-surface-card); border: 1px solid var(--preview-line); }
.sample-pill.live { color: var(--preview-accent); border-color: color-mix(in srgb, var(--preview-accent) 35%, var(--preview-line)); background: var(--preview-accent-soft); }
.sample-pill.live i { font-size: 0.48rem; }
.quiet-link { padding: 0.4rem 0.15rem; color: var(--preview-accent); text-decoration: none; font-weight: 700; }
.workspace-frame { position: relative; display: grid; grid-template-columns: 275px minmax(0, 1fr); flex: 1; min-height: 650px; overflow: hidden; background: var(--p-surface-card); border: 1px solid var(--preview-line); border-radius: 14px; box-shadow: 0 18px 50px rgba(15, 23, 42, 0.1); }
.resource-explorer { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--preview-line); background: color-mix(in srgb, var(--p-surface-ground) 65%, var(--p-surface-card)); }
.explorer-heading { display: flex; align-items: center; justify-content: space-between; padding: 1rem 0.9rem 0.7rem; }
.explorer-heading > div { display: flex; flex-direction: column; gap: 0.18rem; }
.explorer-heading strong { font-size: 1rem; }
.icon-button { display: inline-flex; width: 2rem; height: 2rem; align-items: center; justify-content: center; border: 0; border-radius: 7px; background: transparent; cursor: pointer; }
.icon-button:hover { background: var(--preview-accent-soft); color: var(--preview-accent); }
.icon-button.bordered { border: 1px solid var(--preview-line); }
.explorer-search, .table-search { display: flex; align-items: center; gap: 0.5rem; border: 1px solid var(--preview-line); background: var(--p-surface-card); }
.explorer-search { margin: 0 0.75rem 0.8rem; padding: 0 0.55rem; min-height: 2.25rem; border-radius: 8px; }
.explorer-search i, .table-search i { color: var(--preview-muted); font-size: 0.78rem; }
.explorer-search input, .table-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--p-text-color); font-size: var(--app-fs-sm); }
.explorer-search kbd { padding: 0.12rem 0.3rem; border: 1px solid var(--preview-line); border-radius: 4px; color: var(--preview-muted); background: var(--p-surface-ground); font-size: 0.62rem; }
.estate-row { display: grid; grid-template-columns: 2rem 1fr auto; align-items: center; gap: 0.55rem; margin: 0 0.55rem 0.65rem; padding: 0.55rem; border: 1px solid var(--preview-line); border-radius: 9px; text-align: left; background: var(--p-surface-card); cursor: pointer; }
.estate-row:hover, .estate-row.active { border-color: color-mix(in srgb, var(--preview-accent) 45%, var(--preview-line)); background: var(--preview-accent-soft); }
.estate-row > span:nth-child(2) { display: flex; min-width: 0; flex-direction: column; gap: 0.12rem; }
.estate-row strong { font-size: var(--app-fs-sm); }.estate-row small { overflow: hidden; color: var(--preview-muted); font-size: 0.63rem; text-overflow: ellipsis; white-space: nowrap; }.estate-row > .pi-chevron-right { color: var(--preview-muted); font-size: 0.6rem; }
.estate-icon { display: inline-flex; width: 1.85rem; height: 1.85rem; align-items: center; justify-content: center; border-radius: 7px; color: var(--preview-accent); background: var(--preview-accent-soft); }
.explorer-section-head { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 0.75rem 0.35rem; color: var(--preview-muted); font-size: 0.62rem; font-weight: 800; letter-spacing: 0.12em; }
.explorer-section-head button { padding: 0; border: 0; color: var(--preview-accent); background: none; font-size: 0.64rem; font-weight: 700; letter-spacing: 0; cursor: pointer; }
.network-tree { flex: 1; min-height: 0; overflow-y: auto; padding: 0 0.45rem; }
.explorer-empty { padding: 1rem 0.7rem; color: var(--preview-muted); font-size: var(--app-fs-sm); text-align: center; }
.network-group + .network-group { margin-top: 0.18rem; }
.folder-row { display: grid; grid-template-columns: 1.25rem 1fr; width: 100%; align-items: center; padding: 0.12rem; border-radius: 7px; color: var(--preview-muted); }
.folder-row:hover, .folder-row.active { background: var(--preview-accent-soft); }.folder-row.active { box-shadow: inset 3px 0 var(--preview-accent); }
.folder-toggle, .folder-select { border: 0; background: none; cursor: pointer; }.folder-toggle { display: inline-flex; width: 1.25rem; height: 1.8rem; align-items: center; justify-content: center; padding: 0; color: var(--preview-muted); }.folder-toggle i { font-size: 0.52rem; }
.folder-select { display: grid; grid-template-columns: 0.9rem 1fr auto; align-items: center; gap: 0.38rem; min-width: 0; padding: 0.3rem 0.3rem 0.3rem 0; color: var(--preview-muted); text-align: left; }
.folder-select span { overflow: hidden; color: var(--p-text-color); font-size: var(--app-fs-sm); font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
.folder-select small { font-size: 0.65rem; }
.folder-networks { display: grid; gap: 0.16rem; margin-bottom: 0.3rem; }
.network-row { display: grid; grid-template-columns: 0.5rem 1fr auto; align-items: start; gap: 0.5rem; width: 100%; padding: 0.48rem 0.45rem 0.48rem 1.05rem; border: 0; border-radius: 8px; background: transparent; text-align: left; cursor: pointer; }
.network-row:hover, .network-row.active { background: var(--p-surface-card); box-shadow: inset 0 0 0 1px var(--preview-line); }
.network-row.active { box-shadow: inset 3px 0 var(--preview-accent), inset 0 0 0 1px var(--preview-line); }
.network-state { width: 0.42rem; height: 0.42rem; margin-top: 0.32rem; border-radius: 50%; background: var(--p-green-500); }
.network-state.warning { background: var(--p-orange-500); }
.network-state.muted { background: var(--p-surface-400); }
.network-copy { display: flex; min-width: 0; flex-direction: column; gap: 0.1rem; }
.network-copy strong { overflow: hidden; font-size: var(--app-fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.network-copy small { overflow: hidden; color: var(--preview-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.62rem; text-overflow: ellipsis; white-space: nowrap; }
.mini-meter { height: 2px; margin-top: 0.22rem; overflow: hidden; border-radius: 99px; background: var(--p-surface-200); }
.mini-meter i { display: block; height: 100%; background: var(--preview-accent); }
.network-percent { padding-top: 0.12rem; color: var(--preview-muted); font-size: 0.62rem; font-weight: 700; }
.explorer-footer { display: flex; justify-content: space-between; gap: 0.3rem; padding: 0.65rem; border-top: 1px solid var(--preview-line); }
.explorer-footer button { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.3rem; border: 0; background: none; color: var(--preview-muted); font-size: 0.65rem; cursor: pointer; }
.explorer-footer button:hover { color: var(--preview-accent); }
.work-surface { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; }
.workspace-error { display: flex; align-items: center; gap: 0.55rem; padding: 0.55rem 0.8rem; color: color-mix(in srgb, #dc2626 82%, var(--p-text-color)); background: color-mix(in srgb, #ef4444 9%, var(--p-surface-card)); border-bottom: 1px solid color-mix(in srgb, #ef4444 28%, var(--preview-line)); font-size: 0.68rem; }
.workspace-error span { display: flex; min-width: 0; flex: 1; flex-direction: column; }.workspace-error button { border: 0; background: none; color: inherit; font-weight: 800; cursor: pointer; }
.context-header { container: workspace-context / inline-size; flex-shrink: 0; padding: 0.85rem 1rem 0; border-bottom: 1px solid var(--preview-line); }
.context-breadcrumb { display: flex; align-items: center; gap: 0.35rem; margin-bottom: 0.55rem; color: var(--preview-muted); font-size: 0.65rem; }
.context-breadcrumb button { padding: 0; border: 0; color: var(--preview-accent); background: none; cursor: pointer; }
.context-breadcrumb i { font-size: 0.48rem; }
.context-overview { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(540px, max-content) auto; align-items: center; gap: 0.75rem 1.25rem; }
.context-title-row { display: flex; min-width: 0; align-items: center; gap: 1rem; }
.context-identity { display: flex; align-items: center; gap: 0.7rem; min-width: 0; }
.context-icon { display: inline-flex; width: 2.4rem; height: 2.4rem; flex: 0 0 auto; align-items: center; justify-content: center; border-radius: 9px; color: var(--preview-accent); background: var(--preview-accent-soft); }
.context-icon.dns { color: var(--preview-dns); background: color-mix(in srgb, var(--preview-dns) 12%, transparent); }
.context-icon.dhcp { color: var(--preview-dhcp); background: color-mix(in srgb, var(--preview-dhcp) 12%, transparent); }
.title-line { display: flex; align-items: center; gap: 0.55rem; }
.title-line h2 { margin: 0; font-size: 1.24rem; letter-spacing: -0.025em; }
.context-identity p { margin: 0.15rem 0 0; color: var(--preview-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.69rem; }
.state-chip { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.18rem 0.42rem; border-radius: 999px; color: var(--p-green-600); background: color-mix(in srgb, var(--p-green-500) 11%, transparent); font-size: 0.61rem; font-weight: 800; text-transform: uppercase; }
.state-chip i { width: 0.36rem; height: 0.36rem; border-radius: 50%; background: var(--p-green-500); }
.context-actions { display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; gap: 0.4rem; }
.button { display: inline-flex; min-height: 2rem; align-items: center; justify-content: center; gap: 0.38rem; padding: 0 0.68rem; border: 1px solid var(--preview-line); border-radius: 7px; background: var(--p-surface-card); font-size: var(--app-fs-sm); font-weight: 700; cursor: pointer; }
.button:hover { border-color: color-mix(in srgb, var(--preview-accent) 55%, var(--preview-line)); }
.button.primary { border-color: var(--preview-accent); color: var(--p-primary-contrast-color, white); background: var(--preview-accent); }
.button.compact { min-height: 1.9rem; white-space: nowrap; }
.health-strip { display: flex; min-width: 0; flex: 1 1 540px; justify-content: flex-end; gap: 0; overflow-x: auto; }
.health-stat { display: grid; min-width: 118px; padding: 0.58rem 1rem 0.62rem 0; border: 0; color: inherit; background: none; text-align: left; }
.health-stat:disabled { opacity: 1; }.health-stat.interactive { cursor: pointer; }.health-stat.interactive:hover strong { color: var(--preview-accent); }
.health-stat + .health-stat { padding-left: 1rem; border-left: 1px solid var(--preview-line); }
.health-stat > span { color: var(--preview-muted); font-size: 0.56rem; font-weight: 800; letter-spacing: 0.11em; }
.health-stat strong { margin: 0.12rem 0; font-size: 0.8rem; }
.health-stat small { display: flex; align-items: center; gap: 0.28rem; color: var(--preview-muted); font-size: 0.61rem; white-space: nowrap; }
.health-stat small i { width: 0.34rem; height: 0.34rem; border-radius: 50%; background: var(--p-green-500); }
.health-stat small.warning { color: var(--p-orange-600); }
.health-stat small.warning i { background: var(--p-orange-500); }
@container workspace-context (max-width: 1180px) {
  .context-overview { grid-template-columns: minmax(0, 1fr) auto; }
  .context-title-row { grid-column: 1; grid-row: 1; }
  .context-actions { grid-column: 2; grid-row: 1; }
  .health-strip { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; }
}
.view-tabs { display: flex; flex-shrink: 0; gap: 0.18rem; padding: 0.48rem 0.75rem 0; background: color-mix(in srgb, var(--p-surface-ground) 52%, var(--p-surface-card)); border-bottom: 1px solid var(--preview-line); }
.view-tabs button { display: inline-flex; align-items: center; gap: 0.38rem; padding: 0.5rem 0.68rem 0.56rem; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--preview-muted); font-size: var(--app-fs-sm); font-weight: 700; cursor: pointer; }
.view-tabs button.active { border-bottom-color: var(--preview-accent); color: var(--preview-accent); }
.view-tabs button span { padding: 0.08rem 0.3rem; border-radius: 999px; background: var(--p-surface-200); color: var(--preview-muted); font-size: 0.59rem; }
.view-summary { display: flex; min-height: 78px; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.7rem 1rem; border-bottom: 1px solid var(--preview-line); background: var(--p-surface-card); }
.view-summary h3 { margin: 0.1rem 0; font-size: 0.96rem; }
.view-summary p { margin: 0; color: var(--preview-muted); font-size: 0.68rem; }
.linked-resources { display: flex; gap: 0.45rem; }
.linked-card { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.5rem; max-width: 235px; padding: 0.48rem 0.58rem; border: 1px solid var(--preview-line); border-radius: 8px; background: var(--p-surface-card); text-align: left; cursor: pointer; }
.linked-card.selected { border-color: color-mix(in srgb, var(--preview-accent) 42%, var(--preview-line)); background: var(--preview-accent-soft); }
.linked-card > i { color: var(--preview-accent); }
.linked-card span { display: flex; min-width: 0; flex-direction: column; }
.linked-card small { color: var(--preview-muted); font-size: 0.52rem; letter-spacing: 0.09em; }
.linked-card strong { overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.64rem; text-overflow: ellipsis; white-space: nowrap; }
.linked-card em { color: var(--preview-muted); font-size: 0.63rem; font-style: normal; }
.linked-empty { align-self: center; color: var(--preview-muted); font-size: 0.65rem; }
.address-overview { display: flex; gap: 0.5rem; }
.address-overview > div { display: grid; grid-template-columns: 4px auto; grid-template-rows: auto auto; column-gap: 0.42rem; min-width: 66px; }
.address-overview > div > span { grid-row: 1 / 3; display: block; width: 4px; height: 2rem; align-self: center; overflow: hidden; border-radius: 99px; background: var(--p-surface-200); }
.address-overview > div > span::after { content: ''; display: block; height: var(--value); margin-top: calc(2rem - var(--value)); background: var(--preview-accent); }
.address-overview small { align-self: end; color: var(--preview-muted); font-size: 0.58rem; }
.address-overview strong { font-size: 0.8rem; }
.scope-summary { display: inline-flex; max-width: 440px; align-items: center; gap: 0.45rem; color: var(--preview-muted); font-size: var(--workspace-font-body); }.scope-summary i { color: var(--preview-accent); }
.range-legend, .grid-key { display: flex; flex-wrap: wrap; gap: 0.7rem; color: var(--preview-muted); font-size: 0.61rem; }
.range-legend span, .grid-key span { display: inline-flex; align-items: center; gap: 0.3rem; }
.legend-dot, .grid-key i { width: 0.48rem; height: 0.48rem; border-radius: 2px; }
.legend-dot.scope, .grid-key i.dhcp { background: var(--preview-accent); }.legend-dot.infra, .grid-key i.infra { background: #22d3ee; }.legend-dot.reserved, .grid-key i.reserved { background: var(--preview-dhcp); }.legend-dot.system, .grid-key i.system { background: var(--p-surface-500); }
.table-card { display: flex; min-height: 0; flex: 1; flex-direction: column; margin: 0.7rem; overflow: hidden; border: 1px solid var(--preview-line); border-radius: 10px; background: var(--p-surface-card); }
.loading-bar { display: flex; align-items: center; justify-content: center; gap: 0.45rem; padding: 0.38rem; color: var(--preview-accent); background: var(--preview-accent-soft); border-bottom: 1px solid color-mix(in srgb, var(--preview-accent) 28%, var(--preview-line)); font-size: 0.66rem; font-weight: 750; }
.table-toolbar { display: flex; align-items: center; gap: 0.4rem; padding: 0.48rem; border-bottom: 1px solid var(--preview-line); }
.table-search { width: min(300px, 31%); min-height: 1.9rem; padding: 0 0.5rem; border-radius: 7px; }
.filter-button { display: inline-flex; min-height: 1.9rem; align-items: center; gap: 0.35rem; padding: 0 0.52rem; border: 1px solid var(--preview-line); border-radius: 7px; background: var(--p-surface-card); color: var(--preview-muted); font-size: 0.66rem; cursor: pointer; }
.filter-button.active { border-color: var(--preview-accent); color: var(--preview-accent); background: var(--preview-accent-soft); }
.available-switch { display: flex; align-items: center; gap: 0.4rem; color: var(--preview-muted); font-size: 0.66rem; cursor: pointer; }
.available-switch input { position: absolute; opacity: 0; pointer-events: none; }
.available-switch span { position: relative; width: 1.65rem; height: 0.92rem; border-radius: 99px; background: var(--p-surface-300); transition: background 0.15s; }
.available-switch span::after { content: ''; position: absolute; top: 2px; left: 2px; width: calc(0.92rem - 4px); height: calc(0.92rem - 4px); border-radius: 50%; background: white; transition: transform 0.15s; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
.available-switch input:checked + span { background: var(--preview-accent); }
.available-switch input:checked + span::after { transform: translateX(0.72rem); }
.toolbar-space { flex: 1; }
.view-switcher { display: flex; padding: 0.12rem; border-radius: 7px; background: var(--p-surface-ground); }
.view-switcher button { display: inline-flex; width: 1.7rem; height: 1.55rem; align-items: center; justify-content: center; border: 0; border-radius: 5px; background: transparent; color: var(--preview-muted); cursor: pointer; }
.view-switcher button.active { background: var(--p-surface-card); color: var(--preview-accent); box-shadow: 0 1px 3px rgba(0,0,0,.1); }.compact-grid-icon { font-size: 0.66rem; transform: scale(.82); }
.selection-bar { display: flex; align-items: center; gap: 0.6rem; padding: 0.42rem 0.65rem; color: var(--p-primary-contrast-color, white); background: var(--preview-accent); font-size: 0.67rem; }
.selection-bar button { padding: 0; border: 0; background: none; color: inherit; text-decoration: underline; cursor: pointer; }.selection-bar button:last-child { margin-left: auto; }
.table-scroll { min-height: 0; flex: 1; overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.67rem; }
thead { position: sticky; top: 0; z-index: 1; background: color-mix(in srgb, var(--p-surface-ground) 78%, var(--p-surface-card)); }
th { height: 2rem; padding: 0 0.6rem; border-bottom: 1px solid var(--preview-line); color: var(--preview-muted); text-align: left; white-space: nowrap; }
th button { padding: 0; border: 0; background: none; color: inherit; font-size: 0.59rem; font-weight: 800; letter-spacing: 0.055em; text-transform: uppercase; cursor: pointer; }
td { height: 2.35rem; padding: 0 0.6rem; border-bottom: 1px solid color-mix(in srgb, var(--preview-line) 65%, transparent); white-space: nowrap; }
tbody tr { cursor: pointer; }
tbody tr:hover, tbody tr.selected { background: var(--preview-accent-soft); }
.check-cell { width: 1.5rem; padding-right: 0; }.check-cell input { accent-color: var(--preview-accent); }.action-cell { width: 2rem; padding-left: 0; text-align: right; }.action-cell button { width: 1.65rem; height: 1.65rem; border: 0; border-radius: 5px; background: transparent; cursor: pointer; }.action-cell button:hover { color: var(--preview-accent); background: var(--p-surface-card); }
.wide-cell { min-width: 135px; }.primary-cell { font-weight: 750; }.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }.muted { color: var(--preview-muted); }
.table-pill { display: inline-flex; padding: 0.17rem 0.38rem; border-radius: 999px; font-size: 0.6rem; font-weight: 750; }.table-pill.in-use, .table-pill.active { color: var(--p-red-600); background: color-mix(in srgb, var(--p-red-500) 10%, transparent); }.table-pill.dhcp-scope, .table-pill.available { color: var(--preview-accent); background: color-mix(in srgb, var(--preview-accent) 10%, transparent); }.table-pill.offline, .table-pill.expired { color: var(--preview-muted); background: var(--p-surface-ground); }.table-pill.unavailable { color: var(--preview-dns); background: color-mix(in srgb, var(--preview-dns) 12%, transparent); }
.online-value, .enabled-value { display: inline-flex; align-items: center; gap: 0.3rem; text-transform: capitalize; }.online-value i, .enabled-value i { width: 0.38rem; height: 0.38rem; border-radius: 50%; background: var(--p-green-500); }.online-value.offline i, .enabled-value.off i { background: var(--p-surface-400); }.online-value.unknown { color: var(--preview-muted); }.online-value.unknown i { border: 1px solid var(--p-surface-400); background: transparent; }
.type-value { display: inline-flex; align-items: center; gap: 0.3rem; }.type-value i { color: var(--preview-accent); font-size: 0.7rem; }
.no-results { display: flex; min-height: 180px; align-items: center; justify-content: center; flex-direction: column; gap: 0.4rem; color: var(--preview-muted); }.no-results i { font-size: 1.4rem; }.no-results strong { color: var(--p-text-color); }
.table-footer { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 0.38rem 0.55rem; border-top: 1px solid var(--preview-line); color: var(--preview-muted); font-size: 0.61rem; }.table-footer > span:last-child { justify-self: end; }.pagination { display: flex; align-items: center; gap: 0.12rem; }.pagination button { width: 1.5rem; height: 1.5rem; border: 0; border-radius: 5px; background: transparent; color: var(--preview-muted); cursor: pointer; }.pagination button:disabled { opacity: .35; cursor: default; }.pagination button.active { color: white; background: var(--preview-accent); }.pagination span { padding: 0 .22rem; }
.address-grid-view { flex: 1; min-height: 0; overflow: auto; padding: 0.7rem; }.grid-ruler { display: grid; grid-template-columns: repeat(8, 1fr); margin: 0 0 0.28rem; color: var(--preview-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.56rem; }.address-grid { display: grid; grid-template-columns: repeat(16, minmax(24px, 1fr)); gap: 3px; }.address-grid button { aspect-ratio: 1.35; min-height: 23px; border: 1px solid transparent; border-radius: 4px; background: var(--p-surface-100); color: var(--preview-muted); font-size: 0.54rem; cursor: pointer; }.address-grid button:hover { border-color: var(--p-text-color); transform: translateY(-1px); }.address-grid button.system { background: var(--p-surface-400); color: white; }.address-grid button.gateway { background: var(--preview-dns); color: #111; }.address-grid button.infra { background: color-mix(in srgb, #22d3ee 35%, var(--p-surface-card)); }.address-grid button.dhcp { background: color-mix(in srgb, var(--preview-accent) 22%, var(--p-surface-card)); }.address-grid button.dhcp-active { background: var(--preview-accent); color: white; }.address-grid button.dns { background: color-mix(in srgb, var(--preview-dns) 70%, #fde68a); color: #111; }.address-grid button.reserved { background: color-mix(in srgb, var(--preview-dhcp) 64%, var(--p-surface-card)); color: white; }.address-grid button.rogue { border: 2px solid var(--p-red-500); background: color-mix(in srgb, var(--p-red-500) 12%, var(--p-surface-card)); color: var(--p-red-600); font-weight: 800; }.grid-key { margin-top: 0.65rem; }.grid-key i.gateway { background: var(--preview-dns); }.grid-key i.dns { background: color-mix(in srgb, var(--preview-dns) 70%, #fde68a); }.grid-key i.rogue { border: 2px solid var(--p-red-500); }.grid-key i.available { border: 1px solid var(--preview-line); background: var(--p-surface-100); }
.compact-grid-view { min-height: 0; flex: 1; overflow: auto; padding: 0.7rem; }.compact-address-grid { display: grid; grid-template-columns: repeat(64, minmax(5px, 1fr)); overflow: hidden; border-top: 1px solid var(--preview-line); border-left: 1px solid var(--preview-line); user-select: none; }.compact-address-grid button { position: relative; min-width: 0; min-height: 7px; aspect-ratio: 1; padding: 0; border: 0; border-radius: 0; background: var(--p-surface-100); box-shadow: inset -1px 0 var(--preview-line), inset 0 -1px var(--preview-line); cursor: pointer; }.compact-address-grid button.section { box-shadow: inset -2px 0 color-mix(in srgb, var(--preview-line) 75%, var(--p-text-color)), inset 0 -1px var(--preview-line); }.compact-address-grid button:hover { z-index: 1; outline: 2px solid var(--p-text-color); outline-offset: -1px; }.compact-address-grid button.system { background: var(--p-surface-400); }.compact-address-grid button.gateway { background: var(--preview-dns); }.compact-address-grid button.dhcp { background: color-mix(in srgb, var(--preview-accent) 22%, var(--p-surface-card)); }.compact-address-grid button.dhcp-active { background: var(--preview-accent); }.compact-address-grid button.dns { background: color-mix(in srgb, var(--preview-dns) 70%, #fde68a); }.compact-address-grid button.reserved { background: color-mix(in srgb, var(--preview-dhcp) 64%, var(--p-surface-card)); }.compact-address-grid button.rogue { z-index: 1; outline: 2px solid var(--p-red-500); outline-offset: -2px; background: color-mix(in srgb, var(--p-red-500) 12%, var(--p-surface-card)); }
.details-panel { position: absolute; top: 0; right: 0; bottom: 0; z-index: 4; display: flex; width: min(330px, 90%); flex-direction: column; overflow-y: auto; border-left: 1px solid var(--preview-line); background: var(--p-surface-card); box-shadow: -12px 0 32px rgba(15,23,42,.13); }.details-head { display: flex; align-items: center; justify-content: space-between; padding: 0.85rem; border-bottom: 1px solid var(--preview-line); }.details-head > div { display: flex; flex-direction: column; gap: 0.2rem; }.details-head strong { font-size: 0.9rem; }.details-status { display: flex; align-items: center; gap: 0.65rem; padding: 0.9rem; border-bottom: 1px solid var(--preview-line); }.detail-orb { display: inline-flex; width: 2.5rem; height: 2.5rem; align-items: center; justify-content: center; border-radius: 10px; color: var(--p-green-600); background: color-mix(in srgb, var(--p-green-500) 12%, transparent); }.detail-orb.offline, .detail-orb.unknown { color: var(--preview-muted); background: var(--p-surface-ground); }.details-status > div { display: flex; min-width: 0; flex-direction: column; gap: 0.14rem; }.details-status strong { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }.details-status small { overflow: hidden; color: var(--preview-muted); font-size: 0.65rem; text-overflow: ellipsis; white-space: nowrap; }.details-panel dl { display: grid; grid-template-columns: 42% 58%; margin: 0; padding: 0.7rem 0.9rem; border-bottom: 1px solid var(--preview-line); font-size: 0.66rem; }.details-panel dt, .details-panel dd { padding: 0.33rem 0; border-bottom: 1px solid color-mix(in srgb, var(--preview-line) 55%, transparent); }.details-panel dt { color: var(--preview-muted); }.details-panel dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }.details-section { display: grid; gap: 0.42rem; padding: 0.75rem 0.9rem; border-bottom: 1px solid var(--preview-line); }.details-section > button { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.5rem; padding: 0.48rem; border: 1px solid var(--preview-line); border-radius: 7px; background: transparent; text-align: left; cursor: pointer; }.details-section > button:hover { border-color: var(--preview-accent); background: var(--preview-accent-soft); }.details-section > button > i:first-child { color: var(--preview-accent); }.details-section > button > i:last-child { color: var(--preview-muted); font-size: 0.55rem; }.details-section > button span { display: flex; flex-direction: column; gap: 0.1rem; }.details-section > button strong { font-size: 0.67rem; }.details-section > button small { color: var(--preview-muted); font-size: 0.6rem; }.quick-actions { display: flex; flex-wrap: wrap; gap: 0.32rem; }.quick-actions button { padding: 0.32rem 0.45rem; border: 1px solid var(--preview-line); border-radius: 6px; background: transparent; font-size: 0.61rem; cursor: pointer; }.quick-actions button:hover { color: var(--preview-accent); border-color: var(--preview-accent); }.activity-link { display: flex; align-items: center; gap: 0.38rem; margin: auto 0.9rem 0.9rem; padding: 0.52rem; border: 0; background: none; color: var(--preview-accent); font-size: 0.66rem; font-weight: 700; cursor: pointer; }
.menu-scrim { position: fixed; inset: 0; z-index: 7; }.floating-menu { position: fixed; z-index: 8; display: grid; width: 270px; padding: 0.35rem; border: 1px solid var(--preview-line); border-radius: 10px; background: var(--p-surface-card); box-shadow: 0 16px 45px rgba(15,23,42,.2); }.floating-menu > span { padding: 0.45rem 0.5rem 0.3rem; color: var(--preview-muted); font-size: 0.58rem; font-weight: 800; letter-spacing: .12em; }.floating-menu button { display: grid; grid-template-columns: 1.7rem 1fr; align-items: center; gap: 0.35rem; padding: 0.5rem; border: 0; border-radius: 7px; background: transparent; text-align: left; cursor: pointer; }.floating-menu button:hover { background: var(--preview-accent-soft); }.floating-menu button > i { color: var(--preview-accent); }.floating-menu button span { display: flex; flex-direction: column; gap: 0.1rem; }.floating-menu button strong { font-size: 0.67rem; }.floating-menu button small { color: var(--preview-muted); font-size: 0.59rem; }.floating-menu button.danger { color: var(--p-red-600); }.floating-menu button.danger > i { color: var(--p-red-500); }.create-menu { top: 7.8rem; right: 2rem; }.actions-menu { top: 7.8rem; right: 7.8rem; }.row-menu { top: 48%; right: 2.4rem; width: 225px; }.row-menu button { grid-template-columns: 1rem 1fr; }
.prototype-notice { position: fixed; right: 1.25rem; bottom: 1.25rem; z-index: 10; display: flex; align-items: center; gap: 0.65rem; width: min(330px, calc(100vw - 2.5rem)); padding: 0.7rem 0.85rem; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--preview-accent) 40%, var(--preview-line)); border-radius: 10px; color: var(--p-text-color); background: var(--p-surface-card); box-shadow: 0 14px 40px rgba(15,23,42,.2); }.prototype-notice > i { color: var(--preview-accent); }.prototype-notice span { display: flex; flex-direction: column; gap: 0.1rem; font-size: 0.67rem; }.prototype-notice strong { font-size: 0.71rem; }.notice-enter-active, .notice-leave-active { transition: opacity .18s, transform .18s; }.notice-enter-from, .notice-leave-to { opacity: 0; transform: translateY(10px); }
.preview-kicker, .eyebrow, .estate-row small, .explorer-section-head, .explorer-section-head button, .folder-select small, .network-percent, .explorer-footer button, .context-breadcrumb, .state-chip, .health-stat small, .view-tabs button span, .view-summary p, .linked-card small, .linked-card strong, .linked-card em, .linked-empty, .address-overview small, .range-legend, .grid-key, .loading-bar, .filter-button, .available-switch, .selection-bar, .table-pill, .table-footer, .grid-ruler, .address-grid button, .details-status small, .details-section > button small, .floating-menu > span, .floating-menu button small, .prototype-notice span { font-size: var(--workspace-font-small); }
.sample-pill, .quiet-link, .explorer-search input, .table-search input, .estate-row strong, .explorer-empty, .folder-select span, .network-copy strong, .network-copy small, .workspace-error, .context-identity p, .button, .health-stat strong, .view-tabs button, table, th button, .details-head strong, .details-status strong, .details-panel dl, .details-section > button strong, .quick-actions button, .activity-link, .floating-menu button strong, .prototype-notice strong { font-size: var(--workspace-font-body); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (max-width: 1100px) { .workspace-frame { grid-template-columns: 235px minmax(0, 1fr); }.linked-card:nth-child(2) { display: none; } }
@media (max-width: 820px) { .workspace-preview { padding: 0.65rem; }.preview-banner { align-items: flex-start; flex-direction: column; gap: 0.6rem; }.preview-banner-actions { width: 100%; justify-content: space-between; }.workspace-frame { flex: none; height: auto; min-height: calc(100vh - 10rem); grid-template-columns: 1fr; overflow: visible; }.resource-explorer { display: none; }.context-title-row { align-items: flex-start; }.context-actions { justify-content: flex-end; }.view-summary { align-items: flex-start; flex-direction: column; }.table-card { min-height: 430px; }.table-toolbar { flex-wrap: wrap; }.table-search { width: 100%; }.toolbar-space { display: none; }.details-panel { position: fixed; }.sample-pill { display: none; } }
</style>
