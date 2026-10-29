/**
 * The calculator asks for a split a page at a time (docs/IPV6-HANDLING.md):
 * a /48 into /64s is 65,536 networks, never held in the browser at once, and
 * only the inputs are remembered across visits.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = { post: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => ({ add: vi.fn() }) }));

const { default: SubnetCalculator } = await import('../../../src/views/SubnetCalculator.vue');

const DataTableStub = {
  props: ['value', 'totalRecords', 'first', 'rows'],
  emits: ['page'],
  template:
    '<div class="table-stub"><span v-for="row in value" :key="row.cidr" class="row">{{ row.cidr }}</span></div>',
};

function page(cidr, prefix, first, count, extra = {}) {
  return {
    data: {
      parent: { network: cidr.split('/')[0], prefix: Number(cidr.split('/')[1]) },
      count: String(count),
      first: `${first}/${prefix}`,
      last: 'last',
      subnets: [{ cidr: `${first}/${prefix}`, network: first, prefix }],
      ...extra,
    },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  api.post.mockReset();
  globalThis.localStorage?.removeItem('cidrella-subnet-calc');
});

function mountCalculator() {
  return mount(SubnetCalculator, {
    global: {
      stubs: {
        DataTable: DataTableStub,
        Column: true,
        ContextMenu: true,
        InputText: true,
        InputNumber: true,
        Button: true,
      },
    },
  });
}

describe('SubnetCalculator', () => {
  it('IPv6: asks for the first page, then the page a person turns to', async () => {
    api.post.mockResolvedValueOnce(page('fd00:90::/48', 64, 'fd00:90::', 65536));
    const wrapper = mountCalculator();
    wrapper.vm.cidr = 'fd00:90::/48';
    wrapper.vm.newPrefix = 64;
    await wrapper.vm.calculate();
    expect(api.post).toHaveBeenLastCalledWith('/subnets/calculate', {
      cidr: 'fd00:90::/48',
      new_prefix: 64,
      page: 1,
      page_size: 256,
    });
    expect(wrapper.text()).toContain('65,536 Networks');
    expect(wrapper.findComponent(DataTableStub).props('totalRecords')).toBe(65536);

    api.post.mockResolvedValueOnce(page('fd00:90::/48', 64, 'fd00:90:0:800::', 65536));
    wrapper.findComponent(DataTableStub).vm.$emit('page', { page: 7, rows: 256 });
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith('/subnets/calculate', {
      cidr: 'fd00:90::/48',
      new_prefix: 64,
      page: 8,
      page_size: 256,
    });
    expect(wrapper.findComponent(DataTableStub).props('first')).toBe(1792);
  });

  it('IPv4: remembers the inputs, never the result, and asks again on return', async () => {
    api.post.mockResolvedValue(page('10.90.0.0/22', 28, '10.90.0.0', 64));
    const first = mountCalculator();
    first.vm.cidr = '10.90.0.0/22';
    first.vm.newPrefix = 28;
    await first.vm.calculate();
    expect(JSON.parse(globalThis.localStorage.getItem('cidrella-subnet-calc'))).toEqual({
      cidr: '10.90.0.0/22',
      newPrefix: 28,
    });
    first.unmount();

    mountCalculator();
    await flushPromises();
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(api.post).toHaveBeenLastCalledWith(
      '/subnets/calculate',
      expect.objectContaining({ page: 1 }),
    );
  });
});
