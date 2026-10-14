/**
 * Settings > Logs: one tab per role, named for the server filling it, each
 * showing that role's log; a server that keeps no log says so instead, and
 * an audit log has no clear button.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { api, toast } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  toast: { add: vi.fn() },
}));
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
// Loaded through defineAsyncComponent, which unwraps an ES module's default.
vi.mock('../../../src/components/LogViewer.vue', () => ({
  __esModule: true,
  default: {
    props: ['role', 'clearable'],
    template: '<div class="viewer" :data-role="role" :data-clearable="String(clearable)" />',
  },
}));

// The tab shims wrap vendor components; plain elements keep the value and
// click contracts. Tabs provides the open value; Tab sets it; TabPanel shows
// only the open one.
vi.mock('../../../src/ui/Tabs.js', async () => {
  const { provide, ref, watch } = await import('vue');
  return {
    default: {
      props: ['value'],
      emits: ['update:value'],
      setup(props, { emit, slots }) {
        const open = ref(props.value);
        watch(
          () => props.value,
          (v) => (open.value = v),
        );
        provide('tabs', {
          open,
          set: (v) => {
            open.value = v;
            emit('update:value', v);
          },
        });
        return () => slots.default?.();
      },
    },
  };
});
vi.mock('../../../src/ui/Tab.js', async () => {
  const { h, inject } = await import('vue');
  return {
    default: {
      props: ['value'],
      setup(props, { slots, attrs }) {
        const tabs = inject('tabs');
        return () => h('button', { ...attrs, onClick: () => tabs.set(props.value) }, slots.default?.());
      },
    },
  };
});
vi.mock('../../../src/ui/TabPanel.js', async () => {
  const { h, inject } = await import('vue');
  return {
    default: {
      props: ['value'],
      setup(props, { slots }) {
        const tabs = inject('tabs');
        return () => (tabs.open.value === props.value ? h('div', slots.default?.()) : null);
      },
    },
  };
});
for (const shim of ['TabList', 'TabPanels']) {
  vi.doMock(`../../../src/ui/${shim}.js`, () => ({ default: { template: '<div><slot /></div>' } }));
}
vi.mock('../../../src/ui/MultiSelect.js', () => ({ default: { template: '<div />' } }));
vi.mock('../../../src/ui/DataTable.js', () => ({ default: { template: '<div />' } }));
vi.mock('../../../src/ui/Column.js', () => ({ default: { template: '<div />' } }));

const LogsSettings = (await import('../../../src/views/settings/LogsSettings.vue')).default;

function mountWith(sources) {
  api.get.mockImplementation((url) => {
    if (url === '/logs/sources') return Promise.resolve({ data: sources });
    if (url === '/audit') return Promise.resolve({ data: { items: [], total: 0 } });
    return Promise.resolve({ data: [] });
  });
  return mount(LogsSettings);
}

beforeEach(() => vi.clearAllMocks());

describe('LogsSettings', () => {
  it('names each role tab for its server and shows that role log', async () => {
    const w = mountWith([
      { role: 'dns', label: 'dnsmasq', available: true, clearable: true, message: null },
      { role: 'dhcp', label: 'dnsmasq', available: true, clearable: true, message: null },
    ]);
    await flushPromises();
    expect(w.find('[data-track="logs-tab-dns"]').text()).toBe('DNS (dnsmasq)');
    expect(w.find('[data-track="logs-tab-dhcp"]').text()).toBe('DHCP (dnsmasq)');
    await flushPromises();
    expect(w.find('.viewer').attributes()).toMatchObject({
      'data-role': 'dns',
      'data-clearable': 'true',
    });
  });

  it('says when a server keeps no log, and keeps an audit log uncleared', async () => {
    const w = mountWith([
      {
        role: 'dns',
        label: 'PowerDNS',
        available: false,
        clearable: false,
        message: 'PowerDNS keeps no DNS log to show',
      },
      { role: 'dhcp', label: 'Kea', available: true, clearable: false, message: null },
    ]);
    await flushPromises();
    expect(w.text()).toContain('PowerDNS keeps no DNS log to show');
    expect(w.find('[data-track="logs-tab-dhcp"]').text()).toBe('DHCP (Kea)');
    await w.find('[data-track="logs-tab-dhcp"]').trigger('click');
    await flushPromises();
    expect(w.find('.viewer').attributes()).toMatchObject({
      'data-role': 'dhcp',
      'data-clearable': 'false',
    });
  });
});
