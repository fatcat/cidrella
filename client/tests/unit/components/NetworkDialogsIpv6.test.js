/**
 * The network editor with an IPv6 CIDR: refused inline while the IPv6
 * switch is off, and with the switch on the gateway section gives way to a
 * DHCPv6 mode picker whose choice is what Create sends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';

const { store, toast, api } = vi.hoisted(() => ({
  store: {
    folders: [],
    createSupernet: vi.fn(),
    configureSubnet: vi.fn(),
    updateSubnet: vi.fn(),
    deleteSubnet: vi.fn(),
    previewDivide: vi.fn(),
    divideSubnet: vi.fn(),
    getSettings: vi.fn(),
  },
  toast: { add: vi.fn() },
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../../src/stores/subnets.js', () => ({ useSubnetStore: () => store }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const NetworkDialogs = (await import('../../../src/components/NetworkDialogs.vue')).default;
const { useFeaturesStore } = await import('../../../src/stores/features.js');

const DialogStub = {
  props: ['visible', 'header'],
  emits: ['update:visible'],
  template:
    '<section v-if="visible" :data-header="header"><slot /><slot name="footer" /></section>',
};
const ButtonStub = {
  props: ['label', 'disabled'],
  emits: ['click'],
  template:
    '<button type="button" :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
};
const InputStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const SelectButtonStub = {
  props: ['modelValue', 'options'],
  template:
    '<div class="select-button" :data-value="modelValue" :data-options="options.map((o) => o.value).join(\',\')" />',
};
const MessageStub = { template: '<div class="message"><slot /></div>' };

const CheckboxStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
};

function mountDialogs(ipv6) {
  const pinia = createPinia();
  const wrapper = mount(NetworkDialogs, {
    props: { selectedNode: null, folders: [] },
    global: {
      plugins: [pinia],
      stubs: {
        Dialog: DialogStub,
        Button: ButtonStub,
        InputText: InputStub,
        Message: MessageStub,
        SelectButton: SelectButtonStub,
        InputNumber: true,
        Checkbox: CheckboxStub,
        Slider: true,
        Select: true,
        AutoComplete: true,
        ToggleSwitch: true,
        Tag: true,
        Tabs: true,
        TabList: true,
        Tab: true,
        TabPanels: true,
        TabPanel: true,
      },
    },
  });
  useFeaturesStore(pinia).set({ ipv6 });
  return wrapper;
}

const dialog = (wrapper) => wrapper.find('[data-track="dialog-network-edit"]');
const button = (wrapper, text) =>
  dialog(wrapper)
    .findAll('button')
    .find((candidate) => candidate.text() === text);
const checkbox = (wrapper, label) =>
  wrapper
    .findAll('label.toggle-label')
    .find((candidate) => candidate.text().includes(label))
    .find('input');

async function settle() {
  await vi.runAllTimersAsync();
  await flushPromises();
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const fn of Object.values(store)) if (typeof fn?.mockReset === 'function') fn.mockReset();
  store.getSettings.mockResolvedValue({
    default_scan_enabled: '1',
    default_gateway_position: 'first',
  });
  api.get.mockReset().mockResolvedValue({ data: [] });
  api.post.mockReset().mockResolvedValue({
    data: {
      gateway_address: 'fd00:1234::1',
      suggested_name: 'Lab6',
      default_dhcp_pool: null,
      address_family: 6,
      dhcp_v6_modes: ['stateful'],
    },
  });
  toast.add.mockReset();
});

describe('NetworkDialogs with an IPv6 CIDR', () => {
  it('refuses the CIDR inline and never previews while IPv6 support is off', async () => {
    const wrapper = mountDialogs(false);
    await wrapper.vm.openCreateNetwork(null);
    await settle();
    await dialog(wrapper).find('input').setValue('fd00:1234::/48');
    await settle();
    expect(dialog(wrapper).text()).toContain('IPv6 support is disabled');
    expect(button(wrapper, 'Create').attributes('disabled')).toBeDefined();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('hides the gateway, offers the DHCPv6 modes the server allows, and sends the choice', async () => {
    store.createSupernet.mockResolvedValue({ id: 9, cidr: 'fd00:1234::/48' });
    store.configureSubnet.mockResolvedValue({ id: 9 });
    const wrapper = mountDialogs(true);
    await wrapper.vm.openCreateNetwork(null);
    await settle();
    await dialog(wrapper).find('input').setValue('fd00:1234::/48');
    await settle();

    expect(dialog(wrapper).text()).not.toContain('IPv6 support is disabled');
    expect(dialog(wrapper).text()).not.toContain('Gateway');
    expect(api.post).toHaveBeenCalledWith(
      '/subnets/configuration-preview',
      expect.objectContaining({ cidr: 'fd00:1234::/48' }),
    );

    await checkbox(wrapper, 'Create DHCP scope').setValue(true);
    await settle();
    const mode = wrapper.find('[data-track="net-dhcp-v6-mode"]');
    expect(mode.exists()).toBe(true);
    expect(mode.attributes('data-options')).toBe('stateful');
    expect(mode.attributes('data-value')).toBe('stateful');
    expect(dialog(wrapper).text()).toContain('Start IP');

    await button(wrapper, 'Create').trigger('click');
    await settle();
    expect(store.createSupernet).toHaveBeenCalledWith(
      expect.objectContaining({ cidr: 'fd00:1234::/48' }),
    );
    expect(store.configureSubnet).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        create_dhcp_scope: true,
        dhcp_v6_mode: 'stateful',
        gateway_address: '',
      }),
    );
  });

  it('sends no DHCPv6 mode for an IPv4 network', async () => {
    store.createSupernet.mockResolvedValue({ id: 4, cidr: '10.9.0.0/24' });
    store.configureSubnet.mockResolvedValue({ id: 4 });
    api.post.mockResolvedValue({
      data: { gateway_address: '10.9.0.1', suggested_name: 'Nine', default_dhcp_pool: null },
    });
    const wrapper = mountDialogs(true);
    await wrapper.vm.openCreateNetwork(null);
    await settle();
    await dialog(wrapper).find('input').setValue('10.9.0.0/24');
    await settle();
    expect(dialog(wrapper).text()).toContain('Gateway');
    await button(wrapper, 'Create').trigger('click');
    await settle();
    const payload = store.configureSubnet.mock.calls[0][1];
    expect(payload).not.toHaveProperty('dhcp_v6_mode');
  });
});
