import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import NetworksWorkspacePreview from '../../../src/views/NetworksWorkspacePreview.vue';
import NetworksWorkspace from '../../../src/views/networks-workspace/NetworksWorkspace.vue';
import AddressGrid from '../../../src/views/networks-workspace/AddressGrid.vue';
import ResourceExplorer from '../../../src/views/networks-workspace/ResourceExplorer.vue';
import WorkspaceContextHeader from '../../../src/views/networks-workspace/WorkspaceContextHeader.vue';
import WorkspaceDetailsHost from '../../../src/views/networks-workspace/WorkspaceDetailsHost.vue';
import WorkspaceTable from '../../../src/views/networks-workspace/WorkspaceTable.vue';
import WorkspaceToolbar from '../../../src/views/networks-workspace/WorkspaceToolbar.vue';
import IpReservationEditor from '../../../src/views/networks-workspace/dialogs/IpReservationEditor.vue';
import api from '../../../src/api/client.js';

vi.mock('../../../src/api/client.js', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

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
      return response({ items: [lease], total: 1, page: 1, page_size: 256 });
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
      return response({
        subnet,
        ips,
        ranges,
        totalIps: ips.length,
        filteredTotal: ips.length,
        page: 1,
        pageSize: 256,
        totalPages: 1,
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
      stubs: {
        RouterLink: {
          props: ['to'],
          template: '<a :href="to"><slot /></a>',
        },
        Dialog: {
          props: ['visible'],
          template: '<section v-if="visible"><slot /><slot name="footer" /></section>',
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
    expect(wrapper.find('.table-footer .pagination').exists()).toBe(true);

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
    expect(wrapper.find('.workspace-address-panel').text()).toContain('DNS records');
    expect(wrapper.find('.workspace-address-panel').text()).toContain('DHCP identity');
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

  it('keeps the details drawer pinned while opening a related resource', async () => {
    const wrapper = await mountPreview();
    await enterTestNetwork(wrapper);
    const gatewayRow = wrapper.findAll('tbody tr').find((row) => row.text().includes('1.1.1.1'));
    await gatewayRow.trigger('click');

    expect(wrapper.find('.workspace-address-panel').text()).toContain('IP ADDRESS');
    await wrapper.find('.related-button').trigger('click');

    expect(wrapper.find('.workspace-address-panel').exists()).toBe(true);
    expect(wrapper.find('.workspace-address-panel').text()).toContain('IP ADDRESS');
    expect(wrapper.find('.view-tabs button.active').text()).toContain('DNS');
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

  it('drives every menu through the action registry with a row-derived target', async () => {
    const wrapper = await mountPreview();
    // No network is selected, so there is no target for the network actions.
    expect(wrapper.find('.context-actions').text()).not.toContain('Actions');

    await enterTestNetwork(wrapper);
    const scopeMember = wrapper.findAll('tbody tr').find((row) => row.text().includes('1.1.1.50'));
    await scopeMember.find('button[aria-label="Row actions"]').trigger('click');
    const menu = wrapper.find('.row-menu');
    expect(menu.findAll('button').map((button) => button.text())).toEqual([
      'Edit DHCP scope',
      'Remove this IP from scope',
      'Delete DHCP scope',
      'Create IP Reservation',
      'Add DHCP Reservation',
      'Set range type',
      'Change scan setting',
      'Probe now',
    ]);

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
      'Merge networks',
      'Move to folder',
      'Apply defaults',
      'Deallocate network',
      'Delete network',
    ]);
  });

  it('opens menus to the keyboard and returns focus to the invoker', async () => {
    const wrapper = await mountPreview({ attachTo: document.body });
    await enterTestNetwork(wrapper);
    const rowButton = wrapper
      .findAll('tbody tr')
      .find((row) => row.text().includes('1.1.1.50'))
      .find('button[aria-label="Row actions"]');
    rowButton.element.focus();
    await rowButton.trigger('click');
    await flushPromises();

    const items = wrapper.findAll('.row-menu [role="menuitem"]');
    expect(document.activeElement).toBe(items[0].element);
    await wrapper.find('.row-menu').trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1].element);
    await wrapper.find('.row-menu').trigger('keydown', { key: 'End' });
    expect(document.activeElement).toBe(items.at(-1).element);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(wrapper.find('.row-menu').exists()).toBe(false);
    expect(document.activeElement).toBe(rowButton.element);

    // The grid reaches the same menu from the keyboard.
    await wrapper.find('button[aria-label="Grid view"]').trigger('click');
    await flushPromises();
    const cell = wrapper.find('.address-grid button[tabindex="0"]');
    cell.element.focus();
    await cell.trigger('keydown', { key: 'F10', shiftKey: true });
    await flushPromises();
    expect(wrapper.find('.row-menu').exists()).toBe(true);
    expect(document.activeElement).toBe(wrapper.find('.row-menu [role="menuitem"]').element);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(document.activeElement).toBe(cell.element);
    wrapper.unmount();
  });

  it('operates table rows from the keyboard', async () => {
    const wrapper = await mountPreview({ attachTo: document.body });
    await enterTestNetwork(wrapper);
    const rows = wrapper.findAll('tbody tr');
    rows[0].element.focus();
    await rows[0].trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1].element);

    await rows[1].trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.find('.workspace-address-panel').text()).toContain(rows[1].text().slice(0, 7));
    expect(rows[1].attributes('aria-selected')).toBe('true');

    await rows[1].trigger('keydown', { key: ' ' });
    expect(rows[1].find('input[type="checkbox"]').element.checked).toBe(true);

    await rows[1].trigger('keydown', { key: 'F10', shiftKey: true });
    await flushPromises();
    expect(wrapper.find('.row-menu').exists()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(document.activeElement).toBe(rows[1].element);
    wrapper.unmount();
  });

  it('persists a capped small-text size without resizing larger headings', async () => {
    const wrapper = await mountPreview();
    expect(wrapper.find('.font-sizer output').text()).toBe('+1 pt');

    await wrapper.find('button[aria-label="Increase small text size"]').trigger('click');
    expect(wrapper.find('.font-sizer output').text()).toBe('+2 pt');
    expect(wrapper.find('.workspace-preview').attributes('style')).toContain(
      '--workspace-font-bump: 2.666px',
    );
    expect(localStorage.getItem('cidrella_workspace_font_bump')).toBe('2');
    expect(
      wrapper.find('button[aria-label="Increase small text size"]').attributes(),
    ).toHaveProperty('disabled');
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
