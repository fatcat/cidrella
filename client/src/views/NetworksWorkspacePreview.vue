<template>
  <div class="workspace-preview" data-track="networks-workspace-preview">
    <header class="preview-banner">
      <div>
        <div class="preview-kicker">Interactive concept</div>
        <h1>Network operations, in context</h1>
        <p>One resource explorer, one work surface, and no lost context between IPAM, DNS, and DHCP.</p>
      </div>
      <div class="preview-banner-actions">
        <span class="sample-pill"><i class="pi pi-eye" /> Sample data · nothing is saved</span>
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
          <input v-model="resourceQuery" type="search" placeholder="Find a network or service" aria-label="Find a network or service" />
          <kbd>⌘ K</kbd>
        </label>

        <nav class="service-shortcuts" aria-label="Service-wide views">
          <button :class="{ active: contextKind === 'dns' }" @click="selectService('dns')">
            <span class="shortcut-icon dns"><i class="pi pi-globe" /></span>
            <span><strong>DNS inventory</strong><small>3 zones · 48 records</small></span>
            <i class="pi pi-chevron-right" />
          </button>
          <button :class="{ active: contextKind === 'dhcp' }" @click="selectService('dhcp')">
            <span class="shortcut-icon dhcp"><i class="pi pi-server" /></span>
            <span><strong>DHCP inventory</strong><small>3 scopes · 27 active</small></span>
            <i class="pi pi-chevron-right" />
          </button>
        </nav>

        <div class="explorer-section-head">
          <span>NETWORKS</span>
          <button @click="notify('Browse unallocated networks')">Browse unallocated</button>
        </div>

        <div class="network-tree">
          <section v-for="folder in filteredFolders" :key="folder.name" class="network-group">
            <button class="folder-row" @click="toggleFolder(folder.name)">
              <i class="pi" :class="expandedFolders.has(folder.name) ? 'pi-chevron-down' : 'pi-chevron-right'" />
              <i class="pi pi-folder" />
              <span>{{ folder.name }}</span>
              <small>{{ folder.networks.length }}</small>
            </button>
            <div v-if="expandedFolders.has(folder.name)" class="folder-networks">
              <button v-for="network in folder.networks" :key="network.id"
                      class="network-row" :class="{ active: contextKind === 'network' && selectedNetwork.id === network.id }"
                      @click="selectNetwork(network)">
                <span class="network-state" :class="network.state" />
                <span class="network-copy">
                  <strong>{{ network.name }}</strong>
                  <small>{{ network.cidr }} · VLAN {{ network.vlan }}</small>
                  <span class="mini-meter"><i :style="{ width: `${network.used}%` }" /></span>
                </span>
                <span class="network-percent">{{ network.used }}%</span>
              </button>
            </div>
          </section>
        </div>

        <div class="explorer-footer">
          <button @click="notify('Open folder management')"><i class="pi pi-folder-plus" /> Manage folders</button>
          <button @click="notify('Open network defaults')"><i class="pi pi-sliders-h" /> Defaults</button>
        </div>
      </aside>

      <main class="work-surface">
        <header class="context-header">
          <div class="context-breadcrumb">
            <span>{{ contextKind === 'network' ? selectedNetwork.folder : 'Infrastructure' }}</span>
            <i class="pi pi-chevron-right" />
            <span>{{ contextTitle }}</span>
          </div>
          <div class="context-title-row">
            <div class="context-identity">
              <span class="context-icon" :class="contextKind"><i :class="contextIcon" /></span>
              <div>
                <div class="title-line">
                  <h2>{{ contextTitle }}</h2>
                  <span v-if="contextKind === 'network'" class="state-chip"><i /> allocated</span>
                </div>
                <p>{{ contextSubtitle }}</p>
              </div>
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

          <div class="health-strip">
            <div v-for="stat in contextStats" :key="stat.label" class="health-stat">
              <span>{{ stat.label }}</span>
              <strong>{{ stat.value }}</strong>
              <small :class="stat.tone"><i v-if="stat.dot" />{{ stat.note }}</small>
            </div>
          </div>
        </header>

        <nav class="view-tabs" aria-label="Network workspace views">
          <button v-for="view in availableViews" :key="view.key" :class="{ active: activeView === view.key }"
                  @click="switchView(view.key)">
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
            <button class="linked-card selected" @click="notify('Selected forward zone')">
              <i class="pi pi-globe" /><span><small>FORWARD</small><strong>{{ selectedNetwork.domain }}</strong></span><em>24</em>
            </button>
            <button class="linked-card" @click="notify('Selected reverse zone')">
              <i class="pi pi-replay" /><span><small>REVERSE</small><strong>{{ reverseZoneName }}</strong></span><em>21</em>
            </button>
          </div>
          <div v-else-if="activeView === 'dhcp'" class="linked-resources">
            <button class="linked-card selected" @click="notify('Selected DHCP scope')">
              <i class="pi pi-server" /><span><small>ACTIVE SCOPE</small><strong>{{ selectedPrefix }}.33 – {{ selectedPrefix }}.126</strong></span><em>37%</em>
            </button>
            <button class="linked-card" @click="notify('Edit DHCP scope')">
              <i class="pi pi-cog" /><span><small>LEASE POLICY</small><strong>12 hours · gateway .1</strong></span>
            </button>
          </div>
          <div v-else-if="activeView === 'ranges'" class="range-legend">
            <span><i class="legend-dot scope" />DHCP Scope</span>
            <span><i class="legend-dot infra" />Infrastructure</span>
            <span><i class="legend-dot reserved" />IP Reservation</span>
            <span><i class="legend-dot system" />System</span>
          </div>
          <div v-else class="address-overview" aria-label="Address utilization">
            <div><span style="--value: 28%" /><small>Assigned</small><strong>71</strong></div>
            <div><span style="--value: 37%" /><small>DHCP pool</small><strong>94</strong></div>
            <div><span style="--value: 35%" /><small>Available</small><strong>89</strong></div>
          </div>
        </section>

        <section class="table-card">
          <div class="table-toolbar">
            <label class="table-search">
              <i class="pi pi-search" />
              <input v-model="tableQuery" type="search" :placeholder="viewMeta.search" aria-label="Search current table" />
            </label>
            <button class="filter-button" :class="{ active: activeFilter !== 'all' }" @click="cycleFilter">
              <i class="pi pi-filter" /> {{ filterLabel }}
            </button>
            <label v-if="activeView === 'addresses' || activeView === 'dhcp'" class="available-switch">
              <input v-model="showAvailable" type="checkbox" />
              <span /> Show available
            </label>
            <span class="toolbar-space" />
            <div v-if="activeView === 'addresses'" class="view-switcher" aria-label="Address presentation">
              <button :class="{ active: addressPresentation === 'table' }" aria-label="Table view" @click="addressPresentation = 'table'"><i class="pi pi-list" /></button>
              <button :class="{ active: addressPresentation === 'grid' }" aria-label="Grid view" @click="addressPresentation = 'grid'"><i class="pi pi-th-large" /></button>
            </div>
            <button class="icon-button bordered" title="Choose columns" aria-label="Choose columns" @click="notify('Open column chooser')"><i class="pi pi-table" /></button>
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

          <div v-else class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th v-if="activeView === 'addresses'" class="check-cell"><input type="checkbox" aria-label="Select all visible rows" @change="toggleAllRows" /></th>
                  <th v-for="column in columns" :key="column.key" :class="column.className">
                    <button @click="notify(`Sort by ${column.label}`)">{{ column.label }} <i v-if="column.key === 'address'" class="pi pi-sort-amount-up-alt" /></button>
                  </th>
                  <th class="action-cell"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in filteredRows" :key="row.id" :class="{ selected: selectedRow?.id === row.id }" @click="selectedRow = row">
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
            <span>Showing {{ filteredRows.length }} of {{ currentRows.length }}</span>
            <div class="pagination"><button disabled><i class="pi pi-chevron-left" /></button><button class="active">1</button><button>2</button><button>3</button><button><i class="pi pi-chevron-right" /></button></div>
            <button @click="notify('Change rows per page')">50 rows <i class="pi pi-chevron-down" /></button>
          </footer>
        </section>
      </main>

      <aside v-if="selectedRow" class="details-panel">
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
        <div class="details-section">
          <span class="eyebrow">RELATED RESOURCES</span>
          <button v-for="resource in relatedResources" :key="resource.label" @click="switchView(resource.view)">
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
      <div v-if="notice" class="prototype-notice"><i class="pi pi-sparkles" /><span><strong>Prototype interaction</strong>{{ notice }}</span></div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { EMPTY_CELL } from '../utils/format.js';

