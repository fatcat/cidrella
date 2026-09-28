import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import api from '../../../../src/api/client.js';
import AddressDetailsPanel from '../../../../src/views/networks-workspace/AddressDetailsPanel.vue';
import WorkspaceTable from '../../../../src/views/networks-workspace/WorkspaceTable.vue';
import { useWorkspaceActions } from '../../../../src/views/networks-workspace/composables/useWorkspaceActions.js';
import {
  actionAvailability,
  menuActions,
} from '../../../../src/views/networks-workspace/workspace-actions.js';

vi.mock('../../../../src/api/client.js', () => ({ default: { get: vi.fn(), put: vi.fn() } }));

const ID = 'dns.record.create-for-address';
const all = () => true;
const address = (allocation_state, extra = {}) => ({
  kind: 'address',
  id: 'address:10.0.0.9',
  address: '10.0.0.9',
  allocation_state,
  status: allocation_state === 'unassigned' ? 'available' : 'in use',
  raw: {},
  ...extra,
});

describe('Create DNS entry in the address row menu', () => {
  it('is offered for an address DNS may claim, after Create IP Reservation', () => {
    const ids = menuActions({ menu: 'row', target: address('unassigned'), can: all }).map(
      (item) => item.id,
    );
    expect(ids).toContain(ID);
    expect(ids.indexOf(ID)).toBe(ids.indexOf('ip.reserve') + 1);
    for (const state of ['reserved', 'gateway']) {
      expect(actionAvailability(ID, address(state), all).available).toBe(true);
    }
  });

  it('stays in the menu greyed out, with the reason, where it cannot run', () => {
    const network = menuActions({ menu: 'row', target: address('system'), can: all }).find(
      (item) => item.id === ID,
    );
    expect(network).toMatchObject({
      label: 'Create DNS entry',
      available: false,
      reason: expect.stringMatching(/network and broadcast/),
    });
    // Other unavailable entries are still left out.
    expect(
      menuActions({ menu: 'row', target: address('system'), can: all }).map((item) => item.id),
    ).not.toContain('ip.reserve');
  });

  it('is refused where the lifecycle would refuse the record', () => {
    expect(actionAvailability(ID, address('static_dns'), all).reason).toMatch(/CNAME/);
    expect(
      actionAvailability(ID, address('unassigned', { status: 'DHCP Scope' }), all).reason,
    ).toMatch(/DHCP pool/);
    expect(
      actionAvailability(ID, address('unassigned', { raw: { in_dynamic_pool: 1 } }), all).available,
    ).toBe(false);
    for (const state of ['dynamic_dhcp', 'static_dhcp', 'system']) {
      expect(actionAvailability(ID, address(state), all).available).toBe(false);
    }
  });

  it('needs dns:write, not subnets:write', () => {
    const target = address('unassigned');
    const labels = (can) => menuActions({ menu: 'row', target, can }).map((item) => item.label);
    expect(labels((capability) => capability === 'dns:write')).toContain('Create DNS entry');
    expect(labels((capability) => capability === 'subnets:write')).not.toContain(
      'Create DNS entry',
    );
  });
});

