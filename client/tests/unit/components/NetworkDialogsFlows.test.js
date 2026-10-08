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

const CheckboxStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
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
        Checkbox: CheckboxStub,
        Slider: true,
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
  it('creates a network unallocated, with no allocation settings to choose', async () => {
    store.createSupernet.mockResolvedValue({ id: 78, cidr: '10.8.0.0/24' });
    store.folders = [{ id: 3, name: 'First folder', subnets: [] }];
    const wrapper = mountDialogs();
    await wrapper.vm.openCreateNetwork(null);
    await settle();
    // No folder unless one was asked for, never the first in the list.
    expect(wrapper.vm.networkForm.folder_id).toBeNull();
    store.folders = [];
    const editor = dialog(wrapper, 'dialog-network-edit');
    await editor.find('input').setValue('10.8.0.0/24');
    await settle();

    // Gateway, domain, scanning, reverse DNS and DHCP belong to allocation.
    for (const label of [
      'Gateway',
      'Domain Name',
      'Create reverse DNS zone',
      'Create DHCP scope',
    ]) {
      expect(editor.text()).not.toContain(label);
    }

    await button(wrapper, 'dialog-network-edit', 'Create').trigger('click');
    await settle();
    expect(store.createSupernet).toHaveBeenCalledWith(
      expect.objectContaining({ cidr: '10.8.0.0/24' }),
    );
    expect(store.configureSubnet).not.toHaveBeenCalled();
    expect(wrapper.emitted('network-created')).toHaveLength(1);
    expect(dialog(wrapper, 'dialog-network-edit').exists()).toBe(false);
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining('10.8.0.0/24 is unallocated') }),
    );
  });

  it('allocates several selected networks, keeping given names and reporting failures', async () => {
    store.fetchTree = vi.fn().mockResolvedValue();
    store.configureSubnet
      .mockResolvedValueOnce({ id: 1 })
      .mockRejectedValueOnce({ response: { status: 400, data: { error: 'boom' } } });
    const wrapper = mountDialogs();
    wrapper.vm.openGroupConfigure([
      { id: 1, cidr: '10.1.0.0/24', name: '10.1.0.0/24' },
      { id: 2, cidr: 'fd00:2::/64', name: 'Lab v6' },
    ]);
    await settle();
    expect(dialog(wrapper, 'dialog-group-allocate').text()).toContain('Allocate 2 networks?');
    await wrapper.get('[data-track="group-allocate-confirm"]').trigger('click');
    await settle();

    const [first, second] = store.configureSubnet.mock.calls;
    // A network still named by its CIDR takes the template name; a named one keeps it.
    expect(first[0]).toBe(1);
    expect(first[1]).toMatchObject({ name: 'Nine', create_dhcp_scope: false });
    expect(first[1]).not.toHaveProperty('folder_id');
    expect(second[0]).toBe(2);
    expect(second[1].name).toBe('Lab v6');
    expect(wrapper.emitted('group-configured')).toHaveLength(1);
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', detail: 'fd00:2::/64: boom' }),
    );
    // The one that failed stays in the dialog.
    expect(dialog(wrapper, 'dialog-group-allocate').text()).toContain('fd00:2::/64');
    expect(dialog(wrapper, 'dialog-group-allocate').text()).not.toContain('10.1.0.0/24');
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

  it('divides the network the dialog was opened for, not a stale selected one', async () => {
    store.previewDivide.mockResolvedValue({
      plan: { dependency_token: 'tok', plan_id: 'p', targets: [], conflicts: [] },
    });
    store.divideSubnet.mockResolvedValue({});
    const stale = { key: 'subnet-14', data: { ...node.data, id: 14, cidr: '1.1.2.0/24' } };
    const wrapper = mountDialogs({ selectedNode: stale });
    wrapper.vm.openDivide(node);
    await settle();
    expect(store.previewDivide).toHaveBeenCalledWith(42, expect.anything());
    await wrapper.vm.executeDivide();
    await settle();
    expect(store.divideSubnet).toHaveBeenCalledWith(42, expect.anything());
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
