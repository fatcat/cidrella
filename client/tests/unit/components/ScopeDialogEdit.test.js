import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { dhcpStore, subnetStore, toast, api } = vi.hoisted(() => ({
  dhcpStore: { updateScope: vi.fn(), createScope: vi.fn(), fetchAvailableRanges: vi.fn() },
  subnetStore: { folders: [], getRangeTypes: vi.fn(), createRange: vi.fn() },
  toast: { add: vi.fn() },
  api: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../../../src/stores/dhcp.js', () => ({ useDhcpStore: () => dhcpStore }));
vi.mock('../../../src/stores/subnets.js', () => ({ useSubnetStore: () => subnetStore }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const ScopeDialog = (await import('../../../src/components/ScopeDialog.vue')).default;

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
const InputStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};

const subnet = { id: 11, name: 'Lab', cidr: '10.0.0.0/24', status: 'allocated', children: [] };
const scope = {
  id: 31,
  subnet_id: 11,
  range_id: 3,
  start_ip: '10.0.0.10',
  end_ip: '10.0.0.50',
  lease_time: '12h',
  enabled: 1,
  options: [],
  pools: [
    { start_ip: '10.0.0.10', end_ip: '10.0.0.50' },
    { start_ip: '10.0.0.100', end_ip: '10.0.0.150' },
  ],
};

function mountDialog() {
  return mount(ScopeDialog, {
    global: {
      stubs: {
        Dialog: DialogStub,
        Button: ButtonStub,
        InputText: InputStub,
        InputNumber: true,
        Select: true,
        ToggleSwitch: true,
        Popover: true,
        NetworkDialogs: true,
      },
    },
  });
}

const saveButton = (wrapper) =>
  wrapper.findAll('button').find((button) => ['Save', 'Create Scope'].includes(button.text()));

beforeEach(() => {
  for (const fn of [
    ...Object.values(dhcpStore),
    subnetStore.getRangeTypes,
    subnetStore.createRange,
    toast.add,
    api.get,
    api.post,
  ])
    fn.mockReset();
  api.get.mockImplementation((url) => {
    if (url === '/dhcp/options')
      return Promise.resolve({
        data: {
          catalog: [
            { code: 3, label: 'Router', type: 'ip', group: 'Common' },
            { code: 51, label: 'Lease time', type: 'number', group: 'Common' },
          ],
          groups: [{ name: 'Common', label: 'Common' }],
          defaults: {},
          enabledDefaults: [],
        },
      });
    if (url === '/subnets')
      return Promise.resolve({ data: { folders: [{ id: 1, name: 'Lab', subnets: [subnet] }] } });
    return Promise.reject(new Error(`Unexpected GET ${url}`));
  });
  dhcpStore.updateScope.mockResolvedValue({});
  dhcpStore.fetchAvailableRanges.mockResolvedValue([]);
});

describe('ScopeDialog pools, ranges and options', () => {
  it('T-24 shows every pool interval and locks the bounds so a save keeps them all', async () => {
    const wrapper = mountDialog();
    await wrapper.vm.openEdit(scope);
    await flushPromises();
    const pools = wrapper.find('[data-track="dhcp-scope-pools"]');
    expect(pools.text()).toContain('10.0.0.10');
    expect(pools.text()).toContain('10.0.0.100');
    expect(pools.text()).toContain('2 pool intervals');
    expect(wrapper.findAll('input').length).toBe(1); // description only, no start/end

    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(dhcpStore.updateScope).toHaveBeenCalledTimes(1);
    const [, payload] = dhcpStore.updateScope.mock.calls[0];
    expect(payload).not.toHaveProperty('start_ip');
    expect(payload).not.toHaveProperty('end_ip');
    expect(payload.lease_time).toBe('12h');

    await wrapper.vm.openEdit({ ...scope, pools: [scope.pools[0]] });
    await flushPromises();
    expect(wrapper.find('[data-track="dhcp-scope-pools"]').exists()).toBe(false);
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(dhcpStore.updateScope.mock.calls[1][1]).toMatchObject({
      start_ip: '10.0.0.10',
      end_ip: '10.0.0.50',
    });
  });

  it('T-27 never offers option 51 beside the lease time control', async () => {
    const wrapper = mountDialog();
    await wrapper.vm.openEdit({ ...scope, pools: [scope.pools[0]] });
    wrapper.vm.optionsExpanded = true;
    await flushPromises();
    const codes = wrapper.findAll('.scope-option-code').map((node) => node.text());
    expect(codes).toContain('(3)');
    expect(codes).not.toContain('(51)');
  });

  it('T-23 keeps a created range selected so the retry creates only the scope', async () => {
    subnetStore.getRangeTypes.mockResolvedValue([{ id: 9, name: 'DHCP Scope', is_system: 1 }]);
    subnetStore.createRange.mockResolvedValue({
      id: 55,
      start_ip: '10.0.0.20',
      end_ip: '10.0.0.40',
    });
    dhcpStore.createScope
      .mockRejectedValueOnce({ response: { status: 502, data: { error: 'dnsmasq refused' } } })
      .mockResolvedValue({ id: 61 });
    const wrapper = mountDialog();
    await wrapper.vm.openNewWithPicker(null);
    await flushPromises();
    wrapper.vm.form.subnet_id = 11;
    wrapper.vm.form.start_ip = '10.0.0.20';
    wrapper.vm.form.end_ip = '10.0.0.40';
    await flushPromises();

    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(subnetStore.createRange).toHaveBeenCalledTimes(1);
    expect(dhcpStore.createScope).toHaveBeenCalledWith(expect.objectContaining({ range_id: 55 }));
    expect(wrapper.find('[data-track="dhcp-scope-error"]').text()).toContain(
      'Range 10.0.0.20 to 10.0.0.40 was created but the scope was not: dnsmasq refused',
    );
    expect(wrapper.vm.form.range_id).toBe(55);
    expect(wrapper.emitted('saved')).toBeUndefined();

    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(subnetStore.createRange).toHaveBeenCalledTimes(1);
    expect(dhcpStore.createScope).toHaveBeenCalledTimes(2);
    expect(dhcpStore.createScope.mock.calls[1][0]).toMatchObject({ range_id: 55, subnet_id: 11 });
    expect(wrapper.emitted('saved')).toHaveLength(1);
  });
});
