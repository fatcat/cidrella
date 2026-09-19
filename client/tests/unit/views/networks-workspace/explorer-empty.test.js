/**
 * The explorer's empty state is where a fresh appliance creates its first
 * network, so it carries the create action rather than only a sentence.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ResourceExplorer from '../../../../src/views/networks-workspace/ResourceExplorer.vue';

function mountEmpty(props = {}) {
  return mount(ResourceExplorer, {
    props: {
      contextKind: 'estate',
      folders: [],
      expandedFolders: new Set(),
      loading: false,
      canCreate: true,
      ...props,
    },
  });
}

describe('ResourceExplorer empty state', () => {
  it('offers to create the first network and routes it through the allocate action', async () => {
    const w = mountEmpty();
    const cta = w.find('[data-track="explorer-create-first-network"]');
    expect(cta.exists()).toBe(true);
    expect(cta.text()).toContain('Create your first network');
    await cta.trigger('click');
    expect(w.emitted('action')).toEqual([['network.allocate']]);
  });

  it('stays a plain sentence for viewers who cannot create', () => {
    const w = mountEmpty({ canCreate: false });
    expect(w.find('[data-track="explorer-create-first-network"]').exists()).toBe(false);
    expect(w.text()).toContain('No allocated networks found.');
  });

  it('does not offer it in the unallocated view', () => {
    const w = mountEmpty({ contextKind: 'unallocated' });
    expect(w.find('[data-track="explorer-create-first-network"]').exists()).toBe(false);
  });

  it('is absent while loading or once networks exist', () => {
    expect(mountEmpty({ loading: true }).find('.explorer-empty').exists()).toBe(false);
    const w = mountEmpty({
      folders: [{ id: 1, name: 'LAN', networks: [{ id: 1, name: 'lan', cidr: '10.0.0.0/24' }] }],
    });
    expect(w.find('.explorer-empty').exists()).toBe(false);
  });
});
