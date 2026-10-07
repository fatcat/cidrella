/* global document -- these run in the test DOM. */
// Mounts the Networks workspace on the fake estate, reads what the screen
// shows back into a plain state, and checks that state against what the
// estate says the screen should show. The model test drives it; a failing
// walk prints the actions that got there, and those become regression tests.
import { flushPromises, mount } from '@vue/test-utils';
import { vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import NetworksWorkspace from '../../../../../src/views/networks-workspace/NetworksWorkspace.vue';
import { UiPlugin } from '../../../../../src/ui/plugin.js';
import {
  buildExplorerFolders,
  mapNetworkRows,
} from '../../../../../src/views/networks-workspace-data.js';
import { zoneFileName, zoneFileValue } from '../../../../../src/utils/dnsZoneFile.js';
import {
  FOLDERS,
  RECORDS,
  allocatedLeaves,
  applyColumnFilters,
  queryAddresses,
  queryDhcpRows,
  queryDnsRecords,
  queryNetworks,
  queryScopes,
  queryZones,
  recordRow,
  subnetTree,
  unallocatedLeaves,
} from './fake-estate.js';

export const STORAGE_KEY = 'cidrella_workspace_v1_admin';

// ─── Mounting and settling ────────────────────────────────────────────

export function freshSession() {
  const pinia = createPinia();
  setActivePinia(pinia);
  pinia.state.value.auth = {
    user: { username: 'admin', role: 'admin', is_admin: true, permissions: ['*'] },
  };
  return pinia;
}

export function mountWorkspace(pinia) {
  return mount(NetworksWorkspace, {
    attachTo: document.body,
    global: {
      plugins: [pinia, [UiPlugin, { unstyled: true }]],
      stubs: {
        RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        // The vendor paginator's markup is not what is under test; the stub
        // keeps its contract (first/rows/totalRecords in, a page event out).
        Paginator: {
          props: ['first', 'rows', 'totalRecords', 'rowsPerPageOptions'],
          emits: ['page'],
          template:
            '<nav class="paginator-stub" :data-first="first" :data-rows="rows" :data-total="totalRecords">' +
            '<button aria-label="Previous Page" :disabled="first === 0" @click="$emit(\'page\', { page: Math.floor(first / rows) - 1, first: first - rows, rows })" />' +
            '<button aria-label="Next Page" :disabled="first + rows >= totalRecords" @click="$emit(\'page\', { page: Math.floor(first / rows) + 1, first: first + rows, rows })" />' +
            '<select aria-label="Rows per page" :value="rows" @change="$emit(\'page\', { page: 0, first: 0, rows: Number($event.target.value) })"><option v-for="size in rowsPerPageOptions" :key="size" :value="size">{{ size }}</option></select>' +
            '</nav>',
        },
        // The vendor popover leaves its content behind in this DOM once
        // hidden; the stub renders it only while open, as a browser shows it.
        Popover: {
          emits: ['show', 'hide'],
          data: () => ({ visible: false }),
          methods: {
            toggle() {
              if (this.visible) this.hide();
              else this.show();
            },
            show() {
              this.visible = true;
              this.$emit('show');
            },
            hide() {
              if (!this.visible) return;
              this.visible = false;
              this.$emit('hide');
            },
          },
          template: '<div v-if="visible" class="popover-stub"><slot /></div>',
        },
        Dialog: {
          props: ['visible'],
          template:
            '<section v-if="visible" class="dialog-stub"><slot /><slot name="footer" /></section>',
        },
      },
    },
  });
}

// Debounced searches and the details panel's reads all hang off timers; the
// walk runs on fake ones and lets each step finish before looking.
export async function settle() {
  for (let round = 0; round < 4; round += 1) {
    await flushPromises();
    await vi.advanceTimersByTimeAsync(400);
  }
  await flushPromises();
}

// ─── Reading the screen ───────────────────────────────────────────────

const all = (selector) => [...document.body.querySelectorAll(selector)];
const one = (selector) => document.body.querySelector(selector);

export function observe() {
  const activeFolder = one('.folder-row.active');
  const activeNetwork = one('.network-row.active');
  const activeEstate = all('.estate-row.active').map((row) => row.dataset.track);
  const activeTab = one('.view-tabs button.active');
  const zoneCard = one('.linked-card.selected:not(.linked-picker)[data-zone-id]');
  const picker = one('.linked-picker.selected');
  const scopeCard = one('.linked-card.selected[data-scope-id]');
  const explorerSearch = one('[data-track="workspace-global-search"]');
  const tableSearch = one('.table-search input');
  const available = one('.available-switch input');
  const domainNames = one('.domain-names-switch input');
  return {
    title: one('.context-title-row h2')?.textContent.trim() ?? null,
    activeEstate,
    activeFolders: all('.folder-row.active').map((row) => row.dataset.folderId),
    activeNetworks: all('.network-row.active').map((row) => Number(row.dataset.networkId)),
    explorerFolders: all('.folder-row[data-folder-id]').map((row) => row.dataset.folderId),
    folderId: activeFolder ? activeFolder.dataset.folderId : null,
    networkId: activeNetwork ? Number(activeNetwork.dataset.networkId) : null,
    tabs: all('.view-tabs button').map((button) =>
      button.dataset.track.replace('workspace-tab-', ''),
    ),
    view: activeTab ? activeTab.dataset.track.replace('workspace-tab-', '') : null,
    zoneCards: all('.linked-card:not(.linked-picker)[data-zone-id]').map((card) =>
      Number(card.dataset.zoneId),
    ),
    pickerZones: all('.picker-item[data-zone-id]').map((item) => Number(item.dataset.zoneId)),
    hasPicker: Boolean(one('.linked-picker')),
    pickerZoneId: picker?.dataset.zoneId ? Number(picker.dataset.zoneId) : null,
    zoneId: zoneCard
      ? Number(zoneCard.dataset.zoneId)
      : picker?.dataset.zoneId
        ? Number(picker.dataset.zoneId)
        : null,
    reverseNetworkId: picker?.dataset.networkId ? Number(picker.dataset.networkId) : null,
    selectedCards: all('.linked-card.selected').length,
    scopeCards: all('.linked-card[data-scope-id]').map((card) => Number(card.dataset.scopeId)),
    scopeId: scopeCard ? Number(scopeCard.dataset.scopeId) : null,
    q: explorerSearch?.value.trim() ?? '',
    tableQ: tableSearch?.value.trim() ?? '',
    showAvailable: available ? available.checked : null,
    showDomainNames: domainNames ? domainNames.checked : null,
    dnsCells: dnsCells(),
    rows: all('tbody tr[data-row-id]').map((row) => row.dataset.rowId),
    checked: all('tbody tr[data-row-id]')
      .filter((row) => row.querySelector('.check-cell input')?.checked)
      .map((row) => row.dataset.rowId),
    explorerNetworks: all('.network-row[data-network-id]').map((row) =>
      Number(row.dataset.networkId),
    ),
    explorerChecked: all('.network-row.checked').map((row) => Number(row.dataset.networkId)),
    pager: pagerOf(one('.paginator-stub')),
    chips: all('.filter-chips button[data-filter-key]').map((chip) => chip.dataset.filterKey),
    filters: savedFilters(),
    loadError: one('.load-error, .workspace-error')?.textContent.trim() || null,
  };
}

// The DNS Name and Value cell of each DNS row on screen, by record id.
function dnsCells() {
  const headers = all('thead th');
  const at = (key) => headers.findIndex((th) => th.dataset.column === key);
  const [name, value] = [at('dns_hostname'), at('value')];
  return all('tbody tr[data-row-id^="dns:"]').map((row) => {
    const cells = row.querySelectorAll('td');
    const text = (index) => (index < 0 ? null : (cells[index]?.textContent.trim() ?? null));
    return { id: recordIdOf(row.dataset.rowId), name: text(name), value: text(value) };
  });
}

function pagerOf(element) {
  if (!element) return null;
  const [first, rows, total] = ['first', 'rows', 'total'].map((key) =>
    Number(element.dataset[key]),
  );
  return { first, rows, total };
}

// The column filters in force, from the saved workspace state (the route):
// the chips on screen are checked against these.
function savedFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return saved.filters ? JSON.parse(saved.filters) : {};
  } catch {
    return {};
  }
}

