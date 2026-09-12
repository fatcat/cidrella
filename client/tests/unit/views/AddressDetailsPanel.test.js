import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AddressDetailsPanel from '../../../src/views/networks-workspace/AddressDetailsPanel.vue';
import api from '../../../src/api/client.js';

vi.mock('../../../src/api/client.js', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn() }
}));

const availableRow = {
  id: 'address:10.0.0.33', address: '10.0.0.33', hostname: null, status: 'DHCP Scope', type: null,
  online: 'offline', mac: '—', source: null, lastSeen: '—', scanning: 'On · inherited',
  raw: { ip_address: '10.0.0.33', allocation_state: 'unassigned', scan_enabled: null, scanning_enabled: true }
};

function response(data) {
  return Promise.resolve({ data });
}

function mountPanel(row = availableRow) {
  return mount(AddressDetailsPanel, { props: { row, subnetId: 7, networkName: 'Lab', dnsCount: 1, dhcpCount: 2 } });
}

describe('workspace address details panel', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.put.mockReset();
    api.post.mockReset();
    api.get.mockResolvedValue(response({ events: [
      { id: 1, event_type: 'retired', source: 'retirement', created_at: '2026-09-10 12:00:00' },
      { id: 2, event_type: 'allocation_changed', old_value: 'unassigned', new_value: 'reserved', source: 'manual', created_at: '2026-09-10 11:00:00' }
    ] }));
    api.put.mockResolvedValue(response({}));
    api.post.mockResolvedValue(response({ responded: true, method: 'arp', mac: '02:00:00:00:00:33' }));
  });

  it('loads lifecycle history and uses the concise Metadata Expired label', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith('/subnets/7/ips/10.0.0.33/events');
    expect(wrapper.find('.events-list').text()).toContain('Metadata Expired');
    expect(wrapper.find('.events-list').text()).toContain('Allocation changed');
  });

  it('creates an IP Reservation with an explicit note', async () => {
    const wrapper = mountPanel();
    await wrapper.find('button[data-track="workspace-create-ip-reservation"]').trigger('click');
    await wrapper.find('textarea').setValue('Printer replacement');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/subnets/7/ips/10.0.0.33/allocation', {
      allocation_state: 'reserved', note: 'Printer replacement'
    });
    expect(wrapper.emitted('changed')?.[0]).toEqual(['IP Reservation created']);
  });

  it('updates the explicit scan policy and probes the address', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.find('button[data-track="workspace-scan-off"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/subnets/7/ips/10.0.0.33/scan-enabled', { scan_enabled: false });

    await wrapper.find('button[data-track="workspace-probe-address"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/scans/probe', { ip: '10.0.0.33', subnet_id: 7 });
    expect(wrapper.find('.feedback').text()).toContain('responded via ARP');
  });

  it('requires confirmation before releasing an IP Reservation', async () => {
    const row = {
      ...availableRow,
      status: 'in use', type: 'IP Reservation',
      raw: { ...availableRow.raw, allocation_state: 'reserved', reservation_note: 'Printer' }
    };
    const wrapper = mountPanel(row);
    await wrapper.find('button[data-track="workspace-release-ip-reservation"]').trigger('click');
    expect(wrapper.find('.confirm-action').exists()).toBe(true);

    await wrapper.find('.confirm-action button.danger').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/subnets/7/ips/10.0.0.33/allocation', { allocation_state: 'unassigned', note: null });
  });
});
