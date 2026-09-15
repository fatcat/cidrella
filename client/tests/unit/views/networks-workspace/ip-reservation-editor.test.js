import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../../../src/api/client.js';
import IpReservationEditor from '../../../../src/views/networks-workspace/dialogs/IpReservationEditor.vue';

vi.mock('../../../../src/api/client.js', () => ({
  default: { put: vi.fn() },
}));

function mountEditor(mode) {
  return mount(IpReservationEditor, {
    props: { visible: true, subnetId: 7, address: '10.0.0.33', mode },
    global: {
      stubs: {
        Dialog: { template: '<section><slot /></section>' },
        Button: {
          props: ['label'],
          template: '<button :type="$attrs.type" @click="$emit(\'click\')">{{ label }}</button>',
        },
      },
    },
  });
}

describe('workspace IP Reservation editor', () => {
  beforeEach(() => api.put.mockReset().mockResolvedValue({ data: {} }));

  it('creates a reservation through the canonical single-address endpoint', async () => {
    const wrapper = mountEditor('reserve');
    await wrapper.find('textarea').setValue('Printer replacement');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/subnets/7/ips/10.0.0.33/allocation', {
      allocation_state: 'reserved',
      note: 'Printer replacement',
    });
    expect(wrapper.emitted('saved')?.[0]?.[0]).toMatchObject({
      address: '10.0.0.33',
      allocation_state: 'reserved',
    });
  });

  it('releases only the administrative IP Reservation', async () => {
    const wrapper = mountEditor('release');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/subnets/7/ips/10.0.0.33/allocation', {
      allocation_state: 'unassigned',
      note: null,
    });
  });
});
