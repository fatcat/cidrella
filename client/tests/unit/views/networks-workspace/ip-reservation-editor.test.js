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
        Dialog: {
          emits: ['update:visible'],
          template:
            '<section><button class="vendor-close" @click="$emit(\'update:visible\', false)">x</button><slot /></section>',
        },
        Button: {
          props: ['label'],
          emits: ['click'],
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

  it('does not silently discard a typed note on dismiss', async () => {
    const wrapper = mountEditor('reserve');
    // Clean form: dismissal closes straight away.
    await wrapper.find('.vendor-close').trigger('click');
    expect(wrapper.emitted('update:visible')).toEqual([[false]]);

    await wrapper.find('textarea').setValue('Printer replacement');
    await wrapper.find('.vendor-close').trigger('click');
    expect(wrapper.emitted('update:visible')).toHaveLength(1);
    expect(wrapper.find('[role="alertdialog"]').text()).toContain('Discard your changes?');

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Keep editing')
      .trigger('click');
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false);
    expect(wrapper.find('textarea').element.value).toBe('Printer replacement');

    // Cancel goes through the same guard as the vendor close.
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Cancel')
      .trigger('click');
    expect(wrapper.emitted('update:visible')).toHaveLength(1);
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Discard')
      .trigger('click');
    expect(wrapper.emitted('update:visible')).toHaveLength(2);
  });

  it('closes a dirty form on the second dismissal so Escape twice still works', async () => {
    const wrapper = mountEditor('reserve');
    await wrapper.find('textarea').setValue('Printer replacement');
    await wrapper.find('.vendor-close').trigger('click');
    await wrapper.find('.vendor-close').trigger('click');
    expect(wrapper.emitted('update:visible')).toEqual([[false]]);
  });
});
