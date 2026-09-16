import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { store, toast, api } = vi.hoisted(() => ({
  store: {
    scopes: [],
    leases: [],
    reservations: [],
    loading: false,
    fetchScopes: vi.fn(),
    fetchLeases: vi.fn(),
    createReservation: vi.fn(),
    updateReservation: vi.fn(),
  },
  toast: { add: vi.fn() },
  api: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../../../src/stores/dhcp.js', () => ({ useDhcpStore: () => store }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const DhcpPanel = (await import('../../../src/components/DhcpPanel.vue')).default;

const DialogStub = {
  props: ['visible'],
  emits: ['update:visible'],
  template: '<section v-if="visible"><slot /><slot name="footer" /></section>',
};
const ButtonStub = {
  props: ['label'],
  emits: ['click'],
  template: '<button type="button" @click="$emit(\'click\')">{{ label }}</button>',
};

function mountPanel() {
  return mount(DhcpPanel, {
    props: { dialogsOnly: true },
    global: {
      stubs: {
        Dialog: DialogStub,
        Button: ButtonStub,
        InputText: true,
        Select: true,
        ToggleSwitch: true,
        ScopeDialog: true,
        IpDetailsDrawer: true,
        ContextMenu: true,
        DataTable: true,
      },
    },
  });
}

beforeEach(() => {
  store.fetchScopes.mockReset().mockResolvedValue([]);
  store.fetchLeases.mockReset().mockResolvedValue([]);
  store.createReservation.mockReset();
  toast.add.mockReset();
  api.get.mockReset().mockResolvedValue({
    data: {
      folders: [
        {
          id: 1,
          name: 'Lab',
          subnets: [
            { id: 11, name: 'Lab', cidr: '10.0.0.0/24', status: 'allocated', children: [] },
          ],
        },
      ],
    },
  });
});

describe('DhcpPanel reservation conflicts (T-26)', () => {
  it('keeps the form and its values and says why the server refused', async () => {
    store.createReservation.mockRejectedValueOnce({
      response: { status: 409, data: { error: '10.0.0.9 already has a DHCP Reservation' } },
    });
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.vm.openReservationDialog(null, {
      subnet_id: 11,
      mac_address: 'aa:bb:cc:dd:ee:ff',
      ip_address: '10.0.0.9',
      hostname: 'printer',
    });
    await flushPromises();

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Create')
      .trigger('click');
    await flushPromises();

    expect(store.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ subnet_id: 11, ip_address: '10.0.0.9', hostname: 'printer' }),
    );
    expect(wrapper.find('[data-track="dialog-dhcp-reservation"]').exists()).toBe(true);
    expect(wrapper.find('[data-track="dhcp-reservation-error"]').text()).toBe(
      '10.0.0.9 already has a DHCP Reservation',
    );
    expect(wrapper.vm.reservationForm).toMatchObject({
      ip_address: '10.0.0.9',
      mac_address: 'aa:bb:cc:dd:ee:ff',
    });
    expect(wrapper.emitted('changed')).toBeUndefined();

    // A corrected retry clears the message and closes.
    store.createReservation.mockResolvedValueOnce({ id: 5 });
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Create')
      .trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-track="dialog-dhcp-reservation"]').exists()).toBe(false);
    expect(wrapper.emitted('changed')).toEqual([['DHCP Reservation created']]);
  });
});
