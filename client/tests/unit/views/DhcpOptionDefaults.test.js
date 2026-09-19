import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { store, toast, api } = vi.hoisted(() => ({
  store: { applyConfig: vi.fn() },
  toast: { add: vi.fn() },
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../../src/stores/dhcp.js', () => ({ useDhcpStore: () => store }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const DHCP = (await import('../../../src/views/DHCP.vue')).default;

const catalogs = {
  4: {
    family: 4,
    customRange: [128, 254],
    catalog: [
      { code: 6, label: 'DNS Servers', type: 'ip-list', group: 'Common' },
      { code: 15, label: 'Domain Name', type: 'text', group: 'Common' },
    ],
    groups: [{ name: 'Common', label: 'Common' }],
    defaults: { 6: '10.0.0.2,9.9.9.9' },
    enabledDefaults: [6, 15],
  },
  6: {
    family: 6,
    customRange: [1, 65535],
    catalog: [
      { code: 23, label: 'DNS Servers', type: 'ip-list', group: 'Common' },
      { code: 24, label: 'Domain Search List', type: 'text-list', group: 'Common' },
      { code: 56, label: 'NTP Servers', type: 'ip-list', group: 'Common' },
    ],
    groups: [{ name: 'Common', label: 'Common' }],
    defaults: {},
    enabledDefaults: [23, 24],
  },
};

// The table renders one row per catalog entry; the value cell is an InputText
// for these types, so a stub input carrying the placeholder is enough.
const InputStub = {
  props: ['modelValue', 'placeholder'],
  emits: ['update:modelValue'],
  template:
    '<input :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const DataTableStub = {
  props: ['value'],
  template:
    '<div><slot name="empty" v-if="!value.length" /><div v-for="row in value" :key="row.code" class="row"><slot name="__row" :data="row" /></div></div>',
};

function mountEditor(props = {}) {
  return mount(DHCP, {
    props,
    global: {
      stubs: {
        DataTable: DataTableStub,
        Column: true,
        Dialog: true,
        Popover: true,
        Select: true,
        InputNumber: true,
        InputText: InputStub,
        EmptyState: true,
        Button: {
          props: ['label'],
          emits: ['click'],
          template: '<button type="button" @click="$emit(\'click\')">{{ label }}</button>',
        },
      },
    },
  });
}

beforeEach(() => {
  for (const fn of [store.applyConfig, toast.add, api.get, api.put, api.post, api.delete])
    fn.mockReset();
  api.get.mockImplementation((url, config) => {
    if (url !== '/dhcp/options') return Promise.reject(new Error(`Unexpected GET ${url}`));
    const family = config?.params?.family === 6 ? 6 : 4;
    return Promise.resolve({ data: catalogs[family] });
  });
  api.put.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
});

describe('DHCP option defaults editor by family', () => {
  it('is the IPv4 editor by default, with the historic requests and tracking ids', async () => {
    const wrapper = mountEditor();
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/dhcp/options', { params: { family: 4 } });
    expect(wrapper.text()).toContain('newly created DHCPv4 scopes');
    expect(wrapper.text()).not.toContain('Router Advertisements');
    expect(wrapper.find('[data-track="dhcp-save-defaults"]').exists()).toBe(true);
    expect(wrapper.find('[data-track="dhcp-save-defaults-v6"]').exists()).toBe(false);
    expect(wrapper.vm.getOptionPlaceholder(6, 'ip-list')).toBe('e.g. 192.168.1.1, 192.168.1.2');
    expect(wrapper.vm.getOptionPlaceholder(15, 'text')).toBe("Defaults to network's domain");

    wrapper.vm.defaultValues[15] = 'lab.test';
    await flushPromises();
    await wrapper.find('[data-track="dhcp-save-defaults"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/dhcp/options/defaults', {
      family: 4,
      options: [
        { code: 6, value: '10.0.0.2,9.9.9.9' },
        { code: 15, value: 'lab.test' },
      ],
      enabledDefaults: [6, 15],
    });
  });

  it('serves the IPv6 family end to end when given family 6', async () => {
    const wrapper = mountEditor({ family: 6 });
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/dhcp/options', { params: { family: 6 } });
    expect(wrapper.text()).toContain('newly created DHCPv6 scopes');
    expect(wrapper.text()).toContain('Router Advertisements');
    expect(wrapper.find('[data-track="dhcp-save-defaults-v6"]').exists()).toBe(true);
    expect(wrapper.find('[data-track="dhcp-save-defaults"]').exists()).toBe(false);
    expect(wrapper.vm.getOptionPlaceholder(56, 'ip-list')).toBe(
      'e.g. fd00::53, 2606:4700:4700::1111',
    );
    expect(wrapper.vm.getOptionPlaceholder(23, 'ip-list')).toBe(
      "Defaults to CIDRella's IPv6 address on the network",
    );
    expect(wrapper.vm.customRange).toEqual([1, 65535]);

    wrapper.vm.defaultValues[56] = 'fd00::123';
    wrapper.vm.defaultEnabled[56] = true;
    await flushPromises();
    await wrapper.find('[data-track="dhcp-save-defaults-v6"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/dhcp/options/defaults', {
      family: 6,
      options: [{ code: 56, value: 'fd00::123' }],
      enabledDefaults: [23, 24, 56],
    });

    wrapper.vm.customOptionForm = { code: 200, label: 'Vendor', name: '', type: 'text' };
    await wrapper.vm.createCustomOption();
    expect(api.post).toHaveBeenCalledWith(
      '/dhcp/options/custom',
      expect.objectContaining({ code: 200, address_family: 6 }),
    );
    await wrapper.vm.deleteCustomOption(200);
    expect(api.delete).toHaveBeenCalledWith('/dhcp/options/custom/200', {
      params: { family: 6 },
    });
  });
});
