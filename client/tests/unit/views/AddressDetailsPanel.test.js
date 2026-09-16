import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AddressDetailsPanel from '../../../src/views/networks-workspace/AddressDetailsPanel.vue';
import api from '../../../src/api/client.js';

vi.mock('../../../src/api/client.js', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

const availableRow = {
  id: 'address:10.0.0.33',
  address: '10.0.0.33',
  hostname: null,
  status: 'DHCP Scope',
  type: null,
  online: 'offline',
  mac: '—',
  source: null,
  lastSeen: '—',
  scanning: 'On · inherited',
  raw: {
    ip_address: '10.0.0.33',
    allocation_state: 'unassigned',
    scan_enabled: null,
    scanning_enabled: true,
  },
};

function response(data) {
  return Promise.resolve({ data });
}

function mountPanel(row = availableRow, extraProps = {}) {
  return mount(AddressDetailsPanel, {
    props: {
      row,
      subnetId: 7,
      networkName: 'Lab',
      dnsCount: 1,
      dhcpCount: 2,
      canWrite: true,
      ...extraProps,
    },
  });
}

describe('workspace address details panel', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.put.mockReset();
    api.post.mockReset();
    api.delete.mockReset();
    api.get.mockResolvedValue(
      response({
        events: [
          { id: 1, event_type: 'retired', source: 'retirement', created_at: '2026-09-10 12:00:00' },
          {
            id: 2,
            event_type: 'allocation_changed',
            old_value: 'unassigned',
            new_value: 'reserved',
            source: 'manual',
            created_at: '2026-09-10 11:00:00',
          },
        ],
      }),
    );
    api.put.mockResolvedValue(response({}));
    api.delete.mockResolvedValue(response({ ok: true, cleared: true }));
    api.post.mockResolvedValue(
      response({ responded: true, method: 'arp', mac: '02:00:00:00:00:33' }),
    );
  });

  it('loads lifecycle history and uses the concise Metadata Expired label', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith('/subnets/7/ips/10.0.0.33/events?limit=100');
    await wrapper.findAll('[role="tab"]')[1].trigger('click');
    expect(wrapper.find('.events-list').text()).toContain('Metadata Expired');
    expect(wrapper.find('.events-list').text()).toContain('Allocation changed');
    expect(wrapper.find('.events-list').text()).toContain('Latest 100');

    api.get.mockResolvedValueOnce(response({ events: [] }));
    await wrapper.find('.show-events').trigger('click');
    await flushPromises();
    expect(api.get).toHaveBeenLastCalledWith('/subnets/7/ips/10.0.0.33/events?limit=500');
  });

  it('creates an IP Reservation with an explicit note', async () => {
    const wrapper = mountPanel();
    await wrapper.find('button[data-track="workspace-create-ip-reservation"]').trigger('click');
    await wrapper.find('textarea').setValue('Printer replacement');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/subnets/7/ips/10.0.0.33/allocation', {
      allocation_state: 'reserved',
      note: 'Printer replacement',
    });
    expect(wrapper.emitted('changed')?.[0]).toEqual(['IP Reservation created']);
  });

  it('updates the explicit scan policy and probes the address', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    await wrapper.find('button[data-track="workspace-scan-off"]').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/subnets/7/ips/10.0.0.33/scan-enabled', {
      scan_enabled: false,
    });

    await wrapper.find('button[data-track="workspace-probe-address"]').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/scans/probe', { ip: '10.0.0.33', subnet_id: 7 });
    expect(wrapper.find('.feedback').text()).toContain('responded via ARP');
  });

  it.each([
    ['inherit', null],
    ['on', true],
    ['off', false],
  ])('sends the exact nullable scan policy for %s', async (track, expected) => {
    const row = {
      ...availableRow,
      raw: { ...availableRow.raw, scan_enabled: track === 'inherit' ? 1 : null },
    };
    const wrapper = mountPanel(row);
    await wrapper.find(`button[data-track="workspace-scan-${track}"]`).trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/subnets/7/ips/10.0.0.33/scan-enabled', {
      scan_enabled: expected,
    });
  });

  it('uses the server effective scanning value and disables unsupported probes', async () => {
    const row = {
      ...availableRow,
      raw: { ...availableRow.raw, address_family: 6, scanning_enabled: false },
    };
    const wrapper = mountPanel(row);
    expect(wrapper.text()).toContain('Effective setting: Off');
    expect(
      wrapper.find('[data-track="workspace-probe-address"]').attributes('disabled'),
    ).toBeDefined();
  });

  it('distinguishes a completed probe with no response from a successful response', async () => {
    api.post.mockResolvedValueOnce(response({ responded: false, method: 'icmp' }));
    const wrapper = mountPanel();
    await wrapper.find('[data-track="workspace-probe-address"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.feedback.warning').text()).toContain('did not respond via ICMP');
  });

  it('loads and edits device facts only with DHCP permissions', async () => {
    const row = {
      ...availableRow,
      mac: '02:00:00:00:00:33',
      raw: { ...availableRow.raw, mac_address: '02:00:00:00:00:33' },
    };
    api.get.mockImplementation((url) => {
      if (url.includes('/fingerprint/history')) {
        return response([{ field: 'os_family', new_value: 'Linux', changed_at: '2026-09-10' }]);
      }
      if (url.includes('/fingerprint')) {
        return response({
          device_type: 'Computer',
          os_family: 'Linux',
          confidence: 85,
          source: 'dhcp',
        });
      }
      return response({ events: [] });
    });
    const wrapper = mountPanel(row, { canReadDevice: true, canWriteDevice: true });
    await wrapper.findAll('[role="tab"]')[2].trigger('click');
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith('/devices/02%3A00%3A00%3A00%3A00%3A33/fingerprint');
    expect(api.get).toHaveBeenCalledWith(
      '/devices/02%3A00%3A00%3A00%3A00%3A33/fingerprint/history?days=90',
    );
    expect(wrapper.find('.device-facts').text()).toContain('85%');
    expect(wrapper.find('.device-history').text()).toContain('os family');
    expect(wrapper.find('.device-history').text()).toContain('Linux');
    await wrapper.find('#workspace-device-type').setValue('Server');
    await wrapper.find('#workspace-os-family').setValue('Linux');
    await wrapper.find('.device-section form').trigger('submit');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/devices/02%3A00%3A00%3A00%3A00%3A33/fingerprint', {
      device_type: 'Server',
      os_family: 'Linux',
    });

    await wrapper.find('.device-section form button[type="button"]').trigger('click');
    await flushPromises();
    expect(api.delete).toHaveBeenCalledWith('/devices/02%3A00%3A00%3A00%3A00%3A33/fingerprint');
  });

  it('does not request device data without DHCP read permission or a MAC', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(2);
    expect(api.get.mock.calls.some(([url]) => url.startsWith('/devices/'))).toBe(false);
  });

  it('offers only the related resources that exist', () => {
    expect(mountPanel(availableRow, { dnsCount: 0, dhcpCount: 0 }).text()).not.toContain(
      'RELATED RESOURCES',
    );
    const dhcpOnly = mountPanel(availableRow, { dnsCount: 0, dhcpCount: 2 });
    expect(
      dhcpOnly.findAll('.related-button').map((button) => button.find('strong').text()),
    ).toEqual(['DHCP identity']);
  });

  it('emits stable identities for related resources and the network', async () => {
    const wrapper = mountPanel();
    await wrapper.findAll('.related-button')[0].trigger('click');
    await wrapper.find('.quick-actions button:last-child').trigger('click');
    expect(wrapper.emitted('navigate')?.[0]).toEqual([
      'dns',
      { kind: 'ip', subnet_id: 7, ip_address: '10.0.0.33', address_family: null },
    ]);
    expect(wrapper.emitted('open-network')?.[0]).toEqual([{ kind: 'network', subnet_id: 7 }]);
  });

  it('requires confirmation before releasing an IP Reservation', async () => {
    const row = {
      ...availableRow,
      status: 'in use',
      type: 'IP Reservation',
      raw: { ...availableRow.raw, allocation_state: 'reserved', reservation_note: 'Printer' },
    };
    const wrapper = mountPanel(row);
    await wrapper.find('button[data-track="workspace-release-ip-reservation"]').trigger('click');
    expect(wrapper.find('.confirm-action').exists()).toBe(true);

    await wrapper.find('.confirm-action button.danger').trigger('click');
    await flushPromises();
    expect(api.put).toHaveBeenCalledWith('/subnets/7/ips/10.0.0.33/allocation', {
      allocation_state: 'unassigned',
      note: null,
    });
  });
});
