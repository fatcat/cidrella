import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import NetworksWorkspacePreview from '../../../src/views/NetworksWorkspacePreview.vue';

function mountPreview() {
  return mount(NetworksWorkspacePreview, {
    global: {
      stubs: {
        RouterLink: {
          props: ['to'],
          template: '<a :href="to"><slot /></a>'
        }
      }
    }
  });
}

describe('Networks workspace preview', () => {
  it('keeps network context while switching between address, DNS, and DHCP views', async () => {
    const wrapper = mountPreview();
    expect(wrapper.find('.context-header').text()).toContain('Staff LAN');
    expect(wrapper.find('table').text()).toContain('10.42.16.18');

    const dnsTab = wrapper.findAll('.view-tabs button').find(button => button.text().includes('DNS'));
    await dnsTab.trigger('click');

    expect(wrapper.find('.context-header').text()).toContain('Staff LAN');
    expect(wrapper.find('.view-summary').text()).toContain('corp.example');
    expect(wrapper.find('table').text()).toContain('print-west');

    const dhcpTab = wrapper.findAll('.view-tabs button').find(button => button.text().includes('DHCP'));
    await dhcpTab.trigger('click');

    expect(wrapper.find('.context-header').text()).toContain('Staff LAN');
    expect(wrapper.find('.view-summary').text()).toContain('Staff LAN scope');
    expect(wrapper.find('table').text()).toContain('74:DA:38:17:2C:91');
  });

  it('offers service-wide inventory without creating a second work surface', async () => {
    const wrapper = mountPreview();
    const dnsInventory = wrapper.findAll('.service-shortcuts button')[0];
    await dnsInventory.trigger('click');

    expect(wrapper.find('.context-header').text()).toContain('DNS inventory');
    expect(wrapper.findAll('.view-tabs button')).toHaveLength(1);
    expect(wrapper.find('.view-tabs button').text()).toContain('DNS');
  });

  it('filters available rows and opens contextual details from a table row', async () => {
    const wrapper = mountPreview();
    expect(wrapper.find('table').text()).toContain('10.42.16.64');

    await wrapper.find('.available-switch input').setValue(false);
    expect(wrapper.find('table').text()).not.toContain('10.42.16.64');

    const gatewayRow = wrapper.findAll('tbody tr').find(row => row.text().includes('10.42.16.1'));
    await gatewayRow.trigger('click');
    expect(wrapper.find('.details-panel').text()).toContain('10.42.16.1');
    expect(wrapper.find('.details-panel').text()).toContain('DNS records');
    expect(wrapper.find('.details-panel').text()).toContain('DHCP identity');
  });

  it('switches the address work surface between table and grid presentations', async () => {
    const wrapper = mountPreview();
    await wrapper.find('button[aria-label="Grid view"]').trigger('click');

    expect(wrapper.find('.address-grid').exists()).toBe(true);
    expect(wrapper.findAll('.address-grid button')).toHaveLength(128);
    expect(wrapper.find('table').exists()).toBe(false);
  });
});
