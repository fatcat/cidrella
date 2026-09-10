import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { store, toast } = vi.hoisted(() => ({
  store: {
    folders: [],
    updateSubnet: vi.fn(),
    getSettings: vi.fn()
  },
  toast: { add: vi.fn() }
}));

vi.mock('../../../src/stores/subnets.js', () => ({
  useSubnetStore: () => store
}));
vi.mock('../../../src/ui/useToast.js', () => ({
  useToast: () => toast
}));
vi.mock('../../../src/api/client.js', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  }
}));

const NetworkDialogs = (await import('../../../src/components/NetworkDialogs.vue')).default;

const DialogStub = {
  props: ['visible'],
  template: '<section v-if="visible"><slot /><slot name="footer" /></section>'
};
const ButtonStub = {
  props: ['label'],
  emits: ['click'],
  template: '<button type="button" @click="$emit(\'click\')">{{ label }}</button>'
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
        TabPanel: true
      }
    }
  });
}

beforeEach(() => {
  store.updateSubnet.mockReset().mockResolvedValue({ id: 42 });
  store.getSettings.mockReset().mockResolvedValue({ default_scan_enabled: '1' });
  toast.add.mockReset();
});

describe('NetworkDialogs active network target', () => {
  it('saves a network opened from a folder row when selectedNode is null', async () => {
    const wrapper = mountDialogs();
    wrapper.vm.openEdit({
      data: {
        id: 42,
        cidr: '10.42.0.0/24',
        prefix_length: 24,
        status: 'allocated',
        name: 'Folder network',
        description: '',
        gateway_address: '10.42.0.1',
        gateway_policy: 'first',
        scan_enabled: null
      }
    });
    await flushPromises();

    const save = wrapper.findAll('button').find(button => button.text() === 'Save');
    expect(save).toBeDefined();
    await save.trigger('click');
    await flushPromises();

    expect(store.updateSubnet).toHaveBeenCalledWith(42, expect.objectContaining({
      cidr: '10.42.0.0/24',
      name: 'Folder network'
    }));
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'success', summary: 'Network updated'
    }));
  });
});
