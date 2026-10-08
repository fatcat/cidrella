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
            {
              id: 12,
              name: 'Lab6',
              cidr: 'fd00:1234::/64',
              address_family: 6,
              status: 'allocated',
              children: [],
            },
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

describe('DhcpPanel reservation identity by family', () => {
  it('binds a DUID instead of a MAC on an IPv6 network and sends it', async () => {
    store.createReservation.mockResolvedValueOnce({ id: 6 });
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.vm.openReservationDialog(null, {
      subnet_id: 12,
      ip_address: 'fd00:1234::100',
      hostname: 'printer6',
    });
    await flushPromises();

    expect(wrapper.find('[data-track="dhcp-res-duid"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('MAC Address *');
    wrapper.vm.reservationForm.duid = '00:01:00:01:AA:BB:CC:DD:EE:FF:00:11';
    wrapper.vm.reservationForm.iaid = '12345';
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Create')
      .trigger('click');
    await flushPromises();

    const payload = store.createReservation.mock.calls[0][0];
    expect(payload).toMatchObject({
      subnet_id: 12,
      ip_address: 'fd00:1234::100',
      duid: '00:01:00:01:AA:BB:CC:DD:EE:FF:00:11',
      iaid: 12345,
      hostname: 'printer6',
    });
    expect(payload).not.toHaveProperty('mac_address');
  });

  it('keeps the MAC field for an IPv4 network', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.vm.openReservationDialog(null, { subnet_id: 11, ip_address: '10.0.0.9' });
    await flushPromises();
    expect(wrapper.find('[data-track="dhcp-res-duid"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('MAC Address *');
  });
});
