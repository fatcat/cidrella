import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, reactive } from 'vue';
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

// A small catalog stands in for settingsAreas.js so no real editor (with its
// API reads) mounts. The shell must not know the difference.
const leaf = (name) => defineComponent({ name, render: () => h('p', { class: 'leaf' }, name) });
vi.mock('../../../../src/config/settingsAreas.js', () => {
  const SETTINGS_AREAS = [
    {
      id: 'general',
      label: 'General',
      icon: 'pi pi-cog',
      group: 'Configuration',
      blurb: 'Naming, VLANs',
      dataTrack: 'settings-area-general',
      subtabs: [
        {
          id: 'naming',
          label: 'Naming',
          dataTrack: 'settings-sec-naming',
          component: leaf('Naming'),
        },
        {
          id: 'vlans',
          label: 'VLANs',
          dataTrack: 'settings-sec-vlans',
          fill: true,
          component: leaf('Vlans'),
        },
      ],
    },
    {
      id: 'dhcp',
      label: 'DHCP',
      icon: 'pi pi-server',
      group: 'Configuration',
      blurb: 'Scopes, rogue detection',
      dataTrack: 'settings-area-dhcp',
      subtabs: [
        {
          id: 'scopes',
          label: 'Scopes',
          dataTrack: 'settings-sec-dhcp',
          component: leaf('Scopes'),
        },
        {
          id: 'rogue',
          label: 'Rogue Detection',
          dataTrack: 'settings-sec-rogue',
          component: leaf('Rogue'),
        },
      ],
    },
    {
      id: 'maintenance',
      label: 'Maintenance',
      icon: 'pi pi-wrench',
      group: 'System',
      blurb: 'Backup, updates',
      dataTrack: 'settings-area-maintenance',
      subtabs: [
        {
          id: 'backup',
          label: 'Backup',
          dataTrack: 'settings-sec-backup',
          component: leaf('Backup'),
        },
        {
          id: 'updates',
          label: 'Updates',
          dataTrack: 'settings-sec-updates',
          component: leaf('Updates'),
        },
      ],
    },
    {
      id: 'tools',
      label: 'Tools',
      icon: 'pi pi-calculator',
      group: 'Tools',
      blurb: 'Subnet calculator',
      dataTrack: 'settings-area-tools',
      subtabs: [
        {
          id: 'calculator',
          label: 'Calculator',
          dataTrack: 'settings-sec-calc',
          component: leaf('Calc'),
        },
      ],
    },
  ];
  return {
    SETTINGS_AREAS,
    SETTINGS_GROUPS: ['Configuration', 'System', 'Tools'],
    findArea: (id) => SETTINGS_AREAS.find((area) => area.id === id) || null,
  };
});

const { default: SettingsWorkspace } =
  await import('../../../../src/views/settings-workspace/SettingsWorkspace.vue');

function mountShell() {
  return mount(SettingsWorkspace, {
    attachTo: globalThis.document.body,
    global: {
      stubs: {
        RouterLink: {
          props: ['to'],
          template: '<a :href="typeof to === \'string\' ? to : to.path"><slot /></a>',
        },
      },
    },
  });
}

