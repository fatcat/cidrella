/**
 * The presentation switcher is withheld for an IPv6 network: its address
 * space cannot be enumerated, so the table is the one presentation.
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
