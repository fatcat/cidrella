/**
 * The Hosts view of a network (docs/IPV6-HANDLING.md rule 5): one row per
 * device, opened to list its addresses, temporaries folded until asked for.
 * An address opens the address details panel.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import HostTable from '../../../../src/views/networks-workspace/HostTable.vue';

const address = (ip, kind, fields = {}) => ({
  ip_address: ip,
  interface_id: null,
  kind,
  allocation_state: 'slaac',
  address_type: 'SLAAC',
  hostname: null,
  online: false,
  last_seen_at: null,
  ...fields,
});

const laptop = {
  key: 'mac:00:1a:2b:3c:4d:5e',
  key_kind: 'mac',
  mac: '00:1a:2b:3c:4d:5e',
  duid: null,
  name: 'laptop',
  hostnames: ['laptop'],
  online: true,
  last_seen_at: null,
  stable_count: 2,
  temporary_count: 1,
  other_count: 1,
  vendor: 'Acme',
  device_type: 'Laptop',
  os_family: 'Linux',
  addresses: [
    address('fe80::21a:2bff:fe3c:4d5e', 'link-local', { interface_id: 'eth0' }),
    address('fd00:5::21a:2bff:fe3c:4d5e', 'eui64'),
    address('fd00:5::9999', 'temporary'),
  ],
  other_family: [{ ip_address: '10.0.0.5', subnet_id: 3, cidr: '10.0.0.0/24', source: 'lease' }],
};

const printer = {
  ...laptop,
  key: 'address:10.0.0.30',
  key_kind: 'address',
  mac: null,
  name: 'printer',
  hostnames: ['printer'],
  online: false,
  vendor: null,
  device_type: null,
  os_family: null,
  temporary_count: 0,
  other_count: 0,
  stable_count: 1,
  addresses: [address('10.0.0.30', 'static', { allocation_state: 'reserved' })],
  other_family: [],
};

const shown = (wrapper) =>
  wrapper.findAll('[data-track="workspace-host-address"]').map((b) => b.attributes('data-address'));

describe('HostTable', () => {
  it('shows one row per host, in either family', () => {
    const wrapper = mount(HostTable, { props: { hosts: [laptop, printer] } });
    const rows = wrapper.findAll('tbody tr[data-row-id]');
    expect(rows.map((row) => row.attributes('data-row-id'))).toEqual([
      'host:mac:00:1a:2b:3c:4d:5e',
      'host:address:10.0.0.30',
    ]);
    expect(rows[0].text()).toContain('laptop');
    expect(rows[0].text()).toContain('Acme');
    expect(rows[0].text()).toContain('Laptop · Linux');
    expect(rows[0].text()).toContain('1 other');
    expect(rows[1].text()).toContain('10.0.0.30');
  });

  it('opens a host to its addresses with temporaries folded, and shows its IPv4 side', async () => {
    const wrapper = mount(HostTable, { props: { hosts: [laptop] } });
    expect(shown(wrapper)).toEqual([]);
    await wrapper.find('[data-track="workspace-host-expand"]').trigger('click');
    expect(shown(wrapper)).toEqual(['fe80::21a:2bff:fe3c:4d5e%eth0', 'fd00:5::21a:2bff:fe3c:4d5e']);
    expect(wrapper.find('.other-family').text()).toContain('10.0.0.5');
    await wrapper.find('[data-track="workspace-host-temporaries"]').trigger('click');
    expect(shown(wrapper)).toContain('fd00:5::9999');
  });

  it('opens an address in the details panel', async () => {
    const wrapper = mount(HostTable, { props: { hosts: [laptop] } });
    await wrapper.find('tbody tr[data-row-id]').trigger('click');
    await wrapper.find('[data-address="fd00:5::21a:2bff:fe3c:4d5e"]').trigger('click');
    expect(wrapper.emitted('open-address')).toEqual([['fd00:5::21a:2bff:fe3c:4d5e']]);
  });

  it('keeps the host of the open address open and marked', () => {
    const wrapper = mount(HostTable, {
      props: { hosts: [laptop, printer], selectedAddress: '10.0.0.30' },
    });
    expect(wrapper.find('tbody tr.selected').attributes('data-row-id')).toBe(
      'host:address:10.0.0.30',
    );
    expect(shown(wrapper)).toEqual(['10.0.0.30']);
  });

  it('says so when there are no hosts', () => {
    const wrapper = mount(HostTable, { props: { hosts: [] } });
    expect(wrapper.text()).toContain('No hosts');
  });
});