const folders = [
  {
    name: 'Campus',
    networks: [
      { id: 1, folder: 'Campus', name: 'Staff LAN', cidr: '10.42.16.0/24', vlan: 120, used: 42, state: 'healthy', domain: 'corp.example', gateway: '10.42.16.1' },
      { id: 2, folder: 'Campus', name: 'Voice', cidr: '10.42.20.0/24', vlan: 140, used: 68, state: 'warning', domain: 'voice.corp.example', gateway: '10.42.20.1' },
      { id: 3, folder: 'Campus', name: 'Guest Wi-Fi', cidr: '10.42.32.0/22', vlan: 160, used: 31, state: 'healthy', domain: 'guest.example', gateway: '10.42.32.1' }
    ]
  },
  {
    name: 'Data center',
    networks: [
      { id: 4, folder: 'Data center', name: 'Production', cidr: '10.80.0.0/23', vlan: 210, used: 74, state: 'healthy', domain: 'prod.example', gateway: '10.80.0.1' },
      { id: 5, folder: 'Data center', name: 'Management', cidr: '10.80.8.0/24', vlan: 211, used: 19, state: 'healthy', domain: 'mgmt.example', gateway: '10.80.8.1' }
    ]
  },
  {
    name: 'Ungrouped',
    networks: [
      { id: 6, folder: 'Ungrouped', name: 'Lab', cidr: '192.168.50.0/24', vlan: 50, used: 12, state: 'muted', domain: 'lab.example', gateway: '192.168.50.1' }
    ]
  }
];

const addressRows = [
  { id: 'a0', address: '10.42.16.0', hostname: null, status: 'in use', type: 'system', online: 'unknown', mac: null, source: 'Topology', lastSeen: null, scanning: 'Inherited' },
  { id: 'a1', address: '10.42.16.1', hostname: 'core-gw.corp.example', status: 'in use', type: 'gateway', online: 'online', mac: '00:1C:73:42:A0:01', source: 'Topology + DNS', lastSeen: '12 sec ago', scanning: 'On' },
  { id: 'a2', address: '10.42.16.17', hostname: null, status: 'DHCP Scope', type: null, online: 'unknown', mac: null, source: 'DHCP pool', lastSeen: null, scanning: 'Inherited' },
  { id: 'a3', address: '10.42.16.18', hostname: 'mira-mbp.corp.example', status: 'in use', type: 'dynamic DHCP', online: 'online', mac: '74:DA:38:17:2C:91', source: 'DHCP lease', lastSeen: '38 sec ago', scanning: 'Inherited' },
  { id: 'a4', address: '10.42.16.24', hostname: 'print-west.corp.example', status: 'in use', type: 'static DNS', online: 'online', mac: 'A4:BB:6D:33:71:09', source: 'DNS A record', lastSeen: '2 min ago', scanning: 'On' },
  { id: 'a5', address: '10.42.16.33', hostname: 'conf-room-display', status: 'in use', type: 'DHCP Reservation', online: 'offline', mac: 'E8:48:B8:2D:44:C1', source: 'DHCP reservation', lastSeen: '2 hr ago', scanning: 'Inherited' },
  { id: 'a6', address: '10.42.16.47', hostname: 'unknown-7c92', status: 'in use', type: 'rogue', online: 'online', mac: '7C:92:55:0A:91:EE', source: 'ARP scan', lastSeen: '8 sec ago', scanning: 'On' },
  { id: 'a7', address: '10.42.16.64', hostname: null, status: 'available', type: null, online: 'offline', mac: null, source: null, lastSeen: 'Yesterday', scanning: 'Inherited' }
];

