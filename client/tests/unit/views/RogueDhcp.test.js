/**
 * The rogue detection page with the IPv6 detectors: events say which
 * protocol found them, the allowlist takes an IP, a MAC or a DUID, and the
 * IPv6 status lines appear only while IPv6 support is on.
 */
import { computed } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store, toast } = vi.hoisted(() => ({
  store: {
    events: [],
    authorized: [],
    loading: false,
    fetchStatus: vi.fn(),
    fetchEvents: vi.fn(),
    fetchAuthorized: vi.fn(),
    updateSettings: vi.fn(),
    probe: vi.fn(),
    acknowledge: vi.fn(),
    acknowledgeAll: vi.fn(),
    clearEvent: vi.fn(),
    addAuthorized: vi.fn(),
    removeAuthorized: vi.fn(),
    deleteAuthorized: vi.fn(),
  },
  toast: { add: vi.fn() },
}));
vi.mock('../../../src/stores/rogueDhcp.js', () => ({ useRogueDhcpStore: () => store }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/api/client.js', () => ({ default: { get: vi.fn() } }));

const { default: RogueDhcp } = await import('../../../src/views/RogueDhcp.vue');
const { useFeaturesStore } = await import('../../../src/stores/features.js');

const DataTableStub = {
  props: ['value'],
  provide() {
    return { rows: computed(() => this.value || []) };
  },
  template: '<div class="dt"><slot name="empty" v-if="!value || !value.length" /><slot /></div>',
};
const ColumnStub = {
  inject: ['rows'],
  props: ['header', 'field'],
  template:
    '<div class="col" :data-header="header"><div v-for="(row, i) in rows" :key="i" class="cell"><slot name="body" :data="row">{{ field ? row[field] : "" }}</slot></div></div>',
};
const InputStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<input :value="modelValue" :placeholder="$attrs.placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const ButtonStub = {
  props: ['label', 'disabled'],
  emits: ['click'],
  template: '<button :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
};
const StatusBadgeStub = {
  props: ['label', 'kind'],
  template: '<span class="badge">{{ label }}</span>',
};

const STATUS = {
  enabled: true,
  intervalMin: 15,
  lastProbeAt: '2026-09-18T10:00:00.000Z',
  probeSupported: true,
  stale: false,
  unacknowledged: 1,
  dhcpv6: { probeSupported: true, lastProbeAt: '2026-09-18T10:00:00.000Z', disabled: false },
  routerAdvertisements: { supported: false, disabled: false, unsupportedInterfaces: ['eth0'] },
};

function mountPage(ipv6) {
  const pinia = createPinia();
  useFeaturesStore(pinia).set({ ipv6 });
  return mount(RogueDhcp, {
    global: {
      plugins: [pinia],
      stubs: {
        DataTable: DataTableStub,
        Column: ColumnStub,
        InputText: InputStub,
        InputNumber: true,
        ToggleSwitch: true,
        Button: ButtonStub,
        StatusBadge: StatusBadgeStub,
        EmptyState: true,
        Toast: true,
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.fetchStatus.mockResolvedValue(STATUS);
  store.fetchEvents.mockResolvedValue([]);
  store.fetchAuthorized.mockResolvedValue([]);
  store.addAuthorized.mockResolvedValue({ id: 1 });
  store.events = [
    {
      id: 1,
      kind: 'dhcp',
      server_ip: '10.0.0.250',
      offered_gateway: '10.0.0.250',
      iface: 'eth0',
      times_seen: 2,
    },
    {
      id: 2,
      kind: 'dhcpv6',
      server_ip: 'fe80::bad',
      server_duid: '00:01:00:01:aa:bb',
      offered_dns: 'fd00::bad',
      iface: 'eth0',
      times_seen: 1,
    },
    {
      id: 3,
      kind: 'ra',
      server_ip: 'fe80::1',
      server_mac: 'aa:bb:cc:dd:ee:ff',
      advertised_prefixes: '2001:db8:bad::/64',
      iface: 'eth0',
      times_seen: 4,
    },
  ];
});

describe('RogueDhcp page with IPv6 detectors', () => {
  it('labels each finding by the protocol that found it and shows the DUID and prefixes', async () => {
    const wrapper = mountPage(true);
    await flushPromises();
    const kinds = wrapper.findAll('.col[data-header="Kind"] .cell').map((c) => c.text());
    expect(kinds).toEqual(['DHCPv4', 'DHCPv6', 'Router']);
    const servers = wrapper.find('.col[data-header="Server"]').text();
    expect(servers).toContain('00:01:00:01:aa:bb');
    const gateways = wrapper
      .findAll('.col[data-header="Offered gateway"] .cell')
      .map((c) => c.text());
    expect(gateways[0]).toBe('10.0.0.250');
    expect(gateways[2]).toBe('2001:db8:bad::/64');
  });

  it('shows the DHCPv6 and Router Advertisement lines only while IPv6 support is on', async () => {
    const on = mountPage(true);
    await flushPromises();
    expect(on.find('[data-track="rogue-dhcpv6-status"]').text()).toContain('last probe');
    expect(on.find('[data-track="rogue-ra-status"]').text()).toContain('accept_ra is off on eth0');

    const off = mountPage(false);
    await flushPromises();
    expect(off.find('[data-track="rogue-dhcpv6-status"]').exists()).toBe(false);
    expect(off.find('[data-track="rogue-dhcp-auth-duid"]').exists()).toBe(false);
  });

  it('authorizes a server by DUID alone, and by MAC alone', async () => {
    const wrapper = mountPage(true);
    await flushPromises();
    await wrapper.find('[data-track="rogue-dhcp-auth-duid"]').setValue('00:01:00:01:aa:bb');
    await wrapper.find('[data-track="rogue-dhcp-add-authorized"]').trigger('click');
    await flushPromises();
    expect(store.addAuthorized).toHaveBeenCalledWith({
      server_ip: undefined,
      server_mac: undefined,
      server_duid: '00:01:00:01:aa:bb',
      description: undefined,
    });

    const inputs = wrapper.findAll('.rd-add-form input');
    await inputs[1].setValue('aa:bb:cc:dd:ee:ff');
    await wrapper.find('[data-track="rogue-dhcp-add-authorized"]').trigger('click');
    await flushPromises();
    expect(store.addAuthorized).toHaveBeenLastCalledWith(
      expect.objectContaining({ server_mac: 'aa:bb:cc:dd:ee:ff', server_ip: undefined }),
    );
  });

  it('refuses an entry with no identity at all', async () => {
    const wrapper = mountPage(false);
    await flushPromises();
    await wrapper.find('[data-track="rogue-dhcp-add-authorized"]').trigger('click');
    expect(store.addAuthorized).not.toHaveBeenCalled();
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warn' }));
  });
});
