import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useSubnetStore } from '../../../src/stores/subnets.js';
import NetworksWorkspacePreview from '../../../src/views/NetworksWorkspacePreview.vue';
import NetworksWorkspace from '../../../src/views/networks-workspace/NetworksWorkspace.vue';
import AddressGrid from '../../../src/views/networks-workspace/AddressGrid.vue';
import AddressDetailsPanel from '../../../src/views/networks-workspace/AddressDetailsPanel.vue';
import ResourceExplorer from '../../../src/views/networks-workspace/ResourceExplorer.vue';
import WorkspaceContextHeader from '../../../src/views/networks-workspace/WorkspaceContextHeader.vue';
import WorkspaceDetailsHost from '../../../src/views/networks-workspace/WorkspaceDetailsHost.vue';
import WorkspaceTable from '../../../src/views/networks-workspace/WorkspaceTable.vue';
import WorkspaceToolbar from '../../../src/views/networks-workspace/WorkspaceToolbar.vue';
import IpReservationEditor from '../../../src/views/networks-workspace/dialogs/IpReservationEditor.vue';
import api from '../../../src/api/client.js';
import { useWorkspaceFontBump } from '../../../src/composables/useWorkspaceUi.js';

vi.mock('../../../src/api/client.js', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));
// The reused NetworkDialogs editors toast on save; the workspace has no toast host.
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => ({ add: vi.fn() }) }));

let reservedIp33 = false;
let deletedIps = new Set();
let dnsRecordsHidden = false;
let summaryStats;

const subnet = {
  id: 11,
  cidr: '1.1.1.0/24',
  name: 'Public test network',
  status: 'allocated',
  total_addresses: 256,
  used_count: 5,
  gateway_address: '1.1.1.1',
  domain_name: 'test.example',
  vlan_id: 101,
  children: [],
};
const unallocatedSubnet = {
  id: 12,
  cidr: '1.1.2.0/24',
  name: null,
  status: 'unallocated',
  total_addresses: 256,
  used_count: 0,
  children: [],
};

const ranges = [
  {
    id: 1,
    start_ip: '1.1.1.0',
    end_ip: '1.1.1.0',
    range_type_name: 'Network',
    range_type_is_system: 1,
    range_type_color: '#64748b',
  },
  {
    id: 2,
    start_ip: '1.1.1.1',
    end_ip: '1.1.1.1',
    range_type_name: 'Gateway',
    range_type_is_system: 1,
    range_type_color: '#f59e0b',
  },
  {
    id: 3,
    start_ip: '1.1.1.33',
    end_ip: '1.1.1.126',
    range_type_name: 'DHCP Scope',
    range_type_is_system: 1,
    range_type_color: '#14b8a6',
  },
  {
    id: 4,
    start_ip: '1.1.1.255',
    end_ip: '1.1.1.255',
    range_type_name: 'Broadcast',
    range_type_is_system: 1,
    range_type_color: '#64748b',
  },
];

function makeIps() {
  return Array.from({ length: 256 }, (_, index) => {
    const ip = `1.1.1.${index}`;
    const inScope = index >= 33 && index <= 126;
    const type =
      index === 0 || index === 255
        ? 'system'
        : index === 1
          ? 'gateway'
          : index === 40
            ? 'dynamic DHCP'
            : index === 33 && reservedIp33
              ? 'IP Reservation'
              : null;
    return {
      ip_address: ip,
      subnet_id: subnet.id,
      allocation_state:
        type === 'system'
          ? 'system'
          : type === 'gateway'
            ? 'gateway'
            : type === 'dynamic DHCP'
              ? 'dynamic_dhcp'
              : type === 'IP Reservation'
                ? 'reserved'
                : 'unassigned',
      allocation_source_type:
        type === 'dynamic DHCP'
          ? 'dhcp_lease'
          : type === 'IP Reservation'
            ? 'admin_reservation'
            : type
              ? 'topology'
              : null,
      ip_display_status: type ? 'in use' : inScope ? 'DHCP Scope' : 'available',
      ip_status_severity: type ? 'danger' : 'secondary',
      address_type: type,
      hostname: index === 40 ? 'client.test.example' : null,
      mac_address: index === 40 ? '02:00:00:00:00:40' : null,
      is_online: index === 40 ? 1 : 0,
      last_seen_at: index === 40 ? new Date().toISOString() : null,
      reservation_note: index === 33 && reservedIp33 ? 'Hold for printer' : null,
      scanning_enabled: true,
      scan_enabled: null,
    };
  });
}

const zones = [
  {
    id: 21,
    name: 'test.example',
    type: 'forward',
    enabled: 1,
    record_count: 1,
    related_subnet_ids: [subnet.id],
  },
  {
    id: 22,
    name: '1.1.1.in-addr.arpa',
    type: 'reverse',
    enabled: 1,
    record_count: 1,
    subnet_id: subnet.id,
    related_subnet_ids: [subnet.id],
  },
];

const dnsRecordA = {
  id: 51,
  zone_id: 21,
  zone_name: 'test.example',
  zone_type: 'forward',
  name: 'client',
  record_fqdn: 'client.test.example',
  record_type: 'A',
  value: '1.1.1.40',
  ttl: 3600,
  dns_source: 'manual',
  enabled: 1,
  ip_address: '1.1.1.40',
  is_online: 1,
  related_subnet_ids: [subnet.id],
};
const dnsRecordPtr = {
  id: 52,
  zone_id: 22,
  zone_name: '1.1.1.in-addr.arpa',
  zone_type: 'reverse',
  name: '40',
  record_type: 'PTR',
  value: 'client.test.example',
  ttl: 3600,
  dns_source: 'dns',
  enabled: 1,
  ip_address: '1.1.1.40',
  is_online: 1,
  related_subnet_ids: [subnet.id],
};

// Only the exact-address read returns this one: the loaded DNS page holds a
// single page of the network's records, so counts cannot come from it.
const dnsRecordAlias = {
  id: 54,
  zone_id: 21,
  zone_name: 'test.example',
  zone_type: 'forward',
  name: 'client-alias',
  record_fqdn: 'client-alias.test.example',
  record_type: 'CNAME',
  value: 'client.test.example',
  ttl: 3600,
  dns_source: 'manual',
  enabled: 1,
  ip_address: '1.1.1.40',
  is_online: 1,
  related_subnet_ids: [subnet.id],
};
// Every address in the reverse zone has a generated placeholder; it is not a
// record worth offering.
const dnsPlaceholder33 = {
  id: 53,
  zone_id: 22,
  zone_name: '1.1.1.in-addr.arpa',
  zone_type: 'reverse',
  name: '33',
  record_type: 'PTR',
  value: '1.1.1.33',
  ttl: null,
  dns_source: 'placeholder',
  enabled: 1,
  ip_address: '1.1.1.33',
  is_online: 0,
  related_subnet_ids: [subnet.id],
};

const scope = {
  id: 31,
  subnet_id: subnet.id,
  range_id: 3,
  subnet_name: subnet.name,
  subnet_cidr: subnet.cidr,
  start_ip: '1.1.1.33',
  end_ip: '1.1.1.126',
  lease_time: 43200,
  enabled: 1,
  pools: [{ start_ip: '1.1.1.33', end_ip: '1.1.1.126' }],
};

const lease = {
  id: 41,
  subnet_id: subnet.id,
  subnet_name: subnet.name,
  subnet_cidr: subnet.cidr,
  dhcp_assignment_type: 'dynamic',
  lease_status: 'active',
  ip_address: '1.1.1.40',
  hostname: 'client',
  mac_address: '02:00:00:00:00:40',
  expires_at: 'infinite',
  is_online: 1,
  address_type: 'dynamic DHCP',
};

function response(data) {
  return Promise.resolve({ data });
}