// The context the header names. The explorer cannot say: a search may hide
// the current folder or network there.
export function contextOf(state) {
  if (state.title === 'All Allocated Networks') return { kind: 'estate' };
  if (state.title === 'All Unallocated Networks') return { kind: 'unallocated' };
  const folder = [...FOLDERS, { id: null, name: 'Ungrouped' }].find(
    (entry) => entry.name === state.title,
  );
  if (folder) return { kind: 'folder', folderId: folder.id };
  const network = allocatedLeaves().find((entry) => entry.name === state.title);
  if (network) return { kind: 'network', networkId: network.id };
  return { kind: 'none' };
}

// The explorer row that should be marked current, if it is on screen.
function explorerMark(state, context) {
  if (context.kind === 'estate' || context.kind === 'unallocated')
    return {
      estate: [`workspace-${context.kind === 'estate' ? 'estate' : 'unallocated'}-select`],
      folders: [],
      networks: [],
    };
  if (context.kind === 'folder')
    return { estate: [], folders: [String(context.folderId ?? 'ungrouped')], networks: [] };
  if (context.kind === 'network') return { estate: [], folders: [], networks: [context.networkId] };
  return null;
}

// ─── What the estate says the screen should show ──────────────────────

const recordIdOf = (rowId) => Number(rowId.split(':')[2]);
const dhcpIpOf = (rowId) => rowId.split(':').slice(3).join(':');