describe('the Create DNS entry handler', () => {
  let openRecordEditor;
  let showLiveNotice;

  function setup({ domain = 'lab.test', zones = [] } = {}) {
    openRecordEditor = vi.fn();
    showLiveNotice = vi.fn();
    const { invoke } = useWorkspaceActions({
      can: all,
      router: { push: vi.fn(), currentRoute: ref({ fullPath: '/' }) },
      state: {
        selectedNetwork: ref({ id: 11, domain_name: domain }),
        dnsZones: ref(zones),
        contextKind: ref('network'),
      },
      dialogs: {
        protocolDialogsMounted: ref(true),
        dnsDialogs: ref({ openRecordEditor }),
        dhcpDialogs: ref({}),
      },
      showLiveNotice,
    });
    return invoke;
  }

  beforeEach(() => vi.clearAllMocks());

  it("opens an A record for the address in the network's forward zone", async () => {
    const zone = { id: 21, name: 'Lab.Test.', type: 'forward' };
    const invoke = setup({ zones: [{ id: 22, name: 'lab.test', type: 'reverse' }, zone] });
    await invoke(ID, address('unassigned'));
    expect(openRecordEditor).toHaveBeenCalledWith(null, { type: 'A', value: '10.0.0.9' }, zone);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('opens an AAAA record for an IPv6 address', async () => {
    const zone = { id: 21, name: 'lab.test', type: 'forward' };
    const invoke = setup({ zones: [zone] });
    await invoke(ID, address('unassigned', { address: 'fd00::9' }));
    expect(openRecordEditor).toHaveBeenCalledWith(null, { type: 'AAAA', value: 'fd00::9' }, zone);
  });

  it('reads the zones when the loaded list does not have it', async () => {
    const zone = { id: 21, name: 'lab.test', type: 'forward' };
    api.get.mockResolvedValue({ data: [zone] });
    const invoke = setup();
    await invoke(ID, address('unassigned'));
    expect(api.get).toHaveBeenCalledWith('/dns/zones', { params: { type: 'forward' } });
    expect(openRecordEditor).toHaveBeenCalledWith(null, { type: 'A', value: '10.0.0.9' }, zone);
  });

  it('says what is missing instead of opening an editor with no zone', async () => {
    let invoke = setup({ domain: null });
    await invoke(ID, address('unassigned'));
    expect(showLiveNotice).toHaveBeenCalledWith(expect.stringMatching(/no DNS domain/));

    api.get.mockResolvedValue({ data: [] });
    invoke = setup();
    await invoke(ID, address('unassigned'));
    expect(showLiveNotice).toHaveBeenCalledWith(
      'There is no forward zone for lab.test. Add it in DNS first.',
    );
    expect(openRecordEditor).not.toHaveBeenCalled();
  });
});

describe('Create DNS entry in the address details panel', () => {
  const row = { address: '10.0.0.9', type: '', raw: { allocation_state: 'unassigned' } };
  const mountPanel = (props) => {
    api.get.mockResolvedValue({ data: { events: [] } });
    return mount(AddressDetailsPanel, { props: { row, subnetId: 11, ...props } });
  };

  it('offers the row-menu item and hands it back as an action', async () => {
    const item = {
      id: ID,
      label: 'Create DNS entry',
      available: true,
      reason: '',
      target: address('unassigned'),
    };
    const wrapper = mountPanel({ dnsAction: item });
    await flushPromises();
    const button = wrapper.find('[data-track="workspace-address-create-dns"]');
    expect(button.text()).toBe('Create DNS entry');
    // A DNS writer without subnets:write gets the button but not the address edits.
    expect(wrapper.text()).not.toContain('Probe now');
    await button.trigger('click');
    expect(wrapper.emitted('action')).toEqual([[item]]);
  });

  it('greys the button out with the reason where the entry cannot run', async () => {
    const item = {
      id: ID,
      label: 'Create DNS entry',
      available: false,
      reason: 'The network and broadcast addresses belong to the network and cannot be named.',
    };
    const wrapper = mountPanel({ dnsAction: item });
    await flushPromises();
    const button = wrapper.find('[data-track="workspace-address-create-dns"]');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.attributes('title')).toBe(item.reason);
    await button.trigger('click');
    expect(wrapper.emitted('action')).toBeUndefined();
  });

  it('shows no button without dns:write', async () => {
    const wrapper = mountPanel({ canWrite: true, dnsAction: null });
    await flushPromises();
    expect(wrapper.find('[data-track="workspace-address-create-dns"]').exists()).toBe(false);
  });
});

describe('the header checkbox', () => {
  const rows = [{ id: 'address:1' }, { id: 'address:2' }];
  const header = (wrapper) => wrapper.find('thead input[type="checkbox"]');
  const mountTable = (selectedRows) =>
    mount(WorkspaceTable, {
      props: { columns: [], rows, showCheckboxes: true, selectedRows },
    });

  it('shows the selection and clears it when anything is checked', async () => {
    const some = mountTable(['address:1']);
    expect(header(some).element.indeterminate).toBe(true);
    expect(header(some).attributes('aria-label')).toBe('Clear selection');
    await header(some).trigger('click');
    expect(some.emitted('toggle-all')).toEqual([[false]]);

    const every = mountTable(['address:1', 'address:2']);
    expect(header(every).element.checked).toBe(true);
    await header(every).trigger('click');
    expect(every.emitted('toggle-all')).toEqual([[false]]);
  });

  it('checks every visible row when nothing is checked', async () => {
    const none = mountTable([]);
    expect(header(none).element.checked).toBe(false);
    expect(header(none).element.indeterminate).toBe(false);
    await header(none).trigger('click');
    expect(none.emitted('toggle-all')).toEqual([[true]]);
  });
});
