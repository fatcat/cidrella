import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const { default: HeaderBar } = await import('../../../src/components/HeaderBar.vue');
const { EMPTY_CELL } = await import('../../../src/utils/format.js');

const HEALTH = {
  version: '0.5.0',
  services: { dnsmasq: true },
  cpu: { loadAvg: [1, 1, 1], cores: 2 },
  memory: { used: 4e9, total: 8e9 },
  disk: { percent: 41, used: 2e10 },
  rogueDhcp: { enabled: false },
};

function mountHeader(healthImpl) {
  api.get.mockImplementation((url) => {
    if (url === '/health/system') return healthImpl();
    if (url === '/scans') return Promise.resolve({ data: [] });
    if (url === '/scans/next') return Promise.resolve({ data: { next_run: null } });
    return Promise.resolve({ data: {} });
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
  const stub = { template: '<div><slot /></div>' };
  return mount(HeaderBar, {
    global: {
      plugins: [createPinia(), router],
      stubs: { Popover: stub, Select: stub, RouterLink: { template: '<a><slot /></a>' } },
      directives: { tooltip: () => {} },
    },
  });
}

describe('header host status', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the read values when the health read works', async () => {
    const wrapper = mountHeader(() => Promise.resolve({ data: HEALTH }));
    await flushPromises();
    expect(wrapper.find('[data-track="header-chip-cpu"]').text()).toContain('CPU 50%');
    expect(wrapper.find('[data-track="header-chip-ram"]').text()).toContain('RAM 50%');
    expect(wrapper.find('[data-track="header-chip-disk"]').text()).toContain('Disk 41%');
    expect(wrapper.find('[data-track="header-chip-cpu"] .cid-status-dot').classes()).toContain(
      'sd-ok',
    );
  });

  it('shows a failed health read as unavailable, never as zero or healthy', async () => {
    const wrapper = mountHeader(() => Promise.reject(new Error('boom')));
    await flushPromises();
    for (const chip of ['cpu', 'ram', 'disk']) {
      const el = wrapper.find(`[data-track="header-chip-${chip}"]`);
      expect(el.text()).toContain(EMPTY_CELL);
      expect(el.text()).not.toContain('0%');
      expect(el.classes()).toContain('chip-idle');
      expect(el.find('.cid-status-dot').classes()).toContain('sd-muted');
      expect(el.find('.cid-status-dot').attributes('aria-label')).toBe('Unknown');
    }
    const dns = wrapper.find('[data-track="header-chip-dnsmasq"], .status-chip-dns');
    if (dns.exists()) expect(dns.find('.cid-status-dot').classes()).toContain('sd-muted');
    expect(wrapper.text()).toContain('Unavailable');
    expect(wrapper.text()).not.toContain('Running');
  });

  it('drops a stale healthy reading when the next poll fails', async () => {
    let calls = 0;
    const wrapper = mountHeader(() =>
      ++calls === 1 ? Promise.resolve({ data: HEALTH }) : Promise.reject(new Error('gone')),
    );
    await flushPromises();
    expect(wrapper.find('[data-track="header-chip-cpu"]').text()).toContain('CPU 50%');
    await wrapper.vm.$.setupState.fetchHealth();
    await flushPromises();
    const cpu = wrapper.find('[data-track="header-chip-cpu"]');
    expect(cpu.text()).toContain(EMPTY_CELL);
    expect(cpu.text()).not.toContain('50%');
    expect(cpu.find('.cid-status-dot').classes()).toContain('sd-muted');
    // A later good read restores the values.
    calls = 0;
    await wrapper.vm.$.setupState.fetchHealth();
    await flushPromises();
    expect(wrapper.find('[data-track="header-chip-cpu"]').text()).toContain('CPU 50%');
  });
});
