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

// The vendor input needs the PrimeVue plugin; the search box is a plain input.
const InputText = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template:
    '<input class="picker-search-input" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};

function mountHeader(summaryZones, selectedZone = null, extra = {}) {
  return mount(WorkspaceContextHeader, {
    attachTo: globalThis.document.body,
    global: { stubs: { InputText } },
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
      ...extra,
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

  it('lists reverse zones in address order, not name order', async () => {
    const names = [
      '0.0.10.in-addr.arpa',
      '0.16.172.in-addr.arpa',
      '0.168.192.in-addr.arpa',
      '1.0.10.in-addr.arpa',
      '8.0.10.in-addr.arpa',
      '10.0.10.in-addr.arpa',
    ];
    const wrapper = mountHeader(
      names.map((name, i) => ({ id: i + 1, type: 'reverse', name, record_count: 1 })),
    );
    await wrapper.find('.linked-picker').trigger('click');
    const items = globalThis.document.querySelectorAll('.picker-item strong');
    expect([...items].map((el) => el.textContent)).toEqual([
      '0.0.10.in-addr.arpa',
      '1.0.10.in-addr.arpa',
      '8.0.10.in-addr.arpa',
      '10.0.10.in-addr.arpa',
      '0.16.172.in-addr.arpa',
      '0.168.192.in-addr.arpa',
    ]);
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

  it('groups reverse zones under the network each serves, and searches them', async () => {
    const trust = { id: 7, cidr: '10.0.0.0/22', name: 'Trust Network' };
    const iot = { id: 8, cidr: '10.0.8.0/24', name: 'IOT' };
    const zone = (id, name, networks, count = 254) => ({
      id,
      type: 'reverse',
      name,
      record_count: count,
      related_networks: networks,
    });
    const wrapper = mountHeader([
      zone(1, '8.0.10.in-addr.arpa', [iot]),
      zone(2, '1.0.10.in-addr.arpa', [trust]),
      zone(3, '0.0.10.in-addr.arpa', [trust]),
      zone(4, '99.51.198.in-addr.arpa', [], 3),
    ]);
    await wrapper.find('.linked-picker').trigger('click');
    const doc = globalThis.document;
    const headings = () =>
      [...doc.querySelectorAll('.picker-heading strong')].map((el) => el.textContent);
    const zonesShown = () =>
      [...doc.querySelectorAll('.picker-item strong')].map((el) => el.textContent);
    // Networks in address order, zones in address order under each, and the
    // unlinked zone last.
    expect(headings()).toEqual(['Trust Network', 'IOT', 'Other zones']);
    expect(zonesShown()).toEqual([
      '0.0.10.in-addr.arpa',
      '1.0.10.in-addr.arpa',
      '8.0.10.in-addr.arpa',
      '99.51.198.in-addr.arpa',
    ]);
    expect(doc.querySelector('.picker-item small').textContent).toBe('10.0.0.0/24');
    expect(doc.querySelector('.picker-heading em').textContent).toBe('508');

    const search = doc.querySelector('.picker-search-input');
    const type = async (text) => {
      search.value = text;
      search.dispatchEvent(new Event('input'));
      await wrapper.vm.$nextTick();
    };
    // A network name keeps all its zones.
    await type('trust');
    expect(zonesShown()).toEqual(['0.0.10.in-addr.arpa', '1.0.10.in-addr.arpa']);
    // An address finds the zone that covers it.
    await type('10.0.1.77');
    expect(headings()).toEqual(['Trust Network']);
    expect(zonesShown()).toEqual(['1.0.10.in-addr.arpa']);
    // A CIDR prefix.
    await type('10.0.8');
    expect(zonesShown()).toEqual(['8.0.10.in-addr.arpa']);
    await type('nothing here');
    expect(doc.querySelector('.picker-empty').textContent).toContain('nothing here');

    // The heading picks every reverse zone of that network.
    await type('');
    doc.querySelector('[data-track="workspace-reverse-network"]').click();
    expect(wrapper.emitted('filter-reverse-network')?.[0]?.[0]).toEqual(trust);
    wrapper.unmount();
  });

  it('names the whole network on the card when its reverse zones are the filter', () => {
    const trust = { id: 7, cidr: '10.0.0.0/22', name: 'Trust Network' };
    const wrapper = mountHeader(zones(5), null, { selectedReverseNetwork: trust });
    const picker = wrapper.find('.linked-picker');
    expect(picker.find('strong').text()).toBe('Trust Network · all zones');
    expect(picker.attributes('aria-pressed')).toBe('true');
    wrapper.unmount();
  });
});
