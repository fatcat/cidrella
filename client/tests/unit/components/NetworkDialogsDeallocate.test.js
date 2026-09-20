import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { store, toast, api } = vi.hoisted(() => ({
  store: {
    folders: [],
    deleteSubnet: vi.fn(),
    previewDeallocation: vi.fn(),
    getSettings: vi.fn(),
  },
  toast: { add: vi.fn() },
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../../src/stores/subnets.js', () => ({ useSubnetStore: () => store }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const NetworkDialogs = (await import('../../../src/components/NetworkDialogs.vue')).default;

const DialogStub = {
  props: ['visible'],
  emits: ['update:visible'],
  template: '<section v-if="visible"><slot /><slot name="footer" /></section>',
};
const ButtonStub = {
  props: ['label', 'disabled'],
  emits: ['click'],
  template:
    '<button type="button" :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
};

function mountDialogs() {
  return mount(NetworkDialogs, {
    props: { selectedNode: null, folders: [] },
    global: {
      stubs: {
        Dialog: DialogStub,
        Button: ButtonStub,
        InputText: true,
        InputNumber: true,
        Select: true,
        SelectButton: true,
        Message: true,
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
}

const dialog = (wrapper, track) => wrapper.find(`[data-track="${track}"]`);
const confirmButton = (wrapper, track, text) =>
  dialog(wrapper, track)
    .findAll('button')
    .find((candidate) => candidate.text() === text);

const network = { id: 2, cidr: '10.0.0.0/22', status: 'allocated', child_count: 0 };
const preview = {
  reservations: 0,
  scopes: 1,
  leases: 12,
  generated_ptr: 1016,
  generated_address_records: 3,
  reverse_zones: [
    { name: '0.0.10.in-addr.arpa', enabled: true, will_disable: true },
    { name: '1.0.10.in-addr.arpa', enabled: true, will_disable: false },
  ],
  forward_zones: ['the-mcnultys.org'],
  children: 0,
};

describe('NetworkDialogs deallocate and delete impact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.previewDeallocation.mockResolvedValue(preview);
  });

  it('lists what deallocating removes, disables and keeps', async () => {
    const wrapper = mountDialogs();
    wrapper.vm.openDeallocate({ data: network });
    await flushPromises();

    expect(store.previewDeallocation).toHaveBeenCalledWith(2);
    const text = dialog(wrapper, 'dialog-network-deallocate').text();
    expect(text).toContain('1 DHCP scope and 12 leases');
    expect(text).toContain('1016 generated PTR records');
    expect(text).toContain('3 generated A/AAAA records');
    expect(text).toContain('reverse zone 0.0.10.in-addr.arpa');
    expect(text).toContain('forward zone the-mcnultys.org and its manual records');
    expect(text).toContain('reverse zone 1.0.10.in-addr.arpa (still used by another network)');
    expect(text).not.toContain('reservation');
    expect(
      confirmButton(wrapper, 'dialog-network-deallocate', 'Deallocate').attributes('disabled'),
    ).toBeUndefined();
    wrapper.unmount();
  });

  it('blocks the confirm button while reservations exist', async () => {
    store.previewDeallocation.mockResolvedValue({ ...preview, reservations: 2 });
    const wrapper = mountDialogs();
    wrapper.vm.openDelete({ data: network });
    await flushPromises();

    const text = dialog(wrapper, 'dialog-network-delete').text();
    expect(text).toContain('Remove the 2 DHCP reservations in this network first.');
    expect(confirmButton(wrapper, 'dialog-network-delete', 'Delete').attributes('disabled')).toBe(
      '',
    );
    wrapper.unmount();
  });

  it('surfaces the server refusal when a reservation appears after the preview', async () => {
    store.deleteSubnet.mockRejectedValue({
      response: {
        status: 409,
        data: { error: 'Remove the 1 DHCP reservation in this network first.' },
      },
    });
    const wrapper = mountDialogs();
    wrapper.vm.openDeallocate({ data: network });
    await flushPromises();

    await confirmButton(wrapper, 'dialog-network-deallocate', 'Deallocate').trigger('click');
    await flushPromises();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        detail: 'Remove the 1 DHCP reservation in this network first.',
      }),
    );
    expect(dialog(wrapper, 'dialog-network-deallocate').exists()).toBe(true);
    wrapper.unmount();
  });

  it('does not ask for a preview when deleting an unallocated leaf', async () => {
    const wrapper = mountDialogs();
    wrapper.vm.openDelete({ data: { ...network, status: 'unallocated' } });
    await flushPromises();
    expect(store.previewDeallocation).not.toHaveBeenCalled();
    expect(
      dialog(wrapper, 'dialog-network-delete').find('[data-track="deallocation-impact"]').exists(),
    ).toBe(false);
    wrapper.unmount();
  });
});
