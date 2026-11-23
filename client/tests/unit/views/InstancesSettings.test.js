/**
 * Settings > Instances. On the controller: the list with last contact and
 * how far behind each member is, Add member (a join token shown with its
 * warning), and Remove through the confirmation. On a member: the controller
 * it follows, the sync state, and the list with no actions.
 *
 * DHCP: which instance serves it, Move DHCP here on the controller's view,
 * the line and the re-reads while a handover is pending, and Start without
 * the old leases once it has waited a minute. Against mocked API calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, h, inject, provide, ref } from 'vue';

const { auth, api, toast, features, signInAgain } = vi.hoisted(() => ({
  signInAgain: vi.fn(() => Promise.resolve()),
  auth: { isAdmin: true },
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  toast: { add: vi.fn() },
  features: { reload: vi.fn(() => Promise.resolve()), instance: null },
}));
vi.mock('../../../src/stores/auth.js', () => ({ useAuthStore: () => auth }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/composables/useFeatures.js', () => ({ useFeatures: () => features }));
vi.mock('../../../src/composables/useSignInAgain.js', () => ({
  useSignInAgain: () => signInAgain,
}));
// The replaced controller's panel has its own test; here it only reports a
// rejoin, or that it took the controller back.
vi.mock('../../../src/components/instances/FencedPanel.vue', () => ({
  default: {
    props: ['fenced', 'selfName'],
    emits: ['rejoined', 'took-back'],
    template:
      '<section class="fenced-stub" :data-by="fenced.by_name" :data-report="String(fenced.report)" :data-self="selfName"><button class="rejoined" @click="$emit(\'rejoined\', \'ns2\')">rejoin</button><button class="took-back" @click="$emit(\'took-back\')">take back</button></section>',
  },
}));
// The rejoin form is tested through that panel; here it only reports a rejoin.
vi.mock('../../../src/components/instances/RejoinForm.vue', () => ({
  default: {
    props: ['header'],
    emits: ['rejoined'],
    template:
      '<form class="rejoin-stub" :data-header="header"><button type="button" class="rejoined" @click="$emit(\'rejoined\', \'ns3\')">rejoin</button></form>',
  },
}));
vi.mock('vue-router', () => ({
  RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
}));
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
      // A getter, so a row that is read again shows what the new read says.
      provide('row', () => props.row);
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
      return () => h('td', { 'data-col': props.header }, slots.body?.({ data: row() }));
    },
  },
}));
vi.mock('../../../src/components/ConfirmDialog.vue', () => ({
  default: {
    props: ['visible', 'header', 'severity', 'confirmLabel', 'typeToConfirm', 'disabled'],
    emits: ['confirm', 'update:visible'],
    template:
      '<div v-if="visible" class="confirm" :data-severity="severity || \'danger\'" :data-typed="typeToConfirm"><h2>{{ header }}</h2><slot /><button class="go" :disabled="disabled" @click="$emit(\'confirm\')">{{ confirmLabel }}</button></div>',
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

// What a server that can move DHCP adds to the list.
const withDhcp = (rows, handover = null, active = 'i-ctl') => ({
  ...CONTROLLER,
  dhcp: { active_instance_id: active, term: 4, handover },
  instances: rows,
});
const SERVED_BY_CONTROLLER = withDhcp([
  controllerRow({
    dhcp: 'serving',
    can_take_dhcp: false,
    dns_state: 'serving',
    dhcp_state: 'serving',
  }),
  memberRow(2, { dhcp: null, can_take_dhcp: true, dns_state: 'serving', dhcp_state: 'off' }),
  // Out of contact: the server does not vouch for what it does.
  memberRow(3, { dhcp: null, can_take_dhcp: false, behind: 3 }),
]);
const SERVED_BY_MEMBER = withDhcp(
  [
    controllerRow({ dhcp: null, can_take_dhcp: true, dns_state: 'serving', dhcp_state: 'off' }),
    memberRow(2, {
      dhcp: 'serving',
      can_take_dhcp: false,
      dns_state: 'down',
      dhcp_state: 'serving',
    }),
    memberRow(3, { dhcp: null, can_take_dhcp: true, dns_state: 'off', dhcp_state: 'off' }),
  ],
  null,
  'i-m2',
);
const movingSince = (since) =>
  withDhcp(
    [
      controllerRow({ dhcp: 'handing_over', can_take_dhcp: false }),
      memberRow(2, { dhcp: 'starting', can_take_dhcp: false }),
      memberRow(3, { dhcp: null, can_take_dhcp: false }),
    ],
    { from_instance_id: 'i-ctl', from_name: 'ns1', since },
    'i-m2',
  );
const refusal = (code, error) => ({ response: { status: 409, data: { error, code } } });

describe('backups on the controller', () => {
  it('says when backups are switched off, with the way to the backup settings', async () => {
    const w = await mountPage({ ...CONTROLLER, backups_off: true });
    const line = w.find('[data-track="instances-backups-off"]');
    expect(line.text().replace(/\s+/g, ' ')).toBe(
      'Backups are switched off on this controller. Switch them on under Settings > Maintenance > Backup & Restore.',
    );
    expect(line.find('.cid-status-dot').classes()).toContain('sd-warn');
    expect(line.find('a').attributes('href')).toBe('/system?area=maintenance&sec=backup');
    w.unmount();
  });

  it('says nothing when they are on, on an older server, or on a member', async () => {
    for (const state of [
      { ...CONTROLLER, backups_off: false },
      CONTROLLER,
      { ...MEMBER, backups_off: true },
    ]) {
      const w = await mountPage(state);
      expect(w.find('[data-track="instances-backups-off"]').exists()).toBe(false);
      w.unmount();
    }
  });
});

describe('DHCP on the controller', () => {
  it('says which instance serves DHCP and offers the move only where the server allows it', async () => {
    const w = await mountPage(SERVED_BY_CONTROLLER);
    expect(cells(w, 'DHCP')).toEqual(['On', 'Off', '—']);
    expect(cells(w, 'DNS')).toEqual(['On', 'On', '—']);
    expect(w.find('td[data-col="DHCP"] .cid-status-dot').classes()).toContain('sd-ok');
    const rowsWithMove = w
      .findAll('tr')
      .map((tr) => tr.find('[data-track="instances-dhcp-move"]').exists());
    expect(rowsWithMove).toEqual([false, true, false]);
    expect(w.find('[data-track="instances-dhcp-handover"]').exists()).toBe(false);
    w.unmount();
  });

  it('says DHCP is switched off where it is assigned and off, instead of serving', async () => {
    const w = await mountPage({
      ...SERVED_BY_CONTROLLER,
      instances: [
        controllerRow({ dhcp: 'serving', dns_state: 'serving', dhcp_state: 'off' }),
        memberRow(2, { dhcp: null, dns_state: 'serving', dhcp_state: 'serving' }),
      ],
    });
    expect(cells(w, 'DHCP')).toEqual(['Off', 'On, not assigned']);
    const [assigned, stray] = w.findAll('td[data-col="DHCP"]');
    expect(assigned.find('[title]').attributes('title')).toContain('no instance serves it');
    expect(stray.find('.cid-status-dot').classes()).toContain('sd-err');
    w.unmount();
  });

  it('offers the move back to the controller while a member serves', async () => {
    const w = await mountPage(SERVED_BY_MEMBER);
    expect(cells(w, 'DHCP')).toEqual(['Off', 'On', 'Off']);
    expect(cells(w, 'DNS')).toEqual(['On', 'Not running', 'Off']);
    const rowsWithMove = w
      .findAll('tr')
      .map((tr) => tr.find('[data-track="instances-dhcp-move"]').exists());
    expect(rowsWithMove).toEqual([true, false, true]);
    w.unmount();
  });

  it('Move DHCP here asks first in plain words, then moves it and reads the list again', async () => {
    api.post.mockResolvedValue({
      data: {
        active_instance_id: 'i-m2',
        term: 5,
        handover: { from_instance_id: 'i-ctl', from_name: 'ns1', since: '2026-11-21T12:00:00Z' },
      },
    });
    const w = await mountPage(SERVED_BY_CONTROLLER);
    await w.find('[data-track="instances-dhcp-move"]').trigger('click');
    const confirm = w.find('.confirm');
    expect(confirm.attributes('data-severity')).toBe('warn');
    expect(confirm.find('h2').text()).toBe('Move DHCP to ns2?');
    expect(confirm.find('.go').text()).toBe('Move DHCP');
    const text = confirm.text().replace(/\s+/g, ' ');
    expect(text).toContain('ns1 serves DHCP now. After the move, ns2 serves it and ns1 stops.');
    expect(text).toContain('Clients keep their leases: ns1 hands them over to ns2.');
    expect(text).toContain('DHCP stops for a moment during the move.');
    expect(text).toContain(
      'ns2 must be on a network where the clients can reach it: on the same segments, or with the DHCP relays pointed at it. CIDRella cannot check this.',
    );
    expect(api.post).not.toHaveBeenCalled();

    await confirm.find('.go').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/instances/2/dhcp');
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'success', summary: 'DHCP is moving to ns2' }),
    );
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(w.find('.confirm').exists()).toBe(false);
    w.unmount();
  });

  it('names the member that serves now when DHCP moves back', async () => {
    api.post.mockResolvedValue({ data: { active_instance_id: 'i-ctl', term: 6, handover: null } });
    const w = await mountPage(SERVED_BY_MEMBER);
    await w.find('[data-track="instances-dhcp-move"]').trigger('click');
    expect(w.find('.confirm').text().replace(/\s+/g, ' ')).toContain(
      'ns2 serves DHCP now. After the move, ns1 serves it and ns2 stops.',
    );
    await w.find('.confirm .go').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/instances/1/dhcp');
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: 'ns1 serves DHCP' }));
    w.unmount();
  });

  it("shows the server's words when the move is refused, and reads the list again", async () => {
    api.post.mockRejectedValue(
      refusal('not_current', 'ns2 is 3 changes behind. Wait until it is current.'),
    );
    const w = await mountPage(SERVED_BY_CONTROLLER);
    await w.find('[data-track="instances-dhcp-move"]').trigger('click');
    await w.find('.confirm .go').trigger('click');
    await flushPromises();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        summary: 'DHCP not moved',
        detail: 'ns2 is 3 changes behind. Wait until it is current.',
      }),
    );
    expect(w.find('.confirm').exists()).toBe(false);
    expect(api.get).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it('will not remove the instance that serves DHCP, and says to move it first', async () => {
    const w = await mountPage(SERVED_BY_MEMBER);
    const [serving, other] = w.findAll('[data-track="instances-remove"]');
    expect(serving.attributes('disabled')).toBeDefined();
    expect(serving.attributes('title')).toBe('Move DHCP to another instance before removing ns2');
    expect(other.attributes('disabled')).toBeUndefined();
    expect(other.attributes('title')).toBe('Remove');
    await serving.trigger('click');
    expect(w.find('.confirm').exists()).toBe(false);
    w.unmount();
  });

  it("shows the server's words when a removal is refused because the member serves DHCP", async () => {
    api.delete.mockRejectedValue(
      refusal('dhcp_active', 'ns3 serves DHCP. Move DHCP to another instance first.'),
    );
    const w = await mountPage(SERVED_BY_CONTROLLER);
    await w.findAll('[data-track="instances-remove"]')[1].trigger('click');
    await w.find('.confirm .go').trigger('click');
    await flushPromises();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        detail: 'ns3 serves DHCP. Move DHCP to another instance first.',
      }),
    );
    w.unmount();
  });

  it('shows nothing new for a server that says nothing about DHCP', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
    const w = await mountPage(CONTROLLER);
    expect(cells(w, 'DHCP').every((cell) => cell === '—')).toBe(true);
    expect(w.find('[data-track="instances-dhcp-move"]').exists()).toBe(false);
    expect(w.find('[data-track="instances-dhcp-handover"]').exists()).toBe(false);
    expect(w.find('[data-track="instances-dhcp-force"]').exists()).toBe(false);
    for (const remove of w.findAll('[data-track="instances-remove"]')) {
      expect(remove.attributes('disabled')).toBeUndefined();
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.get).toHaveBeenCalledTimes(1);
    w.unmount();
  });
});

describe('while DHCP is moving', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
  });

  it('says what it waits for and how long, and reads the list again until the move is done', async () => {
    const w = await mountPage(movingSince('2026-11-21T11:59:50Z'));
    const line = w.find('[data-track="instances-dhcp-handover"]');
    expect(line.text()).toContain(
      'DHCP is moving to ns2. Waiting for ns1 to hand over its leases, 10 seconds so far.',
    );
    expect(line.find('.cid-status-dot').classes()).toContain('sd-warn');
    expect(cells(w, 'DHCP')).toEqual(['Handing over', 'Starting, waiting for ns1', '—']);
    expect(api.get).toHaveBeenCalledTimes(1);

    // The wait counts up between reads.
    await vi.advanceTimersByTimeAsync(3000);
    expect(line.text()).toContain('13 seconds so far');
    expect(api.get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.get).toHaveBeenCalledTimes(2);

    // The old instance handed over: the line goes and the reads stop.
    api.get.mockResolvedValue({
      data: withDhcp(
        [
          controllerRow({ dhcp: null, can_take_dhcp: true, dhcp_state: 'off' }),
          memberRow(2, { dhcp: 'serving', dhcp_state: 'serving' }),
        ],
        null,
        'i-m2',
      ),
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(w.find('[data-track="instances-dhcp-handover"]').exists()).toBe(false);
    expect(cells(w, 'DHCP')).toEqual(['Off', 'On']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.get).toHaveBeenCalledTimes(3);
    w.unmount();
  });

  it('stops reading when the page is left, and a failed re-read raises no toast', async () => {
    const w = await mountPage(movingSince('2026-11-21T11:59:50Z'));
    api.get.mockRejectedValue(new Error('Network Error'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(toast.add).not.toHaveBeenCalled();
    expect(w.find('[data-track="instances-dhcp-handover"]').exists()).toBe(true);
    w.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('offers Start without the old leases only after a minute of waiting', async () => {
    const w = await mountPage(movingSince('2026-11-21T11:59:10Z'));
    expect(w.find('[data-track="instances-dhcp-force"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.find('[data-track="instances-dhcp-force"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.find('[data-track="instances-dhcp-force"]').text()).toBe(
      'Start without the old leases',
    );
    expect(w.find('[data-track="instances-dhcp-handover"]').text()).toContain('1 minute so far');
    w.unmount();
  });

  it('Start without the old leases is gated on the old name, says the risk, then forces', async () => {
    api.post.mockResolvedValue({ data: { active_instance_id: 'i-m2', term: 5, handover: null } });
    const w = await mountPage(movingSince('2026-11-21T11:55:00Z'));
    expect(w.find('[data-track="instances-dhcp-handover"]').text()).toContain('5 minutes so far');
    await w.find('[data-track="instances-dhcp-force"]').trigger('click');
    const confirm = w.find('.confirm');
    expect(confirm.attributes('data-severity')).toBe('danger');
    expect(confirm.attributes('data-typed')).toBe('ns1');
    expect(confirm.find('h2').text()).toBe('Start DHCP on ns2 without the leases from ns1?');
    const text = confirm.text().replace(/\s+/g, ' ');
    expect(text).toContain('Do this only when ns1 is switched off or cut off for good.');
    expect(text).toContain('ns2 starts with the leases the controller last heard about.');
    expect(text).toContain('A lease ns1 gave after that is unknown to ns2.');
    expect(text).toContain('If ns1 is still running, two DHCP servers will answer on the network.');
    expect(api.post).not.toHaveBeenCalled();

    await confirm.find('.go').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/instances/dhcp/force', { confirm: true });
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: 'ns2 serves DHCP' }));
    expect(w.find('.confirm').exists()).toBe(false);
    expect(api.get).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it("shows the server's words when there is no handover left to force", async () => {
    api.post.mockRejectedValue(refusal('no_handover', 'No DHCP handover is pending.'));
    const w = await mountPage(movingSince('2026-11-21T11:55:00Z'));
    await w.find('[data-track="instances-dhcp-force"]').trigger('click');
    await w.find('.confirm .go').trigger('click');
    await flushPromises();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        summary: 'DHCP not started',
        detail: 'No DHCP handover is pending.',
      }),
    );
    w.unmount();
  });
});

describe('on a member', () => {
  it('shows which instance serves DHCP and the pending move, with no actions', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
    features.instance = computed(() => ({ mode: 'member', members: 0 }));
    const w = await mountPage({
      ...MEMBER,
      dhcp: {
        active_instance_id: 'i-m2',
        term: 5,
        handover: { from_instance_id: 'i-ctl', from_name: 'ns1', since: '2026-11-21T11:50:00Z' },
      },
      instances: [
        controllerRow({ is_self: false, dhcp: 'handing_over', can_take_dhcp: false }),
        memberRow(2, { is_self: true, dhcp: 'starting', can_take_dhcp: false }),
      ],
    });
    expect(cells(w, 'DHCP')).toEqual(['Handing over', 'Starting, waiting for ns1']);
    expect(w.find('[data-track="instances-dhcp-handover"]').text()).toContain(
      'DHCP is moving to ns2. Waiting for ns1 to hand over its leases, 10 minutes so far.',
    );
    expect(w.find('[data-track="instances-dhcp-force"]').exists()).toBe(false);
    expect(w.find('[data-track="instances-dhcp-move"]').exists()).toBe(false);
    expect(w.find('[data-track="instances-remove"]').exists()).toBe(false);
    w.unmount();
  });

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

describe('Join a controller again, on a member that cannot reach its controller', () => {
  const OFFLINE = {
    ...MEMBER,
    sync: {
      state: 'offline',
      last_sync_at: '2026-11-21T09:00:00Z',
      last_error: 'ns1 does not know this instance.',
      cursor: 41,
    },
  };
  beforeEach(() => {
    features.instance = computed(() => ({ mode: 'member', members: 0 }));
  });

  it('is not offered while the controller answers', async () => {
    const w = await mountPage(MEMBER);
    expect(w.find('[data-track="instances-join-again"]').exists()).toBe(false);
    expect(w.find('.rejoin-stub').exists()).toBe(false);
    w.unmount();
  });

  it('is closed until asked for, then says what it is for and shows the form', async () => {
    const w = await mountPage(OFFLINE);
    const open = w.find('[data-track="instances-join-again"]');
    expect(open.text()).toBe('Join a controller again');
    expect(w.find('.rejoin-stub').exists()).toBe(false);

    await open.trigger('click');
    expect(w.find('[data-track="instances-join-again-form"]').text()).toContain(
      'Use this when the controller was replaced and the new one does not know this instance. Make a join token on the controller under Settings > System > Instances > Add member.',
    );
    // No header of its own: the confirmation names the address entered.
    expect(w.find('.rejoin-stub').attributes('data-header')).toBeUndefined();

    await open.trigger('click');
    expect(w.find('.rejoin-stub').exists()).toBe(false);
    w.unmount();
  });

  it('after the join says it is restarting, then goes to sign-in as a member', async () => {
    timers();
    serve(OFFLINE, () => ({ data: { instance: { mode: 'member', controller_name: 'ns3' } } }));
    const w = mount(InstancesSettings);
    await flushPromises();
    await w.find('[data-track="instances-join-again"]').trigger('click');
    await w.find('.rejoin-stub .rejoined').trigger('click');
    expect(w.find('[data-track="instances-restarting"]').text()).toContain(
      'Restarting as a member of ns3. The sign-in page opens when it is back.',
    );
    expect(w.find('[data-track="instances-join-again"]').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(signInAgain).toHaveBeenCalledWith('joined', 'ns3');
    w.unmount();
  });
});

// Changing the controller. GET /instances and GET /features answer apart.
function serve(instances, featuresAnswer = () => ({ data: { instance: { mode: 'controller' } } })) {
  api.get.mockImplementation((url) =>
    url === '/features'
      ? Promise.resolve().then(featuresAnswer)
      : Promise.resolve({ data: typeof instances === 'function' ? instances() : instances }),
  );
}
const listReads = () => api.get.mock.calls.filter(([url]) => url === '/instances').length;
const featureReads = () => api.get.mock.calls.filter(([url]) => url === '/features').length;
const timers = () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
};
const withPromotion = (base, promotion, rows = base.instances) => ({
  ...base,
  promotion: { handover: null, fenced: null, ...promotion },
  instances: rows,
});
const PROMOTABLE = withPromotion(CONTROLLER, {}, [
  controllerRow(),
  memberRow(2, { can_promote: true }),
  memberRow(3, { behind: 3, can_promote: false }),
]);
const handingOver = (since) =>
  withPromotion(CONTROLLER, { handover: { to_instance_id: 'i-m2', to_name: 'ns2', since } }, [
    controllerRow(),
    memberRow(2, { can_promote: false }),
  ]);
const MEMBER_CAN_PROMOTE = withPromotion(MEMBER, {});

describe('Make controller, on the controller', () => {
  beforeEach(timers);

  it('is offered only on the rows the server allows', async () => {
    const w = await mountPage(PROMOTABLE);
    const actions = cells(w, '');
    expect(actions[0]).not.toContain('Make controller');
    expect(actions[1]).toContain('Make controller');
    expect(actions[2]).not.toContain('Make controller');
    expect(w.find('[data-track="instances-promote-self"]').exists()).toBe(false);
    expect(w.find('.fenced-stub').exists()).toBe(false);
    w.unmount();
  });

  it('asks first in plain words, then starts the handover and shows it pending', async () => {
    serve(PROMOTABLE);
    const w = mount(InstancesSettings);
    await flushPromises();
    api.post.mockResolvedValue({
      data: { handover: { to_instance_id: 'i-m2', to_name: 'ns2', since: '2026-11-21T12:00:00Z' } },
    });
    await w.find('[data-track="instances-promote"]').trigger('click');
    const dialog = w.find('.confirm');
    expect(dialog.attributes('data-severity')).toBe('warn');
    expect(dialog.attributes('data-typed')).toBeFalsy();
    expect(dialog.text()).toContain('Make ns2 the controller?');
    expect(dialog.text()).toContain(
      'ns2 becomes the controller, and this instance becomes a member of it.',
    );
    expect(dialog.text()).toContain('No changes can be made on either until it is done');
    expect(dialog.text()).toContain('DHCP stays on the instance that serves it now.');
    expect(dialog.text()).toContain('This instance restarts, and you sign in again.');
    expect(dialog.text()).toContain('this instance stays frozen until you cancel the handover');
    expect(dialog.text()).toContain('can leave this instance replaced anyway');
    expect(api.post).not.toHaveBeenCalled();

    // The list still says nothing of it: the answer to the request shows it.
    await dialog.find('.go').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/instances/2/promote');
    expect(features.reload).toHaveBeenCalled();
    expect(toast.add).not.toHaveBeenCalled();
    w.unmount();
  });

  it('keeps the pending line when the list cannot be read after the request', async () => {
    serve(PROMOTABLE);
    const w = mount(InstancesSettings);
    await flushPromises();
    api.post.mockResolvedValue({
      data: { handover: { to_instance_id: 'i-m2', to_name: 'ns2', since: '2026-11-21T12:00:00Z' } },
    });
    await w.find('[data-track="instances-promote"]').trigger('click');
    api.get.mockRejectedValue(new Error('Network Error'));
    await w.find('.confirm .go').trigger('click');
    await flushPromises();
    expect(w.find('[data-track="instances-promote-handover"]').text()).toContain(
      'Handing over to ns2.',
    );
    expect(toast.add).not.toHaveBeenCalled();
    w.unmount();
  });

  it.each(['not_current', 'schema_mismatch', 'handover_pending', 'dhcp_moving'])(
    "shows the server's words when it refuses with %s",
    async (code) => {
      const w = await mountPage(PROMOTABLE);
      api.post.mockRejectedValue({
        response: { status: 409, data: { error: 'ns2 is 3 changes behind.', code } },
      });
      await w.find('[data-track="instances-promote"]').trigger('click');
      await w.find('.confirm .go').trigger('click');
      await flushPromises();
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'error',
          summary: 'Controller not changed',
          detail: 'ns2 is 3 changes behind.',
        }),
      );
      expect(w.find('.confirm').exists()).toBe(false);
      expect(w.find('[data-track="instances-promote-handover"]').exists()).toBe(false);
      w.unmount();
    },
  );
});

describe('while the controller hands over', () => {
  beforeEach(timers);

  it('names the target and the wait, drops the controller actions, and reads again on one timer', async () => {
    serve(handingOver('2026-11-21T11:59:48Z'));
    const w = mount(InstancesSettings);
    await flushPromises();
    const line = w.find('[data-track="instances-promote-handover"]');
    expect(line.text()).toContain(
      'Handing over to ns2. Waiting for it to catch up and take over, 12 seconds so far.',
    );
    expect(line.find('.cid-status-dot').classes()).toContain('sd-warn');
    expect(w.find('[data-track="instances-add-member"]').exists()).toBe(false);
    expect(w.find('[data-track="instances-remove"]').exists()).toBe(false);
    expect(w.find('[data-track="instances-promote"]').exists()).toBe(false);
    expect(listReads()).toBe(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(line.text()).toContain('15 seconds so far');
    expect(listReads()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(listReads()).toBe(2);
    expect(featureReads()).toBe(1);
    expect(signInAgain).not.toHaveBeenCalled();

    // Cancelled from elsewhere: the line goes and the reads stop.
    serve(PROMOTABLE);
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.find('[data-track="instances-promote-handover"]').exists()).toBe(false);
    expect(w.find('[data-track="instances-add-member"]').exists()).toBe(true);
    const reads = api.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.get.mock.calls.length).toBe(reads);
    w.unmount();
  });

  it('shares the timer with a DHCP move', async () => {
    const both = {
      ...movingSince('2026-11-21T11:59:50Z'),
      promotion: {
        handover: { to_instance_id: 'i-m2', to_name: 'ns2', since: '2026-11-21T11:59:50Z' },
        fenced: null,
      },
    };
    serve(both);
    const w = mount(InstancesSettings);
    await flushPromises();
    expect(w.find('[data-track="instances-dhcp-handover"]').exists()).toBe(true);
    expect(w.find('[data-track="instances-promote-handover"]').exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(listReads()).toBe(2);
    w.unmount();
  });

  it('waits calmly while this instance restarts, then goes to sign-in as a member of the new controller', async () => {
    serve(handingOver('2026-11-21T11:59:58Z'));
    const w = mount(InstancesSettings);
    await flushPromises();

    // Restarting: nothing answers.
    api.get.mockRejectedValue(new Error('Network Error'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toast.add).not.toHaveBeenCalled();
    expect(signInAgain).not.toHaveBeenCalled();
    expect(w.find('[data-track="instances-promote-handover"]').exists()).toBe(true);

    // Back, as a member.
    serve(handingOver('2026-11-21T11:59:58Z'), () => ({
      data: { instance: { mode: 'member', controller_name: 'ns2' } },
    }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(signInAgain).toHaveBeenCalledTimes(1);
    expect(signInAgain).toHaveBeenCalledWith('joined', 'ns2');
    expect(api.get).toHaveBeenLastCalledWith('/features', { ownSessionEnd: true });
    const reads = api.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.get.mock.calls.length).toBe(reads);
    w.unmount();
  });

  it('takes a session that is gone after the restart as the arrival', async () => {
    serve(handingOver('2026-11-21T11:59:58Z'));
    const w = mount(InstancesSettings);
    await flushPromises();
    const gone = { response: { status: 401, data: { error: 'Unauthorized' } } };

    // A 401 before anything went away is an ordinary ended session, not this.
    serve(handingOver('2026-11-21T11:59:58Z'), () => Promise.reject(gone));
    await vi.advanceTimersByTimeAsync(5000);
    expect(signInAgain).not.toHaveBeenCalled();

    api.get.mockRejectedValue(new Error('Network Error'));
    await vi.advanceTimersByTimeAsync(5000);
    api.get.mockRejectedValue(gone);
    await vi.advanceTimersByTimeAsync(5000);
    expect(signInAgain).toHaveBeenCalledWith('joined', 'ns2');
    w.unmount();
  });

  it('Cancel handover states the race, then cancels and reads again', async () => {
    serve(handingOver('2026-11-21T11:59:48Z'));
    const w = mount(InstancesSettings);
    await flushPromises();
    api.post.mockResolvedValue({ data: { handover: null } });
    await w.find('[data-track="instances-promote-cancel"]').trigger('click');
    const dialog = w.find('.confirm');
    expect(dialog.attributes('data-severity')).toBe('warn');
    expect(dialog.text()).toContain('Cancel the handover to ns2?');
    expect(dialog.text()).toContain(
      'This instance takes changes again. If ns2 has already taken over, the cancel comes too late: this instance is replaced, and you rejoin it as a member.',
    );
    serve(PROMOTABLE);
    await dialog.find('.go').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/instances/promote/cancel');
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'success', summary: 'Handover cancelled' }),
    );
    expect(w.find('[data-track="instances-promote-handover"]').exists()).toBe(false);
    w.unmount();
  });

  it("shows the server's words when there is no handover left to cancel", async () => {
    serve(handingOver('2026-11-21T11:59:48Z'));
    const w = mount(InstancesSettings);
    await flushPromises();
    api.post.mockRejectedValue({
      response: { status: 409, data: { error: 'No handover is pending.', code: 'no_handover' } },
    });
    await w.find('[data-track="instances-promote-cancel"]').trigger('click');
    await w.find('.confirm .go').trigger('click');
    await flushPromises();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        summary: 'Handover not cancelled',
        detail: 'No handover is pending.',
      }),
    );
    w.unmount();
  });
});

describe('Promote this instance, on a member', () => {
  beforeEach(() => {
    timers();
    features.instance = computed(() => ({
      mode: 'member',
      members: 0,
      sync: { state: 'offline', last_sync_at: '2026-11-21T11:30:00Z' },
    }));
  });

  it('is offered on a member whose server knows how, and never on the controller', async () => {
    const w = await mountPage(MEMBER_CAN_PROMOTE);
    expect(w.find('[data-track="instances-promote-self"]').text()).toBe('Promote this instance');
    expect(w.find('[data-track="instances-promote"]').exists()).toBe(false);
    w.unmount();
    const older = await mountPage(MEMBER);
    expect(older.find('[data-track="instances-promote-self"]').exists()).toBe(false);
    older.unmount();
    const controller = await mountPage(PROMOTABLE);
    expect(controller.find('[data-track="instances-promote-self"]').exists()).toBe(false);
    controller.unmount();
  });

  it('is gated on this instance name and says when its data is from and what is lost', async () => {
    const w = await mountPage(MEMBER_CAN_PROMOTE);
    await w.find('[data-track="instances-promote-self"]').trigger('click');
    const dialog = w.find('.confirm');
    expect(dialog.attributes('data-severity')).toBe('danger');
    expect(dialog.attributes('data-typed')).toBe('ns2');
    expect(dialog.text()).toContain('Make ns2 the controller?');
    expect(dialog.text()).toContain('Do this only when ns1 is switched off or gone for good.');
    const sync = dialog.find('[data-track="instances-promote-self-sync"]').text();
    expect(sync).toContain('The data here is from the last sync,');
    expect(sync).toContain('(30m ago)');
    expect(sync).toContain(
      'Changes made on ns1 after that are not here and will not come back by themselves.',
    );
    expect(dialog.text()).toContain(
      'The other members follow this instance within about a minute.',
    );
    expect(dialog.text()).toContain(
      'DHCP is not started here automatically. If ns1 served DHCP, start it from this page afterwards.',
    );
    expect(dialog.text()).toContain(
      'If ns1 is in fact still running and clients can reach it, two controllers exist until it hears about this one.',
    );
    expect(dialog.find('.go').attributes('disabled')).toBeUndefined();
    expect(api.post).not.toHaveBeenCalled();
    w.unmount();
  });

  it('cannot be confirmed by a member that never synced', async () => {
    features.instance = computed(() => ({ mode: 'member', members: 0, sync: null }));
    const w = await mountPage({ ...MEMBER_CAN_PROMOTE, sync: { state: 'starting' } });
    await w.find('[data-track="instances-promote-self"]').trigger('click');
    expect(w.find('.confirm').text()).toContain('This instance has not synced yet');
    expect(w.find('.confirm .go').attributes('disabled')).toBeDefined();
    w.unmount();
  });

  it('promotes, says it is restarting, and goes to sign-in once it answers as the controller', async () => {
    serve(MEMBER_CAN_PROMOTE, () => ({ data: { instance: { mode: 'member' } } }));
    const w = mount(InstancesSettings);
    await flushPromises();
    api.post.mockResolvedValue({ data: { restarting: true } });
    await w.find('[data-track="instances-promote-self"]').trigger('click');
    await w.find('.confirm .go').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/instances/promote-self', { confirm: true });
    expect(w.find('[data-track="instances-restarting"]').text()).toContain(
      'Restarting as the controller. The sign-in page opens when it is back.',
    );
    expect(w.find('[data-track="instances-promote-self"]').exists()).toBe(false);

    // Still the member it was, then away, then back as the controller.
    const lists = listReads();
    await vi.advanceTimersByTimeAsync(5000);
    expect(featureReads()).toBe(1);
    api.get.mockRejectedValue(new Error('Network Error'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(signInAgain).not.toHaveBeenCalled();
    serve(MEMBER_CAN_PROMOTE, () => ({ data: { instance: { mode: 'controller', members: 1 } } }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(signInAgain).toHaveBeenCalledWith('promoted', null);
    // The list is not read while the box restarts.
    expect(listReads()).toBe(lists);
    expect(toast.add).not.toHaveBeenCalled();
    w.unmount();
  });

  it.each(['not_member', 'handover_pending', 'never_synced'])(
    "shows the server's words when it refuses with %s",
    async (code) => {
      const w = await mountPage(MEMBER_CAN_PROMOTE);
      api.post.mockRejectedValue({
        response: { status: 409, data: { error: 'The controller is handing over.', code } },
      });
      await w.find('[data-track="instances-promote-self"]').trigger('click');
      await w.find('.confirm .go').trigger('click');
      await flushPromises();
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'error',
          summary: 'Not promoted',
          detail: 'The controller is handing over.',
        }),
      );
      expect(w.find('[data-track="instances-restarting"]').exists()).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(signInAgain).not.toHaveBeenCalled();
      w.unmount();
    },
  );
});

describe('Promote this instance, refused because the controller answers', () => {
  it("shows the server's sentence and stays a member", async () => {
    timers();
    features.instance = computed(() => ({
      mode: 'member',
      members: 0,
      sync: { state: 'offline', last_sync_at: '2026-11-21T11:30:00Z' },
    }));
    const w = await mountPage(MEMBER_CAN_PROMOTE);
    const error = 'ns1 is still the controller and answers. Use Make controller on ns1 instead.';
    api.post.mockRejectedValue({
      response: { status: 409, data: { error, code: 'controller_reachable' } },
    });
    await w.find('[data-track="instances-promote-self"]').trigger('click');
    await w.find('.confirm .go').trigger('click');
    await flushPromises();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', summary: 'Not promoted', detail: error }),
    );
    expect(w.find('.confirm').exists()).toBe(false);
    expect(w.find('[data-track="instances-restarting"]').exists()).toBe(false);
    expect(w.find('[data-track="instances-promote-self"]').exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signInAgain).not.toHaveBeenCalled();
    w.unmount();
  });
});

describe('a controller that was replaced', () => {
  beforeEach(timers);
  const FENCED = withPromotion(CONTROLLER, {
    fenced: { by_name: 'ns2', epoch: 4, since: '2026-11-21T11:00:00Z', report: true },
  });

  it('shows the replaced panel in place of the controller actions', async () => {
    const w = await mountPage(FENCED);
    const panel = w.find('.fenced-stub');
    expect(panel.attributes('data-by')).toBe('ns2');
    expect(panel.attributes('data-report')).toBe('true');
    expect(panel.attributes('data-self')).toBe('ns1');
    expect(w.find('[data-track="instances-add-member"]').exists()).toBe(false);
    expect(w.find('[data-track="instances-remove"]').exists()).toBe(false);
    expect(w.find('[data-track="instances-promote"]').exists()).toBe(false);
    expect(w.text()).not.toContain('This instance is the controller');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.get).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it('believes the features when the list cannot be read', async () => {
    features.instance = computed(() => ({ mode: 'controller', members: 1, fenced: true }));
    api.get.mockRejectedValue(new Error('Network Error'));
    const w = mount(InstancesSettings);
    await flushPromises();
    expect(w.find('.fenced-stub').attributes('data-report')).toBe('false');
    w.unmount();
  });

  it('after a rejoin says it is restarting, then goes to sign-in as a member', async () => {
    serve(FENCED);
    const w = mount(InstancesSettings);
    await flushPromises();
    await w.find('.fenced-stub .rejoined').trigger('click');
    expect(w.find('.fenced-stub').exists()).toBe(false);
    expect(w.find('[data-track="instances-restarting"]').text()).toContain(
      'Restarting as a member of ns2. The sign-in page opens when it is back.',
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(signInAgain).not.toHaveBeenCalled();

    // The new controller's accounts replaced the ones here: the session is gone.
    api.get.mockRejectedValue({ response: { status: 401, data: { error: 'Unauthorized' } } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(signInAgain).toHaveBeenCalledWith('joined', 'ns2');
    w.unmount();
  });
});

describe('a replaced controller that takes the controller back', () => {
  it('says it is restarting, waits while it is still replaced, then goes to sign-in', async () => {
    timers();
    const FENCED = withPromotion(
      { ...CONTROLLER, mode: 'member' },
      { fenced: { by_name: 'ns2', epoch: 4, since: '2026-11-21T11:00:00Z', report: true } },
    );
    // Before the restart it still answers as it was: a member, replaced. A
    // box that reported itself a controller while replaced must not count.
    let answer = { mode: 'controller', fenced: true };
    serve(FENCED, () => ({ data: { instance: answer } }));
    const w = mount(InstancesSettings);
    await flushPromises();
    await w.find('.fenced-stub .took-back').trigger('click');
    expect(w.find('.fenced-stub').exists()).toBe(false);
    expect(w.find('[data-track="instances-restarting"]').text()).toContain(
      'Restarting as the controller. The sign-in page opens when it is back.',
    );
    await vi.advanceTimersByTimeAsync(5000);
    answer = { mode: 'member', fenced: true };
    await vi.advanceTimersByTimeAsync(5000);
    expect(signInAgain).not.toHaveBeenCalled();

    answer = { mode: 'controller', fenced: false, members: 1 };
    await vi.advanceTimersByTimeAsync(5000);
    expect(signInAgain).toHaveBeenCalledWith('promoted', null);
    w.unmount();
  });
});

describe('an older server, which says nothing about changing the controller', () => {
  it('shows none of it, on the controller or on a member', async () => {
    timers();
    for (const state of [CONTROLLER, MEMBER]) {
      const w = await mountPage(state);
      for (const track of [
        'instances-promote',
        'instances-promote-self',
        'instances-promote-handover',
        'instances-promote-cancel',
        'instances-restarting',
      ]) {
        expect(w.find(`[data-track="${track}"]`).exists()).toBe(false);
      }
      expect(w.find('.fenced-stub').exists()).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(api.get).toHaveBeenCalledTimes(1);
      w.unmount();
      api.get.mockClear();
    }
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