const dnsRows = [
  { id: 'd1', name: '@', recordType: 'A', value: '10.42.16.24', ttl: '1 hour', source: 'Manual', enabled: true, online: 'online' },
  { id: 'd2', name: 'core-gw', recordType: 'A', value: '10.42.16.1', ttl: '5 min', source: 'Manual', enabled: true, online: 'online' },
  { id: 'd3', name: 'print-west', recordType: 'A', value: '10.42.16.24', ttl: '1 hour', source: 'Manual', enabled: true, online: 'online' },
  { id: 'd4', name: 'files', recordType: 'CNAME', value: 'nas-01.corp.example', ttl: '1 hour', source: 'Manual', enabled: true, online: 'unknown' },
  { id: 'd5', name: '_ipp._tcp', recordType: 'SRV', value: 'print-west.corp.example:631', ttl: '1 hour', source: 'Manual', enabled: true, online: 'unknown' },
  { id: 'd6', name: 'vpn', recordType: 'A', value: '10.42.16.72', ttl: '5 min', source: 'Manual', enabled: false, online: 'offline' }
];

const dhcpRows = [
  { id: 'h1', address: '10.42.16.18', hostname: 'mira-mbp', mac: '74:DA:38:17:2C:91', assignment: 'Dynamic', leaseStatus: 'active', expires: '11h 42m', online: 'online', source: 'Lease' },
  { id: 'h2', address: '10.42.16.21', hostname: 'pixel-9', mac: 'C4:22:7A:8F:3E:10', assignment: 'Dynamic', leaseStatus: 'active', expires: '9h 18m', online: 'online', source: 'Lease' },
  { id: 'h3', address: '10.42.16.33', hostname: 'conf-room-display', mac: 'E8:48:B8:2D:44:C1', assignment: 'Reserved', leaseStatus: 'offline', expires: 'Infinite', online: 'offline', source: 'Reservation' },
  { id: 'h4', address: '10.42.16.47', hostname: 'unknown-7c92', mac: '7C:92:55:0A:91:EE', assignment: null, leaseStatus: 'unavailable', expires: null, online: 'online', source: 'Rogue host' },
  { id: 'h5', address: '10.42.16.64', hostname: null, mac: null, assignment: null, leaseStatus: 'available', expires: null, online: 'offline', source: 'Pool' }
];

const rangeRows = [
  { id: 'r1', range: '10.42.16.0', rangeType: 'System', size: '1 address', description: 'Network address', policy: 'Protected', enabled: true },
  { id: 'r2', range: '10.42.16.1', rangeType: 'Gateway', size: '1 address', description: 'First usable address', policy: 'Topology', enabled: true },
  { id: 'r3', range: '10.42.16.17 – 10.42.16.32', rangeType: 'Infrastructure', size: '16 addresses', description: 'Switches and access points', policy: 'Custom tag', enabled: true },
  { id: 'r4', range: '10.42.16.33 – 10.42.16.126', rangeType: 'DHCP Scope', size: '94 addresses', description: 'Staff client pool', policy: '12 hour lease', enabled: true },
  { id: 'r5', range: '10.42.16.200 – 10.42.16.207', rangeType: 'IP Reservation', size: '8 addresses', description: 'Future conferencing', policy: 'Held', enabled: true }
];

const networkViews = [
  { key: 'addresses', label: 'Addresses', icon: 'pi pi-list', count: '254' },
  { key: 'dns', label: 'DNS', icon: 'pi pi-globe', count: '45' },
  { key: 'dhcp', label: 'DHCP', icon: 'pi pi-server', count: '94' },
  { key: 'ranges', label: 'Ranges', icon: 'pi pi-clone', count: '5' }
];

const resourceQuery = ref('');
const tableQuery = ref('');
const selectedNetwork = ref(folders[0].networks[0]);
const contextKind = ref('network');
const activeView = ref('addresses');
const expandedFolders = ref(new Set(folders.map(folder => folder.name)));
const addressPresentation = ref('table');
const showAvailable = ref(true);
const activeFilter = ref('all');
const selectedRow = ref(null);
const selectedRows = ref([]);
const openMenuName = ref(null);
const notice = ref('');
let noticeTimer = null;

const viewDefinitions = {
  addresses: { eyebrow: 'ADDRESS SPACE', title: '254 managed addresses', description: 'Allocation, liveness, naming, and policy in one canonical view.', search: 'Search IP, hostname, MAC, type…', addLabel: 'Reserve address', addAction: 'Create IP Reservation' },
  dns: { eyebrow: 'DNS FOR THIS NETWORK', title: 'corp.example', description: 'Forward and reverse records linked to the selected address space.', search: 'Search name, record type, or value…', addLabel: 'Add record', addAction: 'Add DNS record' },
  dhcp: { eyebrow: 'DHCP FOR THIS NETWORK', title: 'Staff LAN scope', description: 'Leases, reservations, and pool availability without leaving the network.', search: 'Search IP, MAC, hostname, or lease…', addLabel: 'Add reservation', addAction: 'Add DHCP Reservation' },
  ranges: { eyebrow: 'ADDRESS POLICY', title: '5 managed ranges', description: 'Functional scopes and organizational tags across the selected network.', search: 'Search range, type, or description…', addLabel: 'Add range', addAction: 'Add Network Range Type range' }
};

const columnDefinitions = {
  addresses: [
    { key: 'address', label: 'IP address', className: 'mono primary-cell' }, { key: 'hostname', label: 'Hostname', className: 'wide-cell' },
    { key: 'status', label: 'Status' }, { key: 'type', label: 'Type' }, { key: 'online', label: 'Online' },
    { key: 'mac', label: 'MAC address', className: 'mono' }, { key: 'lastSeen', label: 'Last seen' }
  ],
  dns: [
    { key: 'name', label: 'Name', className: 'mono primary-cell' }, { key: 'recordType', label: 'Type' },
    { key: 'value', label: 'Value', className: 'mono wide-cell' }, { key: 'ttl', label: 'TTL' },
    { key: 'source', label: 'Source' }, { key: 'enabled', label: 'State' }, { key: 'online', label: 'Target' }
  ],
  dhcp: [
    { key: 'address', label: 'IP address', className: 'mono primary-cell' }, { key: 'hostname', label: 'Hostname', className: 'wide-cell' },
    { key: 'mac', label: 'MAC address', className: 'mono' }, { key: 'assignment', label: 'Assignment' },
    { key: 'leaseStatus', label: 'Lease status' }, { key: 'expires', label: 'Expires' }, { key: 'online', label: 'Online' }
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
  if (!query) return folders;
  return folders.map(folder => ({
    ...folder,
    networks: folder.networks.filter(network => `${network.name} ${network.cidr} ${network.vlan}`.toLowerCase().includes(query))
  })).filter(folder => folder.name.toLowerCase().includes(query) || folder.networks.length);
});

