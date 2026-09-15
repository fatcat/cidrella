import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../../../src/api/client.js';
import BulkRangeTypeDialog from '../../../../src/views/networks-workspace/dialogs/BulkRangeTypeDialog.vue';
import RangeEditor from '../../../../src/views/networks-workspace/dialogs/RangeEditor.vue';
import RangeTypeDialog from '../../../../src/views/networks-workspace/dialogs/RangeTypeDialog.vue';
import {
  exactRangeRuns,
  isProtectedRange,
  rangeAction,
  rangeLayer,
  useRangeActions,
} from '../../../../src/views/networks-workspace/composables/useRangeActions.js';

vi.mock('../../../../src/api/client.js', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const DialogStub = {
  props: ['visible', 'header'],
  template:
    '<section v-if="visible"><h2>{{ header }}</h2><slot /><footer><slot name="footer" /></footer></section>',
};
const ButtonStub = {
  props: ['label', 'disabled'],
  emits: ['click'],
  template: '<button :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
};
const SelectStub = {
  props: ['modelValue', 'options'],
  emits: ['update:modelValue'],
  template: '<select :value="modelValue"></select>',
};
const InputTextStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<input :value="modelValue" />',
};
const componentOptions = {
  global: {
    stubs: {
      Dialog: DialogStub,
      Button: ButtonStub,
      Select: SelectStub,
      InputText: InputTextStub,
    },
  },
};

const customType = { id: 8, name: 'Lab equipment', is_system: 0, color: '#14b8a6' };

