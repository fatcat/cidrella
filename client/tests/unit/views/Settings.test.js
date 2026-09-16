import { mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const route = reactive({ query: {} });
const push = vi.fn();
const replace = vi.fn();
const router = {
  push,
  replace,
  resolve: (path) => ({ name: 'Networks', matched: path.startsWith('/networks') ? [{}] : [] }),
};

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => router,
}));

const { default: Settings } = await import('../../../src/views/Settings.vue');

describe('Settings workspace return path', () => {
  beforeEach(() => {
    route.query = {};
    push.mockClear();
    replace.mockClear();
    localStorage.clear();
  });

  function mountSettings() {
    return mount(Settings, {
      global: {
        stubs: {
          RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
          SettingsArea: {
            emits: ['area', 'sec'],
            template:
              '<div><button class="area" @click="$emit(\'area\', \'dhcp\')"/><button class="sec" @click="$emit(\'sec\', \'rogue\')"/></div>',
          },
        },
      },
    });
  }

  it('shows and preserves a safe workspace return URL while navigating settings', async () => {
    route.query = { area: 'dns', sec: 'dns', return: '/networks?view=dns' };
    const wrapper = mountSettings();

    expect(wrapper.get('.settings-return a').attributes('href')).toBe('/networks?view=dns');
    await wrapper.get('.area').trigger('click');
    expect(push).toHaveBeenCalledWith({
      query: { area: 'dhcp', return: '/networks?view=dns' },
    });
  });

  it('does not render an unsafe external return target', () => {
    route.query = { return: '//evil.example.com' };
    expect(mountSettings().find('.settings-return').exists()).toBe(false);
  });
});