const contextTitle = computed(() => {
  if (contextKind.value === 'dns') return 'DNS inventory';
  if (contextKind.value === 'dhcp') return 'DHCP inventory';
  return selectedNetwork.value.name;
});
const contextSubtitle = computed(() => contextKind.value === 'network'
  ? `${selectedNetwork.value.cidr} · VLAN ${selectedNetwork.value.vlan} · ${selectedNetwork.value.domain}`
  : contextKind.value === 'dns' ? 'All authoritative forward and reverse zones' : 'All scopes, leases, and DHCP Reservations');
const contextIcon = computed(() => contextKind.value === 'dns' ? 'pi pi-globe' : contextKind.value === 'dhcp' ? 'pi pi-server' : 'pi pi-sitemap');
const selectedPrefix = computed(() => selectedNetwork.value.cidr.split('/')[0].split('.').slice(0, 3).join('.'));
const usableAddressCount = computed(() => Math.max(0, (2 ** (32 - Number(selectedNetwork.value.cidr.split('/')[1]))) - 2));
const reverseZoneName = computed(() => `${selectedPrefix.value.split('.').reverse().join('.')}.in-addr.arpa`);
const availableViews = computed(() => contextKind.value === 'network'
  ? networkViews.map(view => view.key === 'addresses' ? { ...view, count: String(usableAddressCount.value) } : view)
  : networkViews.filter(view => view.key === contextKind.value));
const viewMeta = computed(() => {
  const base = viewDefinitions[activeView.value];
  if (contextKind.value !== 'network') {
    if (activeView.value === 'dns') return { ...base, title: '3 authoritative zones', description: 'Forward and reverse records across every managed network.' };
    if (activeView.value === 'dhcp') return { ...base, title: '3 active scopes', description: 'Leases, reservations, and availability across every managed pool.' };
  }
  if (activeView.value === 'addresses') return { ...base, title: `${usableAddressCount.value} managed addresses` };
  if (activeView.value === 'dns') return { ...base, title: selectedNetwork.value.domain };
  if (activeView.value === 'dhcp') return { ...base, title: `${selectedNetwork.value.name} scope` };
  return base;
});
const columns = computed(() => columnDefinitions[activeView.value]);
const currentRows = computed(() => {
  const rows = ({ addresses: addressRows, dns: dnsRows, dhcp: dhcpRows, ranges: rangeRows })[activeView.value];
  if (contextKind.value !== 'network') return rows;
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (typeof value !== 'string') return [key, value];
    return [key, value
      .replaceAll('10.42.16.', `${selectedPrefix.value}.`)
      .replaceAll('corp.example', selectedNetwork.value.domain)];
  })));
});
const filterLabel = computed(() => activeFilter.value === 'all' ? 'All states' : activeFilter.value === 'attention' ? 'Needs attention' : 'Configured only');
const actionMenuTitle = computed(() => activeView.value === 'dns' ? 'DNS ACTIONS' : activeView.value === 'dhcp' ? 'DHCP ACTIONS' : 'NETWORK ACTIONS');
const actionMenuItems = computed(() => activeView.value === 'dns' ? dnsActions : activeView.value === 'dhcp' ? dhcpActions : networkActions);

const contextStats = computed(() => contextKind.value === 'network' ? [
  { label: 'UTILIZATION', value: `${selectedNetwork.value.used}%`, note: `${Math.round(usableAddressCount.value * selectedNetwork.value.used / 100)} of ${usableAddressCount.value}`, tone: 'neutral' },
  { label: 'ONLINE NOW', value: '24', note: '2 recently offline', tone: 'good', dot: true },
  { label: 'DNS', value: '45 records', note: 'forward + reverse', tone: 'neutral' },
  { label: 'DHCP POOL', value: '35 / 94', note: '59 addresses free', tone: 'good', dot: true },
  { label: 'ATTENTION', value: '1 rogue', note: 'detected 8 sec ago', tone: 'warning', dot: true }
] : contextKind.value === 'dns' ? [
  { label: 'FORWARD ZONES', value: '2', note: '31 records', tone: 'good', dot: true },
  { label: 'REVERSE ZONES', value: '1', note: '17 PTR records', tone: 'neutral' },
  { label: 'ENABLED', value: '47 / 48', note: '1 record disabled', tone: 'warning', dot: true },
  { label: 'CONFIGURATION', value: 'Current', note: 'applied 14 sec ago', tone: 'good', dot: true }
] : [
  { label: 'SCOPES', value: '3 active', note: '221 pool addresses', tone: 'good', dot: true },
  { label: 'ACTIVE LEASES', value: '27', note: '12% utilization', tone: 'neutral' },
  { label: 'RESERVATIONS', value: '9', note: 'all valid', tone: 'good', dot: true },
  { label: 'CONFIGURATION', value: 'Current', note: 'synced 32 sec ago', tone: 'good', dot: true }
]);

const filteredRows = computed(() => {
  const query = tableQuery.value.trim().toLowerCase();
  return currentRows.value.filter(row => {
    if (!showAvailable.value && (row.status === 'available' || row.leaseStatus === 'available')) return false;
    if (activeFilter.value === 'attention' && !['rogue', 'unavailable', 'offline'].some(value => Object.values(row).includes(value))) return false;
    if (activeFilter.value === 'configured' && (row.status === 'available' || row.leaseStatus === 'available')) return false;
    return !query || Object.values(row).some(value => String(value ?? '').toLowerCase().includes(query));
  });
});

