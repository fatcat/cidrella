import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../../../src/api/client.js';
import BulkActionDialog from '../../../../src/views/networks-workspace/dialogs/BulkActionDialog.vue';
import {
  WORKSPACE_ACTIONS,
  actionAvailability,
  allocationPayload,
  createWorkspaceActionRegistry,
  executeBulkAllocation,
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
