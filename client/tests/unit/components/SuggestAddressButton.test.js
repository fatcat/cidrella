/**
 * The Suggest button (docs/IPV6-HANDLING.md, rule 2): Next free and Random ask
 * the server for one free address in the network, and the editor takes it.
 * A refusal (a full network) is a toast, never a filled field.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = { get: vi.fn() };
const toast = { add: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));

const { default: SuggestAddressButton } =
  await import('../../../src/components/SuggestAddressButton.vue');
const { default: IpReservationEditor } =
  await import('../../../src/views/networks-workspace/dialogs/IpReservationEditor.vue');

// The menu's items as plain buttons, so a test can pick one.
const ContextMenuStub = {
  props: ['model'],
  methods: { show() {} },
  template: `<div class="menu-stub"><button v-for="item in model" :key="item.label"
    class="menu-item" @click="item.command()">{{ item.label }}</button></div>`,
};

function mountButton(props) {
  return mount(SuggestAddressButton, {
    props,
    global: { stubs: { ContextMenu: ContextMenuStub } },
  });
}

async function pick(wrapper, label) {
  await wrapper
    .findAll('.menu-item')
    .find((item) => item.text() === label)
    .trigger('click');
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  api.get.mockReset();
  toast.add.mockReset();
});

describe('SuggestAddressButton', () => {
  it('asks for the next free IPv4 address and emits it', async () => {
    api.get.mockResolvedValue({ data: { ip_address: '10.0.0.5', strategy: 'sequential' } });
    const wrapper = mountButton({ subnetId: 7 });
    await pick(wrapper, 'Next free');
    expect(api.get).toHaveBeenCalledWith('/subnets/7/suggest-address', {
      params: { strategy: 'sequential' },
    });
    expect(wrapper.emitted('suggested')).toEqual([['10.0.0.5']]);
  });

  it('asks for a random IPv6 address inside its bounds', async () => {
    api.get.mockResolvedValue({ data: { ip_address: 'fd00:5::9a3c', strategy: 'random' } });
    const wrapper = mountButton({ subnetId: 16, within: 'fd00:5::/112' });
    await pick(wrapper, 'Random');
    expect(api.get).toHaveBeenCalledWith('/subnets/16/suggest-address', {
      params: { strategy: 'random', within: 'fd00:5::/112' },
    });
    expect(wrapper.emitted('suggested')).toEqual([['fd00:5::9a3c']]);
  });

  it('says why when the network has no free address', async () => {
    api.get.mockRejectedValue({
      response: { status: 404, data: { error: 'No free address in 10.61.0.0/30' } },
    });
    const wrapper = mountButton({ subnetId: 3 });
    await pick(wrapper, 'Next free');
    expect(wrapper.emitted('suggested')).toBeUndefined();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'No free address in 10.61.0.0/30' }),
    );
  });

  it('is disabled until there is a network to ask', () => {
    const wrapper = mountButton({ subnetId: null });
    expect(wrapper.find('[data-track="suggest-address"]').attributes('disabled')).toBeDefined();
  });
});

describe('IpReservationEditor with a suggestion', () => {
  function mountEditor(props) {
    return mount(IpReservationEditor, {
      props: { visible: true, subnetId: 16, address: '', mode: 'reserve', ...props },
      global: {
        stubs: { Dialog: { template: '<div><slot /></div>' }, SuggestAddressButton: true },
      },
    });
  }

  it('starts with the suggested address, editable, in both families', () => {
    for (const initialAddress of ['10.0.0.5', 'fd00:5::10']) {
      const input = mountEditor({ initialAddress }).find('.input-with-action input');
      expect(input.element.value).toBe(initialAddress);
    }
  });

  it('fills the field from the Suggest button', async () => {
    const wrapper = mountEditor({});
    wrapper.findComponent({ name: 'SuggestAddressButton' }).vm.$emit('suggested', 'fd00:5::11');
    await flushPromises();
    expect(wrapper.find('.input-with-action input').element.value).toBe('fd00:5::11');
  });
});
