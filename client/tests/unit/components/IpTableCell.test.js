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

  it('renders a Network Range Type as an organizational tag', () => {
    const wrapper = mountCell('network_range_type', {
      network_range_type: 'Printers',
      network_range_type_color: '#22c55e'
    });

    expect(wrapper.text()).toBe('Printers');
    expect(wrapper.find('.network-range-type-tag').attributes('style')).toContain('#22c55e');
    expect(wrapper.find('.network-range-type-dot').attributes('style')).toContain('#22c55e');
  });

  it('renders the displayable DHCP fingerprint fields', () => {
    const row = {
      os_family: 'Windows',
      device_type: 'Computer',
      device_confidence: 85,
      dhcp_fingerprint: '1,3,6,15',
      dhcp_vendor_class: 'MSFT 5.0',
      dhcp_fingerprint_hostname: 'DESKTOP-TEST',
      device_fingerprint_source: 'dhcp'
    };
    expect(mountCell('os_family', row).text()).toBe('Windows');
    expect(mountCell('device_type', row).text()).toBe('Computer');
    expect(mountCell('device_confidence', row).text()).toBe('85%');
    expect(mountCell('dhcp_fingerprint', row).text()).toBe('1,3,6,15');
    expect(mountCell('dhcp_vendor_class', row).text()).toBe('MSFT 5.0');
    expect(mountCell('dhcp_fingerprint_hostname', row).text()).toBe('DESKTOP-TEST');
    expect(mountCell('device_fingerprint_source', row).text()).toBe('DHCP');
  });
});