function placeParams(context) {
  if (context.kind === 'folder') return { folder_id: context.folderId ?? 'ungrouped' };
  if (context.kind === 'network') return { subnet_id: context.networkId };
  return {};
}

function expectedDns(state, context) {
  const search = { q: state.q || undefined, table_q: state.tableQ || undefined };
  let rows = queryDnsRecords({ ...placeParams(context), ...search });
  if (state.zoneId != null) rows = rows.filter((row) => row.zone_id === state.zoneId);
  if (state.reverseNetworkId != null)
    rows = rows.filter(
      (row) =>
        row.zone_type === 'reverse' && row.related_subnet_ids.includes(state.reverseNetworkId),
    );
  return applyColumnFilters(rows, state.filters, 'dns').map((row) => row.id);
}

function expectedDhcp(state, context) {
  const search = { q: state.q || undefined, table_q: state.tableQ || undefined };
  const rows = queryDhcpRows({
    ...placeParams(context),
    scope_id: state.scopeId ?? undefined,
    ...search,
  });
  return applyColumnFilters(rows, state.filters, 'dhcp').map((row) => row.ip_address);
}

function expectedAddresses(state, context) {
  const params = {
    showAvailable: state.showAvailable === false ? 'false' : 'true',
    search: state.q || undefined,
    table_search: state.tableQ || undefined,
  };
  return queryAddresses(context.networkId, params, state.filters).map((row) => row.ip_address);
}

// The networks list filters in the browser, on the values its rows carry
// (mapNetworkRows over the explorer's networks, as the workspace builds them).
function networkListFilter(ids, filters) {
  if (!Object.keys(filters).length) return ids;
  const rows = mapNetworkRows(
    buildExplorerFolders(subnetTree().folders).flatMap((folder) => folder.networks),
  ).filter((row) => ids.includes(row.raw.id));
  const value = (row, key) => {
    const found = key in row ? row[key] : row.raw?.[key];
    return found === undefined || found === '' ? null : found;
  };
  return rows
    .filter((row) =>
      Object.entries(filters).every(([key, values]) => values.includes(value(row, key))),
    )
    .map((row) => row.raw.id);
}

function expectedNetworks(state, context) {
  const queries = [state.q, state.tableQ].filter(Boolean).map((query) => query.toLowerCase());
  if (context.kind === 'unallocated')
    return unallocatedLeaves()
      .filter((network) => queries.every((query) => network.cidr.includes(query)))
      .map((network) => network.id);
  const rows = queryNetworks({
    ...(context.kind === 'folder' ? placeParams(context) : {}),
    q: state.q || undefined,
    table_q: state.tableQ || undefined,
  });
  return networkListFilter(
    rows.map((row) => row.id),
    state.filters,
  );
}

