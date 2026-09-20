import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import WorkspaceContextHeader from '../../../src/views/networks-workspace/WorkspaceContextHeader.vue';

function zones(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    type: i === 0 ? 'forward' : 'reverse',
    name: i === 0 ? 'example.test' : `${i - 1}.0.10.in-addr.arpa`,
    record_count: 254,
  }));
}

function mountHeader(summaryZones, selectedNetwork = { id: 2, folder: 'Home', folderId: 1 }) {
  return mount(WorkspaceContextHeader, {
    props: {
      contextKind: 'network',
      contextIcon: 'pi pi-sitemap',
      contextTitle: '10.0.0.0/22',
      selectedNetwork,
      stats: [],
      views: [],
      activeView: 'dns',
      showSummary: true,
      viewMeta: { title: 'DNS' },
      summaryZones,
    },
  });
}

const cardNames = (wrapper) =>
  wrapper.findAll('.linked-card:not(.linked-more) strong').map((el) => el.text());

describe('WorkspaceContextHeader linked zone strip', () => {
  it('shows every linked zone of a /22 split into /24 reverse zones', () => {
    const wrapper = mountHeader(zones(5));
    expect(cardNames(wrapper)).toEqual([
      'example.test',
      '0.0.10.in-addr.arpa',
      '1.0.10.in-addr.arpa',
      '2.0.10.in-addr.arpa',
      '3.0.10.in-addr.arpa',
    ]);
    expect(wrapper.find('.linked-more').exists()).toBe(false);
  });

  it('shows seven cards rather than six plus a "+1 more" card', () => {
    const wrapper = mountHeader(zones(7));
    expect(cardNames(wrapper)).toHaveLength(7);
    expect(wrapper.find('.linked-more').exists()).toBe(false);
  });

  it('caps a long list and expands it in place', async () => {
    const wrapper = mountHeader(zones(17));
    expect(cardNames(wrapper)).toHaveLength(6);
    const more = wrapper.find('.linked-more');
    expect(more.text()).toBe('+11 more');

    await more.trigger('click');
    expect(cardNames(wrapper)).toHaveLength(17);
    expect(wrapper.find('.linked-more').text()).toBe('Show fewer');

    // Moving to another network collapses the strip again.
    await wrapper.setProps({ selectedNetwork: { id: 3, folder: 'Home', folderId: 1 } });
    expect(cardNames(wrapper)).toHaveLength(6);
  });
});
