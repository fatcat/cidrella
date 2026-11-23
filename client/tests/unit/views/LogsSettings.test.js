/**
 * Settings > Logs: one tab per role, named for the server filling it, each
 * showing that role's log; a server that keeps no log says so instead, and
 * an audit log has no clear button. A controller with members picks whose
 * logs to show; a member shows its own daemon logs and no audit log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

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
    props: ['role', 'clearable', 'instance'],
    template:
      '<div class="viewer" :data-role="role" :data-clearable="String(clearable)" :data-instance="String(instance)" />',
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
        return () =>
          h('button', { ...attrs, onClick: () => tabs.set(props.value) }, slots.default?.());
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
vi.mock('../../../src/ui/Select.js', () => ({
  default: {
    props: ['modelValue', 'options', 'optionLabel', 'optionValue'],
    emits: ['update:modelValue'],
    template:
      '<select class="instance-select" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="o in options" :key="o.instance_id" :value="o.instance_id">{{ o.name }}</option></select>',
  },
}));
vi.mock('../../../src/ui/DataTable.js', () => ({ default: { template: '<div />' } }));
vi.mock('../../../src/ui/Column.js', () => ({ default: { template: '<div />' } }));

const LogsSettings = (await import('../../../src/views/settings/LogsSettings.vue')).default;
const { useFeaturesStore } = await import('../../../src/stores/features.js');

function mountWith(sources, { instances = [], memberSources = null, mode = 'controller' } = {}) {
  api.get.mockImplementation((url, config) => {
    if (url === '/logs/sources') {
      const asked = config?.params?.instance;
      if (asked && memberSources instanceof Error) return Promise.reject(memberSources);
      return Promise.resolve({ data: { sources: asked ? memberSources : sources, instances } });
    }
    if (url === '/audit') return Promise.resolve({ data: { items: [], total: 0 } });
    return Promise.resolve({ data: [] });
  });
  const pinia = createPinia();
  setActivePinia(pinia);
  useFeaturesStore().set({ instance: { mode } });
  return mount(LogsSettings, { global: { plugins: [pinia] } });
}

beforeEach(() => vi.clearAllMocks());

const DNSMASQ = [
  { role: 'dns', label: 'dnsmasq', available: true, clearable: true, message: null },
  { role: 'dhcp', label: 'dnsmasq', available: true, clearable: true, message: null },
];
const INSTANCES = [
  { instance_id: 'own', name: 'controller' },
  { instance_id: 'm1', name: 'branch-office' },
];

describe('LogsSettings', () => {
  it('names each role tab for its server and shows that role log', async () => {
    const w = mountWith(DNSMASQ);
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

  it('offers no instance to pick on a single box', async () => {
    const w = mountWith(DNSMASQ);
    await flushPromises();
    expect(w.find('.instance-select').exists()).toBe(false);
    expect(w.find('.viewer').attributes('data-instance')).toBe('null');
  });

  it('picks a member and shows its logs, which are not cleared from here', async () => {
    const w = mountWith(DNSMASQ, {
      instances: INSTANCES,
      memberSources: DNSMASQ.map((s) => ({ ...s, clearable: false })),
    });
    await flushPromises();
    const select = w.find('.instance-select');
    expect(select.findAll('option').map((o) => o.text())).toEqual(['controller', 'branch-office']);
    expect(select.element.value).toBe('own');
    await select.setValue('m1');
    await flushPromises();
    expect(api.get).toHaveBeenLastCalledWith('/logs/sources', { params: { instance: 'm1' } });
    expect(w.find('.viewer').attributes()).toMatchObject({
      'data-role': 'dns',
      'data-instance': 'm1',
      'data-clearable': 'false',
    });
    // Back to this box: its own logs, asked without an instance.
    await w.find('.instance-select').setValue('own');
    await flushPromises();
    expect(api.get).toHaveBeenLastCalledWith('/logs/sources', { params: undefined });
    expect(w.find('.viewer').attributes('data-instance')).toBe('null');
  });

  it('says so in place when the member does not answer', async () => {
    const err = Object.assign(new Error('x'), {
      response: { data: { error: 'branch-office did not answer: timeout' } },
    });
    const w = mountWith(DNSMASQ, { instances: INSTANCES, memberSources: err });
    await flushPromises();
    await w.find('.instance-select').setValue('m1');
    await flushPromises();
    expect(w.text()).toContain('branch-office did not answer: timeout');
    expect(w.find('.viewer').exists()).toBe(false);
    expect(toast.add).not.toHaveBeenCalled();
  });

  it('shows the Audit Log on a controller and not on a member', async () => {
    const controller = mountWith(DNSMASQ);
    await flushPromises();
    expect(controller.find('[data-track="logs-tab-audit"]').exists()).toBe(true);
    expect(api.get).toHaveBeenCalledWith('/audit', expect.anything());

    vi.clearAllMocks();
    const member = mountWith(DNSMASQ, { mode: 'member' });
    await flushPromises();
    expect(member.find('[data-track="logs-tab-audit"]').exists()).toBe(false);
    expect(member.find('[data-track="logs-tab-dns"]').exists()).toBe(true);
    expect(api.get).not.toHaveBeenCalledWith('/audit', expect.anything());
    expect(api.get).not.toHaveBeenCalledWith('/audit/actions');
  });
});
