import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { dhcpStore, subnetStore, toast, api } = vi.hoisted(() => ({
  dhcpStore: { updateScope: vi.fn(), createScope: vi.fn(), fetchAvailableRanges: vi.fn() },
  subnetStore: {
    folders: [],
    getRangeTypes: vi.fn(),
    createRange: vi.fn(),
    updateSubnet: vi.fn(),
  },
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
const CheckboxStub = {
  props: ['modelValue', 'inputId'],
  emits: ['update:modelValue'],
  template:
    '<input type="checkbox" :id="inputId" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
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
        Checkbox: CheckboxStub,
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
// The scope form's own inputs, without the option rows' checkboxes and values.
const formInputs = (wrapper) =>
  wrapper.findAll('input').filter((input) => !input.element.closest('.scope-options-section'));

beforeEach(() => {
  for (const fn of [
    ...Object.values(dhcpStore),
    subnetStore.getRangeTypes,
    subnetStore.createRange,
    subnetStore.updateSubnet,
    toast.add,
    api.get,
    api.post,
  ])
    fn.mockReset();
  api.get.mockImplementation((url, config) => {
    if (url === '/dhcp/options' && config?.params?.family === 6)
      return Promise.resolve({
        data: {
          family: 6,
          catalog: [
            { code: 23, label: 'DNS Servers', type: 'ip-list', group: 'Common' },
            { code: 24, label: 'Domain Search List', type: 'text-list', group: 'Common' },
            { code: 56, label: 'NTP Servers', type: 'ip-list', group: 'Common' },
            { code: 14, label: 'Rapid Commit', type: 'flag', group: 'Network', builtIn: true },
          ],
          groups: [
            { name: 'Common', label: 'Common' },
            { name: 'Network', label: 'Network' },
          ],
          defaults: { 56: 'fd00::123' },
          enabledDefaults: [23, 24, 56],
        },
      });
    if (url === '/dhcp/options')
      return Promise.resolve({
        data: {
          family: 4,
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

describe('ScopeDialog on an IPv6 network', () => {
  const scope6 = {
    id: 61,
    subnet_id: 12,
    range_id: 6,
    subnet_cidr: 'fd00:1234::/64',
    subnet_gateway: 'fd00:1234::1',
    subnet_domain_name: 'six.test',
    address_family: 6,
    v6_mode: 'stateless',
    start_ip: 'fd00:1234::1',
    end_ip: 'fd00:1234::ffff:ffff:ffff:ffff',
    lease_time: '1d',
    enabled: 1,
    options: [],
    pools: [{ start_ip: 'fd00:1234::1', end_ip: 'fd00:1234::ffff:ffff:ffff:ffff' }],
  };

  it('offers the DHCPv6 modes, hides the pool for a SLAAC mode, and sends the mode', async () => {
    const wrapper = mountDialog();
    // NTP Servers (56) is stored linked: a row with no value uses the default.
    await wrapper.vm.openEdit({ ...scope6, options: [{ option_code: 56, value: null }] });
    await flushPromises();
    expect(wrapper.find('[data-track="scope-v6-mode"]').exists()).toBe(true);
    expect(wrapper.vm.form.v6_mode).toBe('stateless');
    // Description only: no Start/End for a stateless scope. The options block
    // is the IPv6 catalog, fetched by family, with no DHCPv4 code in it.
    expect(formInputs(wrapper).length).toBe(1);
    expect(api.get).toHaveBeenCalledWith('/dhcp/options', { params: { family: 6 } });
    wrapper.vm.optionsExpanded = true;
    await flushPromises();
    const codes = wrapper.findAll('.scope-option-code').map((node) => node.text());
    expect(codes).toEqual(['(23)', '(24)', '(56)', '(14)']);
    // Rapid Commit is dnsmasq's to send: no checkbox, read as always on.
    const rapid = wrapper.findAll('.scope-option-row').at(3);
    expect(rapid.find('input').exists()).toBe(false);
    expect(rapid.text()).toContain('always on');
    expect(wrapper.vm.form.optionValues[3]).toBeUndefined();
    expect(wrapper.vm.form.optionValues[1]).toBeUndefined();
    // On edit the scope's own rows load: the linked NTP row as Use default,
    // then the search list from the network's domain. DNS Servers (23) stays
    // unselected because this scope has no server_ip.
    expect(wrapper.vm.form.selectedOptions).toEqual([56, 24]);
    expect(wrapper.vm.form.useDefault).toEqual([56]);
    expect(wrapper.vm.form.optionValues[24]).toBe('six.test');
    const ntp = wrapper.findAll('.scope-option-row').at(2);
    expect(ntp.text()).toContain('fd00::123');
    expect(ntp.find('#scope-option-56-use-default').element.checked).toBe(true);

    await saveButton(wrapper).trigger('click');
    await flushPromises();
    const [, payload] = dhcpStore.updateScope.mock.calls[0];
    expect(payload.v6_mode).toBe('stateless');
    expect(payload.options).toEqual([
      { code: 56, use_default: true },
      { code: 24, value: 'six.test' },
    ]);
  });

  // DHCP-01: a default reaches a scope only when the scope uses it.
  describe('Use default', () => {
    it('leaves a default the scope does not use unselected on edit', async () => {
      const wrapper = mountDialog();
      await wrapper.vm.openEdit(scope6);
      await flushPromises();
      expect(wrapper.vm.form.selectedOptions).toEqual([24]);
      expect(wrapper.vm.form.useDefault).toEqual([]);
      await saveButton(wrapper).trigger('click');
      await flushPromises();
      const [, payload] = dhcpStore.updateScope.mock.calls[0];
      expect(payload.options).toEqual([{ code: 24, value: 'six.test' }]);
    });

    it('ticks an option with a default as Use default, and unticking Use default starts an own value from it', async () => {
      const wrapper = mountDialog();
      await wrapper.vm.openEdit(scope6);
      await flushPromises();
      wrapper.vm.optionsExpanded = true;
      await flushPromises();
      const ntp = () => wrapper.findAll('.scope-option-row').at(2);
      await ntp().find('input[type="checkbox"]').setValue(true);
      expect(wrapper.vm.form.useDefault).toEqual([56]);
      await ntp().find('#scope-option-56-use-default').setValue(false);
      expect(wrapper.vm.form.useDefault).toEqual([]);
      expect(wrapper.vm.form.optionValues[56]).toBe('fd00::123');
      await saveButton(wrapper).trigger('click');
      await flushPromises();
      const [, payload] = dhcpStore.updateScope.mock.calls[0];
      expect(payload.options).toContainEqual({ code: 56, value: 'fd00::123' });
    });

    it('links an IPv4 scope row the same way', async () => {
      api.get.mockImplementation((url) => {
        if (url === '/dhcp/options')
          return Promise.resolve({
            data: {
              family: 4,
              catalog: [{ code: 42, label: 'NTP Servers', type: 'ip-list', group: 'Common' }],
              groups: [{ name: 'Common', label: 'Common' }],
              defaults: { 42: '10.0.0.123' },
              enabledDefaults: [42],
            },
          });
        if (url === '/subnets')
          return Promise.resolve({ data: { folders: [{ id: 1, name: 'Lab', subnets: [subnet] }] } });
        return Promise.reject(new Error(`Unexpected GET ${url}`));
      });
      const wrapper = mountDialog();
      await wrapper.vm.openEdit({ ...scope, options: [{ option_code: 42, value: null }] });
      await flushPromises();
      expect(wrapper.vm.form.useDefault).toEqual([42]);
      await saveButton(wrapper).trigger('click');
      await flushPromises();
      const [, payload] = dhcpStore.updateScope.mock.calls[0];
      expect(payload.options).toContainEqual({ code: 42, use_default: true });
    });
  });

  it('shows the pool again for a stateful scope', async () => {
    const wrapper = mountDialog();
    await wrapper.vm.openEdit({
      ...scope6,
      v6_mode: 'stateful',
      start_ip: 'fd00:1234::1000',
      end_ip: 'fd00:1234::1fff',
      pools: [{ start_ip: 'fd00:1234::1000', end_ip: 'fd00:1234::1fff' }],
    });
    await flushPromises();
    expect(formInputs(wrapper).length).toBe(3); // start, end, description
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    const [, payload] = dhcpStore.updateScope.mock.calls[0];
    expect(payload).toMatchObject({
      v6_mode: 'stateful',
      start_ip: 'fd00:1234::1000',
      end_ip: 'fd00:1234::1fff',
    });
  });

  // IPV6-42: a new scope opened from a network left the mode null, and the
  // save then wrote a stateful pool over the whole prefix.
  describe('a new DHCPv6 scope', () => {
    const network6 = { id: 12, name: 'Lab v6', cidr: 'fd00:1234::/64', domain_name: 'lab.test' };
    beforeEach(() => {
      subnetStore.getRangeTypes.mockResolvedValue([{ id: 9, name: 'DHCP Scope', is_system: 1 }]);
      subnetStore.createRange.mockImplementation((subnetId, range) =>
        Promise.resolve({ id: 77, ...range }),
      );
      dhcpStore.createScope.mockResolvedValue({ id: 62 });
    });

    it('keeps the run the operator picked as a stateful pool', async () => {
      const wrapper = mountDialog();
      // As the workspace's Create DHCP Scope on a selected run sends it.
      await wrapper.vm.openNewWithPicker({
        ...network6,
        start_ip: 'fd00:1234::10',
        end_ip: 'fd00:1234::20',
      });
      await flushPromises();
      expect(wrapper.vm.form.v6_mode).toBe('stateful');
      // The add-to-new-scopes default with a value is linked, not copied.
      expect(wrapper.vm.form.useDefault).toEqual([56]);

      await saveButton(wrapper).trigger('click');
      await flushPromises();
      expect(subnetStore.createRange).toHaveBeenCalledWith(
        12,
        expect.objectContaining({ start_ip: 'fd00:1234::10', end_ip: 'fd00:1234::20' }),
      );
      expect(dhcpStore.createScope).toHaveBeenCalledWith(
        expect.objectContaining({
          v6_mode: 'stateful',
          options: expect.arrayContaining([{ code: 56, use_default: true }]),
        }),
      );
    });

    it("opens on the prefix's first mode without a picked pool", async () => {
      const wrapper = mountDialog();
      await wrapper.vm.openNewWithPicker(network6);
      await flushPromises();
      expect(wrapper.vm.form.v6_mode).toBe('stateless');
    });

    it('refuses to save on a prefix shorter than /64 rather than guess', async () => {
      const wrapper = mountDialog();
      await wrapper.vm.openNewWithPicker({ ...network6, cidr: 'fd00:1234::/56' });
      await flushPromises();
      expect(wrapper.vm.form.v6_mode).toBeNull();
      await saveButton(wrapper).trigger('click');
      await flushPromises();
      expect(dhcpStore.createScope).not.toHaveBeenCalled();
      expect(toast.add).toHaveBeenCalledWith(
        expect.objectContaining({ summary: expect.stringContaining('/64 or longer') }),
      );
    });
  });

  it('never offers the mode picker on an IPv4 scope', async () => {
    const wrapper = mountDialog();
    await wrapper.vm.openEdit({ ...scope, pools: [scope.pools[0]] });
    await flushPromises();
    expect(wrapper.find('[data-track="scope-v6-mode"]').exists()).toBe(false);
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    const [, payload] = dhcpStore.updateScope.mock.calls[0];
    expect(payload).not.toHaveProperty('v6_mode');
  });
});

describe('the gateway choice', () => {
  const network = {
    id: 11,
    name: 'Lab',
    cidr: '10.0.0.0/24',
    gateway_policy: 'first',
    gateway_address: '10.0.0.1',
  };
  beforeEach(() => {
    const fallback = api.get.getMockImplementation();
    api.get.mockImplementation((url, config) =>
      url === '/subnets/11' ? Promise.resolve({ data: network }) : fallback(url, config),
    );
    subnetStore.updateSubnet.mockImplementation((id, body) =>
      Promise.resolve({ ...network, ...body, gateway_address: '10.0.0.254' }),
    );
  });

  it("shows the network's gateway and leaves a scope's own router alone on open", async () => {
    const wrapper = mountDialog();
    await wrapper.vm.openEdit({
      ...scope,
      pools: [scope.pools[0]],
      options: [{ option_code: 3, value: '10.0.0.9' }],
    });
    await flushPromises();
    expect(wrapper.find('[data-track="scope-gateway-position"]').exists()).toBe(true);
    expect(wrapper.vm.gateway).toEqual({ position: 'first', address: '10.0.0.1' });
    expect(wrapper.vm.form.optionValues[3]).toBe('10.0.0.9');
    expect(wrapper.vm.gatewayChanged).toBe(false);

    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(subnetStore.updateSubnet).not.toHaveBeenCalled();

    // Moving the gateway keeps the override too.
    await wrapper.vm.openEdit({
      ...scope,
      pools: [scope.pools[0]],
      options: [{ option_code: 3, value: '10.0.0.9' }],
    });
    await flushPromises();
    wrapper.vm.gateway.position = 'last';
    await flushPromises();
    expect(wrapper.vm.form.optionValues[3]).toBe('10.0.0.9');
  });

  it('moves the network gateway to the last address before saving the scope', async () => {
    const wrapper = mountDialog();
    await wrapper.vm.openEdit({ ...scope, pools: [scope.pools[0]] });
    await flushPromises();
    wrapper.vm.gateway.position = 'last';
    await flushPromises();
    expect(wrapper.vm.gateway.address).toBe('10.0.0.254');
    expect(wrapper.vm.form.optionValues[3]).toBe('10.0.0.254');
    expect(wrapper.vm.gatewayChanged).toBe(true);

    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(subnetStore.updateSubnet).toHaveBeenCalledWith(11, { gateway_policy: 'last' });
    expect(subnetStore.updateSubnet.mock.invocationCallOrder[0]).toBeLessThan(
      dhcpStore.updateScope.mock.invocationCallOrder[0],
    );
  });

  it('sends a typed address as a custom gateway, and None drops the router', async () => {
    const wrapper = mountDialog();
    await wrapper.vm.openEdit({ ...scope, pools: [scope.pools[0]] });
    await flushPromises();
    wrapper.vm.gateway.address = '10.0.0.50';
    await flushPromises();
    expect(wrapper.vm.gateway.position).toBe('custom');
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(subnetStore.updateSubnet).toHaveBeenCalledWith(11, {
      gateway_policy: 'custom',
      gateway_address: '10.0.0.50',
    });

    await wrapper.vm.openEdit({ ...scope, pools: [scope.pools[0]] });
    await flushPromises();
    wrapper.vm.gateway.position = 'none';
    await flushPromises();
    expect(wrapper.vm.form.selectedOptions).not.toContain(3);
  });

  it('refills an untouched suggested pool around the new gateway', async () => {
    api.post.mockImplementation((url, body) =>
      Promise.resolve({
        data: {
          default_dhcp_pool:
            body.gateway_address === '10.0.0.254'
              ? { start_ip: '10.0.0.1', end_ip: '10.0.0.200' }
              : { start_ip: '10.0.0.50', end_ip: '10.0.0.254' },
        },
      }),
    );
    dhcpStore.fetchAvailableRanges.mockResolvedValue([]);
    const wrapper = mountDialog();
    await wrapper.vm.openNewWithPicker(network);
    await flushPromises();
    expect(wrapper.vm.form.start_ip).toBe('10.0.0.50');
    wrapper.vm.gateway.position = 'last';
    await flushPromises();
    expect(wrapper.vm.form).toMatchObject({ start_ip: '10.0.0.1', end_ip: '10.0.0.200' });
  });
});
