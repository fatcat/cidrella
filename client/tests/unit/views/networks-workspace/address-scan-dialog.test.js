import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../../../src/api/client.js';
import AddressScanDialog from '../../../../src/views/networks-workspace/dialogs/AddressScanDialog.vue';

vi.mock('../../../../src/api/client.js', () => ({
  default: { put: vi.fn(), post: vi.fn() },
}));

const stubs = {
  Dialog: { template: '<section><slot /></section>' },
  Button: {
    props: ['label', 'disabled'],
    template:
      '<button :type="$attrs.type" :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
  },
};

function mountDialog(mode, extra = {}) {
  return mount(AddressScanDialog, {
    props: {
      visible: true,
      subnetId: 7,
      address: '10.0.0.33',
      mode,
      ...extra,
    },
    global: { stubs },
  });
}

describe('workspace address scan dialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['inherit', null],
    ['on', true],
    ['off', false],
  ])('preserves the nullable %s scan override', async (choice, expected) => {
    api.put.mockResolvedValue({ data: {} });
    const wrapper = mountDialog('policy');
    await wrapper.find(`input[value="${choice}"]`).setValue();
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(api.put).toHaveBeenCalledWith('/subnets/7/ips/10.0.0.33/scan-enabled', {
      scan_enabled: expected,
    });
  });

  it('reports a completed probe with no response without inventing online success', async () => {
    api.post.mockResolvedValue({ data: { responded: false, method: 'icmp' } });
    const wrapper = mountDialog('probe');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith('/scans/probe', { ip: '10.0.0.33', subnet_id: 7 });
    expect(wrapper.get('.result.warning').text()).toContain('did not respond via ICMP');
  });

  // IPV6-44/45: the server probes IPv6 (ICMPv6 echo, then Neighbor
  // Discovery), so the dialog offers it, and one instance reused from an IPv6
  // address to an IPv4 one keeps working.
  it('probes an IPv6 address, then an IPv4 one in the same instance', async () => {
    api.post.mockResolvedValue({ data: { responded: true, method: 'ndp' } });
    const wrapper = mountDialog('probe', { address: '2001:db8::1' });
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined();
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith('/scans/probe', { ip: '2001:db8::1', subnet_id: 7 });

    await wrapper.setProps({ address: '10.0.0.5' });
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined();
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(api.post).toHaveBeenLastCalledWith('/scans/probe', { ip: '10.0.0.5', subnet_id: 7 });
  });
});
