import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

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
const MessageStub = { template: '<div class="message"><slot /></div>' };

const node = {
  data: {
    id: 42,
    cidr: '10.42.0.0/24',
    network_address: '10.42.0.0',
    prefix_length: 24,
    status: 'allocated',
    name: 'Lab network',
    gateway_address: '10.42.0.1',
    gateway_policy: 'first',
    scan_enabled: null,
    child_count: 2,
  },
};

function mountDialogs(props = {}) {
  return mount(NetworkDialogs, {
    props: { selectedNode: null, folders: [], ...props },
    global: {
      stubs: {
        Dialog: DialogStub,
        Button: ButtonStub,
        InputText: InputStub,
        Message: MessageStub,
        InputNumber: true,
        Select: true,
        SelectButton: true,
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
const button = (wrapper, track, text) =>
  dialog(wrapper, track)
    .findAll('button')
    .find((candidate) => candidate.text() === text);

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
    data: { gateway_address: '10.9.0.1', suggested_name: 'Nine', default_dhcp_pool: null },
  });
  toast.add.mockReset();
});

describe('NetworkDialogs transformation and two-step flows', () => {
  it('T-10 resumes configuration on the created root instead of creating it twice', async () => {
    store.createSupernet.mockResolvedValue({ id: 77, cidr: '10.9.0.0/24' });
    store.configureSubnet
      .mockRejectedValueOnce({ response: { status: 502, data: { error: 'dnsmasq refused' } } })
      .mockResolvedValue({ id: 77 });
    const wrapper = mountDialogs();
    await wrapper.vm.openCreateNetwork(null);
    await settle();
    await dialog(wrapper, 'dialog-network-edit').find('input').setValue('10.9.0.0/24');
    await settle();

    await button(wrapper, 'dialog-network-edit', 'Create').trigger('click');
    await settle();
    expect(store.createSupernet).toHaveBeenCalledTimes(1);
    expect(store.configureSubnet).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ name: 'Nine' }),
    );
    const editor = dialog(wrapper, 'dialog-network-edit');
    expect(editor.exists()).toBe(true);
    expect(editor.attributes('data-header')).toBe('Resume Configuration');
    expect(wrapper.find('[data-track="network-save-error"]').text()).toContain(
      '10.9.0.0/24 was created but not configured: dnsmasq refused',
    );
    expect(wrapper.emitted('network-created')).toHaveLength(1);

    await button(wrapper, 'dialog-network-edit', 'Save').trigger('click');
    await settle();
    expect(store.createSupernet).toHaveBeenCalledTimes(1);
    expect(store.configureSubnet).toHaveBeenCalledTimes(2);
    expect(store.configureSubnet.mock.calls[1][0]).toBe(77);
    expect(wrapper.emitted('network-configured')).toEqual([[77]]);
    expect(dialog(wrapper, 'dialog-network-edit').exists()).toBe(false);
  });

  it('T-15 executes the reviewed plan token and re-reviews a stale plan without resubmitting', async () => {
    const plan = (token) => ({
      dependency_token: token,
      plan_id: `plan-${token}`,
      targets: [{ cidr: '10.42.0.0/25' }, { cidr: '10.42.0.128/25' }],
      conflicts: [],
    });
    store.previewDivide.mockResolvedValue({ plan: plan('tok-1') });
    store.divideSubnet.mockResolvedValueOnce({}).mockRejectedValueOnce({
      response: { status: 409, data: { stale_plan: true, plan: plan('tok-2') } },
    });
    const wrapper = mountDialogs({ selectedNode: node });
    wrapper.vm.openDivide(node);
    await settle();
    expect(store.previewDivide).toHaveBeenCalledTimes(1);

    await wrapper.vm.executeDivide();
    await settle();
    expect(store.divideSubnet).toHaveBeenLastCalledWith(
      42,
      expect.objectContaining({ new_prefix: 25, plan_token: 'tok-1', plan_id: 'plan-tok-1' }),
    );

    wrapper.vm.openDivide(node);
    await settle();
    await wrapper.vm.executeDivide();
    await settle();
    expect(store.divideSubnet).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-track="divide-stale-plan"]').text()).toContain('plan changed');
    expect(dialog(wrapper, 'dialog-network-divide').exists()).toBe(true);
    expect(wrapper.vm.serverDividePreview.plan.dependency_token).toBe('tok-2');
    // No hidden re-preview and no automatic submit of the replacement token.
    expect(store.previewDivide).toHaveBeenCalledTimes(2);
    expect(store.divideSubnet).toHaveBeenCalledTimes(2);
    expect(toast.add).not.toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
  });

  it('N-10 reports what the server did with a delete, not the menu label', async () => {
    store.deleteSubnet.mockResolvedValue({ message: 'Subnet deleted', action: 'children_deleted' });
    const wrapper = mountDialogs();
    wrapper.vm.openDeallocate(node);
    await settle();
    await button(wrapper, 'dialog-network-deallocate', 'Deallocate').trigger('click');
    await settle();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'success', summary: 'Descendant networks deleted' }),
    );
    expect(wrapper.emitted('network-deleted')).toEqual([[42]]);

    store.deleteSubnet.mockResolvedValue({ action: 'deallocated' });
    wrapper.vm.openDelete(node);
    await settle();
    await button(wrapper, 'dialog-network-delete', 'Delete').trigger('click');
    await settle();
    expect(toast.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ summary: 'Network deallocated' }),
    );
  });
});