// The zones and scopes the cards should offer: the place's, that the search
// matches. The estate leaves out a disabled reverse zone no network uses
// (what deallocating leaves behind).
function expectedZones(state, context) {
  const matched = new Set(queryZones({ q: state.q || undefined }).map((zone) => zone.id));
  const leaves = allocatedLeaves().filter((network) =>
    context.kind === 'network'
      ? network.id === context.networkId
      : context.kind === 'folder'
        ? (network.folder_id ?? null) === context.folderId
        : true,
  );
  const ids = new Set(leaves.map((network) => network.id));
  return queryZones()
    .filter((zone) =>
      context.kind === 'estate'
        ? zone.type !== 'reverse' || zone.enabled || zone.related_subnet_ids.length
        : zone.related_subnet_ids.some((id) => ids.has(id)),
    )
    .filter((zone) => matched.has(zone.id));
}
function expectedScopes(state, context) {
  return queryScopes({ ...placeParams(context), q: state.q || undefined })
    .filter((scope) => context.kind !== 'network' || scope.subnet_id === context.networkId)
    .map((scope) => scope.id);
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// The rows on screen are one page of `expected`, and the paginator agrees.
function checkPage(out, label, shown, expected, pager) {
  const known = new Set(expected.map(String));
  const stray = shown.filter((id) => !known.has(String(id)));
  if (stray.length) out.push(`${label} rows [${stray.slice(0, 5)}] are not in the result`);
  if (new Set(shown.map(String)).size !== shown.length) out.push(`${label} rows repeat`);
  if (!pager) {
    if (!sameSet(shown.map(String), [...known]))
      out.push(`${label} rows [${shown}] expected [${expected}]`);
    return;
  }
  if (pager.total !== expected.length)
    out.push(`${label} paginator counts ${pager.total}, the result has ${expected.length}`);
  if (pager.first % pager.rows)
    out.push(`${label} page starts at ${pager.first}, not a page boundary`);
  if (pager.first > 0 && pager.first >= expected.length)
    out.push(`${label} page starts at ${pager.first}, past the ${expected.length} results`);
  const want = Math.max(0, Math.min(pager.rows, expected.length - pager.first));
  if (shown.length !== want)
    out.push(
      `${label} page shows ${shown.length} rows, expected ${want} (from ${pager.first} of ${expected.length}, ${pager.rows} a page)`,
    );
}

// ─── Invariants ───────────────────────────────────────────────────────

export function violations(state, { unexpected = [], errors = [] } = {}) {
  const out = [];
  const context = contextOf(state);

  // 1. The header names a place, and the explorer marks that place alone
  // (when a search has not hidden its row).
  if (context.kind === 'none') out.push(`title "${state.title}" names no place`);
  const mark = explorerMark(state, context);
  if (mark) {
    const shown = {
      estate: state.activeEstate,
      folders: state.activeFolders,
      networks: state.activeNetworks,
    };
    const visible = {
      estate: true,
      folders: state.explorerFolders.includes(mark.folders[0]),
      networks: state.explorerNetworks.includes(mark.networks[0]),
    };
    for (const key of ['estate', 'folders', 'networks']) {
      const want = mark[key].length && visible[key] ? mark[key] : [];
      if (String(shown[key]) !== String(want))
        out.push(
          `explorer marks ${key} [${shown[key]}] as current in ${context.kind} context, expected [${want}]`,
        );
    }
  }

  // 2. Each place has its tabs, and one of them is open.
  const tabs = {
    estate: ['networks', 'dns', 'dhcp'],
    folder: ['networks', 'dns', 'dhcp'],
    network: ['addresses', 'dns', 'dhcp', 'ranges'],
    unallocated: [],
  }[context.kind];
  if (tabs && state.tabs.join() !== tabs.join())
    out.push(`tabs [${state.tabs}] in ${context.kind}, expected [${tabs}]`);
  if (tabs?.length && !tabs.includes(state.view))
    out.push(`open tab "${state.view}" not one of [${tabs}]`);

  // 3. The DNS view always has one zone or one network's reverse zones chosen.
  const view = context.kind === 'unallocated' ? 'networks' : state.view;
  if (view === 'dns') {
    // The picker's items exist only while it is open; the card stands for them.
    const zonesShown = state.zoneCards.length + (state.hasPicker ? 1 : 0);
    const chosen = (state.zoneId != null ? 1 : 0) + (state.reverseNetworkId != null ? 1 : 0);
    if (zonesShown && chosen !== 1)
      out.push(
        `DNS view with ${zonesShown} zones shown has ${chosen} choices (zone ${state.zoneId}, reverse network ${state.reverseNetworkId})`,
      );
    if (state.selectedCards > 1) out.push(`${state.selectedCards} zone cards are lit`);
    const onPicker = state.hasPicker && state.pickerZoneId === state.zoneId;
    if (state.zoneId != null && !onPicker && !state.zoneCards.includes(state.zoneId))
      out.push(`chosen zone ${state.zoneId} has no card`);
  }

  // 3b. The cards are the place's zones or scopes that the search matches;
  // two or more reverse zones fold into the picker card.
  if (view === 'dns') {
    const zones = expectedZones(state, context);
    const reverse = zones.filter((zone) => zone.type === 'reverse');
    const cards = (
      reverse.length > 1 ? zones.filter((zone) => zone.type !== 'reverse') : zones
    ).map((zone) => zone.id);
    if (!sameSet(state.zoneCards, cards))
      out.push(`zone cards [${state.zoneCards}] expected [${cards}]`);
    if (state.hasPicker !== reverse.length > 1)
      out.push(
        `reverse picker ${state.hasPicker ? 'shown' : 'missing'} for ${reverse.length} reverse zones`,
      );
  } else if (view === 'dhcp') {
    const scopes = expectedScopes(state, context);
    if (!sameSet(state.scopeCards, scopes))
      out.push(`scope cards [${state.scopeCards}] expected [${scopes}]`);
  }

  // 4. The table shows exactly what the estate says it should: the page on
  // screen is a page of the result, and the paginator counts the result.
  if (view === 'dns') {
    checkPage(out, 'DNS', state.rows.map(recordIdOf), expectedDns(state, context), state.pager);
  } else if (view === 'dhcp') {
    const shown = state.rows.filter((id) => !id.startsWith('dhcp:available')).map(dhcpIpOf);
    checkPage(out, 'DHCP', shown, expectedDhcp(state, context), state.pager);
  } else if (view === 'networks') {
    const shown = state.rows.map((id) => Number(id.split(':')[1]));
    const expected = expectedNetworks(state, context);
    // The unallocated rows' filter values are the workspace's own to build.
    if (context.kind === 'unallocated' && Object.keys(state.filters).length) {
      const stray = shown.filter((id) => !expected.includes(id));
      if (stray.length) out.push(`unallocated rows [${stray}] outside the search`);
    } else checkPage(out, 'network', shown, expected, state.pager);
  } else if (view === 'addresses' && context.kind === 'network') {
    const shown = state.rows.map((id) => id.slice('address:'.length));
    checkPage(out, 'address', shown, expectedAddresses(state, context), state.pager);
  }

  // 4a. DNS names read as the switch says: in full, or as the zone's file
  // writes them (@, relative, absolute with a trailing dot).
  if (view === 'dns' && state.showDomainNames != null) {
    for (const cell of state.dnsCells) {
      const entry = RECORDS.find((record) => record.id === cell.id);
      if (!entry) continue;
      const record = recordRow(entry);
      const name = state.showDomainNames
        ? record.record_fqdn
        : zoneFileName(record.record_fqdn, record.zone_name);
      const value = state.showDomainNames
        ? record.value
        : zoneFileValue(record.record_type, record.value, record.zone_name);
      if (cell.name != null && cell.name !== name)
        out.push(`DNS record ${cell.id} name "${cell.name}", expected "${name}"`);
      if (cell.value != null && cell.value !== String(value))
        out.push(`DNS record ${cell.id} value "${cell.value}", expected "${value}"`);
    }
  }

  // 4b. The chips are the filters in force.
  if (!sameSet(state.chips, Object.keys(state.filters)))
    out.push(`filter chips [${state.chips}] for filters [${Object.keys(state.filters)}]`);

  // 5. A network checked in the table is checked in the explorer and back.
  if (view === 'networks' && context.kind !== 'unallocated') {
    const tableChecked = state.checked.map((id) => Number(id.split(':')[1]));
    for (const id of tableChecked)
      if (state.explorerNetworks.includes(id) && !state.explorerChecked.includes(id))
        out.push(`network ${id} checked in the table, not in the explorer`);
    for (const id of state.explorerChecked)
      if (state.rows.includes(`network:${id}`) && !tableChecked.includes(id))
        out.push(`network ${id} checked in the explorer, not in the table`);
  }

  // 6. Nothing the workspace asked for is unknown, and nothing threw.
  if (unexpected.length) out.push(`unexpected reads: ${unexpected.join(', ')}`);
  if (errors.length) out.push(`errors: ${errors.join(' | ').slice(0, 400)}`);
  if (state.loadError) out.push(`load error shown: ${state.loadError}`);
  return out;
}

// What one action must leave on screen, beyond the invariants.
export function postconditions(label, state) {
  const out = [];
  if (label === 'estate' || label === 'breadcrumb') {
    // Home: every allocated network, whatever was open before.
    if (state.title !== 'All Allocated Networks') out.push(`${label} opened "${state.title}"`);
    if (state.view !== 'networks') out.push(`${label} left the ${state.view} tab open`);
    if (state.q || state.tableQ) out.push(`${label} kept the search "${state.q || state.tableQ}"`);
    if (Object.keys(state.filters).length) out.push(`${label} kept filters`);
    const all = allocatedLeaves().map((network) => network.id);
    const shown = state.rows.map((id) => Number(id.split(':')[1]));
    if (!sameSet(shown, all)) out.push(`${label} shows networks [${shown}], not all [${all}]`);
  }
  return out;
}

// The parts of the screen a reload must bring back.
export function restorable(state) {
  return {
    title: state.title,
    view: state.view,
    zoneId: state.zoneId,
    reverseNetworkId: state.reverseNetworkId,
    scopeId: state.scopeId,
    q: state.q,
    showAvailable: state.showAvailable,
    filters: state.filters,
    chips: [...state.chips].sort(),
    pager: state.pager,
    rows: [...state.rows].sort(),
  };
}

export { allocatedLeaves };