describe('workspace range management', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps organizational labels separate from protected functional projections', () => {
    const custom = { range_type_name: 'Lab equipment', range_type_is_system: 0 };
    const gateway = { range_type_name: 'Gateway', range_type_is_system: 1 };
    const dhcp = { range_type_name: 'DHCP Scope', range_type_is_system: 1 };
    const network = { range_type_name: 'Network', range_type_is_system: 1 };

    expect(rangeLayer(custom)).toBe('organizational');
    expect(rangeAction(custom)).toBe('edit-range');
    expect(rangeAction(gateway)).toBe('edit-network');
    expect(rangeAction(dhcp)).toBe('edit-dhcp-scope');
    expect(rangeAction(network)).toBeNull();
    expect([gateway, dhcp, network].every(isProtectedRange)).toBe(true);
  });

  it('uses the exact selected runs without filling gaps or inferring address state', async () => {
    api.put.mockResolvedValue({ data: { created: [] } });
    const actions = useRangeActions();
    const selectedRuns = [
      { start_ip: '10.0.0.10', end_ip: '10.0.0.12', allocation_state: 'reserved' },
      { start_ip: '10.0.0.20', end_ip: '10.0.0.21', is_online: true },
    ];

    await actions.setRangeType(4, 8, selectedRuns);

    expect(api.put).toHaveBeenCalledWith('/subnets/4/ranges/set-type', {
      range_type_id: 8,
      ranges: [
        { start_ip: '10.0.0.10', end_ip: '10.0.0.12' },
        { start_ip: '10.0.0.20', end_ip: '10.0.0.21' },
      ],
      accept_overlaps: false,
    });
    expect(exactRangeRuns(selectedRuns)).toHaveLength(2);
  });

  it('covers the exact range and range-type CRUD endpoints', async () => {
    api.get.mockResolvedValue({ data: [] });
    api.post.mockResolvedValue({ data: { id: 1 } });
    api.put.mockResolvedValue({ data: { id: 1 } });
    api.delete.mockResolvedValue({ data: { message: 'deleted' } });
    const actions = useRangeActions();

    await actions.listRanges(3);
    await actions.listRangeTypes();
    await actions.createRange(3, { range_type_id: 8 });
    await actions.updateRange(3, 2, { description: 'updated' });
    await actions.deleteRange(3, { id: 2, range_type_name: 'Servers', range_type_is_system: 0 });
    await actions.createRangeType({ name: 'Servers' });
    await actions.updateRangeType(8, { name: 'Infrastructure' });
    await actions.deleteRangeType(customType);

    expect(api.get).toHaveBeenNthCalledWith(1, '/subnets/3/ranges');
    expect(api.get).toHaveBeenNthCalledWith(2, '/range-types');
    expect(api.post).toHaveBeenNthCalledWith(1, '/subnets/3/ranges', { range_type_id: 8 });
    expect(api.put).toHaveBeenNthCalledWith(1, '/subnets/3/ranges/2', {
      description: 'updated',
    });
    expect(api.delete).toHaveBeenNthCalledWith(1, '/subnets/3/ranges/2');
    expect(api.post).toHaveBeenNthCalledWith(2, '/range-types', { name: 'Servers' });
    expect(api.put).toHaveBeenNthCalledWith(2, '/range-types/8', { name: 'Infrastructure' });
    expect(api.delete).toHaveBeenNthCalledWith(2, '/range-types/8');
  });

  it('refuses to call delete endpoints for functional ranges and system types', async () => {
    const actions = useRangeActions();
    expect(() =>
      actions.deleteRange(3, {
        id: 1,
        range_type_name: 'Gateway',
        range_type_is_system: 1,
      }),
    ).toThrow('owning editor');
    expect(() => actions.deleteRangeType({ id: 1, is_system: 1 })).toThrow('cannot be deleted');
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('retries an overlapping bulk assignment only after explicit acceptance', async () => {
    api.put
      .mockRejectedValueOnce({
        response: {
          status: 409,
          data: {
            can_accept: true,
            overlaps: [{ id: 2, type: 'Printers', start_ip: '10.0.0.10', end_ip: '10.0.0.30' }],
          },
        },
      })
      .mockResolvedValueOnce({ data: { created: [{ id: 9 }] } });
    const runs = [
      { start_ip: '10.0.0.10', end_ip: '10.0.0.12' },
      { start_ip: '10.0.0.20', end_ip: '10.0.0.21' },
    ];
    const wrapper = mount(BulkRangeTypeDialog, {
      ...componentOptions,
      props: { visible: true, subnetId: 4, selectedRuns: runs, rangeTypes: [customType] },
    });

    await wrapper.get('[data-track="workspace-bulk-range-type-save"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('Printers: 10.0.0.10 to 10.0.0.30');

    await wrapper.get('[data-track="workspace-bulk-range-overlap-accept"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenLastCalledWith('/subnets/4/ranges/set-type', {
      range_type_id: 8,
      ranges: runs,
      accept_overlaps: true,
    });
    expect(wrapper.emitted('saved')?.[0]?.[0]).toEqual({ created: [{ id: 9 }] });
  });

  it('does not retry when overlap replacement is declined', async () => {
    api.put.mockRejectedValue({
      response: {
        status: 409,
        data: { can_accept: true, overlaps: [{ id: 2, type: 'Printers' }] },
      },
    });
    const wrapper = mount(BulkRangeTypeDialog, {
      ...componentOptions,
      props: {
        visible: true,
        subnetId: 4,
        selectedRuns: [{ start_ip: '10.0.0.10', end_ip: '10.0.0.12' }],
        rangeTypes: [customType],
      },
    });
    await wrapper.get('[data-track="workspace-bulk-range-type-save"]').trigger('click');
    await flushPromises();
    await wrapper.get('button').trigger('click');
    await flushPromises();

    expect(api.put).toHaveBeenCalledTimes(1);
  });

  it('blocks generic edits for projected gateway and DHCP rows', async () => {
    const wrapper = mount(RangeEditor, {
      ...componentOptions,
      props: {
        visible: true,
        subnetId: 4,
        rangeTypes: [customType],
        range: {
          id: 3,
          range_type_id: 2,
          range_type_name: 'Gateway',
          range_type_is_system: 1,
          start_ip: '10.0.0.1',
          end_ip: '10.0.0.1',
        },
      },
    });
    expect(wrapper.text()).toContain('must be changed through their network or DHCP editor');
    expect(wrapper.get('[data-track="workspace-range-save"]').attributes()).toHaveProperty(
      'disabled',
    );
    await wrapper.get('[data-track="workspace-range-save"]').trigger('click');
    expect(api.put).not.toHaveBeenCalled();
  });

  it('deletes an organizational range only after confirmation', async () => {
    api.delete.mockResolvedValue({ data: { message: 'Range deleted' } });
    const range = {
      id: 12,
      range_type_id: 8,
      range_type_name: 'Lab equipment',
      range_type_is_system: 0,
      start_ip: '10.0.0.10',
      end_ip: '10.0.0.20',
    };
    const wrapper = mount(RangeEditor, {
      ...componentOptions,
      props: { visible: true, subnetId: 4, rangeTypes: [customType], range },
    });
    await wrapper.get('[data-track="workspace-range-delete"]').trigger('click');
    expect(api.delete).not.toHaveBeenCalled();
    await wrapper.get('[data-track="workspace-range-delete-confirm-action"]').trigger('click');
    await flushPromises();

    expect(api.delete).toHaveBeenCalledWith('/subnets/4/ranges/12');
    expect(wrapper.emitted('deleted')?.[0]).toEqual([range]);
  });

  it('prevents functional range types from being edited', async () => {
    const wrapper = mount(RangeTypeDialog, {
      ...componentOptions,
      props: {
        visible: true,
        rangeType: { id: 1, name: 'Network', is_system: 1, color: '#000000' },
      },
    });
    expect(wrapper.text()).toContain('cannot be modified');
    await wrapper.get('[data-track="workspace-range-type-save"]').trigger('click');
    expect(api.put).not.toHaveBeenCalled();
  });

  it('deletes a custom range type only after confirmation', async () => {
    api.delete.mockResolvedValue({ data: { message: 'Range type deleted' } });
    const wrapper = mount(RangeTypeDialog, {
      ...componentOptions,
      props: { visible: true, rangeType: customType },
    });
    await wrapper.get('[data-track="workspace-range-type-delete"]').trigger('click');
    expect(api.delete).not.toHaveBeenCalled();
    await wrapper.get('[data-track="workspace-range-type-delete-confirm-action"]').trigger('click');
    await flushPromises();

    expect(api.delete).toHaveBeenCalledWith('/range-types/8');
    expect(wrapper.emitted('deleted')?.[0]).toEqual([customType]);
  });
});
