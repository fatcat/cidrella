import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import NetworksWorkspacePreview from '../../../src/views/NetworksWorkspacePreview.vue';
import api from '../../../src/api/client.js';

vi.mock('../../../src/api/client.js', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

let reservedIp33 = false;

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
  { id: 21, name: 'test.example', type: 'forward', enabled: 1, record_count: 1, subnet_id: null },
  {
    id: 22,
    name: '1.1.1.in-addr.arpa',
    type: 'reverse',
    enabled: 1,
    record_count: 1,
    subnet_id: subnet.id,
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
      return response({ folders: [{ id: 1, name: 'Testerella', subnets: [subnet] }] });
    if (url === '/dns/zones') return response(zones);
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
    if (url === '/dhcp/leases') return response([lease]);
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
      return response({
        subnet,
        ips,
        ranges,
        totalIps: ips.length,
        page: 1,
        pageSize: 256,
        totalPages: 1,
      });
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

async function mountPreview() {
  const wrapper = mount(NetworksWorkspacePreview, {
    global: {
      stubs: {
        RouterLink: {
          props: ['to'],
          template: '<a :href="to"><slot /></a>',
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
  beforeEach(() => {
    localStorage.clear();
    reservedIp33 = false;
    subnet.used_count = 5;
    api.get.mockReset();
    api.put.mockReset();
    api.post.mockReset();
    installApiFixtures();
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

    await wrapper.find('button[data-track="workspace-stat-dns"]').trigger('click');
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
});
