/**
 * The IPv6 switch on Settings > General > Interfaces.
 *
 * Host IPv6 addresses show only while the switch is on, flipping it marks
 * the page dirty, Save sends it with the rest of the interface config, and a
 * successful save refreshes the feature switches every other page reads.
 */
import { computed } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = { get: vi.fn(), put: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => ({ add: vi.fn() }) }));

const { default: InterfacePanel } = await import('../../../src/components/InterfacePanel.vue');
const { useFeaturesStore } = await import('../../../src/stores/features.js');

const ETH0 = {
  name: 'eth0',
  mac: 'aa:bb:cc:dd:ee:ff',
  state: 'up',
  addresses: [
    { address: '10.0.0.5', netmask: '255.255.255.0', family: 4 },
    { address: 'fd00:a::5', netmask: 'ffff:ffff:ffff:ffff::', family: 6, scopeid: 0 },
  ],
};

function configWith(ipv6) {
  return {
    interfaces: { eth0: { dns: true, dhcp: true } },
    dns_enabled: true,
    dhcp_enabled: true,
    ipv6_enabled: ipv6,
    web_ports: { https_port: 443, http_port: 80, http_redirect_enabled: true },
  };
}

// The vendor table renders its columns' body slots per row; these stubs do
// the same with none of the vendor machinery.
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
const ToggleStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<button class="tg" :aria-pressed="String(!!modelValue)" @click="$emit(\'update:modelValue\', !modelValue)" />',
};
const ButtonStub = {
  props: ['label', 'disabled', 'loading'],
  emits: ['click'],
  template: '<button :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
};

function mountPanel() {
  return mount(InterfacePanel, {
    global: {
      plugins: [createPinia()],
      stubs: {
        DataTable: DataTableStub,
        Column: ColumnStub,
        ToggleSwitch: ToggleStub,
        Button: ButtonStub,
        Tag: true,
        EmptyState: true,
      },
    },
  });
}

const ipv6Toggle = (w) => w.find('[data-track="iface-ipv6-global"]');
const saveButton = (w) => w.find('[data-track="iface-save"]');
const addressColumn = (w) => w.find('.col[data-header="IP Address"]').text();

beforeEach(() => {
  api.get.mockReset();
  api.put.mockReset();
  api.get.mockImplementation((url) => {
    if (url === '/interfaces') return Promise.resolve({ data: [ETH0] });
    if (url === '/interfaces/config') return Promise.resolve({ data: configWith(false) });
    if (url === '/features') return Promise.resolve({ data: { ipv6: false } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  api.put.mockResolvedValue({
    data: {
      ok: true,
      dnsmasq: 'unchanged',
      web_ports: configWith(true).web_ports,
      ipv6_enabled: true,
    },
  });
});

describe('InterfacePanel IPv6 switch', () => {
  it('hides host IPv6 addresses and shows the switch off by default', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(ipv6Toggle(wrapper).attributes('aria-pressed')).toBe('false');
    expect(addressColumn(wrapper)).toContain('10.0.0.5');
    expect(addressColumn(wrapper)).not.toContain('fd00:a::5');
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-track="iface-ipv6-help"]').text()).toContain('IPv6 is off');
  });

  it('flipping the switch reveals the addresses and marks the page dirty', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await ipv6Toggle(wrapper).trigger('click');
    expect(addressColumn(wrapper)).toContain('fd00:a::5');
    expect(saveButton(wrapper).attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-track="iface-ipv6-help"]').text()).toContain('IPv6 is on');
  });

  it('Save sends ipv6_enabled with the config and refreshes the feature switches', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const features = useFeaturesStore();
    expect(features.ipv6).toBe(false);

    await ipv6Toggle(wrapper).trigger('click');
    api.get.mockImplementation((url) => {
      if (url === '/interfaces') return Promise.resolve({ data: [ETH0] });
      if (url === '/interfaces/config') return Promise.resolve({ data: configWith(true) });
      if (url === '/features') return Promise.resolve({ data: { ipv6: true } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    await saveButton(wrapper).trigger('click');
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith(
      '/interfaces/config',
      expect.objectContaining({ ipv6_enabled: true, dns_enabled: true, dhcp_enabled: true }),
    );
    expect(features.ipv6).toBe(true);
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
    expect(addressColumn(wrapper)).toContain('fd00:a::5');
  });

  it('a save that did not touch the switch does not reload the feature switches', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.find('[data-track="iface-dhcp-global"]').trigger('click');
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith(
      '/interfaces/config',
      expect.objectContaining({ ipv6_enabled: false, dhcp_enabled: false }),
    );
    expect(api.get.mock.calls.filter(([url]) => url === '/features')).toHaveLength(0);
  });
});
