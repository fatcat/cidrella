import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

const { toast, api, ipv6 } = vi.hoisted(() => ({
  toast: { add: vi.fn() },
  api: { get: vi.fn(), post: vi.fn() },
  ipv6: { value: false },
}));

vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/composables/useFeatures.js', () => ({
  useFeatures: () => ({ ipv6: ref(ipv6.value) }),
}));

const BulkChange = (await import('../../../src/views/DhcpBulkChange.vue')).default;

const catalogs = {
  4: {
    family: 4,
    catalog: [
      { code: 6, label: 'DNS Servers', type: 'ip-list', group: 'Common' },
      { code: 15, label: 'Domain Name', type: 'text', group: 'Common' },
      { code: 42, label: 'NTP Servers', type: 'ip-list', group: 'Common' },
    ],
    groups: [{ name: 'Common', label: 'Common' }],
    defaults: { 6: '10.0.0.2' },
    enabledDefaults: [6, 15],
    shipped: { defaults: { 42: '162.244.81.139' }, enabledDefaults: [6, 15, 42] },
  },
  6: {
    family: 6,
    catalog: [{ code: 24, label: 'Domain Search List', type: 'text-list', group: 'Common' }],
    groups: [{ name: 'Common', label: 'Common' }],
    defaults: {},
    enabledDefaults: [24],
    shipped: { defaults: {}, enabledDefaults: [24] },
  },
};

const previews = {
  4: {
    family: 4,
    applied: [],
    scopes: [
      {
        id: 1,
        subnet_cidr: '10.0.0.0/24',
        subnet_name: 'Lab',
        pools: [{ start_ip: '10.0.0.100', end_ip: '10.0.0.200' }],
        skip_reason: null,
        changes: [{ code: 6, before: '10.0.0.9', after: '10.0.0.2' }],
      },
      {
        id: 2,
        subnet_cidr: '10.0.1.0/24',
        subnet_name: 'Guest',
        pools: [],
        skip_reason: null,
        changes: [],
      },
    ],
  },
  6: {
    family: 6,
    applied: [],
    scopes: [
      {
        id: 7,
        subnet_cidr: 'fd00:b::/64',
        subnet_name: 'SLAAC',
        pools: [],
        skip_reason: 'SLAAC only, sends no options',
        changes: [],
      },
    ],
  },
};

function mountView() {
  return mount(BulkChange, {
    global: {
      stubs: {
        DhcpOptionTable: true,
        ConfirmDialog: true,
        SelectButton: true,
        EmptyState: true,
        StatusDot: { props: ['label'], template: '<span class="source">{{ label }}</span>' },
        Checkbox: true,
        Button: {
          props: ['label'],
          emits: ['click'],
          template: '<button type="button" @click="$emit(\'click\')">{{ label }}</button>',
        },
      },
    },
  });
}

async function settle() {
  await flushPromises();
  await vi.advanceTimersByTimeAsync(400);
  await flushPromises();
}

beforeEach(() => {
  vi.useFakeTimers();
  ipv6.value = false;
  toast.add.mockReset();
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation((_url, config) =>
    Promise.resolve({ data: catalogs[config.params.family] }),
  );
  api.post.mockImplementation((url, body) =>
    Promise.resolve({
      data:
        url === '/dhcp/scopes/bulk-options'
          ? { ...previews[body.family], applied: body.scope_ids }
          : previews[body.family],
    }),
  );
});

describe('DHCP Bulk Change', () => {
  it('starts from the saved defaults and previews every scope', async () => {
    const wrapper = mountView();
    await settle();
    expect(wrapper.vm.values).toEqual({ 6: '10.0.0.2' });
    expect(wrapper.find('.source').text()).toBe('Loaded from your DHCPv4 defaults');
    expect(api.post).toHaveBeenCalledWith('/dhcp/scopes/bulk-options/preview', {
      family: 4,
      options: [{ code: 6, value: '10.0.0.2' }],
      enabledDefaults: [6, 15],
      save_defaults: true,
    });
    const rows = wrapper.findAll('tr[data-scope-id]');
    expect(rows.map((row) => row.text())).toEqual([
      expect.stringContaining('1 option'),
      expect.stringContaining('Matches'),
    ]);
  });

  it('resets to the shipped defaults and marks what differs from the saved ones', async () => {
    const wrapper = mountView();
    await settle();
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Reset to shipped defaults')
      .trigger('click');
    await settle();
    expect(wrapper.vm.values).toEqual({ 42: '162.244.81.139' });
    expect([...wrapper.vm.changedCodes].sort()).toEqual([42, 6]);
    expect(wrapper.find('.source').text()).toBe('Shipped defaults, not saved yet');
    wrapper.vm.values[15] = 'lab.test';
    await settle();
    expect(wrapper.find('.source').text()).toBe('Shipped defaults, edited');
  });

  it('applies to the selected scopes', async () => {
    const wrapper = mountView();
    await settle();
    wrapper.vm.toggle(1, true);
    await flushPromises();
    // Ticking a scope opens its changes.
    expect(wrapper.find('.change-list').text()).toContain('10.0.0.9');
    wrapper.vm.toggle(1, false);
    await flushPromises();
    expect(wrapper.find('.change-list').exists()).toBe(false);
    wrapper.vm.toggleAll(true);
    await flushPromises();
    expect(wrapper.vm.expanded.has(1)).toBe(true);
    wrapper.vm.toggleAll(false);
    wrapper.vm.toggle(1, true);
    await flushPromises();
    expect(wrapper.text()).toContain('Apply to 1 scope');
    expect(wrapper.vm.applySummary).toBe('1 option change, and your defaults');
    await wrapper.vm.apply();
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/dhcp/scopes/bulk-options', {
      family: 4,
      options: [{ code: 6, value: '10.0.0.2' }],
      enabledDefaults: [6, 15],
      save_defaults: true,
      scope_ids: [1],
    });
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ summary: '1 DHCPv4 scope changed' }),
    );
    expect(wrapper.vm.selected).toEqual([]);
  });

  it('switches to IPv6 and never selects a SLAAC-only scope', async () => {
    ipv6.value = true;
    const wrapper = mountView();
    await settle();
    wrapper.vm.family = 6;
    await settle();
    expect(api.get).toHaveBeenLastCalledWith('/dhcp/options', { params: { family: 6 } });
    wrapper.vm.toggleAll(true);
    expect(wrapper.vm.selected).toEqual([]);
    expect(wrapper.text()).toContain('SLAAC only, sends no options');
  });
});
