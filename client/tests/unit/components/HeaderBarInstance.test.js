/**
 * The header's mode chip: nothing on a single box, "Controller" once a member
 * is paired, and "Member of <name>" with the sync state on a member, kept
 * current by the header's poll.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const { default: HeaderBar } = await import('../../../src/components/HeaderBar.vue');
const { useFeaturesStore } = await import('../../../src/stores/features.js');

const MEMBER = {
  mode: 'member',
  controller_name: 'ns1',
  members: 0,
  sync: { state: 'current', last_sync_at: null, last_error: null },
};
let featuresPayload;

async function mountHeader(instance) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useFeaturesStore().set({ instance });
  api.get.mockImplementation((url) => {
    if (url === '/features') return Promise.resolve({ data: featuresPayload });
    if (url === '/scans') return Promise.resolve({ data: [] });
    return Promise.resolve({ data: {} });
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });
  const stub = { template: '<div><slot /></div>' };
  const wrapper = mount(HeaderBar, {
    global: {
      plugins: [pinia, router],
      stubs: { Popover: stub, Select: stub, RouterLink: { template: '<a><slot /></a>' } },
      directives: { tooltip: () => {} },
    },
  });
  await flushPromises();
  return { wrapper, router };
}

const chip = (wrapper) => wrapper.find('[data-track="header-chip-instance"]');
const featureReads = () => api.get.mock.calls.filter(([url]) => url === '/features').length;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  featuresPayload = {};
});
afterEach(() => vi.useRealTimers());

describe('header mode chip', () => {
  it('shows nothing on a single box and never re-reads the features for it', async () => {
    const { wrapper } = await mountHeader({ mode: 'controller', members: 0, sync: null });
    expect(chip(wrapper).exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(featureReads()).toBe(0);
    wrapper.unmount();
  });

  it('says Controller once a member is paired, and opens the Instances page', async () => {
    const { wrapper, router } = await mountHeader({ mode: 'controller', members: 2, sync: null });
    expect(chip(wrapper).text()).toBe('Controller');
    expect(chip(wrapper).attributes('title')).toBe('Controller of 2 members');
    const push = vi.spyOn(router, 'push');
    await chip(wrapper).trigger('click');
    expect(push).toHaveBeenCalledWith('/system?area=instances');
    wrapper.unmount();
  });

  it('names the controller on a member, with the sync state as the dot', async () => {
    const { wrapper } = await mountHeader(MEMBER);
    expect(chip(wrapper).text()).toBe('Member of ns1');
    expect(chip(wrapper).find('.cid-status-dot').classes()).toContain('sd-ok');
    expect(chip(wrapper).attributes('title')).toContain('Current with the controller');
    wrapper.unmount();
  });

  it('follows a member whose sync state changes', async () => {
    const { wrapper } = await mountHeader(MEMBER);
    featuresPayload = {
      instance: {
        ...MEMBER,
        sync: { state: 'offline', last_sync_at: null, last_error: 'connect ECONNREFUSED' },
      },
    };
    await vi.advanceTimersByTimeAsync(60000);
    await flushPromises();
    expect(featureReads()).toBe(1);
    expect(chip(wrapper).find('.cid-status-dot').classes()).toContain('sd-err');
    expect(chip(wrapper).attributes('title')).toContain('Cannot reach the controller');
    expect(chip(wrapper).attributes('title')).toContain('connect ECONNREFUSED');
    wrapper.unmount();
  });
});
