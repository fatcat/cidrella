import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import IpTableCell from '../../../src/components/table/IpTableCell.vue';
import { IP_TABLE_VIEW, ipTableColumns } from '../../../src/utils/ipTableColumns.js';

function column(key) {
  return ipTableColumns(IP_TABLE_VIEW.NETWORKS).find(candidate => candidate.key === key);
}

function mountCell(key, row) {
  return mount(IpTableCell, {
    props: { column: column(key), row, view: IP_TABLE_VIEW.NETWORKS },
    global: { directives: { tooltip: () => {} } }
  });
}

describe('IpTableCell', () => {
  it('renders in-use status with the same red dotted status treatment everywhere', () => {
    const wrapper = mountCell('status', {
      ip_display_status: 'in use',
      ip_status_severity: 'danger'
    });

    expect(wrapper.text()).toBe('in use');
    expect(wrapper.find('.status-text').classes()).toContain('state-err');
  });

  it('uses the shared short empty-cell treatment for missing values', () => {
    const wrapper = mountCell('vendor', {});
    expect(wrapper.text()).toBe('—');
    expect(wrapper.find('.cell-muted').exists()).toBe(true);
  });

  it('renders server-owned scanning and allocation source fields', () => {
    expect(mountCell('scanning_enabled', { scanning_enabled: true }).text()).toBe('Enabled');
    expect(mountCell('source', { allocation_source_type: 'dhcp_lease' }).text()).toBe('DHCP lease');
  });
});