function installApiFixtures() {
  api.get.mockImplementation((url, config = {}) => {
    if (url === '/subnets')
      return response({
        folders: [{ id: 1, name: 'Testerella', subnets: [subnet, unallocatedSubnet] }],
      });
    if (url === '/dns/zones') return response(zones);
    if (url === '/workspace/networks')
      return response({
        items: config.params?.table_q === 'not returned' ? [] : [subnet],
        total: config.params?.table_q === 'not returned' ? 0 : 1,
      });
    if (url === '/workspace/dns-records' && config.params?.ip_address)
      return response({
        items: [dnsRecordA, dnsRecordPtr, dnsRecordAlias, dnsPlaceholder33].filter(
          (record) => record.ip_address === config.params.ip_address,
        ),
        total: 0,
        page: 1,
        page_size: 50,
      });
    if (url === '/workspace/dns-records')
      return response({
        items:
          dnsRecordsHidden && config.params?.table_q !== 'client'
            ? []
            : [
                {
                  id: 51,
                  zone_id: 21,
                  zone_name: 'test.example',
                  zone_type: 'forward',
                  name: 'client',
                  record_fqdn: 'client.test.example',
                  record_type: 'A',
                  value: '1.1.1.40',
                  ttl: 3600,
                  dns_source: 'manual',
                  enabled: 1,
                  ip_address: '1.1.1.40',
                  is_online: 1,
                  related_subnet_ids: [subnet.id],
                },
                {
                  id: 52,
                  zone_id: 22,
                  zone_name: '1.1.1.in-addr.arpa',
                  zone_type: 'reverse',
                  name: '40',
                  record_type: 'PTR',
                  value: 'client.test.example',
                  ttl: 3600,
                  dns_source: 'dns',
                  enabled: 1,
                  ip_address: '1.1.1.40',
                  is_online: 1,
                  related_subnet_ids: [subnet.id],
                },
              ],
        total: 2,
        page: 1,
        page_size: 256,
      });
    if (url === '/dns/zones/21/records')
      return response([
        {
          id: 51,
          zone_id: 21,
          name: 'client',
          record_type: 'A',
          value: '1.1.1.40',
          ttl: 3600,
          dns_source: 'manual',
          enabled: 1,
          ip_address: '1.1.1.40',
          is_online: 1,
        },
      ]);
    if (url === '/dns/zones/22/records')
      return response([
        {
          id: 52,
          zone_id: 22,
          name: '40',
          record_type: 'PTR',
          value: 'client.test.example',
          ttl: 3600,
          dns_source: 'dns',
          enabled: 1,
          ip_address: '1.1.1.40',
          is_online: 1,
        },
      ]);
    if (url === '/dhcp/scopes') return response([scope]);
    if (url === '/range-types')
      return response([{ id: 8, name: 'Lab equipment', is_system: 0, color: '#14b8a6' }]);
    if (url === '/dhcp/leases') return response([lease]);
    if (url === '/workspace/dhcp-addresses')
      return response({
        items: config.params?.ip_address
          ? [lease].filter((row) => row.ip_address === config.params.ip_address)
          : [lease],
        total: 1,
        page: 1,
        page_size: 256,
      });
    if (url === '/dhcp/scopes/31/addresses')
      return response([
        lease,
        {
          id: 'available:1.1.1.41',
          subnet_id: subnet.id,
          ip_address: '1.1.1.41',
          dhcp_assignment_type: null,
          lease_status: 'available',
          is_online: 0,
        },
      ]);
    if (url === '/subnets/11/ips') {
      let ips = makeIps();
      if (config.params?.showAvailable === 'false')
        ips = ips.filter((row) => row.ip_display_status !== 'available');
      for (const term of [config.params?.search, config.params?.table_search].filter(Boolean)) {
        const query = term.toLowerCase();
        ips = ips.filter((row) =>
          `${row.ip_address} ${row.hostname || ''} ${row.mac_address || ''}`
            .toLowerCase()
            .includes(query),
        );
      }
      const pageSize = Number(config.params?.pageSize) || 256;
      const page = Number(config.params?.page) || 1;
      return response({
        subnet,
        ips: ips.slice((page - 1) * pageSize, page * pageSize),
        ranges,
        totalIps: ips.length,
        filteredTotal: ips.length,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(ips.length / pageSize)),
      });
    }
    if (url === '/subnets/11/summary') return response(summaryStats);
    const single = url.match(/^\/subnets\/11\/ips\/([0-9.]+)$/);
    if (single) {
      if (deletedIps.has(single[1]))
        return Promise.reject({ response: { status: 404, data: { error: 'IP not found' } } });
      return response({ ip: makeIps().find((row) => row.ip_address === single[1]) });
    }
    if (url === '/subnets/11/ips/1.1.1.1/events' || url === '/subnets/11/ips/1.1.1.33/events') {
      return response({
        events: [
          {
            id: 1,
            event_type: 'allocation_changed',
            old_value: 'unassigned',
            new_value: 'reserved',
            source: 'manual',
            created_at: '2026-09-10 12:00:00',
          },
        ],
      });
    }
    throw new Error(`Unexpected GET ${url}`);
  });
  api.put.mockImplementation((url, body) => {
    if (url === '/subnets/11/ips/bulk-allocation') {
      return response({ updated: 2, skipped: 0, ...body });
    }
    if (url === '/subnets/11/ips/1.1.1.33/allocation') {
      reservedIp33 = body.allocation_state === 'reserved';
      subnet.used_count = reservedIp33 ? 6 : 5;
      return response({ ip_address: '1.1.1.33', ...body });
    }
    if (url === '/subnets/11/ips/1.1.1.33/scan-enabled')
      return response({ ip_address: '1.1.1.33', scan_enabled: body.scan_enabled });
    throw new Error(`Unexpected PUT ${url}`);
  });
  api.post.mockImplementation((url) => {
    if (url === '/scans/probe')
      return response({ ip: '1.1.1.33', responded: true, method: 'arp', mac: '02:00:00:00:00:33' });
    throw new Error(`Unexpected POST ${url}`);
  });
}

