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

function mountHeader(summaryZones, selectedZone = null) {
  return mount(WorkspaceContextHeader, {
    attachTo: globalThis.document.body,
    props: {
      contextKind: 'network',
      contextIcon: 'pi pi-sitemap',
      contextTitle: '10.0.0.0/22',
      selectedNetwork: { id: 2, folder: 'Home', folderId: 1 },
      stats: [],
      views: [],
      activeView: 'dns',
      showSummary: true,
      viewMeta: { title: 'DNS' },
      summaryZones,
      selectedZone,
    },
  });
}

const cardNames = (wrapper) =>
  wrapper.findAll('.linked-card:not(.linked-picker) strong').map((el) => el.text());

describe('WorkspaceContextHeader linked zone strip', () => {
  it('shows a single reverse zone as its own card', () => {
    const wrapper = mountHeader(zones(2));
    expect(cardNames(wrapper)).toEqual(['example.test', '0.0.10.in-addr.arpa']);
    expect(wrapper.find('.linked-picker').exists()).toBe(false);
    wrapper.unmount();
  });

  it('folds the reverse zones of a /22 into one picker card', async () => {
    const wrapper = mountHeader(zones(5));
    expect(cardNames(wrapper)).toEqual(['example.test']);
    const picker = wrapper.find('.linked-picker');
    expect(picker.find('small').text()).toBe('4 reverse zones');
    expect(picker.find('strong').text()).toBe('Choose a zone');
    expect(picker.find('em').text()).toBe('1016');
    expect(picker.attributes('aria-pressed')).toBe('false');

    await picker.trigger('click');
    const items = globalThis.document.querySelectorAll('.picker-item');
    expect([...items].map((el) => el.querySelector('strong').textContent)).toEqual([
      '0.0.10.in-addr.arpa',
      '1.0.10.in-addr.arpa',
      '2.0.10.in-addr.arpa',
      '3.0.10.in-addr.arpa',
    ]);

    items[2].click();
    expect(wrapper.emitted('filter-zone')?.[0]?.[0]).toMatchObject({
      name: '2.0.10.in-addr.arpa',
    });
    wrapper.unmount();
  });

  it('names the chosen reverse zone on the picker card', () => {
    const list = zones(5);
    const wrapper = mountHeader(list, list[3]);
    const picker = wrapper.find('.linked-picker');
    expect(picker.find('strong').text()).toBe('2.0.10.in-addr.arpa');
    expect(picker.attributes('aria-pressed')).toBe('true');
    expect(picker.classes()).toContain('selected');
    wrapper.unmount();
  });
});
