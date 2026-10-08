import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../../../../src/api/client.js';
import ApplyStatusBanner from '../../../../src/views/networks-workspace/ApplyStatusBanner.vue';

vi.mock('../../../../src/api/client.js', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

function generation(status = 'failed') {
  return {
    hook_name: 'regenerate_dns',
    desired_generation: 4,
    applied_generation: 3,
    status,
    last_error: status === 'failed' ? 'dnsmasq validation failed' : null,
  };
}

function mockReads(item = generation()) {
  api.get.mockImplementation((url) => {
    if (url === '/metrics/configuration-generation') return Promise.resolve({ data: [item] });
    if (url === '/metrics/ip-lifecycle') return Promise.resolve({ data: { stale_rows: 0 } });
    return Promise.resolve({ data: { orphan_scopes: 0 } });
  });
}

describe('workspace apply status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReads();
    api.post.mockResolvedValue({ data: { ok: true } });
  });

  it('shows exact desired/applied generations and server errors', async () => {
    const wrapper = mount(ApplyStatusBanner, { props: { canRead: true, canDnsWrite: true } });
    await flushPromises();
    expect(wrapper.text()).toContain('desired 4, applied 3');
    expect(wrapper.text()).toContain('dnsmasq validation failed');
  });

  it('applies only through the explicit protocol endpoint', async () => {
    const wrapper = mount(ApplyStatusBanner, { props: { canRead: true, canDnsWrite: true } });
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Apply DNS')
      .trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/dns/apply');
    expect(wrapper.emitted('changed')?.[0]).toEqual(['DNS configuration applied']);
  });

  it('requires a separate confirmation before repairing derived state', async () => {
    const wrapper = mount(ApplyStatusBanner, { props: { canRead: true, isAdmin: true } });
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Review repair')
      .trigger('click');
    expect(api.post).not.toHaveBeenCalled();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Repair derived state')
      .trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/operations/network-dhcp/repair-derived');
  });

  it('does not make denied diagnostic requests', async () => {
    mount(ApplyStatusBanner, { props: { canRead: false } });
    await flushPromises();
    expect(api.get).not.toHaveBeenCalled();
  });
});
