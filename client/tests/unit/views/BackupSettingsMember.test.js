/**
 * Backup & Restore on a member: the backups on its disk alone, to download or
 * delete. It takes no backups, so creating, scheduling, restoring and the
 * database reset are not shown, and an empty list says where backups are
 * taken.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { subnetStore, opsStore, features, api } = vi.hoisted(() => ({
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
  features: { isMember: true },
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

vi.mock('../../../src/stores/subnets.js', () => ({ useSubnetStore: () => subnetStore }));
vi.mock('../../../src/stores/operations.js', () => ({ useOperationsStore: () => opsStore }));
vi.mock('../../../src/stores/auth.js', () => ({
  useAuthStore: () => ({ user: { role: 'admin' }, logout: vi.fn() }),
}));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => ({ add: vi.fn() }) }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/composables/useFeatures.js', async () => {
  const { ref } = await import('vue');
  return {
    useFeatures: () => ({
      isMember: ref(features.isMember),
      instance: ref(
        features.isMember
          ? { mode: 'member', controller_name: 'ns1' }
          : { mode: 'controller', controller_name: null },
      ),
    }),
  };
});

const BackupSettings = (await import('../../../src/views/settings/BackupSettings.vue')).default;

const EmptyStub = {
  props: ['title', 'description'],
  template: '<p class="empty">{{ description }}</p>',
};
// The table renders its empty slot, so what an empty list says can be read.
const TableStub = { template: '<div class="table"><slot name="empty" /></div>' };

function mountView() {
  return mount(BackupSettings, {
    global: {
      stubs: {
        Button: { props: ['label'], template: '<button>{{ label }}</button>' },
        DataTable: TableStub,
        Column: true,
        Select: true,
        InputText: true,
        RadioButton: true,
        ContextMenu: true,
        ConfirmDialog: true,
        EmptyState: EmptyStub,
      },
      directives: { tooltip: () => {} },
    },
  });
}

const headings = (wrapper) => wrapper.findAll('h3').map((h) => h.text());

beforeEach(() => {
  vi.clearAllMocks();
  subnetStore.getSettings.mockResolvedValue({});
  api.get.mockResolvedValue({ data: {} });
});

describe('Backup & Restore on a member', () => {
  it('shows the existing backups alone and reads nothing else', async () => {
    features.isMember = true;
    const wrapper = mountView();
    await flushPromises();
    expect(headings(wrapper)).toEqual(['Existing Backups']);
    expect(wrapper.find('.empty').text()).toBe(
      'This member takes no backups. They are taken on ns1.',
    );
    expect(opsStore.fetchBackups).toHaveBeenCalledOnce();
    expect(subnetStore.getSettings).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('shows everything on a controller', async () => {
    features.isMember = false;
    const wrapper = mountView();
    await flushPromises();
    expect(headings(wrapper)).toEqual([
      'Manual Backup',
      'Schedule',
      'Existing Backups',
      'Restore from Backup',
      'Database Reset',
    ]);
    expect(wrapper.find('.empty').text()).toBe('Create a backup now or enable the schedule below.');
    wrapper.unmount();
  });
});
