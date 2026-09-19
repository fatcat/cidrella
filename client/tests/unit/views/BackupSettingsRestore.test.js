import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { subnetStore, opsStore, authStore, toast, api } = vi.hoisted(() => ({
  subnetStore: { getSettings: vi.fn(), updateSetting: vi.fn() },
  opsStore: {
    backups: [],
    loading: false,
    fetchBackups: vi.fn(),
    createBackup: vi.fn(),
    deleteBackup: vi.fn(),
    downloadBackup: vi.fn(),
    restoreBackup: vi.fn(),
  },
  authStore: { user: { role: 'admin' }, logout: vi.fn() },
  toast: { add: vi.fn() },
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

vi.mock('../../../src/stores/subnets.js', () => ({ useSubnetStore: () => subnetStore }));
vi.mock('../../../src/stores/operations.js', () => ({ useOperationsStore: () => opsStore }));
vi.mock('../../../src/stores/auth.js', () => ({ useAuthStore: () => authStore }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const BackupSettings = (await import('../../../src/views/settings/BackupSettings.vue')).default;

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
// The shim wraps PrimeVue's RadioButton; a plain radio keeps the v-model contract.
const RadioStub = {
  props: ['modelValue', 'value', 'inputId'],
  emits: ['update:modelValue'],
  template:
    '<input type="radio" :id="inputId" :checked="modelValue === value" @change="$emit(\'update:modelValue\', value)" />',
};

function mountView() {
  return mount(BackupSettings, {
    global: {
      stubs: {
        Dialog: DialogStub,
        Button: ButtonStub,
        RadioButton: RadioStub,
        DataTable: true,
        Column: true,
        Select: true,
        InputText: true,
        ContextMenu: true,
        EmptyState: true,
      },
    },
  });
}

const confirmButton = (wrapper) => wrapper.find('[data-track="backup-restore-confirm"]');

beforeEach(() => {
  for (const fn of [
    subnetStore.getSettings,
    subnetStore.updateSetting,
    opsStore.fetchBackups,
    opsStore.restoreBackup,
    toast.add,
  ])
    fn.mockReset();
  subnetStore.getSettings.mockResolvedValue({});
  opsStore.fetchBackups.mockResolvedValue([]);
  opsStore.restoreBackup.mockResolvedValue({ message: 'Backup restored. DHCP will be off.' });
});

describe('restore dialog asks whether DHCP should serve afterwards', () => {
  it('holds the restore until a choice is made and sends the choice', async () => {
    const wrapper = mountView();
    await flushPromises();
    const file = new File(['x'], 'backup.tar.gz');
    wrapper.vm.restoreFile = file;
    wrapper.vm.showRestoreDialog = true;
    await flushPromises();

    expect(wrapper.text()).toContain('should this appliance serve DHCP');
    expect(confirmButton(wrapper).attributes('disabled')).toBeDefined();

    await confirmButton(wrapper).trigger('click');
    expect(opsStore.restoreBackup).not.toHaveBeenCalled();

    await wrapper.find('[data-track="backup-restore-dhcp-off"]').trigger('change');
    await flushPromises();
    expect(confirmButton(wrapper).attributes('disabled')).toBeUndefined();

    await confirmButton(wrapper).trigger('click');
    await flushPromises();
    expect(opsStore.restoreBackup).toHaveBeenCalledWith(file, { dhcp: 'disabled' });
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Restore complete',
        detail: 'Backup restored. DHCP will be off.',
      }),
    );
    // The dialog closed and the answer does not carry over to the next restore.
    expect(wrapper.vm.showRestoreDialog).toBe(false);
    expect(wrapper.vm.restoreDhcp).toBeNull();
  });

  it('sends enabled when the operator keeps DHCP', async () => {
    const wrapper = mountView();
    await flushPromises();
    wrapper.vm.restoreFile = new File(['x'], 'backup.tar.gz');
    wrapper.vm.showRestoreDialog = true;
    await flushPromises();
    await wrapper.find('[data-track="backup-restore-dhcp-on"]').trigger('change');
    await confirmButton(wrapper).trigger('click');
    await flushPromises();
    expect(opsStore.restoreBackup).toHaveBeenCalledWith(expect.any(File), { dhcp: 'enabled' });
  });
});
