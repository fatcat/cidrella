import { shallowMount } from '@vue/test-utils';
import { reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const route = reactive({ query: {} });
const push = vi.fn(async ({ query }) => {
  route.query = query;
});

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push }),
}));

vi.mock('../../../src/views/Dashboard.vue', () => ({
  default: { template: '<div />' },
  __isTeleport: false,
}));
vi.mock('../../../src/views/Performance.vue', () => ({
  default: { template: '<div />' },
  __isTeleport: false,
}));
vi.mock('../../../src/views/Intelligence.vue', () => ({
  default: { template: '<div />' },
  __isTeleport: false,
}));
vi.mock('../../../src/views/Anomalies.vue', () => ({
  default: { template: '<div />' },
  __isTeleport: false,
}));

const { default: Analytics } = await import('../../../src/views/Analytics.vue');

describe('Analytics workspace shell', () => {
  beforeEach(() => {
    route.query = {};
    push.mockClear();
    localStorage.clear();
  });

  it('uses keyboard-operable navigation and preserves the section in the URL', async () => {
    const wrapper = shallowMount(Analytics);

    const navigation = wrapper.get('nav');
    const buttons = navigation.findAll('button');
    expect(buttons).toHaveLength(4);
    expect(buttons[0].attributes('aria-current')).toBe('page');

    await buttons[2].trigger('click');
    await wrapper.vm.$nextTick();

    expect(push).toHaveBeenCalledWith({ query: { view: 'intelligence' } });
    expect(navigation.findAll('button')[2].attributes('aria-current')).toBe('page');
  });

  it('opens a bookmarked section and retains unrelated query parameters', async () => {
    route.query = { view: 'anomalies', client: 'device-1' };
    const wrapper = shallowMount(Analytics);

    expect(wrapper.findAll('nav button')[3].attributes('aria-current')).toBe('page');
    await wrapper.findAll('nav button')[1].trigger('click');
    expect(push).toHaveBeenCalledWith({
      query: { view: 'performance', client: 'device-1' },
    });
  });
});
