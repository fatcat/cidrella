/**
 * Settings > Instances. On the controller: the list with last contact and
 * how far behind each member is, Add member (a join token shown with its
 * warning), and Remove through the confirmation. On a member: the controller
 * it follows, the sync state, and the list with no actions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, h, inject, provide, ref } from 'vue';

const { auth, api, toast, features } = vi.hoisted(() => ({
  auth: { isAdmin: true },
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  toast: { add: vi.fn() },
  features: { reload: vi.fn(() => Promise.resolve()), instance: null },
}));
vi.mock('../../../src/stores/auth.js', () => ({ useAuthStore: () => auth }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/composables/useFeatures.js', () => ({ useFeatures: () => features }));
vi.mock('../../../src/ui/Button.js', () => ({
  default: {
    props: ['label', 'disabled', 'loading'],
    emits: ['click'],
    template:
      '<button :disabled="disabled || loading" @click="$emit(\'click\')">{{ label }}</button>',
  },
}));
vi.mock('../../../src/ui/InputText.js', () => ({
  default: { props: ['modelValue'], template: '<input :value="modelValue" readonly />' },
}));
vi.mock('../../../src/ui/Message.js', () => ({
  default: { template: '<div class="msg"><slot /></div>' },
}));
vi.mock('../../../src/ui/Dialog.js', () => ({
  default: {
    props: ['visible', 'header'],
    emits: ['update:visible', 'hide'],
    template:
      '<div v-if="visible" class="dialog"><h2>{{ header }}</h2><slot /><slot name="footer" /></div>',
  },
}));
// A table that renders each row through the columns' body slots, as the
// vendor one does: one <tr> per row, one <td> per column.
vi.mock('../../../src/ui/DataTable.js', () => {
  const Row = {
    props: { row: { type: Object, required: true } },
    setup(props, { slots }) {
      provide('row', props.row);
      return () => h('tr', slots.default?.());
    },
  };
  return {
    default: {
      props: { value: { type: Array, default: () => [] } },
      setup(props, { slots }) {
        return () =>
          h(
            'table',
            (props.value || []).map((row) => h(Row, { row, key: row.id }, () => slots.default?.())),
          );
      },
    },
  };
});
vi.mock('../../../src/ui/Column.js', () => ({
  default: {
    props: { header: { type: String, default: '' } },
    setup(props, { slots }) {
      const row = inject('row');
      return () => h('td', { 'data-col': props.header }, slots.body?.({ data: row }));
    },
  },
}));
vi.mock('../../../src/components/ConfirmDialog.vue', () => ({
  default: {
    props: ['visible', 'header', 'severity'],
    emits: ['confirm', 'update:visible'],
    template:
      '<div v-if="visible" class="confirm"><h2>{{ header }}</h2><slot /><button class="go" @click="$emit(\'confirm\')">Remove</button></div>',
  },
}));

const { EMPTY_CELL } = await import('../../../src/utils/format.js');
const InstancesSettings = (await import('../../../src/views/settings/InstancesSettings.vue'))
  .default;

const SELF = { instance_id: 'i-ctl', name: 'ns1', fingerprint: 'AA:BB', version: '0.7.0' };
const controllerRow = (extra = {}) => ({
  id: 1,
  instance_id: 'i-ctl',
  name: 'ns1',
  address: '10.0.0.2',
  port: 443,
  is_controller: true,
  is_self: true,
  serves_dns: true,
  version: '0.7.0',
  last_contact_at: null,
  behind: null,
  ...extra,
});
const memberRow = (id, extra = {}) => ({
  id,
  instance_id: `i-m${id}`,
  name: `ns${id}`,
  address: '2001:db8::5',
  port: 8443,
  is_controller: false,
  is_self: false,
  serves_dns: true,
  version: '0.7.0',
  last_contact_at: '2026-11-21T11:58:00Z',
  behind: 0,
  ...extra,
});

const CONTROLLER = {
  mode: 'controller',
  self: SELF,
  controller: null,
  sync: null,
  instances: [
    controllerRow(),
    memberRow(2),
    memberRow(3, { address: '10.0.0.7', port: 443, behind: 3 }),
    memberRow(4, { last_contact_at: null, behind: null, version: null }),
  ],
};
const MEMBER = {
  mode: 'member',
  self: { ...SELF, instance_id: 'i-m2', name: 'ns2' },
  controller: { instance_id: 'i-ctl', name: 'ns1', address: '10.0.0.2', port: 443 },
  sync: {
    state: 'behind',
    last_sync_at: '2026-11-21T11:30:00Z',
    last_error: null,
    cursor: 41,
  },
  instances: [
    controllerRow({ is_self: false }),
    memberRow(2, { is_self: true, last_contact_at: null, behind: null }),
  ],
};

const membersOf = ref(3);
async function mountPage(state) {
  api.get.mockResolvedValue({ data: state });
  const w = mount(InstancesSettings);
  await flushPromises();
  return w;
}
const cells = (w, header) => w.findAll(`td[data-col="${header}"]`).map((td) => td.text());

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
  auth.isAdmin = true;
  membersOf.value = 3;
  features.instance = computed(() => ({ mode: 'controller', members: membersOf.value }));
});
afterEach(() => vi.useRealTimers());

describe('on the controller', () => {
  it('lists every instance with its role, address, version, last contact and lag in words', async () => {
    const w = await mountPage(CONTROLLER);
    expect(api.get).toHaveBeenCalledWith('/instances');
    expect(cells(w, 'Name')).toEqual(['ns1 (this instance)', 'ns2', 'ns3', 'ns4']);
    expect(cells(w, 'Address')).toEqual([
      '10.0.0.2:443',
      '[2001:db8::5]:8443',
      '10.0.0.7:443',
      '[2001:db8::5]:8443',
    ]);
    expect(cells(w, 'Role')).toEqual(['Controller', 'Member', 'Member', 'Member']);
    expect(cells(w, 'Version')).toEqual(['0.7.0', '0.7.0', '0.7.0', EMPTY_CELL]);
    expect(cells(w, 'Last contact')).toEqual([EMPTY_CELL, '2m ago', '2m ago', 'Never']);
    expect(cells(w, 'Sync')).toEqual([
      EMPTY_CELL,
      'Current',
      '3 changes behind',
      'Not heard from yet',
    ]);
    // Only members can be removed, never the controller's own row.
    expect(w.findAll('[data-track="instances-remove"]')).toHaveLength(3);
    expect(w.find('[data-track="instances-following"]').exists()).toBe(false);
    expect(features.reload).not.toHaveBeenCalled();
    w.unmount();
  });

  it('re-reads the features when the list holds a member the header does not know', async () => {
    membersOf.value = 0;
    const w = await mountPage(CONTROLLER);
    expect(features.reload).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it('Add member makes a join token and shows it with the steps, its expiry and the warning', async () => {
    api.post.mockResolvedValue({
      status: 201,
      data: { token: 'cj1.abcdef', expires_at: '2026-11-21T12:15:00Z' },
    });
    const writeText = vi.fn().mockResolvedValue();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const w = await mountPage(CONTROLLER);
    expect(w.find('.dialog').exists()).toBe(false);

    await w.find('[data-track="instances-add-member"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/instances/join-token');
    const dialog = w.find('.dialog');
    expect(dialog.find('h2').text()).toBe('Add a member');
    expect(dialog.find('[data-track="instances-token"]').element.value).toBe('cj1.abcdef');
    expect(dialog.text()).toContain('Join an existing CIDRella');
    expect(dialog.text()).toContain("Enter this box's address and the token below.");
    expect(dialog.text()).toContain('works once');
    expect(dialog.text()).toContain('15 minutes');
    expect(dialog.find('.msg').text()).toBe(
      'A member holds a full copy of the data, password hashes and two-factor secrets included. Give it the same protection as this box.',
    );

    await dialog.find('[data-track="instances-token-copy"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('cj1.abcdef');
    expect(dialog.find('[data-track="instances-token-copy"]').text()).toBe('Copied');

    await dialog.find('[data-track="instances-token-done"]').trigger('click');
    expect(w.find('.dialog').exists()).toBe(false);
    vi.unstubAllGlobals();
    w.unmount();
  });

  it("shows the server's words when no token can be made", async () => {
    api.post.mockRejectedValue({
      response: { data: { error: 'Only the controller adds members.' } },
    });
    const w = await mountPage(CONTROLLER);
    await w.find('[data-track="instances-add-member"]').trigger('click');
    await flushPromises();
    expect(w.find('.dialog').exists()).toBe(false);
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', detail: 'Only the controller adds members.' }),
    );
    w.unmount();
  });

  it('Remove asks first, says what the member keeps doing, then deletes and reloads', async () => {
    api.delete.mockResolvedValue({ status: 204 });
    const w = await mountPage(CONTROLLER);
    await w.findAll('[data-track="instances-remove"]')[1].trigger('click');
    const confirm = w.find('.confirm');
    expect(confirm.find('h2').text()).toBe('Remove ns3?');
    expect(confirm.text()).toContain('ns3 stops receiving changes from this controller');
    expect(confirm.text()).toContain('keeps serving DNS from the copy it has');
    expect(api.delete).not.toHaveBeenCalled();

    await confirm.find('.go').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/instances/3');
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(features.reload).toHaveBeenCalled();
    expect(w.find('.confirm').exists()).toBe(false);
    w.unmount();
  });

  it('keeps the member listed and says why when the removal is refused', async () => {
    api.delete.mockRejectedValue({ response: { data: { error: 'No such instance' } } });
    const w = await mountPage(CONTROLLER);
    await w.findAll('[data-track="instances-remove"]')[0].trigger('click');
    await w.find('.confirm .go').trigger('click');
    await flushPromises();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', detail: 'No such instance' }),
    );
    w.unmount();
  });
});

describe('on a member', () => {
  it('names the controller it follows and the sync state, and offers no actions', async () => {
    features.instance = computed(() => ({ mode: 'member', members: 0 }));
    const w = await mountPage(MEMBER);
    const following = w.find('[data-track="instances-following"]');
    expect(following.text()).toContain('This instance is a member of ns1');
    expect(following.text()).toContain('10.0.0.2:443');
    expect(following.text()).toContain('Behind the controller');
    expect(following.text()).toContain('Last sync 30m ago');
    expect(following.find('.cid-status-dot').classes()).toContain('sd-warn');
    expect(w.find('[data-track="instances-sync-error"]').exists()).toBe(false);

    expect(cells(w, 'Name')).toEqual(['ns1', 'ns2 (this instance)']);
    expect(cells(w, 'Role')).toEqual(['Controller', 'Member']);
    expect(cells(w, 'Last contact')).toEqual([]);
    expect(cells(w, 'Sync')).toEqual([]);
    expect(w.find('[data-track="instances-add-member"]').exists()).toBe(false);
    expect(w.find('[data-track="instances-remove"]').exists()).toBe(false);
    expect(features.reload).not.toHaveBeenCalled();
    w.unmount();
  });

  it('shows why sync is paused', async () => {
    const w = await mountPage({
      ...MEMBER,
      sync: {
        state: 'paused',
        last_sync_at: '2026-11-21T09:00:00Z',
        last_error: 'ns1 runs 0.7.1 and this instance 0.7.0. Update this instance.',
        cursor: 41,
      },
    });
    expect(w.find('[data-track="instances-following"]').text()).toContain('Sync is paused');
    expect(w.find('[data-track="instances-sync-error"]').text()).toBe(
      'ns1 runs 0.7.1 and this instance 0.7.0. Update this instance.',
    );
    w.unmount();
  });
});

describe('without the admin role', () => {
  it('reads nothing and says who can', async () => {
    auth.isAdmin = false;
    const w = await mountPage(CONTROLLER);
    expect(api.get).not.toHaveBeenCalled();
    expect(w.text()).toContain('Only an administrator can see the instances.');
    expect(w.find('[data-track="instances-add-member"]').exists()).toBe(false);
    w.unmount();
  });
});
