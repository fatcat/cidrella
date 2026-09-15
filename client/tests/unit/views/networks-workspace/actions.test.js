import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../../../src/api/client.js';
import BulkActionDialog from '../../../../src/views/networks-workspace/dialogs/BulkActionDialog.vue';
import {
  WORKSPACE_ACTIONS,
  actionAvailability,
  actionLabel,
  allocationPayload,
  createWorkspaceActionRegistry,
  executeBulkAllocation,
  menuActions,
  targetForRow,
} from '../../../../src/views/networks-workspace/workspace-actions.js';

vi.mock('../../../../src/api/client.js', () => ({ default: { put: vi.fn() } }));

describe('workspace action registry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses stable IDs, capabilities and canonical allocation state for eligibility', () => {
    expect(WORKSPACE_ACTIONS['ip.reserve']).toMatchObject({
      id: 'ip.reserve',
      capability: 'subnets:write',
      targetKind: 'address',
    });
    expect(
      actionAvailability(
        'ip.reserve',
        { kind: 'address', allocation_state: 'unassigned', ip_display_status: 'DHCP Scope' },
        () => true,
      ),
    ).toEqual({ available: true, reason: '' });
    expect(
      actionAvailability(
        'ip.release',
        { kind: 'address', allocation_state: 'static_dhcp' },
        () => true,
      ),
    ).toMatchObject({ available: false, reason: expect.stringContaining('IP Reservation') });
    expect(
      actionAvailability(
        'ip.reserve',
        { kind: 'address', allocation_state: 'unassigned' },
        () => false,
      ).reason,
    ).toContain('subnets:write');
    expect(
      actionAvailability(
        'ip.bulk-release',
        {
          kind: 'address-selection',
          count: 2,
          allocationStates: ['reserved', 'static_dhcp'],
        },
        () => true,
      ).reason,
    ).toContain('only IP Reservations');
  });

  it('dispatches an immutable target and never uses a display label as a key', async () => {
    const handler = vi.fn((target) => {
      expect(Object.isFrozen(target)).toBe(true);
      return target.ip;
    });
    const registry = createWorkspaceActionRegistry({
      can: () => true,
      handlers: { 'ip.reserve': handler },
    });
    const result = await registry.invoke('ip.reserve', {
      kind: 'address',
      ip: '10.0.0.8',
      allocation_state: 'unassigned',
    });

    expect(result).toEqual({ invoked: true, result: '10.0.0.8' });
    expect(handler).toHaveBeenCalledOnce();
    expect((await registry.invoke('Create IP Reservation', {})).invoked).toBe(false);
  });

  it('derives the target kind from the row identity prefix, not the view', () => {
    expect(targetForRow({ id: 'network:4', raw: { id: 4, status: 'allocated' } })).toMatchObject({
      kind: 'network',
      id: 4,
      status: 'allocated',
    });
    expect(
      targetForRow({
        id: 'address:10.0.0.9',
        address: '10.0.0.9',
        type: null,
        status: 'DHCP Scope',
        raw: { allocation_state: 'unassigned' },
      }),
    ).toMatchObject({ kind: 'address', allocation_state: 'unassigned', status: 'DHCP Scope' });
    expect(targetForRow({ id: 'zone:2', raw: { id: 2 } })).toMatchObject({ kind: 'dns-zone' });
    expect(
      targetForRow({ id: 'dns:2:5', value: '10.0.0.5', raw: { id: 5, zone_id: 2 } }),
    ).toMatchObject({ kind: 'dns-record', zone_id: 2, address: '10.0.0.5' });
    expect(targetForRow({ id: 'scope:3', raw: { id: 3, subnet_id: 1 } })).toMatchObject({
      kind: 'dhcp-scope',
      subnet_id: 1,
    });
    expect(
      targetForRow({
        id: 'dhcp:reserved:7:10.0.0.7',
        address: '10.0.0.7',
        raw: { id: 7, dhcp_assignment_type: 'reserved', scope_id: 3 },
      }),
    ).toMatchObject({ kind: 'dhcp-address', reserved: true, scope_id: 3 });
    expect(targetForRow({ id: 'range:4', rangeType: 'DHCP Scope', raw: { id: 4 } })).toMatchObject({
      kind: 'range',
      isScope: true,
    });
    expect(targetForRow(null)).toBeNull();
    expect(targetForRow({ id: 'mystery:1', raw: {} })).toBeNull();
  });

  it('builds row menus from the registry in the documented order', () => {
    const all = () => true;
    const labels = (options) => menuActions(options).map((item) => item.label);
    const row = (id, extra) => targetForRow({ id, raw: {}, ...extra });

    expect(
      labels({
        menu: 'row',
        target: row('address:10.0.0.9', {
          address: '10.0.0.9',
          status: 'DHCP Scope',
          raw: { allocation_state: 'unassigned' },
        }),
        can: all,
      }),
    ).toEqual([
      'Edit DHCP scope',
      'Remove this IP from scope',
      'Delete DHCP scope',
      'Create IP Reservation',
      'Add DHCP Reservation',
      'Set range type',
      'Change scan setting',
      'Probe now',
    ]);
    expect(
      labels({
        menu: 'row',
        target: row('address:10.0.0.1', {
          address: '10.0.0.1',
          type: 'gateway',
          raw: { allocation_state: 'system' },
        }),
        can: all,
      }),
    ).toEqual([
      'Edit gateway',
      'Delete gateway',
      'Create DHCP scope',
      'Set range type',
      'Change scan setting',
      'Probe now',
    ]);
    expect(
      labels({
        menu: 'row',
        target: row('dhcp:reserved:7:10.0.0.7', {
          address: '10.0.0.7',
          raw: { id: 7, dhcp_assignment_type: 'reserved', scope_id: 3 },
        }),
        can: all,
      }),
    ).toEqual([
      'Open IP details',
      'Open scope',
      'Edit DHCP Reservation',
      'Probe now',
      'Delete DHCP Reservation',
    ]);
    expect(
      labels({ menu: 'row', target: row('range:5', { rangeType: 'Servers' }), can: all }),
    ).toEqual(['Edit range', 'Create DHCP scope', 'Delete range']);
    expect(
      labels({ menu: 'row', target: row('range:4', { rangeType: 'DHCP Scope' }), can: all }),
    ).toEqual(['Edit DHCP scope', 'Remove addresses from scope', 'Delete DHCP scope']);
  });

  it('gates each entry on its own capability rather than the view', () => {
    const labels = (options) => menuActions(options).map((item) => item.label);
    const lease = targetForRow({
      id: 'dhcp:dynamic:8:10.0.0.8',
      address: '10.0.0.8',
      raw: { id: 8, dhcp_assignment_type: 'dynamic', scope_id: 3 },
    });
    // A DHCP-only operator gets the DHCP entries and no probe (subnets:write).
    expect(labels({ menu: 'row', target: lease, can: (c) => c === 'dhcp:write' })).toEqual([
      'Open IP details',
      'Open scope',
      'Add DHCP Reservation',
    ]);
    // A subnet-only operator gets the probe and nothing that writes DHCP.
    expect(labels({ menu: 'row', target: lease, can: (c) => c === 'subnets:write' })).toEqual([
      'Open IP details',
      'Open scope',
      'Probe now',
    ]);
    expect(labels({ menu: 'row', target: lease, can: () => false })).toEqual([
      'Open IP details',
      'Open scope',
    ]);
  });

  it('scopes the header menus to the view and the open zone or scope', () => {
    const all = () => true;
    const labels = (options) => menuActions(options).map((item) => item.label);
    const workspace = (zone = null, scope = null) => ({ kind: 'workspace', zone, scope });

    expect(labels({ menu: 'create', target: workspace(), can: all })).toEqual([
      'Allocate network',
      'Create folder',
      'Add DNS zone',
      'Add DHCP scope',
      'Add DHCP Reservation',
    ]);
    expect(labels({ menu: 'create', target: workspace(), can: (c) => c === 'dns:write' })).toEqual([
      'Add DNS zone',
    ]);
    expect(labels({ menu: 'actions', target: workspace(), view: 'dns', can: all })).toEqual([
      'Switch forward / reverse',
      'Add DNS zone',
    ]);
    expect(
      labels({ menu: 'actions', target: workspace({ id: 2 }), view: 'dns', can: all }),
    ).toEqual([
      'Edit selected zone',
      'Switch forward / reverse',
      'Add DNS zone',
      'Delete selected zone',
    ]);
    expect(
      labels({ menu: 'actions', target: workspace(null, { id: 3 }), view: 'dhcp', can: all }),
    ).toEqual([
      'Edit selected scope',
      'Sync leases now',
      'Add DHCP scope',
      'Delete selected scope',
    ]);
    expect(
      labels({
        menu: 'actions',
        target: { kind: 'network', id: 1, status: 'allocated' },
        view: 'addresses',
        can: all,
      }),
    ).toEqual([
      'Edit network',
      'Divide network',
      'Merge networks',
      'Move to folder',
      'Apply defaults',
      'Deallocate network',
      'Delete network',
    ]);
    expect(actionLabel('dns.zone.edit', { kind: 'dns-zone' })).toBe('Edit zone');
    expect(actionAvailability('dns.record.create', workspace(), () => true).reason).toContain(
      'zone',
    );
  });

  it('builds distinct reserve and release payloads', () => {
    expect(allocationPayload('reserved', '  Printer  ')).toEqual({
      allocation_state: 'reserved',
      note: 'Printer',
    });
    expect(allocationPayload('unassigned', 'ignored')).toEqual({
      allocation_state: 'unassigned',
    });
    expect(() => allocationPayload('reserved', '  ')).toThrow('note is required');
    expect(() => allocationPayload('dynamic_dhcp')).toThrow('reserved or unassigned');
  });

  it('sends exact run payloads sequentially and stops without replay after a failure', async () => {
    const failure = new Error('network failed');
    const put = vi
      .fn()
      .mockResolvedValueOnce({ data: { count: 2, skipped: 1 } })
      .mockRejectedValueOnce(failure);
    const runs = [
      { start_ip: '10.0.0.1', end_ip: '10.0.0.3', count: 3 },
      { start_ip: '10.0.0.8', end_ip: '10.0.0.8', count: 1 },
      { start_ip: '10.0.0.12', end_ip: '10.0.0.12', count: 1 },
    ];

    const ledger = await executeBulkAllocation({
      subnetId: 7,
      runs,
      allocationState: 'reserved',
      note: 'Lab devices',
      put,
    });

    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenNthCalledWith(1, '/subnets/7/ips/bulk-allocation', {
      start_ip: '10.0.0.1',
      end_ip: '10.0.0.3',
      allocation_state: 'reserved',
      note: 'Lab devices',
    });
    expect(ledger.completed).toHaveLength(1);
    expect(ledger.remaining).toEqual(runs.slice(1));
    expect(ledger).toMatchObject({ updated: 2, skipped: 1, error: failure });
  });

  it('renders the exact runs and submits release without a note', async () => {
    api.put.mockResolvedValue({ data: { count: 2, skipped: 0 } });
    const wrapper = mount(BulkActionDialog, {
      props: {
        visible: true,
        subnetId: 9,
        mode: 'release',
        runs: [{ start_ip: '10.0.0.4', end_ip: '10.0.0.5', count: 2 }],
      },
      global: {
        stubs: {
          Dialog: {
            props: ['visible'],
            template: '<section v-if="visible"><slot /></section>',
          },
          Button: {
            props: ['label', 'type', 'disabled'],
            emits: ['click'],
            template:
              '<button :type="type || \'button\'" :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
          },
        },
      },
    });

    expect(wrapper.text()).toContain('10.0.0.4 through 10.0.0.5');
    expect(wrapper.text()).toContain('does not release DHCP leases');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/subnets/9/ips/bulk-allocation', {
      start_ip: '10.0.0.4',
      end_ip: '10.0.0.5',
      allocation_state: 'unassigned',
    });
    expect(wrapper.emitted('complete')).toHaveLength(1);
  });

  it('retries only the failed and not-started bulk runs', async () => {
    api.put
      .mockResolvedValueOnce({ data: { updated: 2, skipped: 0 } })
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ data: { updated: 1, skipped: 0 } })
      .mockResolvedValueOnce({ data: { updated: 1, skipped: 0 } });
    const runs = [
      { start_ip: '10.0.0.1', end_ip: '10.0.0.2', count: 2 },
      { start_ip: '10.0.0.8', end_ip: '10.0.0.8', count: 1 },
      { start_ip: '10.0.0.12', end_ip: '10.0.0.12', count: 1 },
    ];
    const wrapper = mount(BulkActionDialog, {
      props: { visible: true, subnetId: 9, mode: 'release', runs },
      global: {
        stubs: {
          Dialog: { props: ['visible'], template: '<section v-if="visible"><slot /></section>' },
          Button: {
            props: ['label', 'type', 'disabled'],
            emits: ['click'],
            template:
              '<button :type="type || \'button\'" :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
          },
        },
      },
    });

    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('Retry 2 remaining run(s)');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(api.put).toHaveBeenCalledTimes(4);
    expect(api.put.mock.calls.filter(([, body]) => body.start_ip === '10.0.0.1')).toHaveLength(1);
    expect(wrapper.emitted('complete')).toHaveLength(1);
    expect(wrapper.emitted('complete')[0][0]).toMatchObject({ updated: 4, skipped: 0 });
  });
});
