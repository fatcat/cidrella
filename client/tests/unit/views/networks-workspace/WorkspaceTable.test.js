import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import WorkspaceTable from '../../../../src/views/networks-workspace/WorkspaceTable.vue';
import { mapDnsRows } from '../../../../src/views/networks-workspace-data.js';

describe('WorkspaceTable', () => {
  it('marks a disabled row so it recedes, and leaves rows without the flag alone', () => {
    const wrapper = mount(WorkspaceTable, {
      props: {
        columns: [
          { key: 'name', label: 'Hostname' },
          { key: 'enabled', label: 'Enabled' },
        ],
        rows: [
          { id: 1, name: 'hass', enabled: false },
          { id: 2, name: 'nas', enabled: true },
          { id: 3, name: '10.0.0.4' },
        ],
      },
    });
    const classes = wrapper.findAll('tbody tr').map((tr) => tr.classes('disabled'));
    expect(classes).toEqual([true, false, false]);
  });

  it('colors the range name with its range color', () => {
    const wrapper = mount(WorkspaceTable, {
      props: {
        columns: [{ key: 'network_range_type', label: 'Range type' }],
        rows: [
          { id: 1, rangeType: 'Lab bench', rangeColor: '#0ea5e9' },
          { id: 2, rangeType: null, rangeColor: null },
        ],
      },
    });
    const names = wrapper.findAll('.range-name');
    expect(names).toHaveLength(1);
    expect(names[0].text()).toBe('Lab bench');
    expect(names[0].attributes('style')).toContain('--range-color: #0ea5e9');
  });

  it('shows the header box as the selection is, and checks all from partly checked', async () => {
    const rows = [{ id: 'address:1' }, { id: 'address:2' }];
    const wrapper = mount(WorkspaceTable, {
      props: { columns: [{ key: 'name', label: 'Hostname' }], rows, showCheckboxes: true },
    });
    const box = () => wrapper.find('thead input').element;
    const state = () => [box().checked, box().indeterminate];

    await wrapper.find('thead input').trigger('click');
    expect(wrapper.emitted('toggle-all').at(-1)).toEqual([true]);
    await wrapper.setProps({ selectedRows: rows.map((row) => row.id) });
    await flushPromises();
    expect(state()).toEqual([true, false]);

    await wrapper.setProps({ selectedRows: ['address:1'] });
    await flushPromises();
    expect(state()).toEqual([false, true]);

    // Partly checked: a click checks every row.
    await wrapper.find('thead input').trigger('click');
    expect(wrapper.emitted('toggle-all').at(-1)).toEqual([true]);
    await wrapper.setProps({ selectedRows: rows.map((row) => row.id) });
    await flushPromises();

    // All checked: a click clears.
    await wrapper.find('thead input').trigger('click');
    expect(wrapper.emitted('toggle-all').at(-1)).toEqual([false]);
    await wrapper.setProps({ selectedRows: [] });
    await flushPromises();
    expect(state()).toEqual([false, false]);
  });

  // A11Y-01: a record with no address was labeled "Select null".
  it('labels every row checkbox by what names the row, never null', () => {
    const zone = { id: 1, name: 'lab.test', type: 'forward' };
    const record = (id, type, name, value, ip = null) => ({
      id,
      record_type: type,
      name,
      record_fqdn: name === '@' ? 'lab.test' : `${name}.lab.test`,
      value,
      ip_address: ip,
      enabled: 1,
    });
    const rows = mapDnsRows([
      {
        zone,
        records: [
          record(1, 'A', 'nas', '10.0.0.4', '10.0.0.4'),
          record(2, 'AAAA', 'nas', 'fd00::4', 'fd00::4'),
          record(3, 'MX', '@', '10 mail.lab.test'),
          record(4, 'CNAME', 'www', 'nas.lab.test'),
        ],
      },
    ]);
    const wrapper = mount(WorkspaceTable, {
      props: { columns: [{ key: 'dnsName', label: 'Name' }], rows, showCheckboxes: true },
    });
    const labels = wrapper
      .findAll('tbody input[type="checkbox"]')
      .map((box) => box.attributes('aria-label'));
    expect(labels).toEqual([
      'Select 10.0.0.4',
      'Select fd00::4',
      'Select lab.test MX 10 mail.lab.test',
      'Select www.lab.test CNAME nas.lab.test',
    ]);
    for (const label of labels) expect(label).not.toMatch(/null|undefined/);
  });
});