const detailTitle = computed(() => activeView.value === 'dns' ? 'DNS record' : activeView.value === 'dhcp' ? 'DHCP address' : activeView.value === 'ranges' ? 'Managed range' : 'IP address');
const detailHeading = computed(() => selectedRow.value?.address || selectedRow.value?.name || selectedRow.value?.range || 'Resource');
const detailSubheading = computed(() => selectedRow.value?.hostname || selectedRow.value?.value || selectedRow.value?.description || contextTitle.value);
const detailIcon = computed(() => activeView.value === 'dns' ? 'pi pi-globe' : activeView.value === 'dhcp' ? 'pi pi-server' : activeView.value === 'ranges' ? 'pi pi-clone' : 'pi pi-desktop');
const detailItems = computed(() => Object.entries(selectedRow.value || {}).filter(([key]) => !['id', 'online', 'enabled'].includes(key)).slice(0, 8).map(([key, value]) => ({
  label: key.replace(/([A-Z])/g, ' $1').replace(/^./, char => char.toUpperCase()),
  value
})));
const relatedResources = computed(() => activeView.value === 'addresses' ? [
  { view: 'dns', label: 'DNS records', note: '2 records reference this address', icon: 'pi pi-globe' },
  { view: 'dhcp', label: 'DHCP identity', note: 'Lease and reservation details', icon: 'pi pi-server' }
] : [
  { view: 'addresses', label: 'Canonical IP record', note: 'Allocation and liveness details', icon: 'pi pi-list' },
  { view: activeView.value === 'dns' ? 'dhcp' : 'dns', label: activeView.value === 'dns' ? 'DHCP identity' : 'DNS records', note: 'Related service facts', icon: activeView.value === 'dns' ? 'pi pi-server' : 'pi pi-globe' }
]);
const rowActions = computed(() => {
  const row = selectedRow.value;
  if (activeView.value === 'dns') return ['Open IP details', 'Edit record', 'Add CNAME', 'Probe target now', 'Delete record'];
  if (activeView.value === 'dhcp') {
    if (row?.assignment === 'Reserved') return ['Open IP details', 'Edit DHCP Reservation', 'Probe now', 'Delete DHCP Reservation'];
    return ['Open IP details', 'Add DHCP Reservation', 'Probe now'];
  }
  if (activeView.value === 'ranges') {
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

const gridCells = computed(() => Array.from({ length: 128 }, (_, index) => {
  let kind = 'available';
  let label = 'Available';
  if (index === 0) { kind = 'system'; label = 'Network address'; }
  else if (index === 1) { kind = 'gateway'; label = 'Gateway'; }
  else if (index === 24) { kind = 'dns'; label = 'Static DNS'; }
  else if (index >= 17 && index <= 32) { kind = 'infra'; label = 'Infrastructure'; }
  else if (index >= 33 && index <= 63) { kind = index === 47 ? 'rogue' : index % 5 === 3 ? 'dhcp-active' : 'dhcp'; label = index === 47 ? 'Rogue host' : index % 5 === 3 ? 'Active DHCP lease' : 'DHCP Scope'; }
  return { ip: `${selectedPrefix.value}.${index}`, last: index, kind, label };
}));

function toggleFolder(name) {
  const next = new Set(expandedFolders.value);
  if (next.has(name)) next.delete(name); else next.add(name);
  expandedFolders.value = next;
}
function selectNetwork(network) {
  selectedNetwork.value = network;
  contextKind.value = 'network';
  selectedRow.value = null;
  tableQuery.value = '';
}
function selectService(service) {
  contextKind.value = service;
  activeView.value = service;
  selectedRow.value = null;
  tableQuery.value = '';
}
function switchView(view) {
  if (contextKind.value !== 'network') contextKind.value = 'network';
  activeView.value = view;
  selectedRow.value = null;
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
  selectedRow.value = row;
  openMenuName.value = 'row';
}
function notify(message) {
  notice.value = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = ''; }, 2600);
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
  selectedRow.value = addressRows.find(row => row.address === cell.ip) || { id: cell.ip, address: cell.ip, status: cell.label === 'Available' ? 'available' : 'DHCP Scope', type: cell.label, online: 'unknown', source: 'Grid view' };
}
function pillClass(value) {
  return String(value || '').toLowerCase().replaceAll(' ', '-');
}
function typeIcon(type) {
  if (type === 'gateway') return 'pi pi-directions';
  if (type.includes('DHCP')) return 'pi pi-server';
  if (type === 'static DNS') return 'pi pi-globe';
  if (type === 'rogue') return 'pi pi-exclamation-triangle';
  return 'pi pi-shield';
}
</script>

<style scoped>
.workspace-preview {
  --preview-accent: var(--p-primary-color);
  --preview-accent-soft: color-mix(in srgb, var(--preview-accent) 12%, transparent);
  --preview-line: color-mix(in srgb, var(--p-surface-border) 82%, transparent);
  --preview-muted: var(--p-text-muted-color);
  min-height: 100%;
  padding: 1.1rem;
  box-sizing: border-box;
  color: var(--p-text-color);
  background:
    radial-gradient(circle at 80% 0%, color-mix(in srgb, var(--preview-accent) 7%, transparent), transparent 27rem),
    var(--p-surface-ground);
}
button, input { font: inherit; }
button { color: inherit; }
.preview-banner { display: flex; align-items: flex-end; justify-content: space-between; gap: 2rem; max-width: 1680px; margin: 0 auto 1rem; }
.preview-banner h1 { margin: 0.12rem 0 0.25rem; font-size: clamp(1.35rem, 2vw, 2rem); letter-spacing: -0.035em; }
.preview-banner p { margin: 0; color: var(--preview-muted); font-size: var(--app-fs-base); }
.preview-kicker, .eyebrow { color: var(--preview-accent); font-size: 0.65rem; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
.preview-banner-actions { display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0; }
.sample-pill, .quiet-link { display: inline-flex; align-items: center; gap: 0.4rem; border-radius: 999px; font-size: var(--app-fs-sm); }
.sample-pill { padding: 0.4rem 0.7rem; color: var(--preview-muted); background: var(--p-surface-card); border: 1px solid var(--preview-line); }
.quiet-link { padding: 0.4rem 0.15rem; color: var(--preview-accent); text-decoration: none; font-weight: 700; }
.workspace-frame { position: relative; display: grid; grid-template-columns: 275px minmax(0, 1fr); max-width: 1680px; height: calc(100vh - 9.8rem); min-height: 650px; margin: 0 auto; overflow: hidden; background: var(--p-surface-card); border: 1px solid var(--preview-line); border-radius: 14px; box-shadow: 0 18px 50px rgba(15, 23, 42, 0.1); }
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
.service-shortcuts { display: grid; gap: 0.28rem; padding: 0 0.55rem 0.8rem; border-bottom: 1px solid var(--preview-line); }
.service-shortcuts button { display: grid; grid-template-columns: 2rem 1fr auto; align-items: center; gap: 0.55rem; padding: 0.52rem; border: 0; border-radius: 8px; text-align: left; background: transparent; cursor: pointer; }
.service-shortcuts button:hover, .service-shortcuts button.active { background: var(--preview-accent-soft); }
.service-shortcuts button > span:nth-child(2) { display: flex; min-width: 0; flex-direction: column; gap: 0.12rem; }
.service-shortcuts strong { font-size: var(--app-fs-sm); }
.service-shortcuts small { color: var(--preview-muted); font-size: 0.66rem; }
.service-shortcuts button > .pi-chevron-right { color: var(--preview-muted); font-size: 0.6rem; }
.shortcut-icon { display: inline-flex; width: 1.85rem; height: 1.85rem; align-items: center; justify-content: center; border-radius: 7px; }
.shortcut-icon.dns { color: var(--p-blue-500); background: color-mix(in srgb, var(--p-blue-500) 13%, transparent); }
.shortcut-icon.dhcp { color: var(--p-violet-500); background: color-mix(in srgb, var(--p-violet-500) 13%, transparent); }
.explorer-section-head { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 0.75rem 0.35rem; color: var(--preview-muted); font-size: 0.62rem; font-weight: 800; letter-spacing: 0.12em; }
.explorer-section-head button { padding: 0; border: 0; color: var(--preview-accent); background: none; font-size: 0.64rem; font-weight: 700; letter-spacing: 0; cursor: pointer; }
.network-tree { flex: 1; min-height: 0; overflow-y: auto; padding: 0 0.45rem; }
.network-group + .network-group { margin-top: 0.18rem; }
.folder-row { display: grid; grid-template-columns: 0.75rem 0.9rem 1fr auto; width: 100%; align-items: center; gap: 0.38rem; padding: 0.42rem 0.42rem; border: 0; background: none; color: var(--preview-muted); text-align: left; cursor: pointer; }
.folder-row .pi-chevron-down, .folder-row .pi-chevron-right { font-size: 0.52rem; }
.folder-row span { color: var(--p-text-color); font-size: var(--app-fs-sm); font-weight: 750; }
.folder-row small { font-size: 0.65rem; }
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
.context-header { flex-shrink: 0; padding: 0.85rem 1rem 0; border-bottom: 1px solid var(--preview-line); }
.context-breadcrumb { display: flex; align-items: center; gap: 0.35rem; margin-bottom: 0.55rem; color: var(--preview-muted); font-size: 0.65rem; }
.context-breadcrumb i { font-size: 0.48rem; }
.context-title-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.context-identity { display: flex; align-items: center; gap: 0.7rem; min-width: 0; }
.context-icon { display: inline-flex; width: 2.4rem; height: 2.4rem; flex: 0 0 auto; align-items: center; justify-content: center; border-radius: 9px; color: var(--preview-accent); background: var(--preview-accent-soft); }
.context-icon.dns { color: var(--p-blue-500); background: color-mix(in srgb, var(--p-blue-500) 12%, transparent); }
.context-icon.dhcp { color: var(--p-violet-500); background: color-mix(in srgb, var(--p-violet-500) 12%, transparent); }
.title-line { display: flex; align-items: center; gap: 0.55rem; }
.title-line h2 { margin: 0; font-size: 1.24rem; letter-spacing: -0.025em; }
.context-identity p { margin: 0.15rem 0 0; color: var(--preview-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.69rem; }
.state-chip { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.18rem 0.42rem; border-radius: 999px; color: var(--p-green-600); background: color-mix(in srgb, var(--p-green-500) 11%, transparent); font-size: 0.61rem; font-weight: 800; text-transform: uppercase; }
.state-chip i { width: 0.36rem; height: 0.36rem; border-radius: 50%; background: var(--p-green-500); }
.context-actions { display: flex; align-items: center; gap: 0.4rem; }
.button { display: inline-flex; min-height: 2rem; align-items: center; justify-content: center; gap: 0.38rem; padding: 0 0.68rem; border: 1px solid var(--preview-line); border-radius: 7px; background: var(--p-surface-card); font-size: var(--app-fs-sm); font-weight: 700; cursor: pointer; }
.button:hover { border-color: color-mix(in srgb, var(--preview-accent) 55%, var(--preview-line)); }
.button.primary { border-color: var(--preview-accent); color: var(--p-primary-contrast-color, white); background: var(--preview-accent); }
.button.compact { min-height: 1.9rem; white-space: nowrap; }
.health-strip { display: flex; gap: 0; margin-top: 0.85rem; overflow-x: auto; }
.health-stat { display: grid; min-width: 118px; padding: 0.58rem 1rem 0.62rem 0; }
.health-stat + .health-stat { padding-left: 1rem; border-left: 1px solid var(--preview-line); }
.health-stat > span { color: var(--preview-muted); font-size: 0.56rem; font-weight: 800; letter-spacing: 0.11em; }
.health-stat strong { margin: 0.12rem 0; font-size: 0.8rem; }
.health-stat small { display: flex; align-items: center; gap: 0.28rem; color: var(--preview-muted); font-size: 0.61rem; white-space: nowrap; }
.health-stat small i { width: 0.34rem; height: 0.34rem; border-radius: 50%; background: var(--p-green-500); }
.health-stat small.warning { color: var(--p-orange-600); }
.health-stat small.warning i { background: var(--p-orange-500); }
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
.address-overview { display: flex; gap: 0.5rem; }
.address-overview > div { display: grid; grid-template-columns: 4px auto; grid-template-rows: auto auto; column-gap: 0.42rem; min-width: 66px; }
.address-overview > div > span { grid-row: 1 / 3; display: block; width: 4px; height: 2rem; align-self: center; overflow: hidden; border-radius: 99px; background: var(--p-surface-200); }
.address-overview > div > span::after { content: ''; display: block; height: var(--value); margin-top: calc(2rem - var(--value)); background: var(--preview-accent); }
.address-overview small { align-self: end; color: var(--preview-muted); font-size: 0.58rem; }
.address-overview strong { font-size: 0.8rem; }
.range-legend, .grid-key { display: flex; flex-wrap: wrap; gap: 0.7rem; color: var(--preview-muted); font-size: 0.61rem; }
.range-legend span, .grid-key span { display: inline-flex; align-items: center; gap: 0.3rem; }
.legend-dot, .grid-key i { width: 0.48rem; height: 0.48rem; border-radius: 2px; }
.legend-dot.scope, .grid-key i.dhcp { background: var(--p-blue-500); }.legend-dot.infra, .grid-key i.infra { background: var(--p-cyan-500); }.legend-dot.reserved, .grid-key i.reserved { background: var(--p-violet-500); }.legend-dot.system, .grid-key i.system { background: var(--p-surface-500); }
.table-card { display: flex; min-height: 0; flex: 1; flex-direction: column; margin: 0.7rem; overflow: hidden; border: 1px solid var(--preview-line); border-radius: 10px; background: var(--p-surface-card); }
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
.view-switcher button.active { background: var(--p-surface-card); color: var(--preview-accent); box-shadow: 0 1px 3px rgba(0,0,0,.1); }
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
.table-pill { display: inline-flex; padding: 0.17rem 0.38rem; border-radius: 999px; font-size: 0.6rem; font-weight: 750; }.table-pill.in-use, .table-pill.active { color: var(--p-red-600); background: color-mix(in srgb, var(--p-red-500) 10%, transparent); }.table-pill.dhcp-scope, .table-pill.available { color: var(--p-blue-600); background: color-mix(in srgb, var(--p-blue-500) 10%, transparent); }.table-pill.offline { color: var(--preview-muted); background: var(--p-surface-ground); }.table-pill.unavailable { color: var(--p-orange-600); background: color-mix(in srgb, var(--p-orange-500) 12%, transparent); }
.online-value, .enabled-value { display: inline-flex; align-items: center; gap: 0.3rem; text-transform: capitalize; }.online-value i, .enabled-value i { width: 0.38rem; height: 0.38rem; border-radius: 50%; background: var(--p-green-500); }.online-value.offline i, .enabled-value.off i { background: var(--p-surface-400); }.online-value.unknown { color: var(--preview-muted); }.online-value.unknown i { border: 1px solid var(--p-surface-400); background: transparent; }
.type-value { display: inline-flex; align-items: center; gap: 0.3rem; }.type-value i { color: var(--preview-accent); font-size: 0.7rem; }
.no-results { display: flex; min-height: 180px; align-items: center; justify-content: center; flex-direction: column; gap: 0.4rem; color: var(--preview-muted); }.no-results i { font-size: 1.4rem; }.no-results strong { color: var(--p-text-color); }
.table-footer { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 0.38rem 0.55rem; border-top: 1px solid var(--preview-line); color: var(--preview-muted); font-size: 0.61rem; }.table-footer > button { justify-self: end; border: 0; background: none; color: inherit; cursor: pointer; }.pagination { display: flex; gap: 0.12rem; }.pagination button { width: 1.5rem; height: 1.5rem; border: 0; border-radius: 5px; background: transparent; color: var(--preview-muted); cursor: pointer; }.pagination button.active { color: var(--p-primary-contrast-color, white); background: var(--preview-accent); }
.address-grid-view { flex: 1; min-height: 0; overflow: auto; padding: 0.7rem; }.grid-ruler { display: grid; grid-template-columns: repeat(8, 1fr); margin: 0 0 0.28rem; color: var(--preview-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.56rem; }.address-grid { display: grid; grid-template-columns: repeat(16, minmax(24px, 1fr)); gap: 3px; }.address-grid button { aspect-ratio: 1.35; min-height: 23px; border: 1px solid transparent; border-radius: 4px; background: var(--p-surface-100); color: var(--preview-muted); font-size: 0.54rem; cursor: pointer; }.address-grid button:hover { border-color: var(--p-text-color); transform: translateY(-1px); }.address-grid button.system { background: var(--p-surface-400); color: white; }.address-grid button.gateway { background: var(--p-orange-400); color: #111; }.address-grid button.infra { background: color-mix(in srgb, var(--p-cyan-500) 35%, var(--p-surface-card)); }.address-grid button.dhcp { background: color-mix(in srgb, var(--p-blue-500) 22%, var(--p-surface-card)); }.address-grid button.dhcp-active { background: var(--p-blue-500); color: white; }.address-grid button.dns { background: var(--p-green-400); color: #111; }.address-grid button.rogue { border: 2px solid var(--p-red-500); background: color-mix(in srgb, var(--p-red-500) 12%, var(--p-surface-card)); color: var(--p-red-600); font-weight: 800; }.grid-key { margin-top: 0.65rem; }.grid-key i.gateway { background: var(--p-orange-400); }.grid-key i.dns { background: var(--p-green-400); }.grid-key i.rogue { border: 2px solid var(--p-red-500); }.grid-key i.available { border: 1px solid var(--preview-line); background: var(--p-surface-100); }
.details-panel { position: absolute; top: 0; right: 0; bottom: 0; z-index: 4; display: flex; width: min(330px, 90%); flex-direction: column; overflow-y: auto; border-left: 1px solid var(--preview-line); background: var(--p-surface-card); box-shadow: -12px 0 32px rgba(15,23,42,.13); }.details-head { display: flex; align-items: center; justify-content: space-between; padding: 0.85rem; border-bottom: 1px solid var(--preview-line); }.details-head > div { display: flex; flex-direction: column; gap: 0.2rem; }.details-head strong { font-size: 0.9rem; }.details-status { display: flex; align-items: center; gap: 0.65rem; padding: 0.9rem; border-bottom: 1px solid var(--preview-line); }.detail-orb { display: inline-flex; width: 2.5rem; height: 2.5rem; align-items: center; justify-content: center; border-radius: 10px; color: var(--p-green-600); background: color-mix(in srgb, var(--p-green-500) 12%, transparent); }.detail-orb.offline, .detail-orb.unknown { color: var(--preview-muted); background: var(--p-surface-ground); }.details-status > div { display: flex; min-width: 0; flex-direction: column; gap: 0.14rem; }.details-status strong { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; }.details-status small { overflow: hidden; color: var(--preview-muted); font-size: 0.65rem; text-overflow: ellipsis; white-space: nowrap; }.details-panel dl { display: grid; grid-template-columns: 42% 58%; margin: 0; padding: 0.7rem 0.9rem; border-bottom: 1px solid var(--preview-line); font-size: 0.66rem; }.details-panel dt, .details-panel dd { padding: 0.33rem 0; border-bottom: 1px solid color-mix(in srgb, var(--preview-line) 55%, transparent); }.details-panel dt { color: var(--preview-muted); }.details-panel dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }.details-section { display: grid; gap: 0.42rem; padding: 0.75rem 0.9rem; border-bottom: 1px solid var(--preview-line); }.details-section > button { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 0.5rem; padding: 0.48rem; border: 1px solid var(--preview-line); border-radius: 7px; background: transparent; text-align: left; cursor: pointer; }.details-section > button:hover { border-color: var(--preview-accent); background: var(--preview-accent-soft); }.details-section > button > i:first-child { color: var(--preview-accent); }.details-section > button > i:last-child { color: var(--preview-muted); font-size: 0.55rem; }.details-section > button span { display: flex; flex-direction: column; gap: 0.1rem; }.details-section > button strong { font-size: 0.67rem; }.details-section > button small { color: var(--preview-muted); font-size: 0.6rem; }.quick-actions { display: flex; flex-wrap: wrap; gap: 0.32rem; }.quick-actions button { padding: 0.32rem 0.45rem; border: 1px solid var(--preview-line); border-radius: 6px; background: transparent; font-size: 0.61rem; cursor: pointer; }.quick-actions button:hover { color: var(--preview-accent); border-color: var(--preview-accent); }.activity-link { display: flex; align-items: center; gap: 0.38rem; margin: auto 0.9rem 0.9rem; padding: 0.52rem; border: 0; background: none; color: var(--preview-accent); font-size: 0.66rem; font-weight: 700; cursor: pointer; }
.menu-scrim { position: fixed; inset: 0; z-index: 7; }.floating-menu { position: fixed; z-index: 8; display: grid; width: 270px; padding: 0.35rem; border: 1px solid var(--preview-line); border-radius: 10px; background: var(--p-surface-card); box-shadow: 0 16px 45px rgba(15,23,42,.2); }.floating-menu > span { padding: 0.45rem 0.5rem 0.3rem; color: var(--preview-muted); font-size: 0.58rem; font-weight: 800; letter-spacing: .12em; }.floating-menu button { display: grid; grid-template-columns: 1.7rem 1fr; align-items: center; gap: 0.35rem; padding: 0.5rem; border: 0; border-radius: 7px; background: transparent; text-align: left; cursor: pointer; }.floating-menu button:hover { background: var(--preview-accent-soft); }.floating-menu button > i { color: var(--preview-accent); }.floating-menu button span { display: flex; flex-direction: column; gap: 0.1rem; }.floating-menu button strong { font-size: 0.67rem; }.floating-menu button small { color: var(--preview-muted); font-size: 0.59rem; }.floating-menu button.danger { color: var(--p-red-600); }.floating-menu button.danger > i { color: var(--p-red-500); }.create-menu { top: 7.8rem; right: 2rem; }.actions-menu { top: 7.8rem; right: 7.8rem; }.row-menu { top: 48%; right: 2.4rem; width: 225px; }.row-menu button { grid-template-columns: 1rem 1fr; }
.prototype-notice { position: fixed; right: 1.25rem; bottom: 1.25rem; z-index: 10; display: flex; align-items: center; gap: 0.65rem; width: min(330px, calc(100vw - 2.5rem)); padding: 0.7rem 0.85rem; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--preview-accent) 40%, var(--preview-line)); border-radius: 10px; color: var(--p-text-color); background: var(--p-surface-card); box-shadow: 0 14px 40px rgba(15,23,42,.2); }.prototype-notice > i { color: var(--preview-accent); }.prototype-notice span { display: flex; flex-direction: column; gap: 0.1rem; font-size: 0.67rem; }.prototype-notice strong { font-size: 0.71rem; }.notice-enter-active, .notice-leave-active { transition: opacity .18s, transform .18s; }.notice-enter-from, .notice-leave-to { opacity: 0; transform: translateY(10px); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (max-width: 1100px) { .workspace-frame { grid-template-columns: 235px minmax(0, 1fr); }.health-stat:nth-child(4) { display: none; }.linked-card:nth-child(2) { display: none; }.context-actions .secondary:first-child { display: none; } }
@media (max-width: 820px) { .workspace-preview { padding: 0.65rem; }.preview-banner { align-items: flex-start; flex-direction: column; gap: 0.6rem; }.preview-banner-actions { width: 100%; justify-content: space-between; }.workspace-frame { height: auto; min-height: calc(100vh - 10rem); grid-template-columns: 1fr; overflow: visible; }.resource-explorer { display: none; }.context-title-row { align-items: flex-start; }.context-actions { flex-wrap: wrap; justify-content: flex-end; }.health-stat:nth-child(3), .health-stat:nth-child(5) { display: none; }.view-summary { align-items: flex-start; flex-direction: column; }.table-card { min-height: 430px; }.table-toolbar { flex-wrap: wrap; }.table-search { width: 100%; }.toolbar-space { display: none; }.details-panel { position: fixed; }.sample-pill { display: none; } }
</style>
