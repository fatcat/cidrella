/**
 * Analytics on a member: three sections, opening on Performance, a saved tab
 * the member does not show falling back to it, and the line naming a page
 * the router sent the member away from, with a link to the controller.
 */
import { flushPromises, shallowMount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const route = reactive({ query: {} });
const push = vi.fn(async ({ query }) => {
  route.query = query;
});
const replace = vi.fn(async ({ query }) => {
  route.query = query;
});
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push, replace }),
}));

for (const view of [
  'Dashboard',
  'Performance',
  'Intelligence',
  'AnomaliesWorkspace',
  'ResolutionMap',
])
  vi.doMock(`../../../src/views/${view}.vue`, () => ({ default: { template: '<div />' } }));

const { default: Analytics } = await import('../../../src/views/Analytics.vue');
const { useFeaturesStore } = await import('../../../src/stores/features.js');

const MEMBER = {
  mode: 'member',
  controller_name: 'ns1',
  controller_url: 'https://192.0.2.10:443',
  members: 0,
  sync: null,
};

function mountAs(instance) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useFeaturesStore().set({ instance });
  return shallowMount(Analytics, {
    global: { plugins: [pinia], stubs: { StatusDot: true } },
  });
}

const tabs = (wrapper) => wrapper.findAll('nav button').map((b) => b.attributes('data-track'));
const current = (wrapper) =>
  wrapper
    .findAll('nav button')
    .find((b) => b.attributes('aria-current'))
    ?.attributes('data-track');

beforeEach(() => {
  route.query = {};
  push.mockClear();
  replace.mockClear();
  localStorage.clear();
});

describe('Analytics on a member', () => {
  it('lists Performance, Intelligence and the Resolution Map and opens on Performance', async () => {
    const wrapper = mountAs(MEMBER);
    expect(tabs(wrapper)).toEqual(['ana-tab-performance', 'ana-tab-intelligence', 'ana-tab-map']);
    expect(current(wrapper)).toBe('ana-tab-performance');
    await flushPromises();
    wrapper.unmount();
  });

  it('falls back to Performance from a saved Dashboard tab', async () => {
    localStorage.setItem('cidrella_analytics_tab', '0');
    const wrapper = mountAs(MEMBER);
    expect(current(wrapper)).toBe('ana-tab-performance');
    await flushPromises();
    wrapper.unmount();
  });

  it('keeps a saved tab the member shows', async () => {
    localStorage.setItem('cidrella_analytics_tab', '4');
    const wrapper = mountAs(MEMBER);
    expect(current(wrapper)).toBe('ana-tab-map');
    await flushPromises();
    wrapper.unmount();
  });

  it('names the page it was sent from once, links the controller, and drops the query', async () => {
    route.query = { elsewhere: 'IP Management' };
    const wrapper = mountAs(MEMBER);
    await flushPromises();
    const line = wrapper.find('[data-track="ana-managed-elsewhere"]');
    expect(line.text()).toContain('IP Management is managed on ns1.');
    const link = wrapper.find('[data-track="ana-open-controller"]');
    expect(link.attributes('href')).toBe('https://192.0.2.10:443');
    expect(link.text()).toBe('Open ns1');
    expect(replace).toHaveBeenCalledWith({ query: {} });

    // Gone once the member picks a section.
    await wrapper.findAll('nav button')[1].trigger('click');
    expect(wrapper.find('[data-track="ana-managed-elsewhere"]').exists()).toBe(false);
    await flushPromises();
    wrapper.unmount();
  });

  it('names the page without a link when the controller has no URL', async () => {
    route.query = { elsewhere: 'DNS' };
    const wrapper = mountAs({ ...MEMBER, controller_url: null });
    await flushPromises();
    expect(wrapper.find('[data-track="ana-managed-elsewhere"]').text()).toContain(
      'DNS is managed on ns1.',
    );
    expect(wrapper.find('[data-track="ana-open-controller"]').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('Analytics on a controller', () => {
  it('lists every section and opens on the Dashboard', async () => {
    const wrapper = mountAs({ mode: 'controller', members: 2, sync: null });
    expect(tabs(wrapper)).toHaveLength(5);
    expect(current(wrapper)).toBe('ana-tab-dashboard');
    await flushPromises();
    wrapper.unmount();
  });
});
