/**
 * The classic network view on an IPv6 network (IPV6-46). Every IPv6 network
 * has a Network range (its subnet-router anycast address), and the Grid tab's
 * range table and the row-click range lookup used 32-bit math on it, which
 * threw while rendering. The view should mount and show the workspace pointer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const detail = {
  subnet: {
    id: 9,
    cidr: 'fd00:1234::/64',
    name: 'lab6',
    network_address: 'fd00:1234::',
    prefix_length: 64,
    address_family: 6,
    status: 'allocated',
    total_addresses: null,
    gateway_address: 'fd00:1234::1',
  },
  ips: [
    { ip_address: 'fd00:1234::', allocation_state: 'system', address_family: 6 },
    { ip_address: 'fd00:1234::1', allocation_state: 'gateway', address_family: 6 },
    { ip_address: 'fd00:1234::50', allocation_state: 'reserved', address_family: 6 },
  ],
  ranges: [
    {
      id: 1,
      range_type_name: 'Network',
      range_type_is_system: 1,
      start_ip: 'fd00:1234::',
      end_ip: 'fd00:1234::',
    },
    {
      id: 2,
      range_type_name: 'Gateway',
      range_type_is_system: 1,
      start_ip: 'fd00:1234::1',
      end_ip: 'fd00:1234::1',
    },
  ],
  totalIps: null,
  totalPages: 1,
  page: 1,
  pageSize: 256,
};

vi.mock('../../../src/stores/subnets.js', () => ({
  useSubnetStore: () => ({
    getSubnetDetail: vi.fn(async () => detail),
    getRangeTypes: vi.fn(async () => []),
    fetchSubnets: vi.fn(async () => []),
    subnets: [],
    invalidateDetail: vi.fn(),
  }),
}));
vi.mock('../../../src/stores/dhcp.js', () => ({
  useDhcpStore: () => ({ scopes: [], fetchScopes: vi.fn(async () => []) }),
}));
vi.mock('../../../src/api/client.js', () => ({
  default: {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
  },
}));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => ({ add: vi.fn() }) }));

const { default: SubnetDetail } = await import('../../../src/views/SubnetDetail.vue');
const { UiPlugin } = await import('../../../src/ui/plugin.js');

enableAutoUnmount(afterEach);

describe('SubnetDetail on an IPv6 network', () => {
  it('mounts, renders the workspace pointer and survives the range table', async () => {
    const errors = [];
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(SubnetDetail, {
      props: { subnetId: 9 },
      global: {
        plugins: [pinia, [UiPlugin, { unstyled: true }]],
        config: { errorHandler: (err) => errors.push(err) },
        stubs: { IpDetailsDrawer: true, ScopeDialog: true },
      },
    });
    // The view debounces its first load by 80ms.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flushPromises();
    expect(errors.map((err) => err.message)).toEqual([]);
    expect(wrapper.find('[data-track="classic-ipv6-notice"]').exists()).toBe(true);
  });
});
