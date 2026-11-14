/**
 * The presentation switcher and Show available are withheld for an IPv6
 * network: its address space cannot be enumerated, so the table is the one
 * presentation and there is no free space to list.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import WorkspaceToolbar from '../../../../src/views/networks-workspace/WorkspaceToolbar.vue';

function mountToolbar(props = {}) {
  return mount(WorkspaceToolbar, {
    shallow: true,
    props: {
      activeView: 'addresses',
      contextKind: 'network',
      viewMeta: { addLabel: 'Add', search: 'Search addresses' },
      filterOptions: { status: [], type: [], range: [], protocol: [] },
      columnTableName: 'addresses',
      columnCatalog: [],
      columns: [],
      filters: {},
      ...props,
    },
  });
}

describe('WorkspaceToolbar presentation switcher', () => {
  it('offers table, grid and compact grid for an IPv4 network', () => {
    const wrapper = mountToolbar();
    expect(wrapper.find('.view-switcher').exists()).toBe(true);
    expect(wrapper.find('[data-track="workspace-compact-grid"]').exists()).toBe(true);
  });

  it('offers no switcher at all when the grid is not allowed', () => {
    const wrapper = mountToolbar({ allowGrid: false });
    expect(wrapper.find('.view-switcher').exists()).toBe(false);
  });
});

describe('WorkspaceToolbar Show available', () => {
  it('is offered on the Addresses and DHCP views of an IPv4 network', () => {
    for (const activeView of ['addresses', 'dhcp']) {
      expect(mountToolbar({ activeView }).find('.available-switch').exists()).toBe(true);
    }
  });

  it('is withheld when the network cannot list available addresses', () => {
    for (const activeView of ['addresses', 'dhcp']) {
      const wrapper = mountToolbar({ activeView, allowAvailable: false });
      expect(wrapper.find('.available-switch').exists()).toBe(false);
    }
  });
});