async function mountPreview(options = {}) {
  const wrapper = mount(NetworksWorkspacePreview, {
    ...options,
    global: {
      directives: { tooltip: () => {} },
      stubs: {
        RouterLink: {
          props: ['to'],
          template: '<a :href="to"><slot /></a>',
        },
        Dialog: {
          props: ['visible'],
          template: '<section v-if="visible"><slot /><slot name="footer" /></section>',
        },
        // The reused NetworkDialogs editors use the vendor input, which needs
        // the PrimeVue plugin; the workspace's own forms use plain inputs.
        InputText: {
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template:
            '<input class="w-full" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        // The vendor paginator needs the PrimeVue plugin; the stub keeps its
        // contract (first/rows/totalRecords in, a page event out).
        Paginator: {
          props: ['first', 'rows', 'totalRecords', 'rowsPerPageOptions'],
          emits: ['page'],
          template:
            '<nav class="p-paginator" :data-first="first" :data-rows="rows" :data-total="totalRecords">' +
            '<button aria-label="Previous Page" :disabled="first === 0" @click="$emit(\'page\', { page: Math.floor(first / rows) - 1, first: first - rows, rows })" />' +
            '<button aria-label="Next Page" :disabled="first + rows >= totalRecords" @click="$emit(\'page\', { page: Math.floor(first / rows) + 1, first: first + rows, rows })" />' +
            '<select aria-label="Rows per page" :value="rows" @change="$emit(\'page\', { page: 0, first: 0, rows: Number($event.target.value) })"><option v-for="size in rowsPerPageOptions" :key="size" :value="size">{{ size }}</option></select>' +
            '</nav>',
        },
      },
    },
  });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

async function enterTestNetwork(wrapper) {
  await wrapper.find('.network-row').trigger('click');
  await flushPromises();
  await flushPromises();
}

describe('Networks workspace live preview', () => {
  it('keeps the preview route as a thin workspace wrapper', () => {
    const wrapper = mount(NetworksWorkspacePreview, {
      global: {
        stubs: {
          NetworksWorkspace: true,
        },
      },
    });

    expect(wrapper.findComponent(NetworksWorkspace).exists()).toBe(true);
  });

  beforeEach(() => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = pinia.state.value;
    auth.auth = {
      user: {
        username: 'admin',
        role: 'admin',
        is_admin: true,
        permissions: ['*'],
      },
    };
    localStorage.clear();
    reservedIp33 = false;
    deletedIps = new Set();
    dnsRecordsHidden = false;
    summaryStats = {
      subnet_id: subnet.id,
      total_addresses: 256,
      assigned_count: subnet.used_count,
      unassigned_count: 256 - subnet.used_count,
      online_count: 1,
      rogue_count: 0,
    };
    subnet.used_count = 5;
    api.get.mockReset();
    api.put.mockReset();
    api.post.mockReset();
    installApiFixtures();
  });

  it('applies a saved explorer query to the first workspace reads', async () => {
    localStorage.setItem(
      'cidrella_workspace_v1_admin',
      JSON.stringify({ q: 'printer', context: 'all', view: 'networks' }),
    );

    await mountPreview();

    const firstNetworkRead = api.get.mock.calls.find(([url]) => url === '/workspace/networks');
    const firstDnsRead = api.get.mock.calls.find(([url]) => url === '/workspace/dns-records');
    const firstDhcpRead = api.get.mock.calls.find(([url]) => url === '/workspace/dhcp-addresses');
    expect(firstNetworkRead[1].params.q).toBe('printer');
    expect(firstDnsRead[1].params.q).toBe('printer');
    expect(firstDhcpRead[1].params.q).toBe('printer');
  });

  it('composes the section 5 presentation boundaries around one orchestrator', async () => {
    // W-01: the explorer, context header, toolbar, table, grid and details
    // host are separate components. The orchestrator owns state; each child
    // only renders what it is handed and emits what the operator did.
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    for (const component of [
      ResourceExplorer,
      WorkspaceContextHeader,
      WorkspaceToolbar,
      WorkspaceTable,
    ]) {
      expect(wrapper.findComponent(component).exists()).toBe(true);
    }
    expect(wrapper.findComponent(AddressGrid).exists()).toBe(false);
    await wrapper.find('button[aria-label="Grid view"]').trigger('click');
    expect(wrapper.findComponent(AddressGrid).props('density')).toBe('spacious');
    expect(wrapper.findComponent(WorkspaceTable).exists()).toBe(false);
    await wrapper.find('button[aria-label="Compact grid view"]').trigger('click');
    expect(wrapper.findComponent(AddressGrid).props('density')).toBe('compact');
    // The pager belongs to the surface, not the table, so it survives the grid.
    expect(wrapper.find('.table-footer .p-paginator').exists()).toBe(true);

    await wrapper.find('button[aria-label="Table view"]').trigger('click');
    await wrapper.find('tbody tr').trigger('click');
    await flushPromises();
    expect(wrapper.findComponent(WorkspaceDetailsHost).props('row')).not.toBeNull();
  });

  it('loads real API data and keeps network context across address, DNS, and DHCP views', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    expect(wrapper.find('.context-header').text()).toContain('Public test network');
    expect(wrapper.find('table').text()).toContain('1.1.1.40');
    expect(wrapper.find('table').text()).toContain('dynamic DHCP');
    expect(wrapper.find('.table-footer').text()).toContain(
      '256 on this page · 256 matching · 256 addresses in network',
    );

    const dnsTab = wrapper
      .findAll('.view-tabs button')
      .find((button) => button.text().includes('DNS'));
    await dnsTab.trigger('click');
    expect(wrapper.find('.context-header').text()).toContain('Public test network');
    expect(wrapper.find('.view-summary').text()).toContain('test.example');
    expect(wrapper.find('table').text()).toContain('client.test.example');

    const dhcpTab = wrapper
      .findAll('.view-tabs button')
      .find((button) => button.text().includes('DHCP'));
    await dhcpTab.trigger('click');
    expect(wrapper.find('.view-summary').text()).toContain('Public test network scope');
    expect(wrapper.find('table').text()).toContain('02:00:00:00:00:40');
    expect(wrapper.find('table').text()).toContain('active');
  });

  it('offers all-network, zone, and scope inventories in the same work surface', async () => {
    const wrapper = await mountPreview();
    expect(wrapper.find('.service-shortcuts').exists()).toBe(false);
    expect(wrapper.find('.estate-row.active').exists()).toBe(true);
    expect(wrapper.find('.context-header').text()).toContain('All Networks');
    expect(wrapper.findAll('.view-tabs button')).toHaveLength(3);
    expect(wrapper.find('table').text()).toContain('Public test network');

    // Was a click on the DNS stat tile. That tile was navigation duplicating
    // the DNS tab, so the tile is a readout now and the tab is the only way in.
    await wrapper
      .findAll('.view-tabs button')
      .find((button) => button.text().includes('DNS'))
      .trigger('click');
    expect(wrapper.find('.context-header').text()).toContain('All Networks');
    expect(wrapper.find('.view-tabs button.active').text()).toContain('DNS');
    expect(wrapper.find('table').text()).toContain('1.1.1.in-addr.arpa');

    await wrapper
      .findAll('.view-tabs button')
      .find((button) => button.text().includes('DHCP'))
      .trigger('click');
    expect(wrapper.find('table').text()).toContain('1.1.1.33 – 1.1.1.126');
    expect(wrapper.find('table').text()).toContain('Public test network');
  });

  it('uses folders as intermediate inventory scopes', async () => {
    const wrapper = await mountPreview();
    await wrapper.find('.folder-select').trigger('click');

    expect(wrapper.find('.folder-row.active').exists()).toBe(true);
    expect(wrapper.find('.context-header').text()).toContain('Testerella');
    expect(wrapper.findAll('.view-tabs button')).toHaveLength(3);

    await wrapper
      .findAll('.view-tabs button')
      .find((button) => button.text().includes('DNS'))
      .trigger('click');
    expect(wrapper.find('table').text()).toContain('test.example');
  });

  it('opens unallocated address space as a functional inventory context', async () => {
    const wrapper = await mountPreview();
    await wrapper.find('button[data-track="workspace-unallocated-select"]').trigger('click');

    expect(wrapper.find('.context-header').text()).toContain('Unallocated Networks');
    expect(wrapper.find('table').text()).toContain('1.1.2.0/24');
    expect(wrapper.find('.network-tree').text()).toContain('1.1.2.0/24');
  });

  it('filters available canonical rows and opens details from a live row', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    expect(wrapper.find('table').text()).toContain('1.1.1.200');

    await wrapper.find('.available-switch input').setValue(false);
    await flushPromises();
    expect(wrapper.find('table').text()).not.toContain('1.1.1.200');
    expect(api.get).toHaveBeenCalledWith(
      '/subnets/11/ips',
      expect.objectContaining({
        params: expect.objectContaining({ showAvailable: 'false' }),
      }),
    );

    const gatewayRow = wrapper.findAll('tbody tr').find((row) => row.text().includes('1.1.1.1'));
    await gatewayRow.trigger('click');
    expect(wrapper.find('.workspace-address-panel').text()).toContain('1.1.1.1');
    // Nothing references the gateway, so no related resources are offered.
    expect(wrapper.find('.workspace-address-panel').text()).not.toContain('RELATED RESOURCES');
  });

  it('builds the address grid from API rows instead of sample cells', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    await wrapper.find('button[aria-label="Grid view"]').trigger('click');

    expect(wrapper.find('.address-grid').exists()).toBe(true);
    expect(wrapper.findAll('.address-grid button')).toHaveLength(256);
    expect(wrapper.find('button[title="1.1.1.1 · gateway"]').exists()).toBe(true);
    expect(wrapper.find('button[title="1.1.1.40 · dynamic DHCP"]').exists()).toBe(true);
    expect(wrapper.find('table').exists()).toBe(false);
  });

  it('offers a dense 64-column compact address grid using the same canonical rows', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    await wrapper.find('button[aria-label="Compact grid view"]').trigger('click');

    expect(wrapper.find('.compact-address-grid').exists()).toBe(true);
    expect(wrapper.findAll('.compact-address-grid button')).toHaveLength(256);
    expect(wrapper.find('button[aria-label="1.1.1.1, gateway"]').exists()).toBe(true);
    expect(wrapper.find('button[aria-label="1.1.1.40, dynamic DHCP"]').exists()).toBe(true);
    expect(wrapper.findAll('.compact-address-grid button.section')).toHaveLength(16);
  });

  it('shares address selection across table and grids and opens the real bulk reservation flow', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    const rowCheckboxes = wrapper.findAll('tbody input[type="checkbox"]');
    await rowCheckboxes[2].setValue(true);
    await rowCheckboxes[3].setValue(true);

    expect(wrapper.find('.selection-bar').text()).toContain('2 selected');
    await wrapper.find('button[aria-label="Compact grid view"]').trigger('click');
    expect(wrapper.findAll('.compact-address-grid button.selected')).toHaveLength(2);

    const reserve = wrapper
      .findAll('.selection-bar button')
      .find((button) => button.text() === 'Reserve');
    await reserve.trigger('click');
    const form = wrapper.find('.bulk-action-form');
    expect(form.text()).toContain('1.1.1.2 through 1.1.1.3');
    await form.find('textarea').setValue('Lab hosts');
    await form.trigger('submit');
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/subnets/11/ips/bulk-allocation', {
      start_ip: '1.1.1.2',
      end_ip: '1.1.1.3',
      allocation_state: 'reserved',
      note: 'Lab hosts',
    });
    expect(wrapper.find('.selection-bar').exists()).toBe(false);
  });

  it('uses the explorer search as a hostname and IP table filter', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    const search = wrapper.find('input[data-track="workspace-global-search"]');

    await search.setValue('client.test.example');
    await new Promise((resolve) => setTimeout(resolve, 320));
    await flushPromises();
    expect(wrapper.findAll('tbody tr')).toHaveLength(1);
    expect(wrapper.find('tbody').text()).toContain('1.1.1.40');
    expect(api.get).toHaveBeenCalledWith(
      '/subnets/11/ips',
      expect.objectContaining({
        params: expect.objectContaining({ search: 'client.test.example' }),
      }),
    );

    await search.setValue('1.1.1.40');
    await new Promise((resolve) => setTimeout(resolve, 320));
    await flushPromises();
    expect(wrapper.findAll('tbody tr')).toHaveLength(1);
    expect(wrapper.find('tbody').text()).toContain('client.test.example');
  });

  it('sends explicit address filters and preserves table search for network inventory', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    await wrapper.find('select[aria-label="Online filter"]').setValue('false');
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith(
      '/subnets/11/ips',
      expect.objectContaining({ params: expect.objectContaining({ online: 'false' }) }),
    );
    expect(wrapper.find('.filter-chips').text()).toContain('online: false');

    await wrapper.find('select[aria-label="Protocol filter"]').setValue('dhcp_lease');
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith(
      '/subnets/11/ips',
      expect.objectContaining({
        params: expect.objectContaining({ allocation_source_type: 'dhcp_lease' }),
      }),
    );

    await wrapper.find('button[data-track="workspace-estate-select"]').trigger('click');
    await wrapper.find('input[aria-label="Search current table"]').setValue('Public');
    await new Promise((resolve) => setTimeout(resolve, 320));
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith(
      '/workspace/networks',
      expect.objectContaining({ params: expect.objectContaining({ table_q: 'Public' }) }),
    );

    await wrapper.find('input[aria-label="Search current table"]').setValue('not returned');
    await new Promise((resolve) => setTimeout(resolve, 320));
    await flushPromises();
    expect(wrapper.findAll('tbody tr')).toHaveLength(0);
  });

  it('opens zone and scope inventories as URL-backed drill-ins', async () => {
    const wrapper = await mountPreview();
    await wrapper
      .findAll('.view-tabs button')
      .find((button) => button.text().includes('DNS'))
      .trigger('click');
    await wrapper.find('tbody tr').trigger('click');
    await wrapper
      .findAll('.quick-actions button')
      .find((button) => button.text() === 'Open zone')
      .trigger('click');
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith(
      '/workspace/dns-records',
      expect.objectContaining({ params: expect.objectContaining({ zone_id: 21 }) }),
    );
    expect(JSON.parse(localStorage.getItem('cidrella_workspace_v1_admin'))).toMatchObject({
      view: 'dns',
      zone: '21',
    });
    expect(wrapper.find('tbody').text()).toContain('client.test.example');

    await wrapper
      .findAll('.view-tabs button')
      .find((button) => button.text().includes('DHCP'))
      .trigger('click');
    await wrapper.find('tbody tr').trigger('click');
    await wrapper
      .findAll('.quick-actions button')
      .find((button) => button.text() === 'Open scope')
      .trigger('click');
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith(
      '/workspace/dhcp-addresses',
      expect.objectContaining({ params: expect.objectContaining({ scope_id: 31 }) }),
    );
    expect(JSON.parse(localStorage.getItem('cidrella_workspace_v1_admin'))).toMatchObject({
      view: 'dhcp',
      scope: '31',
    });
  });

  it('opens related resources inside the details panel, never by switching the view', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    const rowFor = (ip) => wrapper.findAll('tbody tr').find((row) => row.text().includes(ip));

    // No DNS record or DHCP row references 1.1.1.33: nothing to offer.
    await rowFor('1.1.1.33').trigger('click');
    await flushPromises();
    expect(wrapper.find('.workspace-address-panel').text()).not.toContain('RELATED RESOURCES');
    expect(wrapper.findAll('.related-button')).toHaveLength(0);

    // 1.1.1.40 has two DNS records and one DHCP row.
    await rowFor('1.1.1.40').trigger('click');
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith(
      '/workspace/dns-records',
      expect.objectContaining({ params: expect.objectContaining({ ip_address: '1.1.1.40' }) }),
    );
    expect(api.get).toHaveBeenCalledWith(
      '/workspace/dhcp-addresses',
      expect.objectContaining({ params: expect.objectContaining({ ip_address: '1.1.1.40' }) }),
    );
    const related = wrapper.findAll('.related-button');
    expect(related.map((button) => button.find('strong').text())).toEqual([
      'DNS records',
      'DHCP identity',
    ]);
    expect(related[0].text()).toContain('3 records reference this address');

    await related[0].trigger('click');
    await flushPromises();
    expect(wrapper.find('.view-tabs button.active').text()).toContain('Addresses');
    expect(wrapper.find('.workspace-address-panel').exists()).toBe(false);
    const panel = wrapper.find('.details-panel');
    expect(panel.text()).toContain('DNS record');
    expect(panel.text()).toContain('client');
    expect(panel.text()).toContain('1.1.1.40');
    const links = () => panel.findAll('.details-section button').map((button) => button.text());
    // Back to the IP, the two sibling records, and the DHCP side.
    expect(links().slice(0, 4)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Canonical IP record'),
        expect.stringContaining('PTR record for the same address'),
        expect.stringContaining('CNAME record for the same address'),
        expect.stringContaining('DHCP identity'),
      ]),
    );

    await panel
      .findAll('.details-section button')
      .find((button) => button.text().includes('PTR record'))
      .trigger('click');
    await flushPromises();
    expect(wrapper.find('.details-panel').text()).toContain('40');
    expect(wrapper.find('.view-tabs button.active').text()).toContain('Addresses');

    await wrapper
      .find('.details-panel')
      .findAll('.details-section button')
      .find((button) => button.text().includes('DHCP identity'))
      .trigger('click');
    await flushPromises();
    expect(wrapper.find('.details-panel').text()).toContain('DHCP address');

    await wrapper
      .find('.details-panel')
      .findAll('.details-section button')
      .find((button) => button.text().includes('Canonical IP record'))
      .trigger('click');
    await flushPromises();
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/subnets/11/ips/1.1.1.40');
    expect(wrapper.find('.workspace-address-panel').text()).toContain('1.1.1.40');
    expect(wrapper.find('.view-tabs button.active').text()).toContain('Addresses');
  });

  it('keeps the pinned address open by identity when the page no longer holds it', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    await wrapper
      .findAll('tbody tr')
      .find((row) => row.text().includes('1.1.1.33'))
      .trigger('click');
    expect(wrapper.find('.workspace-address-panel').text()).toContain('1.1.1.33');

    await wrapper.find('input[aria-label="Search current table"]').setValue('1.1.1.40');
    await new Promise((resolve) => setTimeout(resolve, 320));
    await flushPromises();

    expect(wrapper.findAll('tbody tr')).toHaveLength(1);
    expect(api.get).toHaveBeenCalledWith('/subnets/11/ips/1.1.1.33');
    expect(wrapper.find('.workspace-address-panel').text()).toContain('1.1.1.33');
  });

  it('closes the details panel with a notice when the pinned resource is gone', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    await wrapper
      .findAll('tbody tr')
      .find((row) => row.text().includes('1.1.1.33'))
      .trigger('click');
    deletedIps.add('1.1.1.33');

    await wrapper.find('input[aria-label="Search current table"]').setValue('1.1.1.40');
    await new Promise((resolve) => setTimeout(resolve, 320));
    await flushPromises();

    expect(wrapper.find('.workspace-address-panel').exists()).toBe(false);
    expect(wrapper.find('.prototype-notice').text()).toContain('no longer available');
  });

  it('re-reads a pinned DNS record by zone and id when it leaves the page', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    await wrapper
      .findAll('.view-tabs button')
      .find((button) => button.text().includes('DNS'))
      .trigger('click');
    await flushPromises();
    await wrapper
      .findAll('tbody tr')
      .find((row) => row.text().includes('client'))
      .trigger('click');
    expect(wrapper.find('.details-panel').text()).toContain('DNS record');

    dnsRecordsHidden = true;
    api.get.mockClear();
    await wrapper.find('input[aria-label="Search current table"]').setValue('nothing');
    await new Promise((resolve) => setTimeout(resolve, 320));
    await flushPromises();

    expect(wrapper.findAll('tbody tr')).toHaveLength(0);
    expect(api.get).toHaveBeenCalledWith(
      '/workspace/dns-records',
      expect.objectContaining({
        params: expect.objectContaining({ zone_id: 21, subnet_id: 11, table_q: 'client' }),
      }),
    );
    expect(wrapper.find('.details-panel').text()).toContain('client');
  });

  it('creates and releases an IP Reservation while preserving address context', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    const addressRow = wrapper.findAll('tbody tr').find((row) => row.text().includes('1.1.1.33'));
    await addressRow.trigger('click');

    await wrapper.find('button[data-track="workspace-create-ip-reservation"]').trigger('click');
    await wrapper.find('#workspace-reservation-note').setValue('Hold for printer');
    await wrapper.find('.inline-action').trigger('submit');
    await flushPromises();
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/subnets/11/ips/1.1.1.33/allocation', {
      allocation_state: 'reserved',
      note: 'Hold for printer',
    });
    expect(wrapper.find('.workspace-address-panel').text()).toContain('IP Reservation');
    expect(wrapper.find('button[data-track="workspace-release-ip-reservation"]').exists()).toBe(
      true,
    );

    await wrapper.find('button[data-track="workspace-release-ip-reservation"]').trigger('click');
    await wrapper.find('.confirm-action button.danger').trigger('click');
    await flushPromises();
    await flushPromises();

    expect(api.put).toHaveBeenLastCalledWith('/subnets/11/ips/1.1.1.33/allocation', {
      allocation_state: 'unassigned',
      note: null,
    });
    expect(wrapper.find('button[data-track="workspace-create-ip-reservation"]').exists()).toBe(
      true,
    );
  });

  it('re-reads shared inventories, drops the old cache and reports refresh failures after a save', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    const store = useSubnetStore();
    const invalidate = vi.spyOn(store, 'invalidateDetailCache');
    const statsChanged = vi.fn();
    globalThis.window.addEventListener('ipam:stats-changed', statsChanged);
    const calls = () => api.get.mock.calls.map(([url]) => url);

    await wrapper
      .findAll('tbody tr')
      .find((row) => row.text().includes('1.1.1.33'))
      .trigger('click');
    await wrapper.find('button[data-track="workspace-create-ip-reservation"]').trigger('click');
    await wrapper.find('#workspace-reservation-note').setValue('Hold for printer');
    api.get.mockClear();
    await wrapper.find('.inline-action').trigger('submit');
    await flushPromises();
    await flushPromises();

    // IP Reservation: tree (utilization), scope counts, the address page,
    // summary and the pinned address. Zones are untouched by an allocation.
    expect(calls()).toEqual(
      expect.arrayContaining([
        '/subnets',
        '/dhcp/scopes',
        '/subnets/11/ips',
        '/subnets/11/summary',
      ]),
    );
    expect(calls()).not.toContain('/dns/zones');
    expect(invalidate).toHaveBeenCalledWith(11);
    expect(statsChanged).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.prototype-notice').text()).toBe('WorkspaceIP Reservation created');

    // A DNS change re-reads zones as well and clears the whole old cache.
    api.get.mockClear();
    wrapper.findComponent(NetworksWorkspace).vm.refreshAfterMutation('dns', 'DNS record saved');
    await flushPromises();
    await flushPromises();
    expect(calls()).toEqual(expect.arrayContaining(['/subnets', '/dns/zones', '/subnets/11/ips']));
    expect(invalidate).toHaveBeenLastCalledWith(undefined);
    expect(statsChanged).toHaveBeenCalledTimes(2);

    // Saved but the follow-up read failed: say so, keep the page, offer Retry.
    api.get.mockImplementationOnce(() => Promise.reject(new Error('tree offline')));
    wrapper.findComponent(NetworksWorkspace).vm.refreshAfterMutation('address', 'Released');
    await flushPromises();
    await flushPromises();
    expect(wrapper.find('.prototype-notice').text()).toContain('Released. Saved; refresh failed');
    expect(wrapper.find('.prototype-notice').text()).toContain('tree offline');
    expect(wrapper.findAll('tbody tr').length).toBeGreaterThan(0);
    api.get.mockClear();
    await wrapper.find('.prototype-notice button').trigger('click');
    await flushPromises();
    await flushPromises();
    expect(calls()).toContain('/subnets');
    expect(wrapper.find('.prototype-notice').text()).toBe('WorkspaceLive data refreshed.');
    globalThis.window.removeEventListener('ipam:stats-changed', statsChanged);
  });

  it('carries the last zone choice to the next network on the DNS view', async () => {
    const sibling = {
      id: 13,
      cidr: '1.1.0.0/24',
      name: 'Sibling test network',
      status: 'allocated',
      total_addresses: 256,
      used_count: 1,
      children: [],
    };
    const siblingReverse = {
      id: 23,
      name: '0.1.1.in-addr.arpa',
      type: 'reverse',
      enabled: 1,
      record_count: 1,
      subnet_id: 13,
      related_subnet_ids: [13],
    };
    const base = api.get.getMockImplementation();
    api.get.mockImplementation((url, config) => {
      if (url === '/subnets')
        return response({
          folders: [{ id: 1, name: 'Testerella', subnets: [subnet, sibling, unallocatedSubnet] }],
        });
      if (url === '/dns/zones')
        return response([
          { ...zones[0], related_subnet_ids: [subnet.id, 13] },
          zones[1],
          siblingReverse,
        ]);
      return base(url, config);
    });
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    await wrapper.find('[data-track="workspace-tab-dns"]').trigger('click');
    await flushPromises();
    // The table read, not the one-row count read that follows it.
    const lastDnsParams = () =>
      api.get.mock.calls
        .filter(([url, config]) => url === '/workspace/dns-records' && config.params.sort_order)
        .at(-1)[1].params;
    const selectSibling = async () => {
      await wrapper
        .findAll('.network-row')
        .find((row) => row.text().includes('Sibling'))
        .trigger('click');
      await flushPromises();
      await flushPromises();
    };
    const clickCard = async (side) => {
      await wrapper
        .findAll('.linked-card')
        .find((card) => card.text().includes(side))
        .trigger('click');
      await flushPromises();
      await flushPromises();
    };
    const selectFirst = async () => {
      await wrapper.find('.network-row').trigger('click');
      await flushPromises();
      await flushPromises();
    };

    // Mixed record list by default, no zone in the request.
    expect(lastDnsParams().zone_id).toBeUndefined();

    // Open the forward zone, then move to the sibling: its forward zone opens.
    await clickCard('forward');
    expect(lastDnsParams()).toMatchObject({ subnet_id: 11, zone_id: 21 });
    expect(localStorage.getItem('cidrella_workspace_dns_zone_side')).toBe('"forward"');
    await selectSibling();
    expect(lastDnsParams()).toMatchObject({ subnet_id: 13, zone_id: 21 });
    expect(wrapper.find('.view-summary h3').text()).toBe('test.example');

    // The reverse side follows the network: each has its own reverse zone.
    await clickCard('reverse');
    expect(lastDnsParams()).toMatchObject({ subnet_id: 13, zone_id: 23 });
    await selectFirst();
    expect(lastDnsParams()).toMatchObject({ subnet_id: 11, zone_id: 22 });
    expect(localStorage.getItem('cidrella_workspace_dns_zone_side')).toBe('"reverse"');

    // Clearing the zone is remembered too: the next network shows everything.
    await clickCard('reverse');
    expect(lastDnsParams().zone_id).toBeUndefined();
    await selectSibling();
    expect(lastDnsParams()).toMatchObject({ subnet_id: 13 });
    expect(lastDnsParams().zone_id).toBeUndefined();
    expect(localStorage.getItem('cidrella_workspace_dns_zone_side')).toBe('""');

    // Leaving the DNS view still resets the choice for that view's filters.
    await wrapper.find('[data-track="workspace-tab-addresses"]').trigger('click');
    await flushPromises();
    await selectFirst();
    expect(wrapper.find('.workspace-frame').exists()).toBe(true);
  });

  it('merges and re-templates checked networks from the selection bar', async () => {
    const sibling = {
      id: 13,
      cidr: '1.1.0.0/24',
      name: 'Sibling test network',
      status: 'allocated',
      total_addresses: 256,
      used_count: 1,
      children: [],
    };
    const base = api.get.getMockImplementation();
    api.get.mockImplementation((url, config) =>
      url === '/subnets'
        ? response({
            folders: [{ id: 1, name: 'Testerella', subnets: [subnet, sibling, unallocatedSubnet] }],
          })
        : base(url, config),
    );
    api.post.mockImplementation((url, body) => {
      if (url === '/subnets/merge/preview')
        return response({
          source_cidrs: ['1.1.0.0/24', '1.1.1.0/24'],
          merged_cidr: '1.1.0.0/23',
          plan: {},
        });
      if (url === '/subnets/apply-template') return response({ updated: body.subnet_ids });
      throw new Error(`Unexpected POST ${url}`);
    });
    const wrapper = await mountPreview();
    const checkboxes = wrapper.findAll('tbody input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);

    // One network: Merge stays visible but disabled with its reason.
    await checkboxes[0].setValue(true);
    let bar = wrapper.find('.selection-bar');
    const merge = () => bar.findAll('button').find((button) => button.text() === 'Merge');
    expect(bar.text()).toContain('1 selected');
    expect(merge().attributes('disabled')).toBeDefined();
    expect(merge().attributes('title')).toContain('two');
    expect(bar.text()).not.toContain('Reserve');

    await checkboxes[1].setValue(true);
    bar = wrapper.find('.selection-bar');
    expect(merge().attributes('disabled')).toBeUndefined();
    await merge().trigger('click');
    await flushPromises();
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/subnets/merge/preview', { subnet_ids: [11, 13] });
    expect(wrapper.text()).toContain('1.1.0.0/23');

    await bar
      .findAll('button')
      .find((button) => button.text() === 'Apply defaults')
      .trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/subnets/apply-template', { subnet_ids: [11, 13] });
  });

  it('opens folder actions from the explorer row and carries the description into rename', async () => {
    const base = api.get.getMockImplementation();
    api.get.mockImplementation((url, config) =>
      url === '/subnets'
        ? response({
            folders: [
              { id: 1, name: 'Testerella', description: 'Lab racks', subnets: [subnet] },
              { id: null, name: 'Ungrouped', description: null, subnets: [unallocatedSubnet] },
            ],
          })
        : base(url, config),
    );
    const wrapper = await mountPreview();
    const menuButtons = wrapper.findAll('.row-menu-button');
    expect(menuButtons.map((button) => button.attributes('aria-label'))).toEqual([
      'Testerella folder actions',
      'Ungrouped folder actions',
    ]);

    await menuButtons[1].trigger('click');
    expect(wrapper.find('.row-menu span').text()).toBe('FOLDER ACTIONS');
    expect(wrapper.findAll('.row-menu button strong').map((label) => label.text())).toEqual([
      'Allocate network',
    ]);
    await wrapper.find('.menu-scrim').trigger('click');

    await menuButtons[0].trigger('click');
    expect(wrapper.findAll('.row-menu button strong').map((label) => label.text())).toEqual([
      'Allocate network',
      'Rename folder',
      'Delete folder',
    ]);
    await wrapper
      .findAll('.row-menu button')
      .find((button) => button.text() === 'Rename folder')
      .trigger('click');
    await flushPromises();
    await flushPromises();
    const inputs = wrapper.findAll('input.w-full');
    expect(inputs.map((input) => input.element.value)).toEqual(['Testerella', 'Lab racks']);

    // The folder context header targets the folder too.
    await wrapper.find('.folder-select').trigger('click');
    await flushPromises();
    await wrapper
      .findAll('.context-actions button')
      .find((button) => button.text().startsWith('Actions'))
      .trigger('click');
    expect(wrapper.find('.actions-menu span').text()).toBe('FOLDER ACTIONS');
    expect(wrapper.findAll('.actions-menu button strong').map((label) => label.text())).toEqual([
      'Allocate network',
      'Rename folder',
      'Delete folder',
    ]);
  });

  it('moves a network dropped on an explorer folder through the same PUT as the row menu', async () => {
    const base = api.get.getMockImplementation();
    api.get.mockImplementation((url, config) =>
      url === '/subnets'
        ? response({
            folders: [
              { id: 1, name: 'Testerella', description: 'Lab racks', subnets: [subnet] },
              { id: null, name: 'Ungrouped', description: null, subnets: [unallocatedSubnet] },
            ],
          })
        : base(url, config),
    );
    const basePut = api.put.getMockImplementation();
    api.put.mockImplementation((url, body) =>
      url === '/subnets/11' ? response({ id: 11, ...body }) : basePut(url, body),
    );
    const wrapper = await mountPreview();
    // The old store's PUT re-reads the tree itself; the zone read only comes
    // from the workspace's network refresh contract.
    const zoneReads = () =>
      api.get.mock.calls.filter(([url]) => url.startsWith('/dns/zones')).length;
    const readsBefore = zoneReads();

    // A fake DataTransfer: jsdom has no DragEvent, so the events are plain
    // Events carrying the same fields the browser would.
    const dataTransfer = {
      data: {},
      types: [],
      effectAllowed: null,
      dropEffect: null,
      setData(type, value) {
        this.data[type] = value;
        this.types.push(type);
      },
      getData(type) {
        return this.data[type] ?? '';
      },
    };
    const dispatch = (element, type) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      event.dataTransfer = dataTransfer;
      element.dispatchEvent(event);
      return event;
    };

    const networkRow = wrapper.find('.network-row');
    expect(networkRow.attributes('draggable')).toBe('true');
    dispatch(networkRow.element, 'dragstart');
    expect(dataTransfer.getData('application/x-subnet-id')).toBe('11');
    expect(dataTransfer.effectAllowed).toBe('move');

    const [homeFolder, ungrouped] = wrapper.findAll('.folder-row');
    const over = dispatch(ungrouped.element, 'dragover');
    await nextTick();
    expect(over.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe('move');
    expect(ungrouped.classes()).toContain('drop-target');

    const drop = dispatch(ungrouped.element, 'drop');
    await flushPromises();
    await flushPromises();
    expect(drop.defaultPrevented).toBe(true);
    expect(ungrouped.classes()).not.toContain('drop-target');
    expect(api.put).toHaveBeenCalledWith('/subnets/11', { folder_id: null });
    expect(wrapper.find('.prototype-notice').text()).toContain('1.1.1.0/24 moved to Ungrouped');
    expect(zoneReads()).toBeGreaterThan(readsBefore);

    // Dropping on the folder it already lives in is a no-op.
    const putCalls = api.put.mock.calls.length;
    dispatch(homeFolder.element, 'dragover');
    dispatch(homeFolder.element, 'drop');
    await flushPromises();
    expect(api.put.mock.calls.length).toBe(putCalls);

    // The networks table row carries the same payload.
    dataTransfer.data = {};
    dataTransfer.types = [];
    const tableRow = wrapper.find('tbody tr');
    expect(tableRow.attributes('draggable')).toBe('true');
    dispatch(tableRow.element, 'dragstart');
    expect(dataTransfer.getData('application/x-subnet-id')).toBe('11');

    // A drag that carries no network never marks a folder as a drop target.
    dataTransfer.types = [];
    const plain = dispatch(ungrouped.element, 'dragover');
    await nextTick();
    expect(plain.defaultPrevented).toBe(false);
    expect(ungrouped.classes()).not.toContain('drop-target');
  });

  it('offers no network drag without subnets:write', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    pinia.state.value.auth = {
      user: {
        username: 'viewer',
        role: 'readonly',
        is_admin: false,
        permissions: ['subnets:read'],
      },
    };
    const wrapper = await mountPreview();
    expect(wrapper.find('.network-row').attributes('draggable')).toBeUndefined();
    expect(wrapper.find('tbody tr').attributes('draggable')).toBeUndefined();
  });

  it('opens context menus where they were asked for', async () => {
    const wrapper = await mountPreview({ attachTo: globalThis.document.body });
    // Right-click on an explorer network: the menu sits at the pointer.
    await wrapper.find('.network-row').trigger('contextmenu', { clientX: 240, clientY: 310 });
    await nextTick();
    expect(wrapper.find('.row-menu').attributes('style')).toContain('top: 310px');
    expect(wrapper.find('.row-menu').attributes('style')).toContain('left: 240px');
    await wrapper.find('.menu-scrim').trigger('click');

    // Right-click on a table row opens that row's menu at the pointer too.
    await enterTestNetwork(wrapper);
    const scopeRow = wrapper.findAll('tbody tr').find((row) => row.text().includes('1.1.1.50'));
    await scopeRow.trigger('contextmenu', { clientX: 400, clientY: 500 });
    await nextTick();
    expect(wrapper.find('.row-menu').attributes('style')).toContain('top: 500px');
    expect(wrapper.find('.row-menu').text()).toContain('Edit Scope');
    await wrapper.find('.menu-scrim').trigger('click');

    // A row's menu button anchors the menu under the button.
    const button = wrapper.find('button[aria-label="Row actions"]');
    button.element.getBoundingClientRect = () => ({ left: 600, bottom: 420, top: 400, right: 630 });
    await button.trigger('click');
    await nextTick();
    expect(wrapper.find('.row-menu').attributes('style')).toContain('top: 424px');
    expect(wrapper.find('.row-menu').attributes('style')).toContain('left: 600px');
    await wrapper.find('.menu-scrim').trigger('click');

    // A pointer near the edge is pulled back inside the viewport.
    await wrapper.find('.network-row').trigger('contextmenu', { clientX: 5000, clientY: 5000 });
    await nextTick();
    await nextTick();
    const style = wrapper.find('.row-menu').attributes('style');
    const top = Number(style.match(/top: (\d+)px/)[1]);
    const left = Number(style.match(/left: (\d+)px/)[1]);
    expect(top).toBeLessThanOrEqual(globalThis.innerHeight);
    expect(left).toBeLessThanOrEqual(globalThis.innerWidth);
    wrapper.unmount();
  });

  it('drives every menu through the action registry with a row-derived target', async () => {
    const wrapper = await mountPreview();
    // No network is selected, so there is no target for the network actions.
    expect(wrapper.find('.context-actions').text()).not.toContain('Actions');

    await enterTestNetwork(wrapper);
    const scopeMember = wrapper.findAll('tbody tr').find((row) => row.text().includes('1.1.1.50'));
    await scopeMember.find('button[aria-label="Row actions"]').trigger('click');
    const menu = wrapper.find('.row-menu');
    expect(menu.findAll('button').map((button) => button.text())).toEqual([
      'Edit Scope',
      'Remove this IP from Scope',
      'Delete Scope',
      'Create IP Reservation',
      'Create DHCP Reservation',
      'Set Range Type',
      'Disable liveness scan',
      'Probe now',
    ]);
    // One separator, above Probe now, which closes the menu.
    const separators = menu.findAll('[role="separator"]');
    expect(separators).toHaveLength(1);
    expect(separators[0].element.nextElementSibling.textContent).toContain('Probe now');
    expect(wrapper.find('.table-toolbar').text()).not.toContain('Reserve address');

    await menu
      .findAll('button')
      .find((button) => button.text() === 'Create IP Reservation')
      .trigger('click');
    await flushPromises();
    expect(wrapper.find('.row-menu').exists()).toBe(false);
    const editor = wrapper.findComponent(IpReservationEditor);
    expect(editor.exists()).toBe(true);
    expect(editor.props()).toMatchObject({ address: '1.1.1.50', mode: 'reserve', visible: true });

    // The header Actions menu targets the selected network.
    await wrapper
      .findAll('.context-actions button')
      .find((button) => button.text().startsWith('Actions'))
      .trigger('click');
    expect(wrapper.findAll('.actions-menu button strong').map((label) => label.text())).toEqual([
      'Edit network',
      'Divide network',
      'Move to folder',
      'Apply defaults',
      'Deallocate network',
      'Delete network',
    ]);
  });

  it('opens menus to the keyboard and returns focus to the invoker', async () => {
    const wrapper = await mountPreview({ attachTo: globalThis.document.body });
    await enterTestNetwork(wrapper);
    const rowButton = wrapper
      .findAll('tbody tr')
      .find((row) => row.text().includes('1.1.1.50'))
      .find('button[aria-label="Row actions"]');
    rowButton.element.focus();
    await rowButton.trigger('click');
    await flushPromises();

    const items = wrapper.findAll('.row-menu [role="menuitem"]');
    expect(globalThis.document.activeElement).toBe(items[0].element);
    await wrapper.find('.row-menu').trigger('keydown', { key: 'ArrowDown' });
    expect(globalThis.document.activeElement).toBe(items[1].element);
    await wrapper.find('.row-menu').trigger('keydown', { key: 'End' });
    expect(globalThis.document.activeElement).toBe(items.at(-1).element);

    globalThis.window.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(wrapper.find('.row-menu').exists()).toBe(false);
    expect(globalThis.document.activeElement).toBe(rowButton.element);

    // The grid reaches the same menu from the keyboard.
    await wrapper.find('button[aria-label="Grid view"]').trigger('click');
    await flushPromises();
    const cell = wrapper.find('.address-grid button[tabindex="0"]');
    cell.element.focus();
    await cell.trigger('keydown', { key: 'F10', shiftKey: true });
    await flushPromises();
    expect(wrapper.find('.row-menu').exists()).toBe(true);
    expect(globalThis.document.activeElement).toBe(
      wrapper.find('.row-menu [role="menuitem"]').element,
    );
    globalThis.window.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(globalThis.document.activeElement).toBe(cell.element);
    wrapper.unmount();
  });

  it('operates table rows from the keyboard', async () => {
    const wrapper = await mountPreview({ attachTo: globalThis.document.body });
    await enterTestNetwork(wrapper);
    const rows = wrapper.findAll('tbody tr');
    rows[0].element.focus();
    await rows[0].trigger('keydown', { key: 'ArrowDown' });
    expect(globalThis.document.activeElement).toBe(rows[1].element);

    await rows[1].trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.find('.workspace-address-panel').text()).toContain(rows[1].text().slice(0, 7));
    expect(rows[1].attributes('aria-selected')).toBe('true');

    await rows[1].trigger('keydown', { key: ' ' });
    expect(rows[1].find('input[type="checkbox"]').element.checked).toBe(true);

    await rows[1].trigger('keydown', { key: 'F10', shiftKey: true });
    await flushPromises();
    expect(wrapper.find('.row-menu').exists()).toBe(true);
    globalThis.window.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(globalThis.document.activeElement).toBe(rows[1].element);
    wrapper.unmount();
  });

  it('applies the shared small-text size set from the header user menu', async () => {
    const wrapper = await mountPreview();
    expect(wrapper.find('.preview-banner').exists()).toBe(false);
    expect(wrapper.find('.workspace-preview').attributes('style')).toContain(
      '--workspace-font-bump: 1.333px',
    );
    const { resize, fontBump } = useWorkspaceFontBump();
    resize(1);
    await nextTick();
    expect(wrapper.find('.workspace-preview').attributes('style')).toContain(
      '--workspace-font-bump: 2.666px',
    );
    expect(localStorage.getItem('cidrella_workspace_font_bump')).toBe('2');
    resize(1);
    expect(fontBump.value).toBe(2);
    resize(-1);
  });

  it('uses tab semantics, one main landmark, and reflows for open details (W-07)', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    expect(wrapper.find('main').exists()).toBe(false);
    expect(wrapper.find('.work-surface').attributes('aria-label')).toBe('Work surface');
    const tabs = wrapper.findAll('[role="tablist"] [role="tab"]');
    expect(tabs.length).toBeGreaterThan(2);
    expect(tabs.filter((tab) => tab.attributes('aria-selected') === 'true')).toHaveLength(1);
    expect(wrapper.find('.workspace-frame').classes()).not.toContain('details-open');
    await wrapper
      .findAll('tbody tr')
      .find((row) => row.text().includes('1.1.1.33'))
      .trigger('click');
    expect(wrapper.find('.workspace-frame').classes()).toContain('details-open');
    await wrapper.find('button[aria-label="Close details"]').trigger('click');
    expect(wrapper.find('.workspace-frame').classes()).not.toContain('details-open');
  });

  it('closes the details on an outside press and swaps rows in place', async () => {
    const wrapper = await mountPreview({ attachTo: globalThis.document.body });
    await enterTestNetwork(wrapper);
    const rowFor = (ip) => wrapper.findAll('tbody tr').find((row) => row.text().includes(ip));
    const press = (element) =>
      element.dispatchEvent(new globalThis.Event('pointerdown', { bubbles: true }));

    await rowFor('1.1.1.33').trigger('click');
    const panel = wrapper.findComponent(AddressDetailsPanel);
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain('1.1.1.33');
    // A remount would produce a fresh element without this marker.
    panel.element.dataset.mounted = 'first';

    // A press on another row is not "outside": the same panel shows the new
    // address without unmounting, so nothing slides.
    press(rowFor('1.1.1.34').element);
    await nextTick(); // the browser renders between pointerdown and click
    await rowFor('1.1.1.34').trigger('click');
    await flushPromises();
    const swapped = wrapper.findComponent(AddressDetailsPanel);
    expect(swapped.element.dataset.mounted).toBe('first');
    expect(swapped.text()).toContain('1.1.1.34');
    expect(wrapper.find('.workspace-frame').classes()).toContain('details-open');

    // Presses inside the panel and on layered UI keep it open.
    press(wrapper.find('.workspace-address-panel').element);
    await flushPromises();
    expect(wrapper.find('.workspace-frame').classes()).toContain('details-open');
    const dialog = globalThis.document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    globalThis.document.body.append(dialog);
    press(dialog);
    await flushPromises();
    expect(wrapper.find('.workspace-frame').classes()).toContain('details-open');

    // Anywhere else closes it and drops the address from the route.
    press(wrapper.find('.context-header h2').element);
    await flushPromises();
    expect(wrapper.find('.workspace-frame').classes()).not.toContain('details-open');
    expect(wrapper.findComponent(AddressDetailsPanel).exists()).toBe(false);

    wrapper.unmount();
    dialog.remove();
    // Unmounted workspaces stop listening.
    press(globalThis.document.body);
  });

  it('pages every table through the shared paginator', async () => {
    const wrapper = await mountPreview();
    // Aggregate lists page in the browser: the paginator knows their length.
    expect(wrapper.find('.p-paginator').attributes('data-total')).toBe('1');
    expect(wrapper.find('.p-paginator').attributes('data-rows')).toBe('256');

    await enterTestNetwork(wrapper);
    const ipsCalls = () => api.get.mock.calls.filter(([url]) => url === '/subnets/11/ips');
    expect(wrapper.find('.p-paginator').attributes('data-total')).toBe('256');

    // Rows per page reloads from page 1 with the new size.
    await wrapper.find('.p-paginator select').setValue('128');
    await flushPromises();
    await flushPromises();
    expect(ipsCalls().at(-1)[1].params).toMatchObject({ page: 1, pageSize: 128 });
    expect(wrapper.find('.p-paginator').attributes('data-rows')).toBe('128');

    // Next page asks the API for page 2 and the paginator follows.
    await wrapper.find('.p-paginator button[aria-label="Next Page"]').trigger('click');
    await flushPromises();
    await flushPromises();
    expect(ipsCalls().at(-1)[1].params).toMatchObject({ page: 2, pageSize: 128 });
    expect(wrapper.find('.p-paginator').attributes('data-first')).toBe('128');

    // The loading state is a popover over the table, not a bar above it.
    expect(wrapper.find('.loading-bar').exists()).toBe(false);
  });

  it('renders type and status with the current interface tags, in use neutral', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    const rowFor = (ip) => wrapper.findAll('tbody tr').find((row) => row.text().includes(ip));
    const lease = rowFor('1.1.1.40');
    expect(lease.find('.address-type-pill.type-dynamic-dhcp').text()).toBe('dynamic DHCP');
    expect(lease.find('.status-pill').classes()).toContain('status-in-use');
    expect(lease.find('.status-pill').classes()).not.toContain('type-rogue');
    const rogue = rowFor('1.1.1.0');
    expect(rogue.find('.address-type-pill.type-system').text()).toBe('system');
    expect(rowFor('1.1.1.50').find('.status-pill').classes()).toContain('status-dhcp-scope');
    expect(rowFor('1.1.1.200').find('.status-pill').classes()).toContain('status-available');
    expect(wrapper.find('.table-pill').exists()).toBe(false);
    expect(wrapper.find('.type-value').exists()).toBe(false);

    await wrapper.find('[data-track="workspace-tab-dhcp"]').trigger('click');
    await flushPromises();
    const dhcpRow = wrapper.findAll('tbody tr').find((row) => row.text().includes('1.1.1.40'));
    expect(dhcpRow.find('.address-type-pill.type-dynamic-dhcp').text()).toBe('Dynamic');
    expect(dhcpRow.find('.status-pill.status-active').exists()).toBe(true);
  });

  it('toggles the liveness scan from the row menu and offers Reset to Inherit', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    const row = wrapper.findAll('tbody tr').find((entry) => entry.text().includes('1.1.1.33'));
    await row.find('button[aria-label="Row actions"]').trigger('click');
    let labels = wrapper.findAll('.row-menu button').map((button) => button.text());
    expect(labels).toContain('Disable liveness scan');
    expect(labels).not.toContain('Reset to Inherit');
    await wrapper
      .findAll('.row-menu button')
      .find((button) => button.text() === 'Disable liveness scan')
      .trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/subnets/11/ips/1.1.1.33/scan-enabled', {
      scan_enabled: false,
    });
    expect(wrapper.find('.prototype-notice').text()).toContain('liveness scan disabled');

    // With an override in place the menu also offers Reset to Inherit.
    const base = api.get.getMockImplementation();
    api.get.mockImplementation((url, config) => {
      if (url === '/subnets/11/ips') {
        return base(url, config).then((response) => {
          response.data.ips = response.data.ips.map((ip) =>
            ip.ip_address === '1.1.1.33' ? { ...ip, scan_enabled: 0, scanning_enabled: false } : ip,
          );
          return response;
        });
      }
      return base(url, config);
    });
    await wrapper.find('input[aria-label="Search current table"]').setValue('1.1.1.33');
    await new Promise((resolve) => setTimeout(resolve, 320));
    await flushPromises();
    await wrapper.find('tbody tr button[aria-label="Row actions"]').trigger('click');
    labels = wrapper.findAll('.row-menu button').map((button) => button.text());
    expect(labels).toContain('Enable liveness scan');
    expect(labels).toContain('Reset to Inherit');
    await wrapper
      .findAll('.row-menu button')
      .find((button) => button.text() === 'Reset to Inherit')
      .trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith('/subnets/11/ips/1.1.1.33/scan-enabled', {
      scan_enabled: null,
    });
  });

  it('keeps header actions anchored after the responsive health metrics', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    expect(wrapper.find('.context-overview > .context-title-row').exists()).toBe(true);
    expect(wrapper.find('.context-overview > .health-strip + .context-actions').exists()).toBe(
      true,
    );
    expect(wrapper.findAll('.health-strip .health-stat')).toHaveLength(5);
    expect(wrapper.find('.context-actions').text()).toContain('Scan now');
    expect(wrapper.find('.context-actions').text()).toContain('Actions');
    expect(wrapper.find('.context-actions').text()).toContain('Create');
  });

  it('uses whole-network summary counts when the address page is filtered', async () => {
    summaryStats.online_count = 17;
    summaryStats.rogue_count = 4;
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    await wrapper.find('input[aria-label="Search current table"]').setValue('1.1.1.40');
    await new Promise((resolve) => setTimeout(resolve, 320));
    await flushPromises();

    const stats = wrapper.find('.health-strip').text();
    expect(wrapper.findAll('tbody tr')).toHaveLength(1);
    expect(stats).toContain('17');
    expect(stats).toContain('4 rogue');
    expect(stats).not.toContain('on this page');
  });

  it('requests only permitted domains and hides denied write actions', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    pinia.state.value.auth = {
      user: {
        username: 'dns-reader',
        role: 'readonly_dns',
        is_admin: false,
        permissions: ['subnets:read', 'dns:read'],
      },
    };
    const wrapper = await mountPreview();

    expect(api.get.mock.calls.some(([url]) => url.startsWith('/dhcp'))).toBe(false);
    expect(api.get.mock.calls.some(([url]) => url === '/workspace/dhcp-addresses')).toBe(false);
    expect(wrapper.find('button.primary').exists()).toBe(false);
  });
});
