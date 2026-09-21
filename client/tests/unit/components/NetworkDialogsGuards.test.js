import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { store, toast, api } = vi.hoisted(() => ({
  store: {
    folders: [],
    updateSubnet: vi.fn(),
    updateFolder: vi.fn(),
    getSettings: vi.fn(),
  },
  toast: { add: vi.fn() },
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../../src/stores/subnets.js', () => ({ useSubnetStore: () => store }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const NetworkDialogs = (await import('../../../src/components/NetworkDialogs.vue')).default;

// The Dialog stub reports close-on-escape so the stacking rule is observable.
const DialogStub = {
  props: ['visible', 'closeOnEscape'],
  emits: ['update:visible'],
  template:
    '<section v-if="visible" :data-close-on-escape="String(closeOnEscape)"><slot /><slot name="footer" /></section>',
};
const ButtonStub = {
  props: ['label'],
  emits: ['click'],
  template: '<button type="button" @click="$emit(\'click\')">{{ label }}</button>',
};
const InputStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};

const CheckboxStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
};

function mountDialogs() {
  return mount(NetworkDialogs, {
    props: { selectedNode: null, folders: [] },
    global: {
      stubs: {
        Dialog: DialogStub,
        Button: ButtonStub,
        InputText: InputStub,
        InputNumber: true,
        Checkbox: CheckboxStub,
        Slider: true,
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
const button = (wrapper, track, text) =>
  dialog(wrapper, track)
    .findAll('button')
    .find((candidate) => candidate.text() === text);
const prompt = (wrapper, track) => dialog(wrapper, track).find('.discard-prompt');

const node = {
  data: {
    id: 42,
    cidr: '10.42.0.0/24',
    network_address: '10.42.0.0',
    prefix_length: 24,
    status: 'allocated',
    name: 'Lab network',
    description: '',
    gateway_address: '10.42.0.1',
    gateway_policy: 'first',
    scan_enabled: null,
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  store.getSettings.mockReset().mockResolvedValue({ default_scan_enabled: '1' });
  api.get.mockReset().mockResolvedValue({ data: [] });
  api.post.mockReset().mockResolvedValue({
    data: {
      gateway_address: '10.42.0.254',
      suggested_name: 'Lab network',
      default_dhcp_pool: null,
    },
  });
  toast.add.mockReset();
});

async function settle() {
  await vi.runAllTimersAsync();
  await flushPromises();
}

describe('NetworkDialogs unsaved-form guards', () => {
  it('closes a clean folder editor at once and asks before discarding edits', async () => {
    const wrapper = mountDialogs();
    wrapper.vm.openEditFolder({ id: 4, name: 'Lab', description: 'Racks' });
    await settle();
    await button(wrapper, 'dialog-folder-edit', 'Cancel').trigger('click');
    expect(dialog(wrapper, 'dialog-folder-edit').exists()).toBe(false);

    wrapper.vm.openEditFolder({ id: 4, name: 'Lab', description: 'Racks' });
    await settle();
    await dialog(wrapper, 'dialog-folder-edit').find('input').setValue('Lab 2');
    await button(wrapper, 'dialog-folder-edit', 'Cancel').trigger('click');
    expect(dialog(wrapper, 'dialog-folder-edit').exists()).toBe(true);
    expect(prompt(wrapper, 'dialog-folder-edit').exists()).toBe(true);

    await button(wrapper, 'dialog-folder-edit', 'Keep editing').trigger('click');
    expect(prompt(wrapper, 'dialog-folder-edit').exists()).toBe(false);
    expect(dialog(wrapper, 'dialog-folder-edit').find('input').element.value).toBe('Lab 2');

    // The vendor close (X or Escape) goes through the same gate.
    wrapper
      .findAllComponents(DialogStub)
      .find((candidate) => candidate.attributes('data-track') === 'dialog-folder-edit')
      .vm.$emit('update:visible', false);
    await flushPromises();
    expect(prompt(wrapper, 'dialog-folder-edit').exists()).toBe(true);
    await button(wrapper, 'dialog-folder-edit', 'Discard').trigger('click');
    expect(dialog(wrapper, 'dialog-folder-edit').exists()).toBe(false);
  });

  it('treats server defaults written by the preview as clean, and typed edits as dirty', async () => {
    const wrapper = mountDialogs();
    wrapper.vm.openEdit(node);
    await settle();
    expect(api.post).toHaveBeenCalledWith('/subnets/configuration-preview', expect.any(Object));
    await button(wrapper, 'dialog-network-edit', 'Cancel').trigger('click');
    expect(dialog(wrapper, 'dialog-network-edit').exists()).toBe(false);

    wrapper.vm.openEdit(node);
    await settle();
    const nameInput = dialog(wrapper, 'dialog-network-edit').find('input');
    await nameInput.setValue('Renamed');
    await settle();
    await button(wrapper, 'dialog-network-edit', 'Cancel').trigger('click');
    expect(prompt(wrapper, 'dialog-network-edit').exists()).toBe(true);
    expect(dialog(wrapper, 'dialog-network-edit').exists()).toBe(true);
  });

  it('keeps Escape on the network editor off while the inline folder editor is on top', async () => {
    const wrapper = mountDialogs();
    wrapper.vm.openEdit(node);
    await settle();
    expect(dialog(wrapper, 'dialog-network-edit').attributes('data-close-on-escape')).toBe('true');
    wrapper.vm.openCreateFolderFromEdit();
    await settle();
    expect(dialog(wrapper, 'dialog-network-edit').attributes('data-close-on-escape')).toBe('false');
    await button(wrapper, 'dialog-folder-edit', 'Cancel').trigger('click');
    expect(dialog(wrapper, 'dialog-network-edit').attributes('data-close-on-escape')).toBe('true');
  });

  it('guards the divide form and the address-space form the same way', async () => {
    const wrapper = mountDialogs();
    wrapper.vm.openDivide(node);
    await settle();
    wrapper.vm.divideCount = 4;
    await settle();
    await button(wrapper, 'dialog-network-divide', 'Cancel').trigger('click');
    expect(prompt(wrapper, 'dialog-network-divide').exists()).toBe(true);
    await button(wrapper, 'dialog-network-divide', 'Discard').trigger('click');
    expect(dialog(wrapper, 'dialog-network-divide').exists()).toBe(false);

    wrapper.vm.openQuickAddNetwork();
    await settle();
    await dialog(wrapper, 'dialog-network-create').find('input').setValue('10.9.0.0/16');
    await button(wrapper, 'dialog-network-create', 'Cancel').trigger('click');
    expect(prompt(wrapper, 'dialog-network-create').exists()).toBe(true);
  });
});