describe('Settings workspace shell', () => {
  beforeEach(() => {
    route.query = {};
    push.mockClear();
    replace.mockClear();
    globalThis.document.body.innerHTML = '';
  });

  it('lists every area under its group and mounts the first section of the default area', () => {
    const wrapper = mountShell();
    expect(wrapper.findAll('.eyebrow').map((el) => el.text())).toEqual([
      'Configuration',
      'System',
      'Tools',
    ]);
    expect(wrapper.findAll('.area-row strong').map((el) => el.text())).toEqual([
      'General',
      'DHCP',
      'Maintenance',
      'Tools',
    ]);
    expect(wrapper.find('.area-row.active').attributes('aria-current')).toBe('page');
    expect(wrapper.find('h2').text()).toBe('General');
    expect(wrapper.find('.leaf').text()).toBe('Naming');
    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe('Naming');
    wrapper.unmount();
  });

  it('honors ?area and ?sec deep links, falls back to the first section for unknown ids', async () => {
    route.query = { area: 'dhcp', sec: 'rogue' };
    const wrapper = mountShell();
    expect(wrapper.find('h2').text()).toBe('DHCP');
    expect(wrapper.find('.leaf').text()).toBe('Rogue');
    expect(wrapper.find('[role="tabpanel"]').attributes('aria-labelledby')).toBe(
      'settings-tab-dhcp-rogue',
    );

    route.query = { area: 'dhcp', sec: 'nope' };
    await nextTick();
    expect(wrapper.find('.leaf').text()).toBe('Scopes');

    route.query = { area: 'unknown' };
    await nextTick();
    expect(wrapper.find('h2').text()).toBe('General');
    wrapper.unmount();
  });

  it('navigates through the router and carries a safe return path', async () => {
    route.query = { area: 'general', return: '/networks-preview?context=network&network=4' };
    const wrapper = mountShell();
    expect(wrapper.find('[data-track="settings-workspace-return"]').attributes('href')).toBe(
      '/networks-preview?context=network&network=4',
    );
    expect(wrapper.find('.scope-chip').text()).toContain('Appliance-wide');

    await wrapper.find('[data-track="settings-area-dhcp"]').trigger('click');
    expect(push).toHaveBeenLastCalledWith({
      query: { area: 'dhcp', return: '/networks-preview?context=network&network=4' },
    });
    await wrapper.find('[data-track="settings-sec-vlans"]').trigger('click');
    expect(push).toHaveBeenLastCalledWith({
      query: {
        area: 'general',
        sec: 'vlans',
        return: '/networks-preview?context=network&network=4',
      },
    });
    wrapper.unmount();
  });

  it('drops an unsafe return target and shows no scope chip', () => {
    route.query = { return: '//evil.example.com' };
    const wrapper = mountShell();
    expect(wrapper.find('[data-track="settings-workspace-return"]').exists()).toBe(false);
    expect(wrapper.find('.scope-chip').exists()).toBe(false);
    wrapper.unmount();
  });

  it('translates legacy ?tab= bookmarks once on mount', () => {
    route.query = { tab: 'updates' };
    mountShell().unmount();
    expect(replace).toHaveBeenCalledWith({ query: { area: 'maintenance', sec: 'updates' } });
  });

  it('filters the explorer by area label, blurb and section label', async () => {
    const wrapper = mountShell();
    const search = wrapper.find('[data-track="settings-search"]');
    await search.setValue('rogue');
    expect(wrapper.findAll('.area-row strong').map((el) => el.text())).toEqual(['DHCP']);
    expect(wrapper.findAll('.eyebrow').map((el) => el.text())).toEqual(['Configuration']);
    await search.setValue('calculator');
    expect(wrapper.findAll('.area-row strong').map((el) => el.text())).toEqual(['Tools']);
    await search.setValue('zzz');
    expect(wrapper.find('.explorer-empty').text()).toContain('zzz');
    wrapper.unmount();
  });

  it('moves between section tabs with the arrow keys and marks fill sections', async () => {
    const wrapper = mountShell();
    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs.map((tab) => tab.attributes('tabindex'))).toEqual(['0', '-1']);
    tabs[0].element.focus();
    await tabs[0].trigger('keydown', { key: 'ArrowRight' });
    expect(globalThis.document.activeElement).toBe(tabs[1].element);
    expect(push).toHaveBeenLastCalledWith({ query: { area: 'general', sec: 'vlans' } });

    route.query = { area: 'general', sec: 'vlans' };
    await nextTick();
    expect(wrapper.find('[role="tabpanel"]').classes()).toContain('fill');
    await tabs[1].trigger('keydown', { key: 'End' });
    expect(push).toHaveBeenLastCalledWith({ query: { area: 'general', sec: 'vlans' } });
    await tabs[1].trigger('keydown', { key: 'ArrowRight' });
    expect(push).toHaveBeenLastCalledWith({ query: { area: 'general', sec: 'naming' } });
    wrapper.unmount();
  });
});
