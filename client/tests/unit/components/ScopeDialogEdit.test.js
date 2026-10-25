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
          leaseTime: '1h',
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
    expect(payload.lease_time).toBe('43200');

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

  // Prod's three scopes had 15 and 10 minute leases that no screen offered to
  // change (2026-10-25): the form carried lease_time with no control for it.
  // The lease time is the first row of the option list, in seconds, and the
  // one control for it.
  it('shows the lease time as the first option row, saves an edit, and refuses a bad one', async () => {
    const wrapper = mountDialog();
    await wrapper.vm.openEdit({ ...scope, pools: [scope.pools[0]] });
    wrapper.vm.optionsExpanded = true;
    await flushPromises();
    const firstRow = wrapper.find('.scope-option-row');
    expect(firstRow.text()).toContain('Lease time');
    expect(firstRow.find('input[type="checkbox"]').element.disabled).toBe(true);
    expect(firstRow.find('[data-track="dhcp-scope-lease-time"]').exists()).toBe(true);
    expect(wrapper.vm.form.lease_time).toBe(43200);

    wrapper.vm.form.lease_time = 0;
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(dhcpStore.updateScope).not.toHaveBeenCalled();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Check the lease time' }),
    );

    wrapper.vm.form.lease_time = 3600;
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(dhcpStore.updateScope.mock.calls[0][1].lease_time).toBe('3600');
  });

  it("starts a new scope from the family's default lease time, as the server reports it", async () => {
    const fallback = api.get.getMockImplementation();
    api.get.mockImplementation((url, config) =>
      url === '/dhcp/options' && config?.params?.family !== 6
        ? Promise.resolve({
            data: {
              family: 4,
              catalog: [{ code: 51, label: 'Lease time', type: 'number', group: 'Common' }],
              groups: [{ name: 'Common', label: 'Common' }],
              defaults: { 51: '2h' },
              enabledDefaults: [51],
              leaseTime: '2h',
            },
          })
        : fallback(url, config),
    );
    const wrapper = mountDialog();
    await wrapper.vm.openNewWithPicker({ id: 11, name: 'Lab', cidr: '10.0.0.0/24' });
    await flushPromises();
    expect(wrapper.vm.form.lease_time).toBe(7200);

    // A DHCPv6 network starts from the DHCPv6 default, under its own label.
    const v6 = mountDialog();
    await v6.vm.openNewWithPicker({ id: 12, name: 'Six', cidr: 'fd00:1234::/64' });
    v6.vm.optionsExpanded = true;
    await flushPromises();
    expect(v6.vm.form.lease_time).toBe(3600);
    const firstRow = v6.find('.scope-option-row');
    expect(firstRow.text()).toContain('Address lifetime');
    expect(firstRow.find('.scope-option-code').exists()).toBe(false);
  });

  it('T-27 offers option 51 once, as the lease time row', async () => {
    const wrapper = mountDialog();
    await wrapper.vm.openEdit({ ...scope, pools: [scope.pools[0]] });
    wrapper.vm.optionsExpanded = true;
    await flushPromises();
    const codes = wrapper.findAll('.scope-option-code').map((node) => node.text());
    expect(codes).toContain('(3)');
    expect(codes.filter((code) => code === '(51)')).toHaveLength(1);
    expect(codes[0]).toBe('(51)');
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
    // NTP Servers (56) is the scope's own row.
    await wrapper.vm.openEdit({ ...scope6, options: [{ option_code: 56, value: 'fd00::123' }] });
    await flushPromises();
    expect(wrapper.find('[data-track="scope-v6-mode"]').exists()).toBe(true);
    expect(wrapper.vm.form.v6_mode).toBe('stateless');
    // Lease time and description only: no Start/End for a stateless scope.
    // The options block is the IPv6 catalog, fetched by family, with no
    // DHCPv4 code in it.
    expect(formInputs(wrapper).length).toBe(1);
    expect(api.get).toHaveBeenCalledWith('/dhcp/options', { params: { family: 6 } });
    wrapper.vm.optionsExpanded = true;
    await flushPromises();
    const codes = wrapper.findAll('.scope-option-code').map((node) => node.text());
    expect(codes).toEqual(['(23)', '(24)', '(56)', '(14)']);
    // Rapid Commit is dnsmasq's to send: no checkbox, read as always on.
    const rapid = wrapper.findAll('.scope-option-row').at(4); // after the lease time row
    expect(rapid.find('input').exists()).toBe(false);
    expect(rapid.text()).toContain('always on');
    expect(wrapper.vm.form.optionValues[3]).toBeUndefined();
    expect(wrapper.vm.form.optionValues[1]).toBeUndefined();
    // On edit the scope's own rows load: the NTP row, then the search list
    // from the network's domain. DNS Servers (23) stays unselected because
    // this scope has no server_ip.
    expect(wrapper.vm.form.selectedOptions).toEqual([56, 24]);
    expect(wrapper.vm.form.optionValues[24]).toBe('six.test');
    expect(wrapper.vm.form.optionValues[56]).toBe('fd00::123');

    await saveButton(wrapper).trigger('click');
    await flushPromises();
    const [, payload] = dhcpStore.updateScope.mock.calls[0];
    expect(payload.v6_mode).toBe('stateless');
    expect(payload.options).toEqual([
      { code: 56, value: 'fd00::123' },
      { code: 24, value: 'six.test' },
    ]);
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
      // The add-to-new-scopes default with a value is copied in.
      expect(wrapper.vm.form.optionValues[56]).toBe('fd00::123');

      await saveButton(wrapper).trigger('click');
      await flushPromises();
      expect(subnetStore.createRange).toHaveBeenCalledWith(
        12,
        expect.objectContaining({ start_ip: 'fd00:1234::10', end_ip: 'fd00:1234::20' }),
      );
      expect(dhcpStore.createScope).toHaveBeenCalledWith(
        expect.objectContaining({
          v6_mode: 'stateful',
          options: expect.arrayContaining([{ code: 56, value: 'fd00::123' }]),
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

// DHCP-02: the dialog fills network values by the server's rule
// (networkOptionFills through @shared), never its own copy.
describe('network fills from a picked range', () => {
  const pickRange = async (range) => {
    dhcpStore.fetchAvailableRanges.mockResolvedValue([range]);
    const wrapper = mountDialog();
    await wrapper.vm.openNewWithPicker();
    await flushPromises();
    wrapper.vm.form.range_id = range.id;
    await flushPromises();
    return wrapper;
  };

  it('IPv4: mask, router, broadcast, domain, and DNS with the fallback resolver', async () => {
    const wrapper = await pickRange({
      id: 5,
      subnet_id: 11,
      subnet_name: 'Lab',
      subnet_cidr: '10.0.0.0/24',
      subnet_gateway: '10.0.0.1',
      subnet_domain_name: 'lab.test',
      server_ip: '10.0.0.2',
      start_ip: '10.0.0.10',
      end_ip: '10.0.0.50',
    });
    expect(wrapper.vm.form.optionValues).toMatchObject({
      1: '255.255.255.0',
      3: '10.0.0.1',
      28: '10.0.0.255',
      15: 'lab.test',
      119: 'lab.test',
      6: '10.0.0.2',
    });
  });

  it('IPv6: copies the NTP default and fills DNS and the search list', async () => {
    const wrapper = await pickRange({
      id: 6,
      subnet_id: 12,
      subnet_name: 'Lab v6',
      subnet_cidr: 'fd00:1234::/64',
      subnet_domain_name: 'six.test',
      server_ip: 'fd00:1234::53',
      start_ip: 'fd00:1234::10',
      end_ip: 'fd00:1234::20',
    });
    expect(wrapper.vm.form.optionValues).toMatchObject({
      23: 'fd00:1234::53',
      24: 'six.test',
      56: 'fd00::123',
    });
    expect(wrapper.vm.form.optionValues[6]).toBeUndefined();
  });
});
